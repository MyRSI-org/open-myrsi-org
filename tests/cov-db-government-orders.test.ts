import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/government/orders.ts — executive orders. Authority rules pinned here:
//   * issuing requires CURRENTLY holding a position with can_issue_orders (and the
//     named one, when given) — at creation AND when a draft is published;
//   * drafts are visible only to their author, on the list and the detail read alike;
//   * only the author edits (drafts only), revokes (active only) or deletes (drafts only).
// The field-by-field wire mapper is pinned by tests/sec-gov-orders; here it is
// exercised through every read.

vi.mock('../lib/db/common', async () => (await import('./cov-db-government-fake')).commonModule());

import {
    fake, on, only, queries, eqs, calls, writeLog, resetFake, assertNoWildcards, govBroadcasts,
} from './cov-db-government-fake';
import {
    listGovernmentOrders, getGovernmentOrder, createGovernmentOrder, updateGovernmentOrder,
    revokeGovernmentOrder, deleteGovernmentOrder, getMyOrderIssuingPositions,
} from '../lib/db/government/orders';

type Row = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ORDER_SELECT = 'id, issuer_position_id, issuer_user_id, number, title, preamble, body, rationale, status, effective_at, expires_at, issued_at, revoked_at, revoked_by_user_id, revoked_by_position_id, revoked_reason, created_at, updated_at, issuer_position:government_positions!government_orders_issuer_position_id_fkey(id, name, icon), issuer:users!government_orders_issuer_user_id_fkey(id, name, avatar_url, rsi_handle), revoked_by:users!government_orders_revoked_by_user_id_fkey(id, name, avatar_url, rsi_handle)';

const order = (over: Row = {}): Row => ({ id: 'O1', issuer_position_id: 5, issuer_user_id: 10, title: 'T', body: 'B', status: 'active', ...over });

beforeEach(() => { resetFake(); });
afterEach(() => {
    assertNoWildcards();
    // Orders are RPC-fetched on demand; no mutation here may emit government_update.
    expect(govBroadcasts()).toEqual([]);
});

describe('listGovernmentOrders', () => {
    it('expires stale active orders, then reads the newest 200 with a total order', async () => {
        on('government_orders', 'select', { data: [] });
        await expect(listGovernmentOrders(10)).resolves.toEqual([]);
        const exp = only('government_orders', 'update');
        expect(exp.values).toEqual({ status: 'expired', updated_at: expect.stringMatching(ISO) });
        expect(eqs(exp)).toEqual({ status: 'active' });
        expect(calls(exp, 'lt')).toEqual([['expires_at', expect.stringMatching(ISO)]]);
        const read = only('government_orders', 'select');
        expect(read.columns).toBe(ORDER_SELECT);
        expect(calls(read, 'order')).toEqual([
            ['issued_at', { ascending: false, nullsFirst: false }],
            ['created_at', { ascending: false }],
            ['id', { ascending: false }],
        ]);
        expect(calls(read, 'limit')).toEqual([[200]]);
        // The expiry sweep runs before the read.
        expect(fake.queries.map(q => q.op)).toEqual(['update', 'select']);
    });

    it('shows other members\' drafts to nobody but their author', async () => {
        on('government_orders', 'select', { data: [order({ id: 'A' }), order({ id: 'D-mine', status: 'draft', issuer_user_id: 10 }), order({ id: 'D-theirs', status: 'draft', issuer_user_id: 11 })] });
        expect((await listGovernmentOrders(10)).map(o => o.id)).toEqual(['A', 'D-mine']);
        expect((await listGovernmentOrders(11)).map(o => o.id)).toEqual(['A', 'D-theirs']);
        expect((await listGovernmentOrders()).map(o => o.id)).toEqual(['A']);
    });

    it('narrows array-shaped embeds to their first row and drops unexpected embed columns', async () => {
        on('government_orders', 'select', { data: [order({
            issuer_position: [{ id: 5, name: 'Chancellor', icon: null, secret: 'x' }],
            issuer: [{ id: 10, name: null, avatar_url: null, rsi_handle: null, email: 'LEAK@x' }],
            revoked_by: 'garbage',
        })] });
        const [o] = await listGovernmentOrders(10);
        expect(o.issuer_position).toEqual({ id: 5, name: 'Chancellor', icon: null });
        expect(o.issuer).toEqual({ id: 10, name: null, avatar_url: null, rsi_handle: null });
        expect(o.revoked_by).toBeNull();
        expect(o.number).toBeNull();
        expect(o.preamble).toBeNull();
    });

    it('maps a complete row field-by-field, and every absent field to null', async () => {
        const full = {
            id: 'F', issuer_position_id: 5, issuer_user_id: 10, number: 'EO-9', title: 'T', preamble: 'P', body: 'B', rationale: 'R',
            status: 'revoked', effective_at: 'e', expires_at: 'x', issued_at: 'i', revoked_at: 'r', revoked_by_user_id: 10,
            revoked_by_position_id: 5, revoked_reason: 'why', created_at: 'c', updated_at: 'u',
            issuer_position: { id: 5, name: 'Chancellor', icon: 'crown' },
            issuer: { id: 10, name: 'Al', avatar_url: 'a', rsi_handle: 'al' },
            revoked_by: { id: 10, name: 'Al', avatar_url: 'a', rsi_handle: 'al' },
        };
        on('government_orders', 'select', { data: [full, { id: 'E', issuer_position: { id: 6 } }] });
        const [f, e] = await listGovernmentOrders(10);
        expect(f).toEqual(full);
        expect(e).toEqual({
            id: 'E', issuer_position_id: null, issuer_user_id: null, number: null, title: null, preamble: null, body: null,
            rationale: null, status: null, effective_at: null, expires_at: null, issued_at: null, revoked_at: null,
            revoked_by_user_id: null, revoked_by_position_id: null, revoked_reason: null, created_at: null, updated_at: null,
            issuer_position: { id: 6, name: null, icon: null }, issuer: null, revoked_by: null,
        });
    });

    it('a failed read is an empty list', async () => {
        on('government_orders', 'select', { error: { message: 'x' } });
        await expect(listGovernmentOrders(10)).resolves.toEqual([]);
    });
});

describe('getGovernmentOrder', () => {
    it('reads one order by id with the same explicit projection', async () => {
        on('government_orders', 'select', { data: order() });
        const o = await getGovernmentOrder('O1', 99);
        const q = only('government_orders', 'select');
        expect(q.columns).toBe(ORDER_SELECT);
        expect(eqs(q)).toEqual({ id: 'O1' });
        expect(q.terminal).toBe('maybeSingle');
        expect(o).toMatchObject({ id: 'O1', status: 'active', issuer_user_id: 10 });
    });

    it('an unknown order is null', async () => {
        on('government_orders', 'select', { data: null });
        await expect(getGovernmentOrder('nope', 10)).resolves.toBeNull();
    });

    it('a draft is visible to its author only (the same rule as the list)', async () => {
        on('government_orders', 'select', { data: order({ status: 'draft' }) });
        await expect(getGovernmentOrder('O1', 11)).resolves.toBeNull();
        await expect(getGovernmentOrder('O1')).resolves.toBeNull();
        await expect(getGovernmentOrder('O1', 10)).resolves.toMatchObject({ id: 'O1', status: 'draft' });
    });
});

describe('getMyOrderIssuingPositions', () => {
    it('returns only currently-held positions that can issue orders', async () => {
        on('government_position_holders', 'select', { data: [
            { position: { id: 1, name: 'Chancellor', icon: 'c', can_issue_orders: true } },
            { position: { id: 2, name: 'Clerk', icon: null, can_issue_orders: false } },
            { position: null },
        ] });
        await expect(getMyOrderIssuingPositions(10)).resolves.toEqual([{ id: 1, name: 'Chancellor', icon: 'c', can_issue_orders: true }]);
        const q = only('government_position_holders', 'select');
        expect(q.columns).toBe('position:government_positions!inner(id, name, icon, can_issue_orders)');
        expect(eqs(q)).toEqual({ user_id: 10 });
        expect(calls(q, 'is')).toEqual([['ended_at', null]]);
    });

    it('a failed read is an empty list', async () => {
        on('government_position_holders', 'select', { error: { message: 'x' } });
        await expect(getMyOrderIssuingPositions(10)).resolves.toEqual([]);
    });
});

describe('createGovernmentOrder', () => {
    const holds = (...positions: Row[]) => on('government_position_holders', 'select', { data: positions.map(position => ({ position })) });

    it.each([
        [{ title: '   ', body: 'B' }],
        [{ title: 'T', body: '  ' }],
        [{ title: undefined, body: 'B' }],
    ])('requires a title and a body (%j), before any read', async (fields) => {
        await expect(createGovernmentOrder({ issuerPositionId: 5, ...fields } as never, 10)).rejects.toThrow('Title and body are required.');
        expect(fake.queries).toEqual([]);
    });

    it('requires currently holding THE named order-issuing position', async () => {
        holds({ id: 5, name: 'Clerk', can_issue_orders: false }, { id: 6, name: 'Chancellor', can_issue_orders: true });
        await expect(createGovernmentOrder({ issuerPositionId: 5, title: 'T', body: 'B' }, 10)).rejects.toThrow('You do not currently hold a position authorized to issue orders.');
        const q = only('government_position_holders', 'select');
        expect(q.columns).toBe('position:government_positions!inner(id, name, can_issue_orders)');
        expect(eqs(q)).toEqual({ user_id: 10 });
        expect(calls(q, 'is')).toEqual([['ended_at', null]]);
        expect(writeLog()).toEqual([]);
    });

    it('an unreadable holdings list refuses', async () => {
        on('government_position_holders', 'select', { error: { message: 'x' } });
        await expect(createGovernmentOrder({ issuerPositionId: 5, title: 'T', body: 'B' }, 10)).rejects.toThrow(/authorized to issue orders/);
        expect(writeLog()).toEqual([]);
    });

    it('a draft: trimmed fields, no issue date, the supplied effective date', async () => {
        holds({ id: 5, name: 'Chancellor', can_issue_orders: true }, null as never);
        on('government_orders', 'insert', { data: order({ status: 'draft' }) });
        const o = await createGovernmentOrder({
            issuerPositionId: 5, title: '  Mobilise  ', body: ' Do it ', number: ' EO-1 ', preamble: ' Whereas ', rationale: ' Art. 3 ',
            effectiveAt: '2026-12-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
        }, 10);
        const ins = only('government_orders', 'insert');
        expect(ins.values).toEqual({
            issuer_position_id: 5, issuer_user_id: 10, number: 'EO-1', title: 'Mobilise', preamble: 'Whereas', body: 'Do it',
            rationale: 'Art. 3', status: 'draft', effective_at: '2026-12-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z', issued_at: null,
        });
        expect(ins.returning).toBe(ORDER_SELECT);
        expect(o).toMatchObject({ id: 'O1', status: 'draft' });
    });

    it('an active order is issued now and takes effect now unless dated', async () => {
        holds({ id: 5, can_issue_orders: true });
        on('government_orders', 'insert', { data: null });
        await expect(createGovernmentOrder({ issuerPositionId: 5, title: 'T', body: 'B', status: 'active', number: '  ', preamble: null }, 10)).resolves.toBeNull();
        const v = only('government_orders', 'insert').values as Row;
        expect(v).toMatchObject({ status: 'active', number: null, preamble: null, rationale: null, expires_at: null });
        expect(v.issued_at).toMatch(ISO);
        expect(v.effective_at).toBe(v.issued_at);
    });

    it('an undated draft has no effective date; an unknown status is a draft', async () => {
        holds({ id: 5, can_issue_orders: true });
        on('government_orders', 'insert', { data: null });
        await createGovernmentOrder({ issuerPositionId: 5, title: 'T', body: 'B', status: 'revoked' as never }, 10);
        expect(only('government_orders', 'insert').values).toMatchObject({ status: 'draft', effective_at: null, issued_at: null });
    });

    it('a write failure surfaces the caller message', async () => {
        holds({ id: 5, can_issue_orders: true });
        on('government_orders', 'insert', { error: { message: 'x' } });
        await expect(createGovernmentOrder({ issuerPositionId: 5, title: 'T', body: 'B' }, 10)).rejects.toThrow('Failed to create order');
    });
});

describe('updateGovernmentOrder', () => {
    const existing = (over: Row = {}) => on('government_orders', 'select', { data: { issuer_user_id: 10, issuer_position_id: 5, status: 'draft', ...over } });

    it('an unknown order, another member\'s order, or a published order is not editable', async () => {
        on('government_orders', 'select', { data: null });
        await expect(updateGovernmentOrder('O1', { title: 'x' }, 10)).rejects.toThrow('Order not found.');
        resetFake();
        existing({ issuer_user_id: 11 });
        await expect(updateGovernmentOrder('O1', { title: 'x' }, 10)).rejects.toThrow('Only the author can edit this order.');
        resetFake();
        existing({ status: 'active' });
        await expect(updateGovernmentOrder('O1', { title: 'x', status: 'active' }, 10)).rejects.toThrow('Published orders cannot be edited. Revoke and issue a replacement if needed.');
        expect(writeLog()).toEqual([]);
    });

    it('edits a draft: trimmed fields, emptied optionals stored as null', async () => {
        existing();
        await updateGovernmentOrder('O1', { title: ' T2 ', body: ' B2 ', preamble: '  ', rationale: ' R ', number: null, effectiveAt: '', expiresAt: 'x' }, 10);
        const read = only('government_orders', 'select');
        expect(eqs(read)).toEqual({ id: 'O1' });
        const u = only('government_orders', 'update');
        expect(u.values).toEqual({ updated_at: expect.stringMatching(ISO), title: 'T2', body: 'B2', preamble: null, rationale: 'R', number: null, effective_at: null, expires_at: 'x' });
        expect(eqs(u)).toEqual({ id: 'O1' });
        // A content edit is not an issuance: no office check.
        expect(queries('government_position_holders')).toHaveLength(0);
    });

    // BUG FIX (pinned): create refused an empty title/body, but an edit could blank
    // either on a draft — and publishing it then issued an order with no title or text.
    it.each([
        ['an empty title', { title: '' }],
        ['a whitespace title', { title: '   ' }],
        ['an empty body', { body: '' }],
        ['a whitespace body', { body: ' \n\t ' }],
        ['a null title', { title: null }],
        ['a non-string body', { body: 42 }],
        ['a blank body on publish', { body: '  ', status: 'active' }],
    ])('refuses %s with the same rule as create, writing nothing', async (_label, patch) => {
        existing();
        await expect(updateGovernmentOrder('O1', patch as never, 10)).rejects.toThrow('Title and body are required.');
        expect(writeLog()).toEqual([]);
        expect(queries('government_position_holders')).toHaveLength(0);
    });

    it('the authorship and draft gates still answer first', async () => {
        existing({ issuer_user_id: 11 });
        await expect(updateGovernmentOrder('O1', { title: '' }, 10)).rejects.toThrow('Only the author can edit this order.');
        resetFake();
        existing({ status: 'active' });
        await expect(updateGovernmentOrder('O1', { title: '' }, 10)).rejects.toThrow('Published orders cannot be edited.');
    });

    it('null optionals clear the field; real values are trimmed', async () => {
        existing();
        await updateGovernmentOrder('O1', { preamble: null, rationale: null, number: ' EO-2 ' }, 10);
        expect(only('government_orders', 'update').values).toEqual({ updated_at: expect.stringMatching(ISO), preamble: null, rationale: null, number: 'EO-2' });
    });

    it('an empty patch only touches updated_at; a write failure surfaces', async () => {
        existing();
        await updateGovernmentOrder('O1', {}, 10);
        expect(only('government_orders', 'update').values).toEqual({ updated_at: expect.stringMatching(ISO) });
        resetFake();
        existing();
        on('government_orders', 'update', { error: { message: 'x' } });
        await expect(updateGovernmentOrder('O1', { title: 'x' }, 10)).rejects.toThrow('Failed to update order');
    });

    describe('publishing a draft (draft → active)', () => {
        const holdsOffice = (canIssue: boolean, id = 5) => on('government_position_holders', 'select', { data: [{ position: { id, name: 'Chancellor', can_issue_orders: canIssue } }] });

        it('issues it now and makes it effective now unless dated', async () => {
            existing();
            holdsOffice(true);
            await updateGovernmentOrder('O1', { status: 'active' }, 10);
            const v = only('government_orders', 'update').values as Row;
            expect(v.status).toBe('active');
            expect(v.issued_at).toMatch(ISO);
            expect(v.effective_at).toBe(v.issued_at);
        });

        it('keeps a supplied effective date — and an explicitly cleared one stays cleared', async () => {
            existing();
            holdsOffice(true);
            await updateGovernmentOrder('O1', { status: 'active', effectiveAt: '2027-01-01T00:00:00.000Z' }, 10);
            expect((only('government_orders', 'update').values as Row).effective_at).toBe('2027-01-01T00:00:00.000Z');
            resetFake();
            existing();
            holdsOffice(true);
            await updateGovernmentOrder('O1', { status: 'active', effectiveAt: null }, 10);
            expect((only('government_orders', 'update').values as Row).effective_at).toBeNull();
        });

        // BUG FIX (pinned): publishing is the act of issuing, but only createGovernmentOrder
        // checked that the author currently holds an order-issuing office. A member could
        // draft an order while in office, be removed from it, and still publish the draft as
        // an order "issued" by that position. Publishing now re-checks the office the draft
        // names, exactly as creating an active order does.
        it('requires the author to STILL hold the draft\'s order-issuing position', async () => {
            existing();
            on('government_position_holders', 'select', { data: [] });
            await expect(updateGovernmentOrder('O1', { status: 'active' }, 10)).rejects.toThrow('You do not currently hold a position authorized to issue orders.');
            expect(queries('government_orders', 'update')).toHaveLength(0);
            const read = only('government_orders', 'select');
            expect(read.columns).toBe('issuer_user_id, issuer_position_id, status');
            const office = only('government_position_holders', 'select');
            expect(eqs(office)).toEqual({ user_id: 10 });
            expect(calls(office, 'is')).toEqual([['ended_at', null]]);
        });

        it('holding a DIFFERENT order-issuing position does not let a draft be published under this one', async () => {
            existing({ issuer_position_id: 5 });
            holdsOffice(true, 6);
            await expect(updateGovernmentOrder('O1', { status: 'active' }, 10)).rejects.toThrow(/authorized to issue orders/);
            expect(queries('government_orders', 'update')).toHaveLength(0);
        });

        it('a position that has lost can_issue_orders cannot publish', async () => {
            existing();
            holdsOffice(false);
            await expect(updateGovernmentOrder('O1', { status: 'active' }, 10)).rejects.toThrow(/authorized to issue orders/);
        });
    });
});

describe('revokeGovernmentOrder', () => {
    const existing = (over: Row = {}) => on('government_orders', 'select', { data: { issuer_user_id: 10, issuer_position_id: 5, status: 'active', ...over } });

    it('refuses an unknown order, a non-active order, or someone else\'s order', async () => {
        on('government_orders', 'select', { data: null });
        await expect(revokeGovernmentOrder('O1', 'r', 10)).rejects.toThrow('Order not found.');
        resetFake();
        existing({ status: 'draft' });
        await expect(revokeGovernmentOrder('O1', 'r', 10)).rejects.toThrow('Cannot revoke an order in status "draft".');
        resetFake();
        existing({ issuer_user_id: 11 });
        await expect(revokeGovernmentOrder('O1', 'r', 10)).rejects.toThrow('Only the author can revoke this order.');
        expect(writeLog()).toEqual([]);
    });

    it('revokes, stamping who, the issuing position and a trimmed, capped reason', async () => {
        existing();
        await revokeGovernmentOrder('O1', `  ${'r'.repeat(600)}  `, 10);
        const read = only('government_orders', 'select');
        expect(read.columns).toBe('issuer_user_id, issuer_position_id, status');
        const u = only('government_orders', 'update');
        const v = u.values as Row;
        expect(v).toMatchObject({ status: 'revoked', revoked_by_user_id: 10, revoked_by_position_id: 5, revoked_at: expect.stringMatching(ISO), updated_at: expect.stringMatching(ISO) });
        expect(v.revoked_reason).toBe('r'.repeat(500));
        expect(eqs(u)).toEqual({ id: 'O1' });
    });

    it('an empty reason is stored as null; a write failure surfaces', async () => {
        existing();
        await revokeGovernmentOrder('O1', '   ', 10);
        expect((only('government_orders', 'update').values as Row).revoked_reason).toBeNull();
        resetFake();
        existing();
        on('government_orders', 'update', { error: { message: 'x' } });
        await expect(revokeGovernmentOrder('O1', undefined as never, 10)).rejects.toThrow('Failed to revoke order');
    });
});

describe('deleteGovernmentOrder', () => {
    const existing = (over: Row = {}) => on('government_orders', 'select', { data: { issuer_user_id: 10, status: 'draft', ...over } });

    it('refuses an unknown order, a published order, or someone else\'s draft', async () => {
        on('government_orders', 'select', { data: null });
        await expect(deleteGovernmentOrder('O1', 10)).rejects.toThrow('Order not found.');
        resetFake();
        existing({ status: 'active' });
        await expect(deleteGovernmentOrder('O1', 10)).rejects.toThrow('Only draft orders can be deleted. Revoke published orders instead.');
        resetFake();
        existing({ issuer_user_id: 11 });
        await expect(deleteGovernmentOrder('O1', 10)).rejects.toThrow('Only the author can delete this draft.');
        expect(writeLog()).toEqual([]);
    });

    it('deletes the author\'s own draft by id; a failure surfaces', async () => {
        existing();
        await deleteGovernmentOrder('O1', 10);
        expect(only('government_orders', 'select').columns).toBe('issuer_user_id, status');
        expect(eqs(only('government_orders', 'delete'))).toEqual({ id: 'O1' });
        resetFake();
        existing();
        on('government_orders', 'delete', { error: { message: 'x' } });
        await expect(deleteGovernmentOrder('O1', 10)).rejects.toThrow('Failed to delete order');
    });
});
