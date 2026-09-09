// Delivery consumer for `operation_reminders`.
//
// createOperationReminders (lib/db/ops.ts) has written start-30min / start-5min
// rows on every scheduled operation since day one and NOTHING has ever read them:
// there was no select of the table anywhere in the server, so no operation push
// reminder has ever fired on any deployment. This module is the missing consumer,
// registered in server.ts as an in-process node-cron job under the `op_reminders`
// lease (lib/cronLock.ts). Deliberately NOT an HTTP-poked cron endpoint — an
// externally reachable trigger is attack surface plus a shared secret to manage,
// for a job this process can run itself.
//
// EGRESS GATE. Web push fans out to participants with no per-recipient clearance
// filter, and the participant set genuinely drifts out of an op's visibility:
// addOperationParticipant adds a target without checking the TARGET's clearance,
// updateOperation can add limiting markers after people have joined, and clearance
// can be revoked. So a RESTRICTED op's reminder must not carry the operation NAME
// — it sends a generic body and the member reads the op through the
// permission-gated fetch paths. `restricted` here mirrors operationIsRestricted
// (lib/db/ops.ts) on all three of its dimensions (clearance / limiting marker /
// special) so the batch form and the single-op form cannot drift, and it is
// computed FAIL CLOSED: every op starts restricted and is relaxed only on positive
// confirmation, because supabase-js RESOLVES `{ data: null, error }` and an unread
// error would otherwise read as "clearance 0, no markers".
//
// RECIPIENTS. deleteUser only soft-deletes (deleted_at) — it drops neither the
// removed member's push_subscriptions nor their operation_participants rows — so
// an ejected member would otherwise stay an "active participant" of every op they
// ever joined and keep receiving its name. filterLiveRecipients intersects them
// out, and a probe fault skips the whole tick rather than pushing unfiltered.
//
// CLAIM-BEFORE-EGRESS. The claim is a conditional `.eq('sent', false)` UPDATE, so
// two overlapping runs claim DISJOINT subsets and a reminder is pushed by at most
// one worker (this, not the fail-open cron lease, is the real mutual exclusion).
// It runs AFTER the side-effect-free reads, so a transient read fault leaves the
// rows unclaimed and retryable, and BEFORE the push, so a crash mid-tick loses a
// reminder rather than duplicating one. A duplicate user-facing push is the worse
// outcome — do not flip this to push-then-mark.

import { supabase } from './common.js';
import { sendPushToUsers, filterLiveRecipients } from '../push.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.opReminders' });

/**
 * How stale an unsent reminder may be before it is swept instead of delivered.
 * Shared with the one-time backlog drain below (repairDatabase calls it).
 */
export const REMINDER_EXPIRY_MS = 60 * 60 * 1000;

/** Still worth delivering for an op that started this recently. */
const START_GRACE_MS = 10 * 60 * 1000;

/** Further out than this and the row is stale (the op was pushed back). */
const MAX_LEAD_MS = 45 * 60 * 1000;

/** One tick's fan-out bound. */
const BATCH = 50;

type ReminderRow = { id: string; operation_id: string; remind_at: string };
type OpRow = {
    id: string;
    name: string;
    scheduled_start: string | null;
    status: string | null;
    clearance_level: number | null;
    is_special: boolean | null;
};

/**
 * Deliver every due operation reminder, returning how many pushes went out.
 *
 * `now` is injectable so the delivery window can be driven from a test.
 *
 * NOTE on `sent`: the column is nullable (schema.sql `sent boolean DEFAULT false`)
 * and `.eq('sent', false)` does NOT match NULL. Live rows always insert `false`, so
 * only a hand-crafted import can produce NULLs — and those fail CLOSED (never
 * scanned, never swept, inert). Do not "fix" this to `.not('sent','is',true)`: that
 * resurrects an imported backlog as a push storm.
 */
export async function sendDueOperationReminders(now: number = Date.now()): Promise<number> {
    const expiryIso = new Date(now - REMINDER_EXPIRY_MS).toISOString();

    // Expiry sweep FIRST, as one unbounded statement, so a large imported backlog
    // (operation_reminders is in IMPORTABLE_TABLES) cannot starve fresh reminders
    // behind the 50-row batch below — and so the very first tick after this ships
    // retires years of undelivered rows instead of pushing them. This runs every
    // tick forever, not just during the initial drain.
    const { error: expireErr } = await supabase.from('operation_reminders')
        .update({ sent: true })
        .eq('sent', false)
        .lt('remind_at', expiryIso);
    // code+message only — never the raw PostgREST object (details/hint carry
    // schema fragments). Non-fatal: the scan below is bounded either way.
    if (expireErr) log.warn('reminder expiry sweep failed', { code: expireErr.code, message: expireErr.message });

    const nowIso = new Date(now).toISOString();
    const { data: due, error: scanErr } = await supabase.from('operation_reminders')
        .select('id, operation_id, remind_at')
        .eq('sent', false)
        .lte('remind_at', nowIso)
        .gte('remind_at', expiryIso)
        .order('remind_at', { ascending: true }).order('id', { ascending: true })
        .limit(BATCH);
    if (scanErr) {
        log.error('reminder scan failed', { code: scanErr.code, message: scanErr.message });
        return 0;
    }
    const rows = (due || []) as ReminderRow[];
    if (rows.length === 0) return 0;

    const opIds = Array.from(new Set(rows.map(r => r.operation_id)));

    // The op is read as a SEPARATE query rather than a PostgREST embed on the
    // reminder row so the predicate below reads the op's LIVE status and
    // scheduled_start.
    const { data: opRows, error: opErr } = await supabase.from('operations')
        .select('id, name, scheduled_start, status, clearance_level, is_special')
        .in('id', opIds);
    if (opErr) {
        log.error('reminder operation lookup failed', { code: opErr.code, message: opErr.message });
        return 0;
    }
    const opsById = new Map<string, OpRow>(((opRows || []) as OpRow[]).map(o => [o.id, o]));

    const restricted = new Set<string>(opIds);
    const { data: markerRows, error: markerErr } = await supabase.from('operation_limiting_markers')
        .select('operation_id')
        .in('operation_id', opIds);
    if (markerErr) {
        log.warn('reminder marker probe failed — treating every op as restricted', { code: markerErr.code });
    } else {
        const markered = new Set(((markerRows || []) as { operation_id: string }[]).map(m => m.operation_id));
        for (const op of opsById.values()) {
            if ((op.clearance_level || 0) === 0 && !op.is_special && !markered.has(op.id)) restricted.delete(op.id);
        }
    }

    // ACTIVE participants only — mirrors broadcastOperationAlert, which is the
    // other participant fan-out for the same audience.
    const { data: partRows, error: partErr } = await supabase.from('operation_participants')
        .select('operation_id, user_id')
        .in('operation_id', opIds)
        .is('time_left', null);
    if (partErr) {
        log.error('reminder participant lookup failed', { code: partErr.code, message: partErr.message });
        return 0;
    }
    const byOp = new Map<string, number[]>();
    for (const p of ((partRows || []) as { operation_id: string; user_id: number }[])) {
        const arr = byOp.get(p.operation_id);
        if (arr) arr.push(p.user_id);
        else byOp.set(p.operation_id, [p.user_id]);
    }

    const live = await filterLiveRecipients(Array.from(new Set([...byOp.values()].flat())));
    if (!live) return 0;   // probe faulted — skip the tick with the rows unclaimed
    const liveIds = new Set(live);

    const { data: claimed, error: claimErr } = await supabase.from('operation_reminders')
        .update({ sent: true })
        .in('id', rows.map(r => r.id))
        .eq('sent', false)
        .select('id');
    if (claimErr) {
        log.error('reminder claim failed', { code: claimErr.code, message: claimErr.message });
        return 0;
    }
    const wonIds = new Set(((claimed || []) as { id: string }[]).map(r => r.id));
    const mine = rows.filter(r => wonIds.has(r.id));
    if (mine.length === 0) return 0;

    // ONE push per op per tick. After an outage longer than the 25 minutes between
    // the two lead times, an op's 30-min AND 5-min rows are both due, both inside
    // the expiry window and both claimed together — and because both are evaluated
    // against the same live scheduled_start, both would pass the predicate. The
    // per-op tag + renotify (correct for the normal case) would then DISPLAY both.
    // Keep the latest remind_at, the one closest to the start; the rest are already
    // claimed, so they are consumed either way.
    const latestByOp = new Map<string, ReminderRow>();
    for (const r of mine) {
        const prev = latestByOp.get(r.operation_id);
        if (!prev || Date.parse(r.remind_at) > Date.parse(prev.remind_at)) latestByOp.set(r.operation_id, r);
    }

    let sent = 0;
    for (const r of latestByOp.values()) {
        const op = opsById.get(r.operation_id);
        if (!op) continue;                                  // deleted since it was scheduled
        if (op.status === 'Concluded') continue;

        // The window is evaluated against the op's LIVE scheduled_start, never the
        // row's remind_at: updateOperation rewrites scheduled_start and never
        // rebuilds these rows, so a rescheduled op would otherwise fire at the old
        // time. Reading the live value makes the job self-healing across reschedule.
        const startMs = op.scheduled_start ? Date.parse(op.scheduled_start) : NaN;
        if (!Number.isFinite(startMs)) continue;
        if (startMs < now - START_GRACE_MS) continue;       // started too long ago
        if (startMs > now + MAX_LEAD_MS) continue;          // pushed back — stale row

        const userIds = (byOp.get(op.id) || []).filter(id => liveIds.has(id));
        if (userIds.length === 0) continue;

        const minsUntil = Math.max(0, Math.round((startMs - now) / 60000));
        const when = minsUntil > 0 ? `in ${minsUntil} minute${minsUntil === 1 ? '' : 's'}` : 'now';
        const isRestricted = restricted.has(op.id);

        await sendPushToUsers(userIds, {
            title: isRestricted ? 'Operation Reminder' : `Operation Reminder: ${op.name}`,
            body: isRestricted
                ? `An operation you joined starts ${when}. Open the dashboard to view.`
                : (minsUntil > 0 ? `Starting ${when}` : 'Starting now!'),
            // Per-OP tag: api/sw.ts passes `tag` straight to showNotification, so a
            // flat tag would let the 5-minute reminder silently REPLACE an
            // unread 30-minute one in the tray.
            tag: `op-reminder-${op.id}`,
            renotify: true,
            data: { type: 'operation_reminder', operationId: op.id, url: '/operations' },
        });
        sent++;
    }

    return sent;
}

/**
 * Retire the pre-existing backlog of undelivered reminders in one statement.
 *
 * Called from repairDatabase (lib/db/system.ts) because this is one-time STATE,
 * not convergence — schema.sql is re-runnable and stateful SQL does not belong in
 * it. Idempotent, so re-running Repair Database is harmless.
 *
 * It is housekeeping, NOT the guard: repairDatabase is admin-triggered and is not
 * part of first boot, and an org import can re-create the backlog afterwards
 * (operation_reminders is in IMPORTABLE_TABLES), which is why the delivery job
 * carries its own expiry sweep on every tick.
 */
export async function drainStaleOperationReminders(now: number = Date.now()): Promise<number> {
    const cutoff = new Date(now - REMINDER_EXPIRY_MS).toISOString();
    const { data, error } = await supabase.from('operation_reminders')
        .update({ sent: true })
        .eq('sent', false)
        .lt('remind_at', cutoff)
        .select('id');
    if (error) {
        log.error('reminder backlog drain failed', { code: error.code, message: error.message });
        return 0;
    }
    const drained = (data || []).length;
    if (drained > 0) log.info('drained stale operation reminders', { count: drained });
    return drained;
}
