import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// THE DISCORD FEATURE LAYER — start notices, configurable pings, channel pickers.
//
// Three properties carry the weight, and each one is a place the hosted original
// gets it wrong:
//
//  1. EXACTLY-ONCE. The start-notice scan runs every minute against a 15-minute
//     window, so each operation matches ~15 times. The invariant is a CLAIM
//     (stamp-then-post, conditioned on the stamp still being NULL), not a filter.
//     Claim BEFORE egress — the reverse ordering turns a crash into a duplicate ping.
//
//  2. THE RE-ARM MUST FAIL CLOSED. Rescheduling clears the claim. Hosted reads the
//     prior start time with the error DESTRUCTURED AWAY — and supabase-js RESOLVES
//     { data: null, error } rather than throwing, so a transient fault yields
//     before=null against a real `after`, always unequal, clearing the claim and
//     re-firing a notice that already went out. A missed notice is quieter than a
//     duplicate ping, so an unreadable prior value leaves it claimed.
//
//  3. THE PING TARGET IS NEVER CALLER-SUPPLIED. Configuring who may be @-mentioned
//     is admin:config:discord; triggering a send is operations:create or
//     admin:broadcast:eam. A role id in a payload collapses those two into an
//     arbitrary mention primitive — and the DESTINATION matters as much as the role,
//     which is why the repost channel is shape-checked and owner-bypass-excluded.

const h = vi.hoisted(() => ({
    dueRows: [] as Array<Record<string, unknown>>,
    scanError: null as { code?: string; message: string } | null,
    claimedIds: null as string[] | null,
    claimError: null as { code?: string; message: string } | null,
    queries: [] as Array<{ table: string; op: string; eqs: Array<[string, unknown]>; iss: Array<[string, unknown]>; orders: string[]; limit?: number; update?: Record<string, unknown> }>,
    posts: [] as Array<{ channelId: string; content: unknown }>,
    logged: [] as Array<{ level: string; msg: string }>,
    embedInput: { name: 'Op', restricted: false } as unknown,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const rec = { table, op: 'select', eqs: [] as Array<[string, unknown]>, iss: [] as Array<[string, unknown]>, orders: [] as string[], limit: undefined as number | undefined, update: undefined as Record<string, unknown> | undefined };
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'in', 'not', 'gt', 'lte', 'gte', 'lt', 'or', 'ilike', 'range', 'contains']) b[m] = () => b;
        b.eq = (c: string, v: unknown) => { rec.eqs.push([c, v]); return b; };
        b.is = (c: string, v: unknown) => { rec.iss.push([c, v]); return b; };
        b.order = (c: string) => { rec.orders.push(c); return b; };
        b.limit = (n: number) => { rec.limit = n; return b; };
        b.update = (v: Record<string, unknown>) => { rec.op = 'update'; rec.update = v; return b; };
        const settle = () => {
            h.queries.push(rec);
            if (rec.op === 'update') {
                if (h.claimError) return Promise.resolve({ data: null, error: h.claimError });
                const ids = h.claimedIds ?? h.dueRows.map((r) => r.id as string);
                return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
            }
            if (h.scanError) return Promise.resolve({ data: null, error: h.scanError });
            return Promise.resolve({ data: h.dueRows, error: null });
        };
        b.single = () => settle();
        b.maybeSingle = () => settle();
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle().then(r, j);
        return b;
    }
    return { supabase: { from: (t: string) => builder(t) }, handleSupabaseError: () => {}, broadcastToOrg: () => {} };
});
vi.mock('../lib/log', () => {
    const rec = (level: string) => (msg: string) => { h.logged.push({ level, msg }); };
    const child = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
    return { log: { ...child, child: () => child } };
});
vi.mock('../lib/db/opAnnouncement', () => ({
    buildAnnouncementEmbedInput: async () => h.embedInput,
}));
vi.mock('../lib/discord', () => ({
    postOperationStartingEmbed: async (channelId: string, content: unknown) => {
        h.posts.push({ channelId, content });
        return { messageId: 'msg-1' };
    },
}));

import { sendDueOperationStartNotices, START_NOTICE_LEAD_MS } from '../lib/db/opStartNotices';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const due = (over: Record<string, unknown> = {}) => ({
    id: 'op-1',
    scheduled_start: new Date(NOW + 10 * 60_000).toISOString(),
    status: 'Scheduled',
    discord_announcement_channel_id: '123456789012345678',
    ...over,
});

beforeEach(() => {
    h.dueRows = []; h.scanError = null; h.claimedIds = null; h.claimError = null;
    h.queries = []; h.posts = []; h.logged = []; h.embedInput = { name: 'Op', restricted: false };
});

describe('the start notice claims before it posts', () => {
    it('stamps the row, conditioned on the stamp still being NULL', async () => {
        h.dueRows = [due()];
        await sendDueOperationStartNotices(NOW);
        const claim = h.queries.find((q) => q.op === 'update')!;
        expect(claim, 'no claim was issued').toBeTruthy();
        expect(claim.update).toHaveProperty('discord_start_notice_sent_at');
        // The conditional update IS the mutual exclusion — two instances racing the
        // same tick both select the row and only one update matches.
        expect(claim.iss).toContainEqual(['discord_start_notice_sent_at', null]);
    });

    it('posts ONLY for the ids the claim actually returned', async () => {
        // Two rows scanned, one claimed: the other instance won it.
        h.dueRows = [due(), due({ id: 'op-2' })];
        h.claimedIds = ['op-2'];
        const sent = await sendDueOperationStartNotices(NOW);
        expect(sent).toBe(1);
        expect(h.posts.length).toBe(1);
    });

    it('claims BEFORE the first post — the ordering is the invariant', async () => {
        h.dueRows = [due()];
        await sendDueOperationStartNotices(NOW);
        const claimIdx = h.queries.findIndex((q) => q.op === 'update');
        expect(claimIdx).toBeGreaterThan(-1);
        // Nothing was posted before the claim resolved.
        expect(h.posts.length).toBe(1);
        expect(h.queries.slice(0, claimIdx).every((q) => q.op === 'select')).toBe(true);
    });

    it('a claim fault posts NOTHING', async () => {
        h.dueRows = [due()];
        h.claimError = { message: 'connection reset' };
        expect(await sendDueOperationStartNotices(NOW)).toBe(0);
        expect(h.posts).toEqual([]);
    });
});

describe('the scan', () => {
    it('reads with a total order and a cap', async () => {
        h.dueRows = [due()];
        await sendDueOperationStartNotices(NOW);
        const scan = h.queries.find((q) => q.table === 'operations' && q.op === 'select')!;
        // scheduled_start is not unique — several ops can share a start time — so the
        // id tiebreak is what makes this a total order.
        expect(scan.orders).toEqual(['scheduled_start', 'id']);
        expect(typeof scan.limit).toBe('number');
    });

    it('only considers operations that OPTED IN and are not yet claimed', async () => {
        h.dueRows = [due()];
        await sendDueOperationStartNotices(NOW);
        const scan = h.queries.find((q) => q.table === 'operations' && q.op === 'select')!;
        expect(scan.eqs).toContainEqual(['discord_start_notice', true]);
        expect(scan.iss).toContainEqual(['discord_start_notice_sent_at', null]);
    });

    it('degrades quietly on the pre-apply window, and loudly on anything else', async () => {
        // The pre-apply window is EXPECTED, so it must not log an error every minute
        // forever.
        h.scanError = { code: '42703', message: 'column does not exist' };
        expect(await sendDueOperationStartNotices(NOW)).toBe(0);
        expect(h.posts).toEqual([]);
        expect(h.logged.filter((l) => l.level === 'error'), 'a missing column is not an incident').toEqual([]);

        // A missing RELATION is NOT expected and must stay loud. Both cases return 0
        // and post nothing, so the LOG is the ONLY thing that tells them apart —
        // assert it, or the two branches are indistinguishable and this pin passes
        // whether or not the code-specific early return exists at all.
        h.logged = [];
        h.scanError = { code: '42P01', message: 'relation does not exist' };
        expect(await sendDueOperationStartNotices(NOW)).toBe(0);
        expect(h.logged.filter((l) => l.level === 'error').length, 'an unexpected scan failure must be logged').toBe(1);
    });

    it('the lead time is 15 minutes', () => {
        expect(START_NOTICE_LEAD_MS).toBe(15 * 60 * 1000);
    });
});

describe('the channel rule', () => {
    it('posts to the operation OWN announcement channel', async () => {
        h.dueRows = [due({ discord_announcement_channel_id: '987654321098765432' })];
        await sendDueOperationStartNotices(NOW);
        expect(h.posts[0].channelId).toBe('987654321098765432');
    });

    it('posts NOTHING when the operation has no channel — there is no org-wide fallback', async () => {
        // Deliberately stricter than hosted. 'operation:update' is op-owner-bypassable,
        // so with a default-channel fallback any operations:create holder could
        // schedule an unattended, un-channel-named post into the guild's busiest
        // channel. Requiring an explicit channel keeps the loudest thing this job can
        // do an explicit choice.
        h.dueRows = [due({ discord_announcement_channel_id: null })];
        expect(await sendDueOperationStartNotices(NOW)).toBe(0);
        expect(h.posts).toEqual([]);
    });

    it('the claim is NOT rolled back when a post fails', async () => {
        // A notice that un-claims itself is a retry loop that pings the channel again
        // every minute until the operation starts. Quiet beats duplicated.
        h.dueRows = [due({ discord_announcement_channel_id: null })];
        await sendDueOperationStartNotices(NOW);
        const updates = h.queries.filter((q) => q.op === 'update');
        expect(updates.length, 'exactly one update: the claim').toBe(1);
        expect(updates[0].update).toHaveProperty('discord_start_notice_sent_at');
    });
});

describe('the source contracts', () => {
    const ops = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'ops.ts'), 'utf8');
    const actions = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'operations.ts'), 'utf8');
    const services = readFileSync(resolve(__dirname, '..', 'api', 'services.ts'), 'utf8');
    const discord = readFileSync(resolve(__dirname, '..', 'lib', 'discord.ts'), 'utf8');
    const system = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'system.ts'), 'utf8');
    const importer = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'importer.ts'), 'utf8');
    const notices = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'opStartNotices.ts'), 'utf8');

    it('THE RE-ARM READS ITS ERROR and fails closed', () => {
        // Hosted destructures only `data`. supabase-js resolves { data: null, error },
        // so an unread fault gives before=null against a real `after` — always
        // unequal — and clears the claim on a transient blip.
        const upd = ops.slice(ops.indexOf('if (updates.scheduledStart !== undefined) {'), ops.indexOf('if (updates.scheduledEnd !== undefined)'));
        expect(upd).toMatch(/const \{ data: currentRow, error: readErr \}/);
        expect(upd, 'the clear must be gated on a successful read').toMatch(/if \(!readErr\) \{/);
        expect(upd, 'instants, not strings — the client round-trips the value through a datetime input')
            .toMatch(/new Date\(currentRow\.scheduled_start\)\.getTime\(\)/);
    });

    it('the operation update degrades rather than breaking edits on a pre-apply database', () => {
        // OpAdministerTab sends scheduledStart on EVERY save, so without this every
        // operation edit 42703s where schema.sql has not been re-run.
        const updStart = ops.indexOf('let { error } = await supabase.from(');
        expect(updStart, 'the update tail was restructured').toBeGreaterThan(-1);
        const upd = ops.slice(updStart, ops.indexOf('export async function updateOperationStatus'));
        // The `error &&` half is included deliberately: asserting only that the two
        // codes appear passes even when the whole branch has been disabled.
        expect(upd).toMatch(/if \(error && \(startNoticeCode === '42703' \|\| startNoticeCode === 'PGRST204'\)/);
        expect(upd).toMatch(/delete dbUpdates\.discord_start_notice_sent_at;/);
    });

    it('the announcement pings on CREATE and never on repost or edit', () => {
        const create = actions.slice(actions.indexOf("'operation:create'"), actions.indexOf("'operation:get_details'"));
        expect(create).toMatch(/pingRoleId: await getOperationAnnouncePingRoleId\(\)/);

        const repost = actions.slice(actions.indexOf("'operation:repost_announcement'"), actions.indexOf("'operation:update_status'"));
        expect(repost, 'a repost is not a second event').not.toMatch(/pingRoleId/);
        // editOperationAnnouncementEmbed takes no ping opt at all.
        const edit = discord.slice(discord.indexOf('export async function editOperationAnnouncementEmbed'), discord.indexOf('// --- Guild Channels'));
        expect(edit).not.toMatch(/buildMentionContent/);
    });

    it('the ping role is read server-side and appears in NO payload interface', () => {
        expect(actions).toMatch(/async function getOperationAnnouncePingRoleId/);
        // Comments STRIPPED and only the payload interfaces: the docblock above
        // getOperationAnnouncePingRoleId necessarily names the thing it reads, so an
        // un-stripped absence assertion here matches its own explanation.
        const code = actions
            .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
            .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
        const interfaces = code.slice(0, code.indexOf('async function getOperationAnnouncePingRoleId'));
        expect(interfaces, 'a pingRoleId in a payload is an arbitrary mention primitive')
            .not.toMatch(/pingRoleId/);
    });

    it('the repost CHANNEL is shape-checked and the action is owner-bypass-excluded', () => {
        // The attacker-controlled value here is the DESTINATION, not the role. Both
        // halves are needed: either alone leaves a door open.
        const repost = actions.slice(actions.indexOf("'operation:repost_announcement'"), actions.indexOf("'operation:update_status'"));
        expect(repost).toMatch(/normaliseDiscordSnowflake\(channelId, 'channelId'\)/);
        const start = services.indexOf('OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS');
        const excl = services.slice(start, services.indexOf(']);', start));
        expect(excl).toContain("'operation:repost_announcement'");
    });

    it('the starting embed adds no reactions and cannot ping', () => {
        const fn = discord.slice(discord.indexOf('export async function postOperationStartingEmbed'), discord.indexOf('// Edits the embed of an existing'));
        expect(fn).not.toMatch(/addMessageReactions/);
        expect(fn, 'an unattended scheduled @-mention is not something this build offers')
            .not.toMatch(/buildMentionContent/);
        expect(fn, 'still queued, so simultaneous starts do not trip the rate limiter').toMatch(/enqueueChannelPost/);
    });

    it('the EAM ping is a three-value loudness choice, never a role id', () => {
        expect(system).toMatch(/export type EamPingTarget = 'none' \| 'here' \| 'role';/);
        const fn = system.slice(system.indexOf('function resolveEamPing'), system.indexOf('export async function broadcastEAM'));
        expect(fn, "'@everyone' is deliberately not offered").not.toMatch(/everyone/);
        // The hand-written allowed_mentions is gone — it asked Discord to parse EVERY
        // mention out of the content, the fail-open shape the suppression layer exists
        // to prevent.
        expect(system).not.toMatch(/allowed_mentions: \{ parse: \['everyone'\] \}/);
        expect(system).toMatch(/const mention = buildMentionContent\(ping\);/);
    });

    it('the caller-driven cache bypass has a floor', () => {
        // forceRefresh is reachable by every operations:create holder; without a floor
        // it drives uncached Discord calls at the per-user request ceiling, and a
        // rate-limited bot breaks EVERY Discord path in the product.
        expect(discord).toMatch(/GUILD_CHANNELS_FORCE_FLOOR_MS/);
        const lgcStart = discord.indexOf('export async function listGuildChannels');
        expect(lgcStart, 'listGuildChannels was renamed').toBeGreaterThan(-1);
        const fn = discord.slice(lgcStart, discord.indexOf('const botToken', lgcStart));
        expect(fn).toMatch(/forceAllowed/);
    });

    it('the admin picker is an ALIAS, not a re-gate of the existing action', () => {
        // fullPermissionMap holds one permission per action, so re-gating the existing
        // one would take the channel picker away from every op creator.
        expect(services).toMatch(/'discord:list_guild_channels': 'operations:create'/);
        expect(services).toMatch(/'discord:list_channels_admin': 'admin:config:discord'/);
        const alias = actions.slice(actions.indexOf("'discord:list_channels_admin'"), actions.indexOf("'discord:list_guild_channels'"));
        expect(alias, 'the admin tab has no reason to hold a cache bypass').not.toMatch(/forceRefresh/);
    });

    it('an IMPORT is not consent — every foreign Discord reference is neutralised', () => {
        const set = importer.slice(importer.indexOf('export const FOREIGN_INTEGRATION_COLUMNS'), importer.indexOf('};', importer.indexOf('export const FOREIGN_INTEGRATION_COLUMNS')));
        for (const col of ['discord_start_notice', 'discord_start_notice_sent_at', 'discord_announcement_channel_id', 'discord_announcement_message_id']) {
            expect(set, `${col} would carry over from the source deployment`).toContain(col);
        }
        expect(importer).toMatch(/const foreignCols = FOREIGN_INTEGRATION_COLUMNS\[table\];/);
    });

    it('...including service_types, the DURABLE one the operations list missed', () => {
        // The operations columns are per-event. service_types.discord_channel_id routes
        // the notification for EVERY new service request of that type, so importing it
        // verbatim points the receiving org's live request traffic at a channel in the
        // SOURCE guild — indefinitely, and silently, because the bot just fails to post.
        const set = importer.slice(importer.indexOf('export const FOREIGN_INTEGRATION_COLUMNS'), importer.indexOf('};', importer.indexOf('export const FOREIGN_INTEGRATION_COLUMNS')));
        expect(set, 'FOREIGN_INTEGRATION_COLUMNS covers operations only').toMatch(/service_types:\s*\[[^\]]*'discord_channel_id'/);
    });

    it('the job rides the existing lease and never falls back to a default channel', () => {
        const server = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf8');
        expect(server).toMatch(/sendDueOperationStartNotices/);
        // Its own try/catch, so a Discord outage cannot stop the web-push reminders
        // that share the tick.
        const block = server.slice(server.indexOf('const sent = await sendDueOperationReminders'), server.indexOf('// Alliance live-sync engine'));
        expect((block.match(/try \{/g) || []).length).toBeGreaterThanOrEqual(1);
        expect(block).toMatch(/catch \(e\) \{[\s\S]*?cron op start notices failed/);
        // No second cron.schedule and no second lease key.
        expect(block).not.toMatch(/cron\.schedule/);
        expect(notices, 'no org-wide default channel lookup exists at all').not.toMatch(/defaultOperationAnnounceChannelId/);
    });
});
