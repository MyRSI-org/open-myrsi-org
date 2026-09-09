// Durable security audit trail — the persistence sink for SecurityDenial.
//
// WHY THIS EXISTS. lib/errors.ts has carried `auditEvent` + `fields` on every
// SecurityDenial since the first hardening pass, and api/services.ts has faithfully
// log.warn'd them. But a log line is not evidence: it lives in a container's stdout,
// a redeploy discards it, and "which account tried to reset the treasury, and when?"
// is not a question you can answer by grepping after the fact. This module makes that
// answerable.
//
// SECURITY (Rules 1/2/3/5), and this table is the sharp end of all of them:
//   * PII-BEARING. actor_ip is personal data; actor_user_id identifies a member.
//     schema.sql keeps `security_events` OUT of private.rt_client_tables(), so the
//     SECTION 6 deny-all loop gives it USING (false) and it is not in the realtime
//     publication. It must never be added there.
//   * There is deliberately NO /api/query subset for it. The admin screen reads it
//     through a permission-gated RPC ONLY, so it is structurally incapable of riding
//     the boot bundle, a *_slice refetch or any state aggregate — the leak shape that
//     Phase 3 spent eight items closing for the roster.
//   * Reads use an explicit column list (Rule 1) and are capped and ordered.
//   * Details are redacted through the LOGGER's own walk (redactFields) rather than a
//     second, weaker copy. This row outlives the log line, so it must be at least as
//     clean as one.
//   * Rows are pruned on a retention timer. An audit trail that grows forever is a
//     liability, not an asset.
// tests/securityEventsEgress.test.ts pins the egress rules; the redaction share is
// pinned there too.
//
// Single-org: there is no organization_id.

import { supabase } from './common.js';
import { log as baseLog, redactFields } from '../log.js';
import type { SecurityEvent } from '../../types.js';

const log = baseLog.child({ module: 'db.securityEvents' });

// Explicit, minimal columns (Rule 1).
const EVENT_COLS = 'id, created_at, actor_user_id, actor_label, actor_ip, event, action, outcome, details';

/** Hard caps. A denial path is attacker-reachable, so every field it writes is bounded. */
const MAX_TEXT = 256;
const MAX_DETAILS_BYTES = 4096;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

interface SecurityEventRow {
    id: number;
    created_at: string;
    actor_user_id: number | null;
    actor_label: string | null;
    actor_ip: string | null;
    event: string;
    action: string | null;
    outcome: string;
    details: Record<string, unknown> | null;
}

export interface SecurityEventInput {
    /** The audit slug, e.g. 'authz.denied'. Mirrors SecurityDenial.auditEvent. */
    event: string;
    /** The dispatcher action or route being attempted. */
    action?: string | null;
    actorUserId?: number | null;
    actorLabel?: string | null;
    actorIp?: string | null;
    outcome?: 'denied' | 'allowed';
    details?: Record<string, unknown>;
}

export interface SecurityEventFilters {
    actorUserId?: number | null;
    event?: string | null;
    /** ISO timestamps, inclusive lower / exclusive upper. */
    since?: string | null;
    until?: string | null;
    limit?: number;
    /** Opaque forward cursor: the `id` of the last row of the previous page. */
    beforeId?: number | null;
}

const clip = (v: unknown, max = MAX_TEXT): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t.slice(0, max) : null;
};

// Field-by-field (Rule 1). A raw row is never returned or spread.
function toSecurityEvent(row: SecurityEventRow): SecurityEvent {
    return {
        id: row.id,
        createdAt: row.created_at,
        actorUserId: row.actor_user_id ?? undefined,
        actorLabel: row.actor_label ?? undefined,
        actorIp: row.actor_ip ?? undefined,
        event: row.event,
        action: row.action ?? undefined,
        outcome: row.outcome,
        details: (row.details ?? {}) as Record<string, unknown>,
    };
}

/**
 * Bound the details bag. The `fields` on a SecurityDenial are developer-authored, but
 * they routinely carry ids that came from the request, so a caller could otherwise post
 * a megabyte of junk and have it durably stored on a path that requires no permission
 * to reach (the denial fires BEFORE authorization succeeds — that is the whole point).
 * Redaction runs first so the size check can never be what saves a secret.
 */
function boundedDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!details || typeof details !== 'object') return {};
    let redacted: Record<string, unknown>;
    try {
        redacted = redactFields(details);
    } catch {
        // A hostile getter or an exotic object shape must not turn an audit write into
        // a thrown error on a denial path. Record that we could not serialise it.
        return { _redaction_failed: true };
    }
    let json: string;
    try {
        json = JSON.stringify(redacted);
    } catch {
        return { _unserialisable: true };
    }
    if (json.length <= MAX_DETAILS_BYTES) return redacted;
    // Keep the shape (the keys are the diagnostic value) and drop the volume.
    return { _truncated: true, _bytes: json.length, keys: Object.keys(redacted).slice(0, 40) };
}

/**
 * Write one audit row. NEVER THROWS and never rejects.
 *
 * This is called from denial paths — the places that are, by definition, already
 * refusing a request. If the audit write could fail the request, an attacker who could
 * break the audit table (fill the disk, drop it, revoke the grant) could turn every
 * denial into a 500, and on some code paths a 500 is handled more permissively than a
 * 403. Losing an audit row is bad; losing the denial is worse. So every failure here is
 * swallowed to a warn.
 *
 * Callers may fire-and-forget with `void recordSecurityEvent(...)`; the promise never
 * rejects, so there is no unhandled-rejection risk either way.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
    try {
        const event = clip(input.event) ?? 'authz.denied';
        const row = {
            actor_user_id: typeof input.actorUserId === 'number' && Number.isFinite(input.actorUserId)
                ? input.actorUserId
                : null,
            actor_label: clip(input.actorLabel),
            actor_ip: clip(input.actorIp, 64),
            event,
            action: clip(input.action),
            outcome: input.outcome === 'allowed' ? 'allowed' : 'denied',
            details: boundedDetails(input.details),
        };
        const { error } = await supabase.from('security_events').insert(row);
        if (error) {
            // 42P01 = table absent: the operator has not re-run schema.sql yet. That is
            // an expected transitional state on upgrade, not an incident, so it does not
            // deserve a warn on every denial.
            if (error.code !== '42P01') {
                log.warn('security event write failed', { code: error.code, event });
            }
        }
    } catch (err) {
        log.warn('security event write threw', { err });
    }
}

/**
 * Read a page of the audit trail, newest first. Admin-gated at the dispatcher
 * (api/services.ts fullPermissionMap); this function assumes that gate has run.
 *
 * Keyset pagination on the descending primary key rather than offset: the table is
 * append-only and high-churn under an attack, and an offset page walks rows that new
 * inserts keep shifting.
 */
export async function listSecurityEvents(filters: SecurityEventFilters = {}): Promise<{
    events: SecurityEvent[];
    nextBeforeId: number | null;
}> {
    const limit = Math.min(Math.max(Number(filters.limit) || DEFAULT_PAGE, 1), MAX_PAGE);
    let q = supabase.from('security_events')
        .select(EVENT_COLS)
        .order('id', { ascending: false })
        .limit(limit);

    if (typeof filters.actorUserId === 'number' && Number.isFinite(filters.actorUserId)) {
        q = q.eq('actor_user_id', filters.actorUserId);
    }
    const event = clip(filters.event);
    if (event) q = q.eq('event', event);
    const since = clip(filters.since, 64);
    if (since) q = q.gte('created_at', since);
    const until = clip(filters.until, 64);
    if (until) q = q.lt('created_at', until);
    if (typeof filters.beforeId === 'number' && Number.isFinite(filters.beforeId)) {
        q = q.lt('id', filters.beforeId);
    }

    const { data, error } = await q;
    if (error) {
        if (error.code === '42P01') {
            // Table not created yet — the admin screen should say "no events", not 500.
            log.warn('security_events table absent; has schema.sql been re-run?');
            return { events: [], nextBeforeId: null };
        }
        log.error('listSecurityEvents failed', { code: error.code });
        throw new Error('Could not load the security audit trail.');
    }
    const rows = (data ?? []) as unknown as SecurityEventRow[];
    const events = rows.map(toSecurityEvent);
    // Only advertise another page when this one was full; a short page is the end.
    const nextBeforeId = events.length === limit ? (events[events.length - 1]?.id ?? null) : null;
    return { events, nextBeforeId };
}

/**
 * Retention prune. Same bounded-batch shape as pruneOldNotifications: PostgREST
 * serialises `.in()` into the request URI, so deleting thousands of ids in one call
 * overflows the gateway limit and silently no-ops. Never throws — returns the row count
 * so the cron can log it.
 */
export async function pruneSecurityEvents(days = 365): Promise<number> {
    const SELECT_BATCH = 5000;
    const DELETE_CHUNK = 500;
    const MAX_BATCHES = 500;
    let total = 0;
    try {
        const cutoff = new Date(Date.now() - Math.max(days, 1) * 86_400_000).toISOString();
        for (let i = 0; i < MAX_BATCHES; i++) {
            const { data, error } = await supabase.from('security_events')
                .select('id')
                .lt('created_at', cutoff)
                .order('id', { ascending: true }).limit(SELECT_BATCH);
            if (error) {
                if (error.code !== '42P01') log.warn('pruneSecurityEvents select failed', { code: error.code });
                break;
            }
            const ids = (data as { id: number }[] | null)?.map((r) => r.id) ?? [];
            if (!ids.length) break;
            for (let j = 0; j < ids.length; j += DELETE_CHUNK) {
                const chunk = ids.slice(j, j + DELETE_CHUNK);
                const { error: delErr } = await supabase.from('security_events').delete().in('id', chunk);
                if (delErr) {
                    log.warn('pruneSecurityEvents delete failed', { code: delErr.code });
                    return total;
                }
                total += chunk.length;
            }
            if (ids.length < SELECT_BATCH) break;
        }
    } catch (err) {
        log.warn('pruneSecurityEvents threw', { err });
    }
    return total;
}
