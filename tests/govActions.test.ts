import { describe, it, expect, vi, beforeEach } from 'vitest';

// api/actions/government.ts — the gov:* RPC handlers. They are thin: each forwards its
// payload to one lib/db function (the dispatcher has already authorised the action and
// forced the actor ids), and some announce the change to every gov:view holder with a
// push. Pinned here: the exact forwarding, and WHEN a push goes out.
//
// The executive-order announcement is the regression this file exists for: both
// gov:create_order and gov:update_order compared the order status against 'Active',
// while orders.ts stores lower-case 'active' (the column CHECK allows nothing else) —
// so an issued order was never announced at all.

const h = vi.hoisted(() => ({
    calls: [] as Array<{ fn: string; args: unknown[] }>,
    results: {} as Record<string, unknown>,
    pushes: [] as Array<{ perm: string; payload: Record<string, unknown> }>,
    pushFails: false,
    warn: [] as unknown[][],
}));

vi.mock('../lib/db', () => {
    const names = [
        'addLegislationComment', 'advanceElection', 'applyGovernmentTemplate', 'appointPositionHolder', 'callByElection',
        'cancelElection', 'cancelMotion', 'castElectionVote', 'castLegislationVote', 'castMotionVote', 'certifyElection',
        'concludeLegislationVote', 'concludeMotion', 'createElection', 'createGovernmentBranch', 'createGovernmentOrder',
        'createGovernmentPosition', 'createLegislation', 'createMotion', 'declareCandidacy', 'deleteGovernmentBranch',
        'deleteGovernmentOrder', 'deleteGovernmentPosition', 'deleteLegislationComment', 'getGovernmentOrder',
        'getGovernmentTemplates', 'getMyOrderIssuingPositions', 'listGovernmentOrders', 'proposeLegislation',
        'removePositionHolder', 'reorderGovernmentBranches', 'reorderGovernmentPositions', 'repealLegislation',
        'revokeGovernmentOrder', 'startLegislationDebate', 'startLegislationVote', 'startMotionVote', 'updateConstitution',
        'updateElection', 'updateGovernmentBranch', 'updateGovernmentOrder', 'updateGovernmentPosition',
        'updateGovernmentsConfig', 'updateLegislation', 'upsertGovernmentConfig', 'vetoLegislation', 'withdrawCandidacy',
    ];
    return Object.fromEntries(names.map((fn) => [fn, async (...args: unknown[]) => {
        h.calls.push({ fn, args });
        return h.results[fn];
    }]));
});

vi.mock('../lib/push', () => ({
    sendPushToPermission: (perm: string, payload: Record<string, unknown>) => {
        h.pushes.push({ perm, payload });
        return h.pushFails ? Promise.reject(new Error('push infra down')) : Promise.resolve();
    },
}));

vi.mock('../lib/log', () => {
    const logger = { info: () => {}, error: () => {}, debug: () => {}, warn: (...a: unknown[]) => { h.warn.push(a); }, child: () => logger };
    return { log: logger };
});

import { governmentActions } from '../api/actions/government';

type Handler = (payload: unknown) => Promise<unknown>;
const run = (action: string, payload: unknown = {}) => (governmentActions as unknown as Record<string, Handler>)[action](payload);
const lastCall = () => h.calls.at(-1)!;
const titles = () => h.pushes.map((p) => p.payload.title);

beforeEach(() => {
    h.calls = []; h.results = {}; h.pushes = []; h.pushFails = false; h.warn = [];
});

describe('every handler forwards exactly its payload to its db function', () => {
    const ACTOR = { id: 2, isSystemAdmin: false, permissions: ['gov:manage'] };
    const SEL = [{ candidateId: 4, rankOrder: 1 }];
    it.each([
        ['gov:update_feature_config', { config: { enabled: true } }, 'updateGovernmentsConfig', [{ enabled: true }]],
        ['gov:upsert_config', { config: { name: 'G' } }, 'upsertGovernmentConfig', [{ name: 'G' }]],
        ['gov:apply_template', { templateType: 'republic' }, 'applyGovernmentTemplate', ['republic']],
        ['gov:get_templates', {}, 'getGovernmentTemplates', []],
        ['gov:update_constitution', { content: { type: 'doc' } }, 'updateConstitution', [{ type: 'doc' }]],
        ['gov:create_branch', { branchData: { name: 'B' } }, 'createGovernmentBranch', [{ name: 'B' }]],
        ['gov:update_branch', { branchId: 3, updates: { name: 'B2' } }, 'updateGovernmentBranch', [3, { name: 'B2' }]],
        ['gov:delete_branch', { branchId: 3 }, 'deleteGovernmentBranch', [3]],
        ['gov:reorder_branches', { orderedIds: [2, 1] }, 'reorderGovernmentBranches', [[2, 1]]],
        ['gov:create_position', { positionData: { name: 'P' } }, 'createGovernmentPosition', [{ name: 'P' }]],
        ['gov:update_position', { positionId: 5, updates: { name: 'P2' } }, 'updateGovernmentPosition', [5, { name: 'P2' }]],
        ['gov:delete_position', { positionId: 5 }, 'deleteGovernmentPosition', [5]],
        ['gov:reorder_positions', { branchId: 3, orderedIds: [9] }, 'reorderGovernmentPositions', [3, [9]]],
        ['gov:reorder_positions', { orderedIds: [9] }, 'reorderGovernmentPositions', [null, [9]]],
        // The appointee is the TARGET; the authenticated actor is recorded as appointer
        // and passed through for the authority ceiling.
        ['gov:appoint_holder', { positionId: 5, targetUserId: 8, userId: 2, user: ACTOR }, 'appointPositionHolder', [{ positionId: 5, userId: 8, appointedById: 2 }, ACTOR]],
        ['gov:remove_holder', { holderId: 6, reason: 'misconduct', user: ACTOR }, 'removePositionHolder', [6, 'misconduct', ACTOR]],
        ['gov:remove_holder', { holderId: 6, user: ACTOR }, 'removePositionHolder', [6, 'removed', ACTOR]],
        ['gov:update_election', { electionId: 1, updates: { title: 'T' } }, 'updateElection', [1, { title: 'T' }]],
        ['gov:declare_candidacy', { electionId: 1, userId: 2, statement: 's' }, 'declareCandidacy', [1, 2, 's']],
        ['gov:withdraw_candidacy', { electionId: 1, userId: 2 }, 'withdrawCandidacy', [1, 2]],
        ['gov:cast_election_vote', { electionId: 1, userId: 2, selections: SEL }, 'castElectionVote', [1, 2, SEL]],
        ['gov:create_legislation', { legislationData: { title: 'L' }, userId: 2 }, 'createLegislation', [{ title: 'L', userId: 2 }]],
        ['gov:update_legislation', { legislationId: 4, updates: { title: 'L2' } }, 'updateLegislation', [4, { title: 'L2' }]],
        ['gov:start_legislation_debate', { legislationId: 4 }, 'startLegislationDebate', [4]],
        ['gov:cast_legislation_vote', { legislationId: 4, userId: 2, positionId: 5, vote: 'for' }, 'castLegislationVote', [4, 2, 5, 'for']],
        ['gov:add_legislation_comment', { legislationId: 4, userId: 2, content: 'c' }, 'addLegislationComment', [4, 2, 'c']],
        ['gov:delete_legislation_comment', { commentId: 9 }, 'deleteLegislationComment', [9]],
        ['gov:cast_motion_vote', { motionId: 7, userId: 2, vote: 'against' }, 'castMotionVote', [7, 2, 'against']],
        ['gov:list_orders', { userId: 2 }, 'listGovernmentOrders', [2]],
        ['gov:get_order', { orderId: 'O1', userId: 2 }, 'getGovernmentOrder', ['O1', 2]],
        ['gov:get_my_issuing_positions', { userId: 2 }, 'getMyOrderIssuingPositions', [2]],
        ['gov:delete_order', { orderId: 'O1', userId: 2 }, 'deleteGovernmentOrder', ['O1', 2]],
    ])('%s → %s', async (action, payload, fn, args) => {
        h.results[fn as string] = { marker: fn };
        await expect(run(action as string, payload)).resolves.toEqual({ marker: fn });
        expect(h.calls).toEqual([{ fn, args }]);
        expect(h.pushes).toEqual([]);
    });
});

describe('executive-order announcements match the STORED status', () => {
    const INPUT = { issuerPositionId: 5, title: 'Curfew', body: 'Text' };

    it('gov:create_order announces an order created in force (status \'active\')', async () => {
        h.results.createGovernmentOrder = { id: 'O1', title: 'Curfew', status: 'active' };
        await run('gov:create_order', { input: { ...INPUT, status: 'active' }, userId: 2 });
        expect(lastCall()).toEqual({ fn: 'createGovernmentOrder', args: [{ ...INPUT, status: 'active' }, 2] });
        expect(h.pushes).toEqual([{
            perm: 'gov:view',
            payload: { title: 'Executive order issued', body: 'Curfew is now in force.', tag: 'gov-order-issued-O1', data: { view: 'government', tab: 'orders', orderId: 'O1' } },
        }]);
    });

    it('gov:create_order does NOT announce a draft — its title is visible to its author only', async () => {
        h.results.createGovernmentOrder = { id: 'O2', title: 'Secret plan', status: 'draft' };
        await run('gov:create_order', { input: INPUT, userId: 2 });
        expect(h.pushes).toEqual([]);
    });

    // The old `!status ||` branch announced whenever the result carried no status, with
    // the CALLER's title as the fallback — a draft's title pushed to the whole org.
    it('gov:create_order does not announce a result whose status it cannot see', async () => {
        h.results.createGovernmentOrder = null;
        await run('gov:create_order', { input: { ...INPUT, status: 'draft' }, userId: 2 });
        h.results.createGovernmentOrder = { id: 'O3', title: 'T' };
        await run('gov:create_order', { input: INPUT, userId: 2 });
        expect(h.pushes).toEqual([]);
    });

    it('an untitled active result falls back to the input title, then a generic one', async () => {
        h.results.createGovernmentOrder = { id: 'O4', status: 'active' };
        await run('gov:create_order', { input: INPUT, userId: 2 });
        await run('gov:create_order', { input: { ...INPUT, title: '' }, userId: 2 });
        expect(h.pushes.map((p) => p.payload.body)).toEqual(['Curfew is now in force.', 'An executive order is now in force.']);
    });

    it('gov:update_order announces the draft → active publish', async () => {
        await run('gov:update_order', { orderId: 'O1', patch: { status: 'active' }, userId: 2 });
        expect(lastCall()).toEqual({ fn: 'updateGovernmentOrder', args: ['O1', { status: 'active' }, 2] });
        expect(h.pushes).toEqual([{
            perm: 'gov:view',
            payload: { title: 'Executive order issued', body: 'An executive order is now in force.', tag: 'gov-order-issued-O1', data: { view: 'government', tab: 'orders', orderId: 'O1' } },
        }]);
    });

    it('gov:update_order does not announce a content edit, a draft save, or the never-stored \'Active\'', async () => {
        await run('gov:update_order', { orderId: 'O1', patch: { title: 'x' }, userId: 2 });
        await run('gov:update_order', { orderId: 'O1', patch: { status: 'draft' }, userId: 2 });
        await run('gov:update_order', { orderId: 'O1', patch: { status: 'Active' }, userId: 2 });
        await run('gov:update_order', { orderId: 'O1', userId: 2 });
        expect(h.pushes).toEqual([]);
    });

    it('a refused publish announces nothing', async () => {
        const err = new Error('Published orders cannot be edited.');
        const db = await import('../lib/db');
        vi.spyOn(db, 'updateGovernmentOrder').mockRejectedValueOnce(err);
        await expect(run('gov:update_order', { orderId: 'O1', patch: { status: 'active' }, userId: 2 })).rejects.toBe(err);
        expect(h.pushes).toEqual([]);
    });

    it('gov:revoke_order announces the revocation, with a capped reason when there is one', async () => {
        h.results.revokeGovernmentOrder = undefined;
        await run('gov:revoke_order', { orderId: 'O1', reason: 'x'.repeat(200), userId: 2 });
        await run('gov:revoke_order', { orderId: 'O1', reason: '', userId: 2 });
        expect(lastCall()).toEqual({ fn: 'revokeGovernmentOrder', args: ['O1', '', 2] });
        expect(h.pushes.map((p) => p.payload.body)).toEqual([`An executive order was revoked: ${'x'.repeat(140)}`, 'An executive order was revoked.']);
        expect(new Set(h.pushes.map((p) => p.payload.tag))).toEqual(new Set(['gov-order-revoked-O1']));
    });
});

describe('the other announcements', () => {
    it('gov:create_election forwards the actor and announces with the stored title', async () => {
        h.results.createElection = { id: 11, title: 'Senate race' };
        await expect(run('gov:create_election', { electionData: { title: 'ignored' }, userId: 2 })).resolves.toEqual({ id: 11, title: 'Senate race' });
        expect(lastCall()).toEqual({ fn: 'createElection', args: [{ title: 'ignored', userId: 2 }] });
        expect(h.pushes[0].payload).toMatchObject({ title: 'Election called', tag: 'gov-election-created-11', data: { tab: 'elections', electionId: 11 } });
        expect(h.pushes[0].payload.body).toMatch(/^Senate race has been scheduled/);
        // No stored title: the payload title, then a generic one.
        h.results.createElection = null;
        await run('gov:create_election', { electionData: { title: 'Mine' }, userId: 2 });
        await run('gov:create_election', { userId: 2 });
        expect(h.pushes.map((p) => String(p.payload.body).split(' has')[0])).toEqual(['Senate race', 'Mine', 'An election']);
    });

    it.each([
        ['CandidacyOpen', 'Candidacy open'],
        ['Voting', 'Voting open'],
        ['Concluded', 'Election concluded'],
        ['Certified', 'Election concluded'],
    ])('gov:advance_election announces %s', async (status, title) => {
        h.results.advanceElection = { status, title: 'Race' };
        await run('gov:advance_election', { electionId: 1 });
        expect(lastCall()).toEqual({ fn: 'advanceElection', args: [1] });
        expect(titles()).toEqual([title]);
    });

    it('gov:advance_election stays quiet for any other (or no) status', async () => {
        h.results.advanceElection = { status: 'Draft' };
        await run('gov:advance_election', { electionId: 1 });
        h.results.advanceElection = undefined;
        await run('gov:advance_election', { electionId: 1 });
        expect(h.pushes).toEqual([]);
    });

    it('gov:cancel_election announces, with the reason when given', async () => {
        await run('gov:cancel_election', { electionId: 1, reason: 'fraud' });
        await run('gov:cancel_election', { electionId: 1, reason: '' });
        expect(h.calls).toEqual([{ fn: 'cancelElection', args: [1, 'fraud'] }, { fn: 'cancelElection', args: [1, ''] }]);
        expect(h.pushes.map((p) => p.payload.body)).toEqual(['An election was cancelled: fraud', 'An election was cancelled.']);
    });

    it('gov:certify_results and gov:call_by_election announce', async () => {
        await run('gov:certify_results', { electionId: 1, userId: 2 });
        expect(lastCall()).toEqual({ fn: 'certifyElection', args: [1, 2] });
        h.results.callByElection = { id: 12 };
        await run('gov:call_by_election', { electionData: { title: 'By' }, userId: 2 });
        expect(lastCall()).toEqual({ fn: 'callByElection', args: [{ title: 'By', userId: 2 }] });
        await run('gov:call_by_election', { userId: 2 });
        expect(titles()).toEqual(['Results certified', 'By-election called', 'By-election called']);
        expect(h.pushes.map((p) => p.payload.body)).toEqual(['An election — results have been certified.', 'By has been called.', 'A by-election has been called.']);
    });

    it('legislation: propose, open the vote, veto and repeal each announce', async () => {
        await run('gov:propose_legislation', { legislationId: 4 });
        await run('gov:start_legislation_vote', { legislationId: 4 });
        await run('gov:veto_legislation', { legislationId: 4, userId: 2, reason: 'unconstitutional' });
        await run('gov:veto_legislation', { legislationId: 4, userId: 2, reason: '' });
        await run('gov:repeal_legislation', { legislationId: 4, repealingLegislationId: 9 });
        expect(h.calls.map((c) => [c.fn, c.args])).toEqual([
            ['proposeLegislation', [4]], ['startLegislationVote', [4]],
            ['vetoLegislation', [4, 2, 'unconstitutional']], ['vetoLegislation', [4, 2, '']],
            ['repealLegislation', [4, 9]],
        ]);
        expect(titles()).toEqual(['Legislation proposed', 'Vote opened', 'Bill vetoed', 'Bill vetoed', 'Legislation repealed']);
        expect(h.pushes[2].payload.body).toBe('A bill was vetoed: unconstitutional');
        expect(h.pushes[3].payload.body).toBe('A bill was vetoed.');
    });

    // Converted (review follow-up): these fed shapes concludeLegislationVote never
    // returned (a 'Defeated' it never stores, a title it never carried), so the handler's
    // only real-world output was 'A bill concluded (final).'. The db result is now
    // { passed, status, title }; the verdict is read from `passed`.
    it.each([
        [{ passed: true, status: 'Passed', title: 'Act' }, 'Act passed.'],
        [{ passed: false, status: 'Failed', title: 'Act' }, 'Act was defeated.'],
        [{ passed: true, status: 'Passed', title: '' }, 'A bill passed.'],
    ])('gov:conclude_legislation_vote announces %j', async (result, body) => {
        h.results.concludeLegislationVote = result;
        await expect(run('gov:conclude_legislation_vote', { legislationId: 4 })).resolves.toBe(result);
        expect(lastCall()).toEqual({ fn: 'concludeLegislationVote', args: [4] });
        expect(h.pushes).toEqual([{
            perm: 'gov:view',
            payload: { title: 'Legislation concluded', body, tag: 'gov-legislation-concluded-4', data: { view: 'government', tab: 'legislation', legislationId: 4 } },
        }]);
    });

    it('motions: raise, open the vote and cancel each announce', async () => {
        h.results.createMotion = { id: 21, title: 'Adjourn' };
        await run('gov:create_motion', { motionData: { title: 'x' }, userId: 2 });
        expect(lastCall()).toEqual({ fn: 'createMotion', args: [{ title: 'x', userId: 2 }] });
        h.results.createMotion = undefined;
        await run('gov:create_motion', { motionData: { title: 'Fallback' }, userId: 2 });
        await run('gov:create_motion', { userId: 2 });
        await run('gov:start_motion_vote', { motionId: 21 });
        await run('gov:cancel_motion', { motionId: 21 });
        expect(titles()).toEqual(['Motion raised', 'Motion raised', 'Motion raised', 'Motion vote open', 'Motion cancelled']);
        expect(h.pushes.slice(0, 3).map((p) => String(p.payload.body).split(' —')[0])).toEqual(['Adjourn', 'Fallback', 'A motion']);
    });

    // Converted like the bill table: concludeMotion never returned a title, a
    // 'Defeated' or a 'Cancelled' (a cancelled motion is now refused, not concluded).
    it.each([
        [{ passed: true, status: 'Passed', title: 'Adjourn' }, 'Adjourn passed.'],
        [{ passed: false, status: 'Failed', title: 'Adjourn' }, 'Adjourn was defeated.'],
        [{ passed: false, status: 'Failed', title: '' }, 'A motion was defeated.'],
    ])('gov:conclude_motion announces %j', async (result, body) => {
        h.results.concludeMotion = result;
        await expect(run('gov:conclude_motion', { motionId: 21 })).resolves.toBe(result);
        expect(lastCall()).toEqual({ fn: 'concludeMotion', args: [21] });
        expect(h.pushes).toEqual([{
            perm: 'gov:view',
            payload: { title: 'Motion concluded', body, tag: 'gov-motion-concluded-21', data: { view: 'government', tab: 'motions', motionId: 21 } },
        }]);
    });

    it('a push failure is logged and never fails the action', async () => {
        h.pushFails = true;
        h.results.createMotion = { id: 21, title: 'Adjourn' };
        await expect(run('gov:create_motion', { motionData: {}, userId: 2 })).resolves.toEqual({ id: 21, title: 'Adjourn' });
        await new Promise((r) => setTimeout(r, 0));
        expect(h.warn).toHaveLength(1);
        expect(h.warn[0][0]).toBe('push failed');
    });
});
