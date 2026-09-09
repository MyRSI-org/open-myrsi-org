// "Starting in 15 minutes" Discord notice for operations that opted in.
//
// Registered in server.ts inside the EXISTING per-minute `op_reminders` lease
// block, in its own try/catch — no second cron, no second lease key. Its own catch
// so a Discord outage cannot stop the web-push reminders that share the tick.
//
// EXACTLY-ONCE, AND HOW. The scan runs every minute against a 15-minute window, so
// the same operation matches roughly fifteen times. The invariant is a CLAIM, not a
// filter: the job stamps discord_start_notice_sent_at on the rows it selected,
// conditioned on that column still being NULL, and then posts only for the ids the
// stamp actually returned. A second instance racing the same tick claims nothing and
// posts nothing. Claim BEFORE egress, always — the reverse ordering makes a crash
// between post and stamp into a duplicate ping.
//
// CONSENT. discord_start_notice defaults false. An operation publishes nothing here
// unless someone deliberately ticked the box, and an IMPORTED operation lands opted
// out (lib/db/importer.ts neutralises the column) — importing another deployment's
// operations is not consent to announce them in your guild.
//
// CHANNEL. The notice posts ONLY to the operation's own announcement channel, and
// never falls back to the org-wide default. Hosted falls back for unrestricted ops;
// this build does not, uniformly, because 'operation:update' is op-owner-bypassable
// — so with a fallback any operations:create holder could schedule an unattended,
// un-channel-named post into the guild's busiest channel. Requiring the operator to
// have picked a channel keeps the loudest thing this job can do an explicit choice.
// The practical effect: an operation that never posted an announcement never posts a
// start notice either, and the UI says so.
//
// EGRESS. The embed goes through buildAnnouncementEmbedInput, whose `restricted`
// flag comes from operationIsRestricted (clearance + markers + is_special,
// fail-closed). A restricted operation posts a bare notice, never its briefing.
// postOperationStartingEmbed adds no reactions and no ping — this fires on a timer
// with nobody in the loop, and an unattended scheduled @-mention is not something
// this build offers.

import { supabase } from './common.js';
import { buildAnnouncementEmbedInput } from './opAnnouncement.js';
import { postOperationStartingEmbed } from '../discord.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.opStartNotices' });

/** How far ahead of the scheduled start the notice fires. */
export const START_NOTICE_LEAD_MS = 15 * 60 * 1000;

/** Rows claimed per tick. Bounded so one busy minute cannot become a Discord burst. */
const BATCH = 25;

interface DueOpRow {
    id: string;
    scheduled_start: string | null;
    status: string;
    discord_announcement_channel_id: string | null;
}

export async function sendDueOperationStartNotices(now: number = Date.now()): Promise<number> {
    const nowIso = new Date(now).toISOString();
    const windowEnd = new Date(now + START_NOTICE_LEAD_MS).toISOString();

    const { data: due, error: scanErr } = await supabase.from('operations')
        .select('id, scheduled_start, status, discord_announcement_channel_id')
        .eq('discord_start_notice', true)
        // A cancelled or already-running operation does not need a countdown.
        .in('status', ['Planning', 'Scheduled'])
        .is('discord_start_notice_sent_at', null)
        // Strictly ahead of now: an operation whose start has already passed gets
        // nothing rather than a "starting soon" notice about the past.
        .gt('scheduled_start', nowIso)
        .lte('scheduled_start', windowEnd)
        // scheduled_start is not unique — several operations can share a start time —
        // so the id tiebreak is what makes this a total order. Required by the
        // absolute order rule for any capped read.
        .order('scheduled_start', { ascending: true }).order('id', { ascending: true })
        .limit(BATCH);

    if (scanErr) {
        // The pre-apply window: an operator running this build against a database
        // where schema.sql has not been re-run yet has neither column. Degrade to
        // "no start notices" rather than logging an error every minute forever.
        // ONLY these two codes — a missing RELATION must stay loud.
        if (scanErr.code === '42703' || scanErr.code === 'PGRST204') return 0;
        log.error('start-notice scan failed', { code: scanErr.code, message: scanErr.message });
        return 0;
    }

    const rows = (due || []) as DueOpRow[];
    if (rows.length === 0) return 0;

    // CLAIM. `.is(...)` in the update is the mutual exclusion — two instances racing
    // the same tick both select the rows, and only one update matches.
    const { data: claimed, error: claimErr } = await supabase.from('operations')
        .update({ discord_start_notice_sent_at: nowIso })
        .in('id', rows.map((r) => r.id))
        .is('discord_start_notice_sent_at', null)
        .select('id');
    if (claimErr) {
        log.error('start-notice claim failed', { code: claimErr.code, message: claimErr.message });
        return 0;
    }
    const claimedIds = new Set(((claimed || []) as Array<{ id: string }>).map((r) => r.id));
    const toPost = rows.filter((r) => claimedIds.has(r.id));
    if (toPost.length === 0) return 0;

    const results = await Promise.allSettled(toPost.map(async (op) => {
        // No org-wide fallback — see the channel note at the top of this file.
        const channelId = op.discord_announcement_channel_id
            ? String(op.discord_announcement_channel_id).trim() : '';
        if (!channelId) return false;
        const input = await buildAnnouncementEmbedInput(op.id);
        if (!input) return false;
        const post = await postOperationStartingEmbed(channelId, input);
        return !!post.messageId;
    }));

    let sent = 0;
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) sent++;
        else if (r.status === 'rejected') log.warn('start notice post threw', { err: r.reason });
    }
    // The claim is NOT rolled back on a failed post, deliberately. A notice that
    // failed to send is a missed message; a notice that un-claims itself is a
    // retry loop that pings the channel again every minute until the operation
    // starts. Quiet beats duplicated.
    return sent;
}
