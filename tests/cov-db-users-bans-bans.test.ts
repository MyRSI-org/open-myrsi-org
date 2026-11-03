import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/bans.ts — behaviour coverage for the org-ban data layer.
//
// tests/orgBanEnforcement.test.ts pins the fail-closed enforcement contract and the
// dispatcher's gate shape. This suite drives every remaining function end to end
// against a recording Supabase double and asserts the observable behaviour: the
// exact query shape (explicit columns — discord_id never on a list/detail read —
// filters, CAS predicates, total order + cap), the exact write payloads, the
// write-time sanitisation of operator / member free text, the insert-first
// supersede ordering (a ban write must never silently UN-ban), the SecurityDenial
// audit slugs, and the break-glass that lifts bans held by system Admins.

vi.mock('../lib/db/common', async () => (await import('./cov-db-users-bans-fake')).commonMock);

import {
    findActiveBan, createBan, liftBan, listBans, getBanById, getBanNotice, createBanAppeal,
    reviewBanAppeal, listBanAppeals, loadBanTarget, getBanPermissionHolderIds,
    filterActivelyBanned, liftBansOnSystemAdmins, dropPushSubscriptions, BanCheckUnavailable,
} from '../lib/db/bans';
import { SecurityDenial } from '../lib/errors';
import { sb, resetSb, queue, on, chainOf, argsOf, has, assertNoWildcardSelect, type SbQuery } from './cov-db-users-bans-fake';

const BAN_COLS = 'id, user_id, reason, expires_at, banned_at, banned_by, lifted_at, lifted_by, lift_reason';
const APPEAL_COLS = 'id, ban_id, statement, status, reviewed_by, reviewed_at, review_note, created_at';
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const banRow = (over: Record<string, unknown> = {}) => ({
    id: 11, user_id: 5, reason: 'Griefing', expires_at: null, banned_at: '2026-05-01T00:00:00Z',
    banned_by: 1, lifted_at: null, lifted_by: null, lift_reason: null, ...over,
});
const appealRow = (over: Record<string, unknown> = {}) => ({
    id: 3, ban_id: 11, statement: 'Sorry', status: 'pending', reviewed_by: null, reviewed_at: null,
    review_note: null, created_at: '2026-05-02T00:00:00Z', ...over,
});

beforeEach(() => {
    resetSb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    // Rule 1 holds on every path this suite drove.
    assertNoWildcardSelect();
});

describe('findActiveBan — identity handling and query shape', () => {
    it('user id only: eq(user_id) on the un-lifted partial index, ordered + capped at 2', async () => {
        queue('organization_bans', { data: [{ id: 1, reason: 'r', expires_at: null, banned_at: 'b' }] });
        expect(await findActiveBan({ userId: 5 })).toEqual({ id: 1, reason: 'r', expiresAt: null, bannedAt: 'b' });
        expect(chainOf(on('organization_bans')[0])).toEqual([
            ['select', 'id, reason, expires_at, banned_at'],
            ['is', 'lifted_at', null],
            ['eq', 'user_id', 5],
            ['order', 'banned_at', { ascending: false }],
            ['order', 'id', { ascending: false }],
            ['limit', 2],
        ]);
    });

    it('discord id only: eq(discord_id)', async () => {
        queue('organization_bans', { data: [] });
        expect(await findActiveBan({ discordId: '123456789' })).toBeNull();
        expect(argsOf(on('organization_bans')[0], 'eq')).toEqual(['discord_id', '123456789']);
        expect(has(on('organization_bans')[0], 'or')).toBe(false);
    });

    it('both identities: ONE .or() over the two validated ids', async () => {
        queue('organization_bans', { data: [] });
        await findActiveBan({ userId: 5, discordId: '123456789' });
        expect(argsOf(on('organization_bans')[0], 'or')).toEqual(['user_id.eq.5,discord_id.eq.123456789']);
        expect(has(on('organization_bans')[0], 'eq')).toBe(false);
    });

    it.each([
        ['a numeric string', '5'],
        ['zero', 0],
        ['a negative id', -3],
        ['a fraction', 1.5],
        ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
    ])('a non-positive-safe-integer user id (%s) is treated as absent', async (_label, userId) => {
        expect(await findActiveBan({ userId: userId as number })).toBeNull();
        expect(sb.queries).toEqual([]);
    });

    it('returns the first ACTIVE row, skipping an expired one returned ahead of it', async () => {
        queue('organization_bans', {
            data: [
                { id: 1, reason: 'old', expires_at: '2026-05-31T00:00:00Z', banned_at: 'b1' },
                { id: 2, reason: 'live', expires_at: '2026-07-01T00:00:00Z', banned_at: 'b2' },
            ],
        });
        expect(await findActiveBan({ userId: 5 })).toEqual({ id: 2, reason: 'live', expiresAt: '2026-07-01T00:00:00Z', bannedAt: 'b2' });
    });

    it('a ban expiring exactly NOW is no longer active (strictly-greater comparison)', async () => {
        queue('organization_bans', { data: [{ id: 1, reason: 'r', expires_at: new Date(NOW).toISOString(), banned_at: 'b' }] });
        expect(await findActiveBan({ userId: 5 })).toBeNull();
    });

    it('a null data payload reads as "no ban", not a crash', async () => {
        queue('organization_bans', { data: null });
        expect(await findActiveBan({ userId: 5 })).toBeNull();
    });

    it('BanCheckUnavailable carries a retryable message and survives instanceof', async () => {
        queue('organization_bans', { error: { message: 'boom' } });
        const err = await findActiveBan({ userId: 5 }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BanCheckUnavailable);
        expect((err as Error).name).toBe('BanCheckUnavailable');
        expect((err as Error).message).toBe('Unable to verify account status. Please try again.');
    });
});

describe('createBan — validation, sanitisation, insert-first supersede', () => {
    it('inserts a sanitised permanent ban and returns the mapped row (no appeal)', async () => {
        queue('organization_bans', { data: banRow({ reason: 'Griefing the depot' }) });
        const out = await createBan({ userId: 5, discordId: '123456789', reason: '  <b>Griefing</b> the depot  ' }, 1);
        const q = on('organization_bans')[0];
        expect(q.op).toBe('insert');
        expect(argsOf(q, 'insert')).toEqual([{
            user_id: 5, discord_id: '123456789', reason: 'Griefing the depot', expires_at: null, banned_by: 1,
        }]);
        expect(argsOf(q, 'select')).toEqual([BAN_COLS]);
        expect(q.terminal).toBe('single');
        expect(out).toEqual({
            id: 11, userId: 5, reason: 'Griefing the depot', expiresAt: null, bannedAt: '2026-05-01T00:00:00Z',
            bannedById: 1, liftedAt: null, liftedById: null, liftReason: null, appeal: null,
        });
    });

    it('accepts a numeric-string user id and a malformed discord id is dropped, not stored', async () => {
        queue('organization_bans', { data: banRow() });
        await createBan({ userId: '5' as unknown as number, discordId: 'abc', reason: 'x' }, 1);
        const row = argsOf(on('organization_bans')[0], 'insert')![0] as Record<string, unknown>;
        expect(row.user_id).toBe(5);
        expect(row.discord_id).toBeNull();
    });

    it('a Discord-only ban (soft-deleted member) is allowed', async () => {
        queue('organization_bans', { data: banRow({ user_id: null }) });
        const out = await createBan({ discordId: '123456789', reason: 'evasion' }, 1);
        expect((argsOf(on('organization_bans')[0], 'insert')![0] as Record<string, unknown>).user_id).toBeNull();
        expect(out.userId).toBeNull();
    });

    it('refuses a ban with no identity at all — before any write', async () => {
        await expect(createBan({ reason: 'x' }, 1)).rejects.toThrow('A ban needs a member or a linked Discord account to act on.');
        await expect(createBan({ userId: null, discordId: '12', reason: 'x' }, 1)).rejects.toThrow(/needs a member/);
        expect(sb.queries).toEqual([]);
    });

    it('rejects a garbage user id via requireIntId', async () => {
        await expect(createBan({ userId: 'abc' as unknown as number, reason: 'x' }, 1)).rejects.toThrow('Invalid userId: not an integer');
        expect(sb.queries).toEqual([]);
    });

    it('a reason that strips to nothing is required; an over-long one is refused, not truncated', async () => {
        await expect(createBan({ userId: 5, reason: '<i></i>   ' }, 1)).rejects.toThrow('Ban reason is required.');
        await expect(createBan({ userId: 5, reason: 42 }, 1)).rejects.toThrow('Ban reason is required.');
        await expect(createBan({ userId: 5, reason: 'x'.repeat(1001) }, 1)).rejects.toThrow('Ban reason must be 1000 characters or fewer.');
        expect(sb.queries).toEqual([]);
    });

    it('a reason of exactly the cap is accepted, and newlines are collapsed (single-line field)', async () => {
        queue('organization_bans', { data: banRow() }, { data: banRow() });
        await createBan({ userId: 5, reason: 'y'.repeat(1000) }, 1);
        await createBan({ userId: 5, reason: 'line one\nline two' }, 1);
        const rows = on('organization_bans').map((q) => (argsOf(q, 'insert')![0] as Record<string, unknown>).reason);
        expect(rows).toEqual(['y'.repeat(1000), 'line one line two']);
    });

    it('expiry: future instant → canonical ISO; epoch-ms number accepted; empty string → permanent', async () => {
        queue('organization_bans', { data: banRow() }, { data: banRow() }, { data: banRow() });
        await createBan({ userId: 5, reason: 'r', expiresAt: '2026-06-02T00:00:00+00:00' }, 1);
        await createBan({ userId: 5, reason: 'r', expiresAt: NOW + 60_000 }, 1);
        await createBan({ userId: 5, reason: 'r', expiresAt: '' }, 1);
        const exp = on('organization_bans').map((q) => (argsOf(q, 'insert')![0] as Record<string, unknown>).expires_at);
        expect(exp).toEqual(['2026-06-02T00:00:00.000Z', new Date(NOW + 60_000).toISOString(), null]);
    });

    it('expiry: an unparseable date and a past/now instant are refused before any write', async () => {
        await expect(createBan({ userId: 5, reason: 'r', expiresAt: 'next tuesday-ish' }, 1)).rejects.toThrow('Ban expiry is not a valid date.');
        await expect(createBan({ userId: 5, reason: 'r', expiresAt: NOW }, 1)).rejects.toThrow('A temporary ban must expire in the future.');
        await expect(createBan({ userId: 5, reason: 'r', expiresAt: '2020-01-01' }, 1)).rejects.toThrow(/must expire in the future/);
        expect(sb.queries).toEqual([]);
    });

    it('on a 23505 collision: supersedes BOTH identities, then retries the SAME row', async () => {
        queue('organization_bans',
            { error: { code: '23505', message: 'dup' } },
            { data: null, error: null },   // supersede by user_id
            { data: null, error: null },   // supersede by discord_id
            { data: banRow({ id: 12 }) },  // retried insert
        );
        const out = await createBan({ userId: 5, discordId: '123456789', reason: 'again' }, 7);
        const qs = on('organization_bans');
        expect(qs.map((q) => q.op)).toEqual(['insert', 'update', 'update', 'insert']);
        const stamp = { lifted_at: new Date(NOW).toISOString(), lifted_by: 7, lift_reason: 'Superseded by a new ban' };
        expect(chainOf(qs[1])).toEqual([['update', stamp], ['eq', 'user_id', 5], ['is', 'lifted_at', null]]);
        expect(chainOf(qs[2])).toEqual([['update', stamp], ['eq', 'discord_id', '123456789'], ['is', 'lifted_at', null]]);
        expect(argsOf(qs[3], 'insert')).toEqual(argsOf(qs[0], 'insert'));
        expect(out.id).toBe(12);
    });

    it('supersede only touches the identity the ban actually carries', async () => {
        queue('organization_bans', { error: { code: '23505', message: 'dup' } }, {}, { data: banRow() });
        await createBan({ userId: 5, reason: 'again' }, 7);
        const updates = on('organization_bans').filter((q) => q.op === 'update');
        expect(updates).toHaveLength(1);
        expect(argsOf(updates[0], 'eq')).toEqual(['user_id', 5]);
    });

    it('supersede by discord id only when the ban has no user id', async () => {
        queue('organization_bans', { error: { code: '23505', message: 'dup' } }, {}, { data: banRow({ user_id: null }) });
        await createBan({ discordId: '123456789', reason: 'again' }, 7);
        const updates = on('organization_bans').filter((q) => q.op === 'update');
        expect(updates).toHaveLength(1);
        expect(argsOf(updates[0], 'eq')).toEqual(['discord_id', '123456789']);
    });

    it('a supersede failure throws BEFORE the retry — the existing ban stands', async () => {
        queue('organization_bans', { error: { code: '23505', message: 'dup' } }, { error: { message: 'nope' } });
        await expect(createBan({ userId: 5, reason: 'r' }, 7)).rejects.toThrow('Failed to supersede existing ban');
        expect(on('organization_bans').map((q) => q.op)).toEqual(['insert', 'update']);
    });

    it('a discord-arm supersede failure also throws before the retry', async () => {
        queue('organization_bans', { error: { code: '23505', message: 'dup' } }, {}, { error: { message: 'nope' } });
        await expect(createBan({ userId: 5, discordId: '123456789', reason: 'r' }, 7)).rejects.toThrow('Failed to supersede existing ban');
        expect(on('organization_bans').map((q) => q.op)).toEqual(['insert', 'update', 'update']);
    });

    it('a failing retry after the supersede surfaces as "Failed to place ban"', async () => {
        queue('organization_bans', { error: { code: '23505', message: 'dup' } }, {}, { error: { code: '23505', message: 'dup again' } });
        await expect(createBan({ userId: 5, reason: 'r' }, 7)).rejects.toThrow('Failed to place ban');
    });

    it('a non-collision insert fault does NOT supersede anything (the old ban stands)', async () => {
        queue('organization_bans', { error: { code: '23503', message: 'fk' } });
        await expect(createBan({ userId: 5, reason: 'r' }, 7)).rejects.toThrow('Failed to place ban');
        expect(on('organization_bans').map((q) => q.op)).toEqual(['insert']);
    });
});

describe('liftBan — CAS on lifted_at IS NULL', () => {
    it('stamps the lift with a sanitised reason and returns the mapped row', async () => {
        queue('organization_bans', { data: banRow({ lifted_at: 'L', lifted_by: 2, lift_reason: 'Appeal accepted' }) });
        const out = await liftBan('11', 2, ' <em>Appeal</em> accepted ');
        expect(chainOf(on('organization_bans')[0])).toEqual([
            ['update', { lifted_at: new Date(NOW).toISOString(), lifted_by: 2, lift_reason: 'Appeal accepted' }],
            ['eq', 'id', 11],
            ['is', 'lifted_at', null],
            ['select', BAN_COLS],
            ['maybeSingle'],
        ]);
        expect(out).toMatchObject({ id: 11, liftedAt: 'L', liftedById: 2, liftReason: 'Appeal accepted' });
    });

    it.each([[undefined], [null], [''], ['<br>']])('an absent / markup-only lift reason (%s) stores null', async (reason) => {
        queue('organization_bans', { data: banRow() });
        await liftBan(11, 2, reason);
        expect((argsOf(on('organization_bans')[0], 'update')![0] as Record<string, unknown>).lift_reason).toBeNull();
    });

    it('an over-long lift reason is refused before any write', async () => {
        await expect(liftBan(11, 2, 'z'.repeat(1001))).rejects.toThrow('Lift reason must be 1000 characters or fewer.');
        // The builder is opened, but the payload throws before .update() is invoked.
        expect(sb.queries.flatMap((q) => q.calls)).toEqual([]);
        expect(sb.queries.every((q) => q.terminal === null)).toBe(true);
    });

    it('an already-lifted / unknown id is a SecurityDenial with the resource audit slug', async () => {
        queue('organization_bans', { data: null });
        const err = await liftBan(99, 2).catch((e: unknown) => e) as SecurityDenial;
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('That ban is not active.');
        expect(err.auditEvent).toBe('authz.resource.denied');
        expect(err.fields).toEqual({ banId: 99 });
    });

    it('a write fault is an opaque "Failed to lift ban"', async () => {
        queue('organization_bans', { error: { message: 'boom' } });
        await expect(liftBan(11, 2)).rejects.toThrow('Failed to lift ban');
    });

    it('a non-integer ban id is rejected before any query', async () => {
        await expect(liftBan('1;drop', 2)).rejects.toThrow('Invalid banId: not an integer');
        expect(sb.queries).toEqual([]);
    });
});

describe('listBans — staff console read', () => {
    it('default: active only, embedded appeal, total order, cap 100', async () => {
        queue('organization_bans', { data: [banRow({ appeal: [appealRow()] }), banRow({ id: 10, appeal: appealRow({ id: 4, ban_id: 10 }) }), banRow({ id: 9, appeal: null })] });
        const out = await listBans();
        expect(chainOf(on('organization_bans')[0])).toEqual([
            ['select', `${BAN_COLS}, appeal:organization_ban_appeals(${APPEAL_COLS})`],
            ['is', 'lifted_at', null],
            ['order', 'banned_at', { ascending: false }],
            ['order', 'id', { ascending: false }],
            ['limit', 100],
        ]);
        // Array embed, object embed and null embed all map field-by-field.
        expect(out.map((b) => b.appeal?.id ?? null)).toEqual([3, 4, null]);
        expect(out[0].appeal).toEqual({
            id: 3, banId: 11, statement: 'Sorry', status: 'pending', reviewedById: null, reviewedAt: null,
            reviewNote: null, createdAt: '2026-05-02T00:00:00Z',
        });
        // discord_id is never on the console read.
        expect(JSON.stringify(argsOf(on('organization_bans')[0], 'select'))).not.toContain('discord_id');
    });

    it('an empty embedded array maps to appeal: null', async () => {
        queue('organization_bans', { data: [banRow({ appeal: [] })] });
        expect((await listBans())[0].appeal).toBeNull();
    });

    it('includeLifted drops the lifted_at filter', async () => {
        queue('organization_bans', { data: [] });
        await listBans({ includeLifted: true });
        expect(has(on('organization_bans')[0], 'is')).toBe(false);
    });

    it.each([[0, 100], [5, 5], [-4, 1], [10_000, 200], [Number.NaN, 100]])('limit %s clamps to %s', async (limit, cap) => {
        queue('organization_bans', { data: null });
        expect(await listBans({ limit })).toEqual([]);
        expect(argsOf(on('organization_bans')[0], 'limit')).toEqual([cap]);
    });

    it('a read fault throws "Failed to load bans"', async () => {
        queue('organization_bans', { error: { message: 'x' } });
        await expect(listBans()).rejects.toThrow('Failed to load bans');
    });
});

describe('getBanById / loadBanTarget', () => {
    it('getBanById maps id + user id off a narrow select', async () => {
        queue('organization_bans', { data: { id: 11, user_id: 5 } });
        expect(await getBanById(11)).toEqual({ id: 11, userId: 5 });
        expect(chainOf(on('organization_bans')[0])).toEqual([['select', 'id, user_id'], ['eq', 'id', 11], ['maybeSingle']]);
    });

    it('getBanById: absent → null; fault → throws', async () => {
        queue('organization_bans', { data: null }, { error: { message: 'x' } });
        expect(await getBanById(11)).toBeNull();
        await expect(getBanById(11)).rejects.toThrow('Failed to load ban');
    });

    it('loadBanTarget reads discord_id off the users row (never from the request), soft-deleted included', async () => {
        queue('users', { data: { id: 5, discord_id: '123456789' } });
        expect(await loadBanTarget('5')).toEqual({ id: 5, discordId: '123456789' });
        expect(chainOf(on('users')[0])).toEqual([['select', 'id, discord_id'], ['eq', 'id', 5], ['maybeSingle']]);
    });

    it('loadBanTarget normalises an unlinked member to discordId: null', async () => {
        queue('users', { data: { id: 5, discord_id: undefined } });
        expect(await loadBanTarget(5)).toEqual({ id: 5, discordId: null });
    });

    it('loadBanTarget: unknown member → SecurityDenial(authz.invalid_target); fault → opaque error; bad id → throws', async () => {
        queue('users', { data: null }, { error: { message: 'x' } });
        const err = await loadBanTarget(404).catch((e: unknown) => e) as SecurityDenial;
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('That member could not be found.');
        expect(err.auditEvent).toBe('authz.invalid_target');
        expect(err.fields).toEqual({ targetUserId: 404 });
        await expect(loadBanTarget(5)).rejects.toThrow('Failed to load member');
        await expect(loadBanTarget(-1)).rejects.toThrow('Invalid targetUserId');
    });
});

describe('getBanNotice — self-scoped banned screen', () => {
    it('null when there is no active ban (and no appeal read)', async () => {
        queue('organization_bans', { data: [] });
        expect(await getBanNotice(5, null)).toBeNull();
        expect(on('organization_ban_appeals')).toHaveLength(0);
    });

    it('active ban with no appeal yet → canAppeal true', async () => {
        queue('organization_bans', { data: [{ id: 11, reason: 'Griefing', expires_at: '2026-07-01T00:00:00Z', banned_at: 'B' }] });
        queue('organization_ban_appeals', { data: null });
        expect(await getBanNotice(5, '123456789')).toEqual({
            banId: 11, reason: 'Griefing', expiresAt: '2026-07-01T00:00:00Z', bannedAt: 'B', appealStatus: null, canAppeal: true,
        });
        expect(argsOf(on('organization_bans')[0], 'or')).toEqual(['user_id.eq.5,discord_id.eq.123456789']);
        expect(chainOf(on('organization_ban_appeals')[0])).toEqual([['select', 'status'], ['eq', 'ban_id', 11], ['maybeSingle']]);
    });

    it('an existing appeal → its status, and canAppeal false', async () => {
        queue('organization_bans', { data: [{ id: 11, reason: 'r', expires_at: null, banned_at: 'B' }] });
        queue('organization_ban_appeals', { data: { status: 'rejected' } });
        expect(await getBanNotice(5)).toMatchObject({ appealStatus: 'rejected', canAppeal: false });
    });

    it('an appeal-status read fault throws rather than offering a second appeal', async () => {
        queue('organization_bans', { data: [{ id: 11, reason: 'r', expires_at: null, banned_at: 'B' }] });
        queue('organization_ban_appeals', { error: { message: 'x' } });
        await expect(getBanNotice(5)).rejects.toThrow('Failed to load appeal status');
    });
});

describe('createBanAppeal — the one write a banned member may perform', () => {
    it('inserts a pending appeal with a multi-line sanitised statement', async () => {
        queue('organization_ban_appeals', { data: appealRow({ statement: 'Line 1\nLine 2' }) });
        const out = await createBanAppeal(11, '  <script>x</script>Line 1\nLine 2  ');
        const q = on('organization_ban_appeals')[0];
        expect(chainOf(q)).toEqual([
            ['insert', { ban_id: 11, statement: 'xLine 1\nLine 2', status: 'pending' }],
            ['select', APPEAL_COLS],
            ['single'],
        ]);
        expect(out.statement).toBe('Line 1\nLine 2');
        expect(out.status).toBe('pending');
    });

    it('a duplicate appeal (23505) is a clean message, not a 500', async () => {
        queue('organization_ban_appeals', { error: { code: '23505', message: 'dup' } });
        await expect(createBanAppeal(11, 'please')).rejects.toThrow('You have already appealed this ban.');
    });

    it('any other fault is opaque; an empty / over-long statement never reaches the DB', async () => {
        queue('organization_ban_appeals', { error: { code: '500', message: 'x' } });
        await expect(createBanAppeal(11, 'please')).rejects.toThrow('Failed to submit appeal');
        await expect(createBanAppeal(11, '   ')).rejects.toThrow('Appeal statement is required.');
        await expect(createBanAppeal(11, 's'.repeat(4001))).rejects.toThrow('Appeal statement must be 4000 characters or fewer.');
        expect(on('organization_ban_appeals')).toHaveLength(1);
    });
});

describe('reviewBanAppeal — CAS on the pending state', () => {
    it('resolves a pending appeal with reviewer + sanitised note', async () => {
        queue('organization_ban_appeals', { data: appealRow({ status: 'accepted', reviewed_by: 2, reviewed_at: 'T', review_note: 'ok' }) });
        const out = await reviewBanAppeal('3', 'accepted', 2, '<b>ok</b>');
        expect(chainOf(on('organization_ban_appeals')[0])).toEqual([
            ['update', { status: 'accepted', reviewed_by: 2, reviewed_at: new Date(NOW).toISOString(), review_note: 'ok' }],
            ['eq', 'id', 3],
            ['eq', 'status', 'pending'],
            ['select', APPEAL_COLS],
            ['maybeSingle'],
        ]);
        expect(out).toMatchObject({ id: 3, status: 'accepted', reviewedById: 2, reviewNote: 'ok' });
    });

    it('an already-resolved appeal is a SecurityDenial (no double resolution)', async () => {
        queue('organization_ban_appeals', { data: null });
        const err = await reviewBanAppeal(3, 'rejected', 2).catch((e: unknown) => e) as SecurityDenial;
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('That appeal is not pending.');
        expect(err.auditEvent).toBe('authz.resource.denied');
        expect(err.fields).toEqual({ appealId: 3 });
        expect((argsOf(on('organization_ban_appeals')[0], 'update')![0] as Record<string, unknown>).review_note).toBeNull();
    });

    it('a fault is opaque; a bad id never queries', async () => {
        queue('organization_ban_appeals', { error: { message: 'x' } });
        await expect(reviewBanAppeal(3, 'accepted', 2)).rejects.toThrow('Failed to review appeal');
        await expect(reviewBanAppeal('x', 'accepted', 2)).rejects.toThrow('Invalid appealId');
        expect(on('organization_ban_appeals')).toHaveLength(1);
    });
});

describe('listBanAppeals — admin queue', () => {
    it('status filter + total order + clamped cap, mapped field-by-field', async () => {
        queue('organization_ban_appeals', { data: [appealRow()] });
        const out = await listBanAppeals({ status: 'pending', limit: 999 });
        expect(chainOf(on('organization_ban_appeals')[0])).toEqual([
            ['select', APPEAL_COLS],
            ['eq', 'status', 'pending'],
            ['order', 'created_at', { ascending: false }],
            ['order', 'id', { ascending: false }],
            ['limit', 200],
        ]);
        expect(out).toEqual([{
            id: 3, banId: 11, statement: 'Sorry', status: 'pending', reviewedById: null, reviewedAt: null,
            reviewNote: null, createdAt: '2026-05-02T00:00:00Z',
        }]);
    });

    it('no status → no status filter, default cap 100; null data → []; fault → throws', async () => {
        queue('organization_ban_appeals', { data: null }, { error: { message: 'x' } });
        expect(await listBanAppeals()).toEqual([]);
        expect(has(on('organization_ban_appeals')[0], 'eq')).toBe(false);
        expect(argsOf(on('organization_ban_appeals')[0], 'limit')).toEqual([100]);
        await expect(listBanAppeals()).rejects.toThrow('Failed to load appeals');
    });
});

describe('getBanPermissionHolderIds — query shapes', () => {
    it('asks for the named permission, its roles, then live users of those roles', async () => {
        sb.systemRoles = { admin: { id: 9, name: 'Admin' } };
        queue('permissions', { data: [{ id: 4 }, { id: 5 }] });
        queue('role_permissions', { data: [{ role_id: 3 }] });
        queue('users', { data: [{ id: 42 }, { id: 43 }] });
        expect(await getBanPermissionHolderIds('admin:custom')).toEqual([42, 43]);
        expect(chainOf(on('permissions')[0])).toEqual([
            ['select', 'id'], ['eq', 'name', 'admin:custom'], ['order', 'id', { ascending: true }], ['limit', 50],
        ]);
        expect(chainOf(on('role_permissions')[0])).toEqual([
            ['select', 'role_id'], ['in', 'permission_id', [4, 5]], ['order', 'role_id', { ascending: true }], ['limit', 2000],
        ]);
        expect(chainOf(on('users')[0])).toEqual([
            ['select', 'id'], ['in', 'role_id', [3, 9]], ['is', 'deleted_at', null], ['order', 'id', { ascending: true }], ['limit', 500],
        ]);
    });

    it('null result sets degrade to empty arrays, never a crash', async () => {
        sb.systemRoles = { admin: { id: 9, name: 'Admin' } };
        queue('permissions', { data: null });
        queue('users', { data: null });
        expect(await getBanPermissionHolderIds()).toEqual([]);
        expect(on('role_permissions')).toHaveLength(0);
    });

    it('fails CLOSED on each of its three reads, and returns [] with no users read when no role holds it', async () => {
        sb.systemRoles = { admin: { id: 9, name: 'Admin' } };
        queue('permissions', { error: { message: 'x' } });
        await expect(getBanPermissionHolderIds()).rejects.toBeInstanceOf(BanCheckUnavailable);
        queue('permissions', { data: [{ id: 4 }] });
        queue('role_permissions', { error: { message: 'x' } });
        await expect(getBanPermissionHolderIds()).rejects.toBeInstanceOf(BanCheckUnavailable);
        queue('permissions', { data: [] });
        queue('users', { error: { message: 'x' } });
        await expect(getBanPermissionHolderIds()).rejects.toBeInstanceOf(BanCheckUnavailable);

        sb.systemRoles = {};
        sb.queries = [];
        queue('permissions', { data: [] });
        expect(await getBanPermissionHolderIds()).toEqual([]);
        expect(on('users')).toHaveLength(0);
    });

    it('filterActivelyBanned fails CLOSED on a read fault', async () => {
        queue('organization_bans', { error: { message: 'x' } });
        await expect(filterActivelyBanned([1])).rejects.toBeInstanceOf(BanCheckUnavailable);
    });

    it('null role_permissions rows still fall through to the identity arm', async () => {
        sb.systemRoles = { admin: { id: 9, name: 'Admin' } };
        queue('permissions', { data: [{ id: 4 }] });
        queue('role_permissions', { data: null });
        queue('users', { data: [{ id: 1 }] });
        expect(await getBanPermissionHolderIds()).toEqual([1]);
        expect(argsOf(on('users')[0], 'in')).toEqual(['role_id', [9]]);
    });
});

describe('filterActivelyBanned — input hygiene', () => {
    it('drops non-positive / non-integer ids before querying, and skips null user rows', async () => {
        queue('organization_bans', { data: [{ user_id: null, expires_at: null }, { user_id: 7, expires_at: null }, { user_id: 8, expires_at: '2026-07-01T00:00:00Z' }] });
        const out = await filterActivelyBanned([7, 0, -1, 2.5, 8]);
        expect([...out].sort()).toEqual([7, 8]);
        expect(chainOf(on('organization_bans')[0])).toEqual([
            ['select', 'user_id, expires_at'],
            ['in', 'user_id', [7, 8]],
            ['is', 'lifted_at', null],
            ['order', 'id', { ascending: true }],
            ['limit', 2],
        ]);
    });

    it('all-invalid ids issue no query', async () => {
        expect(await filterActivelyBanned([0, -2, Number.NaN])).toEqual(new Set());
        expect(sb.queries).toEqual([]);
    });

    it('null data reads as nobody banned', async () => {
        queue('organization_bans', { data: null });
        expect(await filterActivelyBanned([1])).toEqual(new Set());
    });
});

describe('liftBansOnSystemAdmins — the break-glass', () => {
    const admin = { admin: { id: 9, name: 'Admin' } };

    it('returns 0 and reads nothing when the Admin role cannot be resolved', async () => {
        sb.systemRoles = {};
        expect(await liftBansOnSystemAdmins()).toBe(0);
        expect(sb.queries).toEqual([]);
    });

    it('lifts exactly the active bans held by live Admin-role users, unattributed', async () => {
        sb.systemRoles = admin;
        queue('users', { data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        queue('organization_bans',
            // filterActivelyBanned: 1 active, 2 expired-but-unlifted (harmless — left alone)
            { data: [{ user_id: 1, expires_at: null }, { user_id: 2, expires_at: '2020-01-01T00:00:00Z' }] },
            { data: [{ id: 50 }] },
            { data: null, error: null },
        );
        expect(await liftBansOnSystemAdmins()).toBe(1);
        expect(chainOf(on('users')[0])).toEqual([
            ['select', 'id'], ['eq', 'role_id', 9], ['is', 'deleted_at', null], ['order', 'id', { ascending: true }], ['limit', 500],
        ]);
        const [, idRead, write] = on('organization_bans');
        expect(chainOf(idRead)).toEqual([
            ['select', 'id'], ['in', 'user_id', [1]], ['is', 'lifted_at', null], ['order', 'id', { ascending: true }], ['limit', 1],
        ]);
        expect(chainOf(write)).toEqual([
            ['update', {
                lifted_at: new Date(NOW).toISOString(),
                lifted_by: null,
                lift_reason: 'Lifted by Database Repair: the subject holds the Admin role',
            }],
            ['in', 'id', [50]],
            ['is', 'lifted_at', null],
        ]);
    });

    it('no live Admins → 0, no ban reads', async () => {
        sb.systemRoles = admin;
        queue('users', { data: null });
        expect(await liftBansOnSystemAdmins()).toBe(0);
        expect(on('organization_bans')).toHaveLength(0);
    });

    it('no Admin actively banned → 0, no id read or write', async () => {
        sb.systemRoles = admin;
        queue('users', { data: [{ id: 1 }] });
        queue('organization_bans', { data: [] });
        expect(await liftBansOnSystemAdmins()).toBe(0);
        expect(on('organization_bans')).toHaveLength(1);
    });

    it('the id read racing a concurrent lift (no rows) → 0, no write', async () => {
        sb.systemRoles = admin;
        queue('users', { data: [{ id: 1 }] });
        queue('organization_bans', { data: [{ user_id: 1, expires_at: null }] }, { data: null });
        expect(await liftBansOnSystemAdmins()).toBe(0);
        expect(on('organization_bans').some((q) => q.op === 'update')).toBe(false);
    });

    it('fails CLOSED on the Admin read and on the ban-id read; a write fault is opaque', async () => {
        sb.systemRoles = admin;
        queue('users', { error: { message: 'x' } });
        await expect(liftBansOnSystemAdmins()).rejects.toBeInstanceOf(BanCheckUnavailable);

        queue('users', { data: [{ id: 1 }] });
        queue('organization_bans', { data: [{ user_id: 1, expires_at: null }] }, { error: { message: 'x' } });
        await expect(liftBansOnSystemAdmins()).rejects.toBeInstanceOf(BanCheckUnavailable);

        queue('users', { data: [{ id: 1 }] });
        queue('organization_bans', { data: [{ user_id: 1, expires_at: null }] }, { data: [{ id: 50 }] }, { error: { message: 'x' } });
        await expect(liftBansOnSystemAdmins()).rejects.toThrow('Failed to lift bans on Admin-role holders');
    });
});

describe('dropPushSubscriptions — closes the push channel the ban gate cannot reach', () => {
    it('deletes every subscription row for the member', async () => {
        await dropPushSubscriptions(5);
        const q = on('push_subscriptions')[0] as SbQuery;
        expect(q.op).toBe('delete');
        expect(chainOf(q)).toEqual([['delete'], ['eq', 'user_id', 5]]);
    });

    it('a fault throws; an invalid id never reaches the DB', async () => {
        queue('push_subscriptions', { error: { message: 'x' } });
        await expect(dropPushSubscriptions(5)).rejects.toThrow('Failed to clear push subscriptions');
        await expect(dropPushSubscriptions(1.5)).rejects.toThrow('Invalid userId');
        // The second builder is opened but never filtered or executed: no unscoped delete.
        const second = on('push_subscriptions')[1];
        expect(has(second, 'eq')).toBe(false);
        expect(second.terminal).toBeNull();
    });
});
