import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// =============================================================================
// api/actions/bans.ts — handler-level behaviour suite (coverage phase 3,
// unit actions-core). The ban AUTHORIZATION rules live in this file:
//   · every refusal is the SAME opaque SecurityDenial message (no existence /
//     peer oracle on a caller-chosen targetUserId); the distinguishing detail
//     rides only in auditEvent + fields (server-side);
//   · self-ban, peer-ban and last-lifter guards run against the RESOLVED row;
//   · read faults in the holder lookups fail CLOSED (propagate, nothing written);
//   · push + voice side channels are best-effort and never undo the ban;
//   · appeals resolve the ban from the ACTOR's own notice, never a payload id,
//     and reviewer notifications carry no statement text or identity;
//   · accepting an appeal lifts the ban unless explicitly opted out, and a
//     benign lift race never fails the committed verdict.
// =============================================================================

const h = vi.hoisted(() => {
    type LogCall = { level: string; msg: string; fields?: Record<string, unknown> };
    const logs: LogCall[] = [];
    const logStub: Record<string, unknown> = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
        logStub[level] = (msg: string, fields?: Record<string, unknown>) => { logs.push({ level, msg, fields }); };
    }
    logStub.child = () => logStub;
    return {
        logs,
        logStub,
        db: {
            loadBanTarget: vi.fn(),
            getBanPermissionHolderIds: vi.fn(),
            filterActivelyBanned: vi.fn(),
            createBan: vi.fn(),
            dropPushSubscriptions: vi.fn(),
            recordSecurityEvent: vi.fn(),
            liftBan: vi.fn(),
            listBans: vi.fn(),
            listBanAppeals: vi.fn(),
            getBanNotice: vi.fn(),
            createBanAppeal: vi.fn(),
            reviewBanAppeal: vi.fn(),
        } as Record<string, Mock<(...args: any[]) => any>>,
        createNotification: vi.fn(),
        evictUserFromAllRooms: vi.fn(),
        // What the audit emitter RETURNS. Deliberately a plain function, not the vi.fn:
        // a vi.fn attaches its own .then to any promise it returns (mock.settledResults),
        // which marks a rejection handled and would hide a missing .catch in the handler.
        auditResult: (() => Promise.resolve()) as () => unknown,
    };
});

vi.mock('../lib/log', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../lib/log')>();
    return { ...orig, log: h.logStub };
});
vi.mock('../lib/db', () => ({
    ...h.db,
    recordSecurityEvent: (event: unknown) => { h.db.recordSecurityEvent(event); return h.auditResult(); },
}));
vi.mock('../lib/db/notifications', () => ({ createNotification: h.createNotification }));
vi.mock('../lib/radio', () => ({ evictUserFromAllRooms: h.evictUserFromAllRooms }));

import { banActions } from '../api/actions/bans';
import { SecurityDenial } from '../lib/errors';

type AnyHandler = (p: any) => Promise<any>;
const act = (name: string) => (banActions as unknown as Record<string, AnyHandler>)[name];
const logged = (level: string, msg: string) => h.logs.filter((l) => l.level === level && l.msg === msg);
const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));
const auditCalls = () => h.db.recordSecurityEvent.mock.calls.map((c) => c[0]);

/** Run `fn`, let rejections settle, and return every unhandled rejection Node reported meanwhile. */
async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => { seen.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
        await fn();
        await flushAsync();
        await flushAsync();
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    return seen;
}

const BAN_REFUSED = 'That member cannot be banned.';
const ACTOR = 10;
const TARGET = { id: 20, discordId: '200000000000000000' };
const BAN = { id: 501, userId: 20, discordId: TARGET.discordId, reason: 'conduct', expiresAt: null };

async function denial(p: Promise<unknown>): Promise<SecurityDenial> {
    const err = await p.then(() => { throw new Error('expected a denial'); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(SecurityDenial);
    return err as SecurityDenial;
}

beforeEach(() => {
    h.logs.length = 0;
    for (const fn of Object.values(h.db)) fn.mockReset();
    h.createNotification.mockReset();
    h.evictUserFromAllRooms.mockReset();

    h.db.loadBanTarget.mockResolvedValue({ ...TARGET });
    h.db.getBanPermissionHolderIds.mockResolvedValue([1, ACTOR]);
    h.db.filterActivelyBanned.mockResolvedValue(new Set());
    h.db.createBan.mockResolvedValue({ ...BAN });
    h.db.dropPushSubscriptions.mockResolvedValue(undefined);
    h.auditResult = () => Promise.resolve();
    h.evictUserFromAllRooms.mockResolvedValue(0);
    h.createNotification.mockResolvedValue({ id: 1 });
});

// ---------------------------------------------------------------------------
describe('ban:place — guards', () => {
    const place = (extra: Record<string, unknown> = {}) =>
        act('ban:place')({ userId: ACTOR, targetUserId: 20, reason: 'conduct', expiresAt: null, ...extra });

    it('resolves the target by the TARGET id (never the actor)', async () => {
        await place();
        expect(h.db.loadBanTarget).toHaveBeenCalledWith(20);
    });

    it('refuses a self-ban (compared on the RESOLVED row) with the opaque message', async () => {
        h.db.loadBanTarget.mockResolvedValue({ id: ACTOR, discordId: 'd' });
        const err = await denial(place({ targetUserId: 'whatever-resolves-to-me' }));
        expect(err.message).toBe(BAN_REFUSED);
        expect(err.auditEvent).toBe('authz.org_ban.self_denied');
        expect(err.fields).toEqual({ targetUserId: ACTOR });
        expect(h.db.getBanPermissionHolderIds).not.toHaveBeenCalled();
        expect(h.db.createBan).not.toHaveBeenCalled();
    });

    it('refuses a PEER (any holder of admin:user:ban, Admin role included) with the same opaque message', async () => {
        h.db.getBanPermissionHolderIds.mockResolvedValue([1, ACTOR, 20]);
        const err = await denial(place());
        expect(err.message).toBe(BAN_REFUSED);
        expect(err.auditEvent).toBe('authz.org_ban.peer_denied');
        expect(err.fields).toEqual({ targetUserId: 20 });
        expect(h.db.filterActivelyBanned).not.toHaveBeenCalled();
        expect(h.db.createBan).not.toHaveBeenCalled();
    });

    it('refuses when every lifter is already banned (recoverability backstop), same opaque message', async () => {
        h.db.getBanPermissionHolderIds.mockResolvedValue([1, 2]);
        h.db.filterActivelyBanned.mockResolvedValue(new Set([1, 2]));
        const err = await denial(place());
        expect(err.message).toBe(BAN_REFUSED);
        expect(err.auditEvent).toBe('authz.org_ban.last_lifter_denied');
        expect(err.fields).toEqual({ targetUserId: 20, holders: 2 });
        expect(h.db.filterActivelyBanned).toHaveBeenCalledWith([1, 2]);
        expect(h.db.createBan).not.toHaveBeenCalled();
    });

    it('refuses when there are no lifters at all', async () => {
        h.db.getBanPermissionHolderIds.mockResolvedValue([]);
        const err = await denial(place());
        expect(err.auditEvent).toBe('authz.org_ban.last_lifter_denied');
        expect(err.fields).toEqual({ targetUserId: 20, holders: 0 });
    });

    it('proceeds while at least one lifter remains un-banned', async () => {
        h.db.getBanPermissionHolderIds.mockResolvedValue([1, 2]);
        h.db.filterActivelyBanned.mockResolvedValue(new Set([1]));
        await expect(place()).resolves.toEqual(BAN);
    });

    it('every refusal message is byte-identical (no oracle across self / peer / last-lifter)', async () => {
        h.db.loadBanTarget.mockResolvedValueOnce({ id: ACTOR, discordId: 'd' });
        const self = await denial(place());
        h.db.getBanPermissionHolderIds.mockResolvedValueOnce([20]);
        const peer = await denial(place());
        h.db.getBanPermissionHolderIds.mockResolvedValueOnce([1]);
        h.db.filterActivelyBanned.mockResolvedValueOnce(new Set([1]));
        const last = await denial(place());
        expect(new Set([self.message, peer.message, last.message])).toEqual(new Set([BAN_REFUSED]));
        expect(new Set([self.auditEvent, peer.auditEvent, last.auditEvent]).size).toBe(3);
    });

    it.each([
        ['the target lookup', 'loadBanTarget'],
        ['the holder lookup', 'getBanPermissionHolderIds'],
        ['the already-banned filter', 'filterActivelyBanned'],
    ])('fails CLOSED when %s faults: the error propagates and no ban is written', async (_label, fn) => {
        const fault = Object.assign(new Error('Ban status unavailable'), { name: 'BanCheckUnavailable' });
        h.db[fn].mockRejectedValue(fault);
        await expect(place()).rejects.toBe(fault);
        expect(h.db.createBan).not.toHaveBeenCalled();
        expect(h.db.dropPushSubscriptions).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('ban:place — the write and its side channels', () => {
    const place = (extra: Record<string, unknown> = {}) =>
        act('ban:place')({ userId: ACTOR, targetUserId: 20, reason: 'conduct', expiresAt: null, ...extra });

    it('writes the ban for the RESOLVED target (id + Discord anchor), attributed to the actor', async () => {
        await place({ reason: 'griefing', expiresAt: '2027-01-01T00:00:00.000Z' });
        expect(h.db.createBan).toHaveBeenCalledWith(
            { userId: 20, discordId: TARGET.discordId, reason: 'griefing', expiresAt: '2027-01-01T00:00:00.000Z' },
            ACTOR,
        );
    });

    it('drops the target\'s push subscriptions and evicts them from live voice, after the ban is written', async () => {
        await place();
        expect(h.db.dropPushSubscriptions).toHaveBeenCalledWith(20);
        expect(h.evictUserFromAllRooms).toHaveBeenCalledWith(20);
        const created = h.db.createBan.mock.invocationCallOrder[0];
        expect(h.db.dropPushSubscriptions.mock.invocationCallOrder[0]).toBeGreaterThan(created);
        expect(h.evictUserFromAllRooms.mock.invocationCallOrder[0]).toBeGreaterThan(created);
    });

    it('logs a voice eviction only when rooms were actually left', async () => {
        await place();
        expect(logged('info', 'evicted banned member from voice')).toEqual([]);
        h.evictUserFromAllRooms.mockResolvedValue(2);
        await place();
        expect(logged('info', 'evicted banned member from voice')[0].fields).toEqual({ targetUserId: 20, rooms: 2 });
    });

    it('a push-drop failure is logged and the ban still stands (voice eviction still runs)', async () => {
        const fault = new Error('push table down');
        h.db.dropPushSubscriptions.mockRejectedValue(fault);
        await expect(place()).resolves.toEqual(BAN);
        expect(logged('error', 'failed to drop push subscriptions after ban')[0].fields).toEqual({ targetUserId: 20, err: fault });
        expect(h.evictUserFromAllRooms).toHaveBeenCalledWith(20);
    });

    it('a voice-eviction failure is logged and the ban still stands', async () => {
        const fault = new Error('livekit down');
        h.evictUserFromAllRooms.mockRejectedValue(fault);
        await expect(place()).resolves.toEqual(BAN);
        expect(logged('error', 'failed to evict banned member from voice')[0].fields).toEqual({ targetUserId: 20, err: fault });
    });

    it('audits the placement with ids only (no reason text), flagging a permanent ban', async () => {
        await place({ reason: 'PRIVATE REASON TEXT' });
        expect(auditCalls()).toEqual([{
            event: 'authz.org_ban.placed', action: 'authz.org_ban.placed', actorUserId: ACTOR, outcome: 'allowed',
            details: { targetUserId: 20, banId: 501, temporary: false },
        }]);
        expect(JSON.stringify(auditCalls())).not.toContain('PRIVATE REASON TEXT');
    });

    it('flags a temporary ban in the audit details', async () => {
        h.db.createBan.mockResolvedValue({ ...BAN, expiresAt: '2027-01-01T00:00:00.000Z' });
        await place();
        expect(auditCalls()[0].details).toEqual({ targetUserId: 20, banId: 501, temporary: true });
    });

    it('a rejected audit write never fails the ban and is never left as an unhandled rejection', async () => {
        h.auditResult = () => Promise.reject(new Error('audit down'));
        const unhandled = await unhandledDuring(async () => {
            await expect(place()).resolves.toEqual(BAN);
        });
        expect(h.db.recordSecurityEvent).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
    });

    it('a synchronously throwing audit emitter never fails the ban', async () => {
        h.auditResult = () => { throw new Error('partial double'); };
        await expect(place()).resolves.toEqual(BAN);
        expect(h.db.recordSecurityEvent).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
describe('ban:lift / ban:list / ban:list_appeals', () => {
    it('ban:lift lifts by ban id as the actor and audits the lifted target by id', async () => {
        h.db.liftBan.mockResolvedValue({ ...BAN, liftedAt: 'now' });
        await expect(act('ban:lift')({ userId: ACTOR, banId: 501, liftReason: 'served' })).resolves.toMatchObject({ id: 501 });
        expect(h.db.liftBan).toHaveBeenCalledWith(501, ACTOR, 'served');
        expect(auditCalls()).toEqual([{
            event: 'authz.org_ban.lifted', action: 'authz.org_ban.lifted', actorUserId: ACTOR, outcome: 'allowed',
            details: { targetUserId: 20, banId: 501 },
        }]);
    });

    it('ban:lift propagates a denial (no such active ban) and audits nothing', async () => {
        h.db.liftBan.mockRejectedValue(new SecurityDenial('That ban could not be lifted.'));
        await expect(act('ban:lift')({ userId: ACTOR, banId: 9 })).rejects.toThrow('That ban could not be lifted.');
        expect(h.db.recordSecurityEvent).not.toHaveBeenCalled();
    });

    it('ban:list forwards only the filter + cap', () => {
        h.db.listBans.mockReturnValue([BAN]);
        expect(act('ban:list')({ userId: ACTOR, includeLifted: true, limit: 25, user: { id: ACTOR } })).toEqual([BAN]);
        expect(h.db.listBans).toHaveBeenCalledWith({ includeLifted: true, limit: 25 });
    });

    it('ban:list_appeals forwards only the status filter + cap', () => {
        h.db.listBanAppeals.mockReturnValue([]);
        act('ban:list_appeals')({ userId: ACTOR, status: 'pending', limit: 10 });
        expect(h.db.listBanAppeals).toHaveBeenCalledWith({ status: 'pending', limit: 10 });
    });
});

// ---------------------------------------------------------------------------
describe('ban:my_notice — self only', () => {
    it('reads the notice for the dispatcher-forced caller and their own Discord anchor', () => {
        h.db.getBanNotice.mockReturnValue({ banId: 501 });
        expect(act('ban:my_notice')({ userId: 20, user: { id: 20, discordId: 'd-20' }, targetUserId: 99 })).toEqual({ banId: 501 });
        expect(h.db.getBanNotice).toHaveBeenCalledWith(20, 'd-20');
    });

    it('passes no Discord anchor when the caller record has none', () => {
        act('ban:my_notice')({ userId: 20 });
        expect(h.db.getBanNotice.mock.calls[0]).toEqual([20, undefined]);
    });
});

// ---------------------------------------------------------------------------
describe('ban:submit_appeal', () => {
    const NOTICE = { banId: 501, canAppeal: true };
    const submit = (extra: Record<string, unknown> = {}) =>
        act('ban:submit_appeal')({ userId: 20, user: { id: 20, discordId: 'd-20' }, statement: 'I was wrong', ...extra });

    it('refuses a caller who is not banned', async () => {
        h.db.getBanNotice.mockResolvedValue(null);
        await expect(submit()).rejects.toThrow('You are not currently banned.');
        expect(h.db.createBanAppeal).not.toHaveBeenCalled();
    });

    it('refuses a second appeal on the same ban', async () => {
        h.db.getBanNotice.mockResolvedValue({ ...NOTICE, canAppeal: false });
        await expect(submit()).rejects.toThrow('You have already appealed this ban.');
        expect(h.db.createBanAppeal).not.toHaveBeenCalled();
    });

    it('writes onto the ACTOR\'s own ban (a payload banId is ignored) and notifies every reviewer without the statement', async () => {
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        h.db.createBanAppeal.mockResolvedValue({ id: 900, banId: 501 });
        h.db.getBanPermissionHolderIds.mockResolvedValue([1, 2]);

        await expect(submit({ banId: 12345 })).resolves.toEqual({ id: 900, banId: 501 });
        expect(h.db.getBanNotice).toHaveBeenCalledWith(20, 'd-20');
        expect(h.db.createBanAppeal).toHaveBeenCalledWith(501, 'I was wrong');

        const expected = {
            type: 'ban_appeal',
            title: 'Ban appeal submitted',
            body: 'A banned member has submitted an appeal for review.',
            link: 'admin',
            metadata: { appealId: 900 },
        };
        expect(h.createNotification.mock.calls).toEqual([[1, expected], [2, expected]]);
        expect(JSON.stringify(h.createNotification.mock.calls)).not.toContain('I was wrong');
    });

    it('one reviewer\'s notification failure does not stop the others or fail the appeal', async () => {
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        h.db.createBanAppeal.mockResolvedValue({ id: 900, banId: 501 });
        h.db.getBanPermissionHolderIds.mockResolvedValue([1, 2]);
        h.createNotification.mockRejectedValueOnce(new Error('inbox full'));
        await expect(submit()).resolves.toEqual({ id: 900, banId: 501 });
        expect(h.createNotification).toHaveBeenCalledTimes(2);
        expect(logged('error', 'ban appeal notification failed')).toEqual([]);
    });

    it('a reviewer-lookup fault is logged and the persisted appeal is still returned', async () => {
        const fault = new Error('holders unavailable');
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        h.db.createBanAppeal.mockResolvedValue({ id: 900, banId: 501 });
        h.db.getBanPermissionHolderIds.mockRejectedValue(fault);
        await expect(submit()).resolves.toEqual({ id: 900, banId: 501 });
        expect(logged('error', 'ban appeal notification failed')[0].fields).toEqual({ appealId: 900, err: fault });
        expect(h.createNotification).not.toHaveBeenCalled();
    });

    it('a duplicate-appeal race in the write propagates its message', async () => {
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        h.db.createBanAppeal.mockRejectedValue(new Error('You have already appealed this ban.'));
        await expect(submit()).rejects.toThrow('You have already appealed this ban.');
        expect(h.createNotification).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('ban:review_appeal', () => {
    const APPEAL = { id: 900, banId: 501 };
    beforeEach(() => {
        h.db.reviewBanAppeal.mockResolvedValue({ ...APPEAL });
        h.db.liftBan.mockResolvedValue({ ...BAN });
    });

    it('accepting records the verdict, audits it, then LIFTS the ban with the reviewer note', async () => {
        await expect(act('ban:review_appeal')({ userId: ACTOR, appealId: 900, verdict: 'accepted', note: 'fair point' })).resolves.toEqual(APPEAL);
        expect(h.db.reviewBanAppeal).toHaveBeenCalledWith(900, 'accepted', ACTOR, 'fair point');
        expect(h.db.liftBan).toHaveBeenCalledWith(501, ACTOR, 'fair point');
        expect(auditCalls()).toEqual([
            { event: 'authz.org_ban.appeal_reviewed', action: 'authz.org_ban.appeal_reviewed', actorUserId: ACTOR, outcome: 'allowed', details: { appealId: 900, banId: 501, verdict: 'accepted' } },
            { event: 'authz.org_ban.lifted', action: 'authz.org_ban.lifted', actorUserId: ACTOR, outcome: 'allowed', details: { targetUserId: 20, banId: 501 } },
        ]);
    });

    it('accepting without a note lifts with the default reason', async () => {
        await act('ban:review_appeal')({ userId: ACTOR, appealId: 900, verdict: 'accepted' });
        expect(h.db.liftBan).toHaveBeenCalledWith(501, ACTOR, 'Appeal accepted');
    });

    it('accepting with an explicit liftBan:false records the verdict but leaves the ban standing', async () => {
        await act('ban:review_appeal')({ userId: ACTOR, appealId: 900, verdict: 'accepted', liftBan: false });
        expect(h.db.reviewBanAppeal).toHaveBeenCalledWith(900, 'accepted', ACTOR, undefined);
        expect(h.db.liftBan).not.toHaveBeenCalled();
        expect(auditCalls().map((a) => a.event)).toEqual(['authz.org_ban.appeal_reviewed']);
    });

    it.each([['rejected'], ['ACCEPTED'], ['lifted'], [undefined]])('any verdict other than exactly "accepted" (%s) is recorded as rejected and lifts nothing', async (verdict) => {
        await act('ban:review_appeal')({ userId: ACTOR, appealId: 900, verdict, liftBan: true });
        expect(h.db.reviewBanAppeal).toHaveBeenCalledWith(900, 'rejected', ACTOR, undefined);
        expect(h.db.liftBan).not.toHaveBeenCalled();
        expect(auditCalls()[0].details).toEqual({ appealId: 900, banId: 501, verdict: 'rejected' });
    });

    it('a benign lift race (already lifted / superseded) is swallowed: the committed verdict stands, no false lift audit', async () => {
        const race = new SecurityDenial('That ban could not be lifted.');
        h.db.liftBan.mockRejectedValue(race);
        await expect(act('ban:review_appeal')({ userId: ACTOR, appealId: 900, verdict: 'accepted' })).resolves.toEqual(APPEAL);
        expect(logged('warn', 'appeal accepted but the ban was no longer active to lift')[0].fields).toEqual({ appealId: 900, banId: 501, err: race });
        expect(auditCalls().map((a) => a.event)).toEqual(['authz.org_ban.appeal_reviewed']);
    });

    it('a failed verdict write propagates and neither audits nor lifts', async () => {
        h.db.reviewBanAppeal.mockRejectedValue(new Error('Appeal already resolved.'));
        await expect(act('ban:review_appeal')({ userId: ACTOR, appealId: 900, verdict: 'accepted' })).rejects.toThrow('Appeal already resolved.');
        expect(h.db.recordSecurityEvent).not.toHaveBeenCalled();
        expect(h.db.liftBan).not.toHaveBeenCalled();
    });
});
