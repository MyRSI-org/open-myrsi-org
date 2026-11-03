import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/quartermaster.ts — the ISSUANCE half: request / fulfil / direct issue /
// bulk issue / return / write-off / bulk return, the member Q-Record rollup, the
// overview aggregate and the overdue scan.
//
// The properties pinned here:
//  - Every id-addressed write first proves the row exists (the stored procs trust
//    that lookup), refuses the wrong state with `false` and no proc call, and fails
//    closed on the lookup error.
//  - The over-issue guard sums the movement log and refuses BEFORE the proc posts a
//    negative movement; a missing ledger is treated as a failure, never as "plenty".
//  - Bulk calls are capped (circuit breaker) and reject the whole batch on any
//    out-of-scope id rather than silently dropping lines.
//  - Broadcasts carry ids only, and only after the write succeeded.

vi.mock('../lib/db/common', async () => (await import('./cov-db-quartermaster-harness')).commonMock);
vi.mock('../lib/db/uex', async () => (await import('./cov-db-quartermaster-harness')).uex);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const hh = await import('./cov-db-quartermaster-harness');
    return { ...actual, log: { ...actual.log, child: () => hh.logSpy } };
});

import {
    h, queue, queueRpc, settled, calls, first, cols, trace, resetHarness, broadcastToOrg,
} from './cov-db-quartermaster-harness';
import {
    listIssuances, requestIssuance, getIssuanceById, fulfilIssuance, issueDirect, issueDirectBulk,
    returnIssuance, writeOffIssuance, returnIssuanceBulk, listMemberRecords, getQuartermasterOverview,
    listOverdueIssuances,
} from '../lib/db/quartermaster';

const USER_EMBED = '(id, name, avatar_url, rsi_handle)';
const ISSUANCE_SELECT = 'id, inventory_id, issued_to_user_id, quantity, status, requested_at, issued_at, due_back_at, returned_at, returned_quantity, outcome, requested_by_user_id, issued_by_user_id, closed_by_user_id, notes, operation_id, created_at, updated_at, '
    + 'inventory:quartermaster_inventory(id, custom_name, catalog:quartermaster_catalog(name, category)), '
    + `issued_to:users!quartermaster_issuances_issued_to_user_id_fkey${USER_EMBED}, `
    + `requested_by:users!quartermaster_issuances_requested_by_user_id_fkey${USER_EMBED}, `
    + `issued_by:users!quartermaster_issuances_issued_by_user_id_fkey${USER_EMBED}, `
    + `closed_by:users!quartermaster_issuances_closed_by_user_id_fkey${USER_EMBED}`;
const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
const PG_MISSING = { code: '42P01', message: 'relation does not exist' };
const PG_FAULT = { code: '08006', message: 'connection failure at 10.0.0.3' };
const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const user = (id: number, name: string) => ({ id, name, avatar_url: null, rsi_handle: `h${id}` });
const userRef = (id: number, name: string) => ({ id, name, avatarUrl: DEFAULT_AVATAR, rsiHandle: `h${id}` });

const issRow = (id: number, over: Record<string, unknown> = {}) => ({
    id, inventory_id: 5, issued_to_user_id: 9, quantity: 2, status: 'active',
    requested_at: 'req-at', issued_at: 'iss-at', due_back_at: null, returned_at: null, returned_quantity: null,
    outcome: null, requested_by_user_id: 9, issued_by_user_id: 1, closed_by_user_id: null, notes: null,
    operation_id: null, created_at: 'c-at', updated_at: 'u-at',
    inventory: { id: 5, custom_name: null, catalog: { name: 'Rifle', category: 'weapon' } },
    issued_to: user(9, 'Ann'), requested_by: null, issued_by: user(1, 'QM'), closed_by: null,
    ...over,
});
const issItem = (id: number, over: Record<string, unknown> = {}) => ({
    id, inventoryId: 5, inventory: { id: 5, customName: null, catalog: { name: 'Rifle', category: 'weapon' } },
    issuedToUserId: 9, issuedTo: userRef(9, 'Ann'), quantity: 2, status: 'active',
    requestedAt: 'req-at', issuedAt: 'iss-at', dueBackAt: null, returnedAt: null, returnedQuantity: null,
    outcome: null, requestedByUserId: 9, requestedBy: undefined, issuedByUserId: 1, issuedBy: userRef(1, 'QM'),
    closedByUserId: null, closedBy: undefined, notes: null, operationId: null, isOverdue: false,
    createdAt: 'c-at', updatedAt: 'u-at',
    ...over,
});

/** Seed the movement log so on-hand for `inventoryId` sums to `onHand`. */
const seedOnHand = (inventoryId: number, onHand: number) =>
    queue('quartermaster_inventory_movements', { data: [{ inventory_id: inventoryId, delta: onHand + 4 }, { inventory_id: inventoryId, delta: -4 }], count: 2 });

beforeEach(() => resetHarness());
afterEach(() => { vi.useRealTimers(); });

// ===========================================================================
// listIssuances / getIssuanceById
// ===========================================================================
describe('listIssuances', () => {
    it('selects the enumerated projection (user embeds are 4 safe columns), newest-first, capped at 200 by default', async () => {
        queue('quartermaster_issuances', { data: [issRow(1)] });
        const out = await listIssuances();
        const [q] = settled('quartermaster_issuances');
        expect(cols(first(q, 'select')![0])).toBe(ISSUANCE_SELECT);
        expect(calls(q, 'eq')).toEqual([]);
        expect(calls(q, 'in')).toEqual([]);
        expect(calls(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'limit')).toEqual([[200]]);
        expect(out).toEqual([issItem(1)]);
    });

    it("status 'open' means requested+active; any other status is an exact match; user/inventory filters apply", async () => {
        await listIssuances({ status: 'open', userId: 9, inventoryId: 5 });
        await listIssuances({ status: 'returned' });
        const [open, ret] = settled('quartermaster_issuances');
        expect(calls(open, 'in')).toEqual([['status', ['requested', 'active']]]);
        expect(calls(open, 'eq')).toEqual([['issued_to_user_id', 9], ['inventory_id', 5]]);
        expect(calls(ret, 'eq')).toEqual([['status', 'returned']]);
        expect(calls(ret, 'in')).toEqual([]);
    });

    it('clamps the limit into [1, 500]', async () => {
        await listIssuances({ limit: 0 });
        await listIssuances({ limit: 9999 });
        await listIssuances({ limit: 10 });
        expect(settled('quartermaster_issuances').map((q) => first(q, 'limit'))).toEqual([[1], [500], [10]]);
    });

    it('maps overdue (active + past due) and every user embed', async () => {
        queue('quartermaster_issuances', { data: [
            issRow(1, { due_back_at: PAST, requested_by: user(9, ''), closed_by: user(3, 'Cy'), closed_by_user_id: 3 }),
            issRow(2, { due_back_at: PAST, status: 'requested' }),
            issRow(3, { due_back_at: FUTURE }),
        ] });
        const [a, b, c] = await listIssuances();
        expect(a).toEqual(issItem(1, {
            dueBackAt: PAST, isOverdue: true, requestedBy: userRef(9, 'Unknown'), closedBy: userRef(3, 'Cy'), closedByUserId: 3,
        }));
        expect(b.isOverdue).toBe(false); // only ACTIVE issuances can be overdue
        expect(c.isOverdue).toBe(false);
    });

    it('[] on 42P01 or null data; high-level throw on any other error', async () => {
        queue('quartermaster_issuances', { error: PG_MISSING }, { data: null }, { error: PG_FAULT });
        await expect(listIssuances()).resolves.toEqual([]);
        await expect(listIssuances()).resolves.toEqual([]);
        await expect(listIssuances()).rejects.toThrow(/^Failed to load issuances$/);
    });
});

describe('getIssuanceById', () => {
    it('fetches one row in the list shape, null when absent, THROWS on error', async () => {
        queue('quartermaster_issuances', { data: issRow(4) }, { data: null }, { error: PG_FAULT });
        await expect(getIssuanceById(4)).resolves.toEqual(issItem(4));
        const [q] = settled('quartermaster_issuances');
        expect(cols(first(q, 'select')![0])).toBe(ISSUANCE_SELECT);
        expect(calls(q, 'eq')).toEqual([['id', 4]]);
        expect(q.terminal).toBe('maybeSingle');
        await expect(getIssuanceById(4)).resolves.toBeNull();
        await expect(getIssuanceById(4)).rejects.toThrow(/^Failed to get issuance slice$/);
    });
});

// ===========================================================================
// requestIssuance
// ===========================================================================
describe('requestIssuance', () => {
    it('rejects a non-positive / non-numeric quantity before any write', async () => {
        for (const bad of [0, -1, 0.5, Number.NaN, 'x']) {
            await expect(requestIssuance(9, { inventoryId: 5, quantity: bad as number })).rejects.toThrow('Quantity must be a positive integer.');
        }
        expect(h.queries).toHaveLength(0);
    });

    it("inserts a 'requested' issuance for the requester by default, attributed to the requester, and broadcasts the id", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-07-08T09:10:11.000Z'));
        queue('quartermaster_issuances', { data: issRow(61, { status: 'requested' }) });
        const out = await requestIssuance(9, { inventoryId: 5, quantity: 2.8 });
        const [q] = settled('quartermaster_issuances');
        expect(first(q, 'insert')).toEqual([{
            inventory_id: 5, issued_to_user_id: 9, quantity: 2, status: 'requested',
            requested_at: '2026-07-08T09:10:11.000Z', due_back_at: null, requested_by_user_id: 9, notes: null, operation_id: null,
        }]);
        expect(cols(first(q, 'select')![0])).toBe(ISSUANCE_SELECT);
        expect(q.terminal).toBe('single');
        expect(broadcastToOrg.mock.calls).toEqual([['qm:issuance_update', { issuanceId: 61 }]]);
        expect(out).toEqual(issItem(61, { status: 'requested' }));
    });

    it('honours an explicit recipient / due date / notes / operation', async () => {
        queue('quartermaster_issuances', { data: issRow(62) });
        await requestIssuance(9, { inventoryId: 5, quantity: 1, issuedToUserId: 12, dueBackAt: FUTURE, notes: 'n', operationId: 77 });
        expect(first(settled('quartermaster_issuances')[0], 'insert')![0]).toMatchObject({
            issued_to_user_id: 12, requested_by_user_id: 9, due_back_at: FUTURE, notes: 'n', operation_id: 77,
        });
    });

    it('throws the high-level message on insert failure without broadcasting', async () => {
        queue('quartermaster_issuances', { error: PG_FAULT });
        await expect(requestIssuance(9, { inventoryId: 5, quantity: 1 })).rejects.toThrow(/^Failed to submit issuance request$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// fulfilIssuance
// ===========================================================================
describe('fulfilIssuance', () => {
    it('looks the issuance up, checks on-hand, calls the proc, and broadcasts both ids', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'requested', inventory_id: 5, quantity: '4' } });
        seedOnHand(5, 4); // exactly enough: the guard is on-hand - qty < 0
        queueRpc('qm_fulfil_issuance', { data: 1 });

        await expect(fulfilIssuance(7, 3)).resolves.toBe(true);

        const [scope] = settled('quartermaster_issuances');
        expect(calls(scope, 'select')).toEqual([['id, status, inventory_id, quantity']]);
        expect(calls(scope, 'eq')).toEqual([['id', 3]]);
        expect(scope.terminal).toBe('maybeSingle');
        expect(calls(settled('quartermaster_inventory_movements')[0], 'in')).toEqual([['inventory_id', [5]]]);
        expect(h.rpcCalls).toEqual([{ fn: 'qm_fulfil_issuance', args: { p_issuance_id: 3, p_actor_id: 7 } }]);
        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:issuance_update', { issuanceId: 3 }],
            ['qm:inventory_update', { inventoryId: 5 }],
        ]);
    });

    it('fails closed on the lookup error, and throws for a missing issuance, without calling the proc', async () => {
        queue('quartermaster_issuances', { error: PG_FAULT }, { data: null });
        await expect(fulfilIssuance(7, 3)).rejects.toThrow(/^Failed to load issuance$/);
        await expect(fulfilIssuance(7, 3)).rejects.toThrow('Issuance not found.');
        expect(h.rpcCalls).toEqual([]);
    });

    it('returns false (no proc, no stock read, no broadcast) when the issuance is not in the requested state', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'active', inventory_id: 5, quantity: 1 } });
        await expect(fulfilIssuance(7, 3)).resolves.toBe(false);
        expect(h.rpcCalls).toEqual([]);
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });

    it('refuses an over-issue with the exact have/need message', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'requested', inventory_id: 5, quantity: 5 } });
        seedOnHand(5, 3);
        await expect(fulfilIssuance(7, 3)).rejects.toThrow('QM_INSUFFICIENT_STOCK: have 3, need 5');
        expect(h.rpcCalls).toEqual([]);
    });

    it('a row with no movements at all has 0 on hand (not "unknown ⇒ allow")', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'requested', inventory_id: 5, quantity: 1 } });
        queue('quartermaster_inventory_movements', { data: [], count: 0 });
        await expect(fulfilIssuance(7, 3)).rejects.toThrow('QM_INSUFFICIENT_STOCK: have 0, need 1');
        expect(h.rpcCalls).toEqual([]);
    });

    it('a missing movement ledger (42P01) is NOT evidence of stock — it fails closed', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'requested', inventory_id: 5, quantity: 1 } });
        queue('quartermaster_inventory_movements', { error: PG_MISSING });
        await expect(fulfilIssuance(7, 3)).rejects.toThrow(/^Failed to compute on-hand quantity$/);
        expect(h.rpcCalls).toEqual([]);
    });

    it('maps a 0 / null proc result to false and surfaces a proc error without broadcasting', async () => {
        for (const data of [0, null]) {
            queue('quartermaster_issuances', { data: { id: 3, status: 'requested', inventory_id: 5, quantity: 1 } });
            seedOnHand(5, 10);
            queueRpc('qm_fulfil_issuance', { data });
            await expect(fulfilIssuance(7, 3)).resolves.toBe(false);
        }
        broadcastToOrg.mockReset();
        queue('quartermaster_issuances', { data: { id: 3, status: 'requested', inventory_id: 5, quantity: 1 } });
        seedOnHand(5, 10);
        queueRpc('qm_fulfil_issuance', { error: { message: 'QM_INSUFFICIENT_STOCK' } });
        await expect(fulfilIssuance(7, 3)).rejects.toThrow(/^Failed to fulfil issuance$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// issueDirect
// ===========================================================================
describe('issueDirect', () => {
    it('proves the inventory row exists, checks on-hand for the truncated qty, calls the proc, returns the new id', async () => {
        queue('quartermaster_inventory', { data: { id: 5 } });
        seedOnHand(5, 3);
        queueRpc('qm_issue_direct', { data: '88' });

        await expect(issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 3.9 })).resolves.toBe(88);

        const [scope] = settled('quartermaster_inventory');
        expect(calls(scope, 'select')).toEqual([['id']]);
        expect(calls(scope, 'eq')).toEqual([['id', 5]]);
        expect(scope.terminal).toBe('maybeSingle');
        expect(h.rpcCalls).toEqual([{ fn: 'qm_issue_direct', args: {
            p_inventory_id: 5, p_issued_to: 9, p_quantity: 3, p_due_back_at: null, p_actor_id: 7, p_notes: null, p_operation_id: null,
        } }]);
        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:issuance_update', { issuanceId: 88 }],
            ['qm:inventory_update', { inventoryId: 5 }],
        ]);
    });

    it('passes due date / notes / operation through', async () => {
        queue('quartermaster_inventory', { data: { id: 5 } });
        seedOnHand(5, 9);
        await issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 1, dueBackAt: FUTURE, notes: 'kit', operationId: 4 });
        expect(h.rpcCalls[0].args).toMatchObject({ p_due_back_at: FUTURE, p_notes: 'kit', p_operation_id: 4 });
    });

    it('fails closed on the lookup error and on a missing row, before any stock read or proc call', async () => {
        queue('quartermaster_inventory', { error: PG_FAULT }, { data: null });
        await expect(issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 1 })).rejects.toThrow(/^Failed to load inventory$/);
        await expect(issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 1 })).rejects.toThrow('Inventory item not found.');
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
        expect(h.rpcCalls).toEqual([]);
    });

    it('refuses an over-issue with the exact have/need message', async () => {
        queue('quartermaster_inventory', { data: { id: 5 } });
        seedOnHand(5, 2);
        await expect(issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 3 })).rejects.toThrow('QM_INSUFFICIENT_STOCK: have 2, need 3');
        expect(h.rpcCalls).toEqual([]);
    });

    it('surfaces a proc failure as the high-level message without broadcasting', async () => {
        queue('quartermaster_inventory', { data: { id: 5 } });
        seedOnHand(5, 9);
        queueRpc('qm_issue_direct', { error: { message: 'boom' } });
        await expect(issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 1 })).rejects.toThrow(/^Failed to issue item$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// issueDirectBulk
// ===========================================================================
describe('issueDirectBulk', () => {
    it('rejects an empty / missing kit and a kit over 200 lines, before any read', async () => {
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [] })).rejects.toThrow('Kit must contain at least one item.');
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: undefined as unknown as [] })).rejects.toThrow('Kit must contain at least one item.');
        const lines = Array.from({ length: 201 }, (_, i) => ({ inventoryId: i + 1, quantity: 1 }));
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines })).rejects.toThrow('qm:issue_bulk: kit capped at 200 lines per call (got 201).');
        expect(h.queries).toHaveLength(0);
    });

    it('verifies every DISTINCT id is in scope, sums per-row draws, sends truncated lines, and broadcasts ids', async () => {
        queue('quartermaster_inventory', { data: [{ id: 5 }, { id: 6 }] });
        queue('quartermaster_inventory_movements', { data: [
            { inventory_id: 5, delta: 5 }, { inventory_id: 6, delta: 1 },
        ], count: 2 });
        queueRpc('qm_issue_bulk', { data: [101, '102', 103] });

        const out = await issueDirectBulk(7, {
            issuedToUserId: 9, dueBackAt: FUTURE, notes: 'kit', operationId: 3,
            lines: [{ inventoryId: 5, quantity: 2.7 }, { inventoryId: 6, quantity: 1 }, { inventoryId: 5, quantity: 3 }],
        });

        expect(out).toEqual([101, 102, 103]);
        const [scope] = settled('quartermaster_inventory');
        expect(calls(scope, 'select')).toEqual([['id']]);
        expect(calls(scope, 'in')).toEqual([['id', [5, 6]]]);
        expect(calls(settled('quartermaster_inventory_movements')[0], 'in')).toEqual([['inventory_id', [5, 6]]]);
        expect(h.rpcCalls).toEqual([{ fn: 'qm_issue_bulk', args: {
            p_issued_to: 9, p_due_back_at: FUTURE, p_actor_id: 7, p_notes: 'kit', p_operation_id: 3,
            p_lines: [{ inventory_id: 5, quantity: 2 }, { inventory_id: 6, quantity: 1 }, { inventory_id: 5, quantity: 3 }],
        } }]);
        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:issuance_update', { issuanceIds: [101, 102, 103] }],
            ['qm:inventory_update', { inventoryIds: [5, 6] }],
        ]);
    });

    it('rejects the WHOLE kit when any id is outside this org (no stock read, no proc)', async () => {
        queue('quartermaster_inventory', { data: [{ id: 5 }] });
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 1 }, { inventoryId: 66, quantity: 1 }] }))
            .rejects.toThrow('Inventory item 66 not found in this org.');
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
        expect(h.rpcCalls).toEqual([]);
    });

    it('fails closed on the scope lookup error, and on an empty (null) scope payload', async () => {
        queue('quartermaster_inventory', { error: PG_FAULT }, { data: null });
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 1 }] })).rejects.toThrow(/^Failed to load inventory$/);
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 1 }] })).rejects.toThrow('Inventory item 5 not found in this org.');
        expect(h.rpcCalls).toEqual([]);
    });

    it('sums the draw PER ROW across duplicate lines — two lines each under on-hand can still over-issue', async () => {
        queue('quartermaster_inventory', { data: [{ id: 5 }] });
        seedOnHand(5, 5);
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 3 }, { inventoryId: 5, quantity: 3 }] }))
            .rejects.toThrow('QM_INSUFFICIENT_STOCK: inventory 5 has 5, need 6');
        expect(h.rpcCalls).toEqual([]);
    });

    it('names the short row in the over-issue error', async () => {
        queue('quartermaster_inventory', { data: [{ id: 5 }, { id: 6 }] });
        queue('quartermaster_inventory_movements', { data: [{ inventory_id: 5, delta: 9 }], count: 1 });
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 1 }, { inventoryId: 6, quantity: 2 }] }))
            .rejects.toThrow('QM_INSUFFICIENT_STOCK: inventory 6 has 0, need 2');
        expect(h.rpcCalls).toEqual([]);
    });

    it('a null proc result yields no ids; a proc error throws without broadcasting', async () => {
        queue('quartermaster_inventory', { data: [{ id: 5 }] }, { data: [{ id: 5 }] });
        seedOnHand(5, 9);
        seedOnHand(5, 9);
        queueRpc('qm_issue_bulk', { data: null }, { error: { message: 'x' } });
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 1 }] })).resolves.toEqual([]);
        broadcastToOrg.mockReset();
        await expect(issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 1 }] })).rejects.toThrow(/^Failed to issue kit$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// returnIssuance / writeOffIssuance
// ===========================================================================
describe('returnIssuance', () => {
    it('looks the issuance up, calls the proc with the truncated qty, broadcasts both ids', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'active', inventory_id: 5 } });
        queueRpc('qm_return_issuance', { data: 1 });
        await expect(returnIssuance(7, { issuanceId: 3, returnedQuantity: 1.9, outcome: 'returned_late', notes: 'n' })).resolves.toBe(true);
        const [scope] = settled('quartermaster_issuances');
        expect(calls(scope, 'select')).toEqual([['id, status, inventory_id']]);
        expect(calls(scope, 'eq')).toEqual([['id', 3]]);
        expect(h.rpcCalls).toEqual([{ fn: 'qm_return_issuance', args: {
            p_issuance_id: 3, p_returned_qty: 1, p_outcome: 'returned_late', p_actor_id: 7, p_notes: 'n',
        } }]);
        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:issuance_update', { issuanceId: 3 }], ['qm:inventory_update', { inventoryId: 5 }],
        ]);
    });

    it('throws for a missing issuance and returns false (no proc) unless it is active', async () => {
        queue('quartermaster_issuances', { data: null }, { data: { id: 3, status: 'returned', inventory_id: 5 } });
        await expect(returnIssuance(7, { issuanceId: 3, returnedQuantity: 1, outcome: 'returned_on_time' })).rejects.toThrow('Issuance not found.');
        await expect(returnIssuance(7, { issuanceId: 3, returnedQuantity: 1, outcome: 'returned_on_time' })).resolves.toBe(false);
        expect(h.rpcCalls).toEqual([]);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });

    it('a lookup error never reaches the proc (fails closed as not-found)', async () => {
        queue('quartermaster_issuances', { error: PG_FAULT });
        await expect(returnIssuance(7, { issuanceId: 3, returnedQuantity: 1, outcome: 'returned_on_time' })).rejects.toThrow('Issuance not found.');
        expect(h.rpcCalls).toEqual([]);
    });

    it('defaults notes to null, maps 0/null to false, and surfaces a proc error without broadcasting', async () => {
        const active = { data: { id: 3, status: 'active', inventory_id: 5 } };
        queue('quartermaster_issuances', active, active, active);
        queueRpc('qm_return_issuance', { data: 0 }, { data: null }, { error: { message: 'outside issued range' } });
        await expect(returnIssuance(7, { issuanceId: 3, returnedQuantity: 0, outcome: 'returned_damaged' })).resolves.toBe(false);
        expect((h.rpcCalls[0].args as { p_notes: unknown }).p_notes).toBeNull();
        await expect(returnIssuance(7, { issuanceId: 3, returnedQuantity: 0, outcome: 'returned_damaged' })).resolves.toBe(false);
        broadcastToOrg.mockReset();
        await expect(returnIssuance(7, { issuanceId: 3, returnedQuantity: 99, outcome: 'returned_damaged' })).rejects.toThrow(/^Failed to close issuance$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('writeOffIssuance', () => {
    it('looks the issuance up, calls the proc, broadcasts the issuance id', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'active' } });
        queueRpc('qm_write_off_issuance', { data: 1 });
        await expect(writeOffIssuance(7, { issuanceId: 3, outcome: 'lost' })).resolves.toBe(true);
        const [scope] = settled('quartermaster_issuances');
        expect(calls(scope, 'select')).toEqual([['id, status']]);
        expect(calls(scope, 'eq')).toEqual([['id', 3]]);
        expect(h.rpcCalls).toEqual([{ fn: 'qm_write_off_issuance', args: { p_issuance_id: 3, p_outcome: 'lost', p_actor_id: 7, p_notes: null } }]);
        expect(broadcastToOrg.mock.calls).toEqual([['qm:issuance_update', { issuanceId: 3 }]]);
    });

    it('throws for a missing issuance; false (no proc) unless active; null result → false; proc error throws', async () => {
        queue('quartermaster_issuances',
            { data: null }, { data: { id: 3, status: 'requested' } },
            { data: { id: 3, status: 'active' } }, { data: { id: 3, status: 'active' } });
        await expect(writeOffIssuance(7, { issuanceId: 3, outcome: 'lost' })).rejects.toThrow('Issuance not found.');
        await expect(writeOffIssuance(7, { issuanceId: 3, outcome: 'lost' })).resolves.toBe(false);
        expect(h.rpcCalls).toEqual([]);
        queueRpc('qm_write_off_issuance', { data: null }, { error: { message: 'x' } });
        await expect(writeOffIssuance(7, { issuanceId: 3, outcome: 'destroyed_in_action', notes: 'boom' })).resolves.toBe(false);
        expect((h.rpcCalls[0].args as { p_notes: unknown }).p_notes).toBe('boom');
        broadcastToOrg.mockReset();
        await expect(writeOffIssuance(7, { issuanceId: 3, outcome: 'lost' })).rejects.toThrow(/^Failed to write off issuance$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// returnIssuanceBulk
// ===========================================================================
describe('returnIssuanceBulk', () => {
    it('rejects an empty / missing selection and more than 200 lines, before any read', async () => {
        await expect(returnIssuanceBulk(7, { lines: [] })).rejects.toThrow('No issuances selected for return.');
        await expect(returnIssuanceBulk(7, { lines: undefined as unknown as [] })).rejects.toThrow('No issuances selected for return.');
        const lines = Array.from({ length: 201 }, (_, i) => ({ issuanceId: i + 1, returnedQuantity: 1, outcome: 'returned_on_time' as const }));
        await expect(returnIssuanceBulk(7, { lines })).rejects.toThrow('qm:return_bulk: return capped at 200 lines per call (got 201).');
        expect(h.queries).toHaveLength(0);
    });

    it('verifies scope for distinct ids, sends truncated lines, broadcasts issuance + de-duplicated inventory ids', async () => {
        queue('quartermaster_issuances', { data: [{ id: 1, inventory_id: 5 }, { id: 2, inventory_id: 5 }, { id: 3, inventory_id: 6 }] });
        queueRpc('qm_return_bulk', { data: '3' });
        const out = await returnIssuanceBulk(7, { notes: 'batch', lines: [
            { issuanceId: 1, returnedQuantity: 1.5, outcome: 'returned_on_time' },
            { issuanceId: 2, returnedQuantity: 2, outcome: 'returned_late' },
            { issuanceId: 3, returnedQuantity: 0, outcome: 'returned_damaged' },
            { issuanceId: 1, returnedQuantity: 1, outcome: 'returned_on_time' },
        ] });
        expect(out).toBe(3);
        const [scope] = settled('quartermaster_issuances');
        expect(calls(scope, 'select')).toEqual([['id, inventory_id']]);
        expect(calls(scope, 'in')).toEqual([['id', [1, 2, 3]]]);
        expect(h.rpcCalls).toEqual([{ fn: 'qm_return_bulk', args: { p_actor_id: 7, p_notes: 'batch', p_lines: [
            { issuance_id: 1, returned_quantity: 1, outcome: 'returned_on_time' },
            { issuance_id: 2, returned_quantity: 2, outcome: 'returned_late' },
            { issuance_id: 3, returned_quantity: 0, outcome: 'returned_damaged' },
            { issuance_id: 1, returned_quantity: 1, outcome: 'returned_on_time' },
        ] } }]);
        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:issuance_update', { issuanceIds: [1, 2, 3] }],
            ['qm:inventory_update', { inventoryIds: [5, 6] }],
        ]);
    });

    it('rejects the WHOLE batch when any issuance is outside this org (or the scope read came back empty)', async () => {
        queue('quartermaster_issuances', { data: [{ id: 1, inventory_id: 5 }] }, { data: null });
        const lines = [
            { issuanceId: 1, returnedQuantity: 1, outcome: 'returned_on_time' as const },
            { issuanceId: 40, returnedQuantity: 1, outcome: 'returned_on_time' as const },
        ];
        await expect(returnIssuanceBulk(7, { lines })).rejects.toThrow('Issuance 40 not found in this org.');
        await expect(returnIssuanceBulk(7, { lines })).rejects.toThrow('Issuance 1 not found in this org.');
        expect(h.rpcCalls).toEqual([]);
    });

    it('fails closed on the scope lookup error; defaults notes to null; null result → 0; proc error throws', async () => {
        queue('quartermaster_issuances', { error: PG_FAULT });
        const line = [{ issuanceId: 1, returnedQuantity: 1, outcome: 'returned_on_time' as const }];
        await expect(returnIssuanceBulk(7, { lines: line })).rejects.toThrow(/^Failed to load issuances$/);
        expect(h.rpcCalls).toEqual([]);

        queue('quartermaster_issuances', { data: [{ id: 1, inventory_id: 5 }] }, { data: [{ id: 1, inventory_id: 5 }] });
        queueRpc('qm_return_bulk', { data: null }, { error: { message: 'x' } });
        await expect(returnIssuanceBulk(7, { lines: line })).resolves.toBe(0);
        expect((h.rpcCalls[0].args as { p_notes: unknown }).p_notes).toBeNull();
        broadcastToOrg.mockReset();
        await expect(returnIssuanceBulk(7, { lines: line })).rejects.toThrow(/^Failed to close issuances$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// listMemberRecords
// ===========================================================================
describe('listMemberRecords', () => {
    it('reads ALL open issuances (uncapped) ordered by due date, nulls last', async () => {
        await listMemberRecords();
        const [q] = settled('quartermaster_issuances');
        expect(cols(first(q, 'select')![0])).toBe(ISSUANCE_SELECT);
        expect(calls(q, 'in')).toEqual([['status', ['requested', 'active']]]);
        expect(calls(q, 'order')).toEqual([['due_back_at', { ascending: true, nullsFirst: false }]]);
        expect(calls(q, 'limit')).toEqual([]);
    });

    it('groups per recipient, counts overdue actives, sums quantity, and sorts overdue → open count → name', async () => {
        const zed = user(1, 'Zed'); const amy = user(2, 'Amy'); const bob = user(3, 'Bob'); const abe = user(4, 'Abe');
        queue('quartermaster_issuances', { data: [
            issRow(10, { issued_to_user_id: 2, issued_to: amy, status: 'requested', quantity: 1 }),
            issRow(11, { issued_to_user_id: 1, issued_to: zed, status: 'active', due_back_at: PAST, quantity: 2 }),
            issRow(12, { issued_to_user_id: 3, issued_to: bob, status: 'active', quantity: 1 }),
            issRow(13, { issued_to_user_id: 3, issued_to: bob, status: 'active', quantity: 4 }),
            issRow(14, { issued_to_user_id: 1, issued_to: zed, status: 'active', due_back_at: FUTURE, quantity: 3 }),
            issRow(15, { issued_to_user_id: 4, issued_to: abe, status: 'active', quantity: 1 }),
            issRow(16, { issued_to_user_id: 8, issued_to: null, status: 'active', quantity: 50 }), // deleted user: skipped
        ] });
        const out = await listMemberRecords();
        expect(out.map((r) => [r.user.name, r.overdueCount, r.active.length, r.requested.length, r.totalQuantity])).toEqual([
            ['Zed', 1, 2, 0, 5],
            ['Bob', 0, 2, 0, 5],
            ['Abe', 0, 1, 0, 1],
            ['Amy', 0, 0, 1, 1],
        ]);
        expect(out[0].user).toEqual(userRef(1, 'Zed'));
        expect(out[0].active.map((i) => i.id)).toEqual([11, 14]);
        expect(out[3].requested.map((i) => i.id)).toEqual([10]);
    });

    it('[] on 42P01; high-level throw on any other error', async () => {
        queue('quartermaster_issuances', { error: PG_MISSING }, { error: PG_FAULT });
        await expect(listMemberRecords()).resolves.toEqual([]);
        await expect(listMemberRecords()).rejects.toThrow(/^Failed to load member records$/);
    });
});

// ===========================================================================
// getQuartermasterOverview
// ===========================================================================
describe('getQuartermasterOverview', () => {
    it('one SQL aggregate + the 10 most recent issuances, numerically coerced', async () => {
        queueRpc('qm_overview_stats', { data: [{ total_items: '12', distinct_skus: 3, items_on_issue: null, overdue_count: 1, pending_requests: 2 }] });
        queue('quartermaster_issuances', { data: [issRow(1)] });
        await expect(getQuartermasterOverview()).resolves.toEqual({
            totalItems: 12, distinctSkus: 3, itemsOnIssue: 0, overdueCount: 1, pendingRequests: 2, recentIssuances: [issItem(1)],
        });
        expect(h.rpcCalls).toEqual([{ fn: 'qm_overview_stats', args: {} }]);
        expect(calls(settled('quartermaster_issuances')[0], 'limit')).toEqual([[10]]);
    });

    it('zeros when the aggregate returns no row', async () => {
        queueRpc('qm_overview_stats', { data: [] });
        await expect(getQuartermasterOverview()).resolves.toEqual({
            totalItems: 0, distinctSkus: 0, itemsOnIssue: 0, overdueCount: 0, pendingRequests: 0, recentIssuances: [],
        });
        queueRpc('qm_overview_stats', { data: null });
        expect((await getQuartermasterOverview()).totalItems).toBe(0);
    });

    it('fails closed on an aggregate error and on a recent-issuance read error', async () => {
        queueRpc('qm_overview_stats', { error: { message: 'x' } });
        await expect(getQuartermasterOverview()).rejects.toThrow(/^Failed to load overview stats$/);
        queue('quartermaster_issuances', { error: PG_FAULT });
        await expect(getQuartermasterOverview()).rejects.toThrow(/^Failed to load issuances$/);
    });
});

// ===========================================================================
// listOverdueIssuances
// ===========================================================================
describe('listOverdueIssuances', () => {
    it('scans ACTIVE issuances with a due date strictly before now, enumerated columns, name fallbacks', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-08-09T10:11:12.000Z'));
        queue('quartermaster_issuances', { data: [
            { id: 1, issued_to_user_id: 9, quantity: 2, due_back_at: PAST, inventory: { custom_name: 'Rope', catalog: { name: 'Rifle' } } },
            { id: 2, issued_to_user_id: 8, quantity: 1, due_back_at: PAST, inventory: { custom_name: 'Rope', catalog: null } },
            { id: 3, issued_to_user_id: 7, quantity: 3, due_back_at: PAST, inventory: null },
        ] });
        await expect(listOverdueIssuances()).resolves.toEqual([
            { id: 1, issuedToUserId: 9, inventoryName: 'Rifle', quantity: 2, dueBackAt: PAST },
            { id: 2, issuedToUserId: 8, inventoryName: 'Rope', quantity: 1, dueBackAt: PAST },
            { id: 3, issuedToUserId: 7, inventoryName: 'Item', quantity: 3, dueBackAt: PAST },
        ]);
        const [q] = settled('quartermaster_issuances');
        expect(calls(q, 'select')).toEqual([['id, issued_to_user_id, quantity, due_back_at, inventory:quartermaster_inventory(custom_name, catalog:quartermaster_catalog(name))']]);
        expect(calls(q, 'eq')).toEqual([['status', 'active']]);
        expect(calls(q, 'not')).toEqual([['due_back_at', 'is', null]]);
        expect(calls(q, 'lt')).toEqual([['due_back_at', '2026-08-09T10:11:12.000Z']]);
    });

    it('[] on 42P01 or null data; high-level throw on any other error', async () => {
        queue('quartermaster_issuances', { error: PG_MISSING }, { data: null }, { error: PG_FAULT });
        await expect(listOverdueIssuances()).resolves.toEqual([]);
        await expect(listOverdueIssuances()).resolves.toEqual([]);
        await expect(listOverdueIssuances()).rejects.toThrow(/^Failed to scan overdue issuances$/);
    });
});

// Reads in the issuance write paths never touch more than the tables they need.
describe('write-path read footprint', () => {
    it('fulfil touches exactly issuance → movements, in that order', async () => {
        queue('quartermaster_issuances', { data: { id: 3, status: 'requested', inventory_id: 5, quantity: 1 } });
        seedOnHand(5, 2);
        await fulfilIssuance(7, 3);
        expect(trace()).toEqual(['quartermaster_issuances:select', 'quartermaster_inventory_movements:select']);
    });
});
