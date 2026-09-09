import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Marketplace security + lifecycle. In this single-org marketplace the only authz
// boundary is per-user ownership / contract-party membership, so every
// id-addressed mutation re-checks it server-side. Also: no over-claim, realtime
// is ids-only, and the warehouse RPCs fire on delivery / reverse on
// cancel-after-delivery.

const h = vi.hoisted(() => ({
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    insertError: null as { code?: string; message: string } | null,
    // Faults ONLY the moderation-column read. Faulting every select would trip the
    // ownership check first, which fails closed on its own and would hide the bug.
    moderationReadError: null as { code?: string; message: string } | null,
    // Simulates a moderator takedown landing BETWEEN the moderation read and the update.
    takedownDuringRead: false,
    nextId: 1,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as Record<string, unknown> | null,
            filters: {} as Record<string, unknown>,
            // `.is(col, null)` predicates, kept separate from .eq() because null-vs-undefined
            // matters: a column that was never set and one explicitly set to null are both
            // "IS NULL" in Postgres.
            isFilters: {} as Record<string, unknown>,
            orClause: null as string | null,
            cols: '' as string,
            // `.in(col, [...])` predicates. This used to be a NO-OP, which is worse
            // than missing: a query narrowed by .in() matched every row instead, so
            // any assertion resting on that narrowing passed for the wrong reason.
            inFilters: {} as Record<string, Set<unknown>>,
            // `.not(col, 'in', '(1,2)')` — the delete-by-exclusion shape.
            notInFilters: {} as Record<string, Set<string>>,
        };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [c, v] of Object.entries(state.filters)) if (r[c] !== v) return false;
            for (const [c, set] of Object.entries(state.inFilters)) if (!set.has(r[c])) return false;
            for (const [c, set] of Object.entries(state.notInFilters)) if (set.has(String(r[c]))) return false;
            for (const [c, v] of Object.entries(state.isFilters)) {
                if (v === null && r[c] !== null && r[c] !== undefined) return false;
                if (v !== null && r[c] !== v) return false;
            }
            if (state.orClause) {
                // only `seller_id.eq.N,buyer_id.eq.N` is used
                const parts = state.orClause.split(',').map((p) => p.split('.'));
                if (!parts.some(([col, , val]) => String(r[col]) === val)) return false;
            }
            return true;
        });
        const b: any = {};
        b.select = (cols?: string) => { state.cols = cols ?? ''; return b; };
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.insert = (values: Record<string, unknown>) => { state.op = 'insert'; state.values = values; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.or = (clause: string) => { state.orClause = clause; return b; };
        // .is() FILTERS — it used to be a no-op, which would let an optimistic predicate
        // that matched nothing (or everything) pass green.
        b.is = (c: string, v: unknown) => { state.isFilters[c] = v; return b; };
        b.in = (c: string, vals: unknown[]) => { state.inFilters[c] = new Set(vals); return b; };
        b.not = (c: string, op: string, val: string) => {
            // Only the `in` form is used, by the consideration replace. Parsed rather
            // than ignored, because ignoring it turns "delete everything except these"
            // into "delete everything" — which passes a naive count assertion.
            if (op === 'in') {
                state.notInFilters[c] = new Set(String(val).replace(/^\(|\)$/g, '').split(',').filter(Boolean));
            }
            return b;
        };
        b.order = () => b; b.limit = () => b; b.ilike = () => b;
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                if (table === 'marketplace_listings' && state.cols.includes('moderation_closed_at')) {
                    if (h.moderationReadError) return Promise.resolve({ data: null, error: h.moderationReadError });
                    const answer = rows().map((r) => ({ moderation_closed_at: r.moderation_closed_at ?? null }));
                    // The takedown lands now — after this read has decided, before the write.
                    if (h.takedownDuringRead) {
                        for (const r of h.tables.marketplace_listings ?? []) r.moderation_closed_at = '2026-06-18T00:00:00Z';
                    }
                    return Promise.resolve({ data: mode === 'single' ? (answer[0] ?? null) : answer, error: null });
                }
                const data = rows();
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (state.op === 'insert') {
                if (h.insertError) return Promise.resolve({ data: null, error: h.insertError });
                // ARRAY INSERTS push one row EACH. This used to object-spread the array,
                // producing a single `{0:{…},1:{…}}` row whose real columns were all
                // undefined — so every assertion about an array-inserted row read
                // undefined and passed. The milestone HTML-strip test had been green
                // that way since it shipped.
                const incoming = Array.isArray(state.values)
                    ? (state.values as Array<Record<string, unknown>>)
                    : [state.values as Record<string, unknown>];
                const written = incoming.map((v) => {
                    const row = { id: `gen-${h.nextId++}`, ...v };
                    list.push(row);
                    h.orgEmits.push({ event: `__insert:${table}`, payload: row });
                    return row;
                });
                return Promise.resolve({
                    data: mode === 'single' ? (written[0] ?? null) : written,
                    error: null,
                });
            }
            if (state.op === 'update') {
                // Return the AFFECTED rows. PostgREST does when you chain .select(), and a
                // caller that treats "zero rows" as a refusal cannot be tested without it.
                const affected = rows();
                for (const r of affected) Object.assign(r, state.values);
                const ids = affected.map((r) => ({ id: r.id }));
                return Promise.resolve({ data: mode === 'single' ? (ids[0] ?? null) : ids, error: null });
            }
            if (state.op === 'delete') { const doomed = new Set(rows()); h.tables[table] = list.filter((r) => !doomed.has(r)); }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: Record<string, unknown>) => {
                h.rpcCalls.push({ fn, args });
                // Emulate the atomic accept RPC: flip a still-proposed contract.
                if (fn === 'marketplace_accept_contract') {
                    const c = (h.tables.marketplace_contracts || []).find((r) => r.id === args.p_contract_id);
                    if (c && c.status === 'proposed') { c.status = 'accepted'; c.accepted_at = 'now'; }
                    return Promise.resolve({ data: 'ok', error: null });
                }
                return Promise.resolve({ data: 'mv-1', error: null });
            },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.orgEmits.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import {
    updateMarketplaceListing, deleteMarketplaceListing, proposeMarketplaceContract,
    acceptMarketplaceContract, markMarketplaceDelivered, confirmMarketplaceReceived,
    cancelMarketplaceContract, rateMarketplaceContract, getMarketplaceContract,
    getMarketplaceListing, getContractRatings, getMarketplaceTraderProfile, createMarketplaceListing,
    listMyMarketplaceListings, getMarketplaceState,
} from '../lib/db/marketplace';

const SELLER = 10, BUYER = 20, STRANGER = 99;

function seedListing(over: Record<string, unknown> = {}) {
    h.tables.marketplace_listings = [{
        id: 'L1', seller_id: SELLER, kind: 'item', listing_type: 'sell', title: 'Widget',
        quantity: 10, quantity_claimed: 0, status: 'active', warehouse_stock_id: null, ...over,
    }];
}
function seedContract(over: Record<string, unknown> = {}) {
    h.tables.marketplace_contracts = [{
        id: 'C1', listing_id: 'L1', seller_id: SELLER, buyer_id: BUYER, kind: 'item', quantity: 2,
        status: 'proposed', proposed_by_id: BUYER, warehouse_stock_id: null, ...over,
    }];
}

beforeEach(() => {
    h.orgEmits = []; h.rpcCalls = []; h.tables = {}; h.insertError = null; h.nextId = 1;
    h.moderationReadError = null; h.takedownDuringRead = false;
});

const ids = () => h.orgEmits.filter((e) => e.event === 'marketplace:update').flatMap((e) => Object.values(e.payload));

describe('listing ownership (M3)', () => {
    it('a non-owner cannot update or delete a listing', async () => {
        seedListing();
        await expect(updateMarketplaceListing('L1', { title: 'hax' }, STRANGER)).rejects.toThrow(/not found or access denied/i);
        await expect(deleteMarketplaceListing('L1', STRANGER)).rejects.toThrow(/not found or access denied/i);
        expect(h.tables.marketplace_listings[0].title).toBe('Widget');     // unchanged
    });
    it('the owner can update', async () => {
        seedListing();
        await updateMarketplaceListing('L1', { title: 'Widget v2' }, SELLER);
        expect(h.tables.marketplace_listings[0].title).toBe('Widget v2');
    });
});

describe('contract-spam dedup (mkt-authz-1)', () => {
    it('refuses a second live contract from the same proposer on a listing', async () => {
        seedListing();
        seedContract({ id: 'C1', proposed_by_id: BUYER, status: 'proposed' });
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, BUYER))
            .rejects.toThrow(/already have an active contract/i);
    });
    it('allows a proposal when the proposer has no live contract on the listing', async () => {
        seedListing();
        h.tables.marketplace_contracts = [];
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, BUYER)).resolves.toBeTruthy();
    });
});

describe('reopen-after-moderation guard (s4-10d / s7b)', () => {
    it('the seller cannot reopen a moderator-closed listing', async () => {
        seedListing({ status: 'closed', moderation_closed_at: '2026-06-18T00:00:00Z' });
        await expect(updateMarketplaceListing('L1', { status: 'active' }, SELLER)).rejects.toThrow(/closed by a moderator/i);
        expect(h.tables.marketplace_listings[0].status).toBe('closed');
    });
    it('the seller can still reopen a self-closed listing (no moderation flag)', async () => {
        seedListing({ status: 'closed' });
        await updateMarketplaceListing('L1', { status: 'active' }, SELLER);
        expect(h.tables.marketplace_listings[0].status).toBe('active');
    });
});

describe('reopen-after-moderation — the guard must FAIL CLOSED, not fail open', () => {
    // The guard used to read `if (!modErr && ...)`: a precondition whose READ FAULT read as
    // SATISFIED. Any error — timeout, reset connection, RLS hiccup — meant "not
    // moderator-closed" and the reopen landed. Latent only while nothing called
    // marketplace:update_listing; the seller UI's Resume button is that caller.
    it('refuses the reopen when the moderation read faults, and does not change the row', async () => {
        seedListing({ status: 'closed', moderation_closed_at: '2026-06-18T00:00:00Z' });
        h.moderationReadError = { code: '08006', message: 'connection reset' };
        await expect(updateMarketplaceListing('L1', { status: 'active' }, SELLER)).rejects.toThrow();
        expect(h.tables.marketplace_listings[0].status).toBe('closed');
    });

    it('refuses even when the row is NOT moderator-closed — a faulted read proves nothing', async () => {
        // The point of failing closed: on a read fault we do not know the moderation state,
        // so the safe answer is to refuse, not to guess the convenient one.
        seedListing({ status: 'closed' });
        h.moderationReadError = { code: '57014', message: 'statement timeout' };
        await expect(updateMarketplaceListing('L1', { status: 'active' }, SELLER)).rejects.toThrow();
        expect(h.tables.marketplace_listings[0].status).toBe('closed');
    });

    it('still soft-fails the SCHEMA-DRIFT codes, so a pre-redeploy DB can reopen normally', async () => {
        // No moderation flag can exist on a database whose column predates the redeploy,
        // so 42703/PGRST204 are the two errors it is safe to treat as "not closed".
        for (const code of ['42703', 'PGRST204']) {
            seedListing({ status: 'closed' });
            h.moderationReadError = { code, message: 'column does not exist' };
            await updateMarketplaceListing('L1', { status: 'active' }, SELLER);
            expect(h.tables.marketplace_listings[0].status).toBe('active');
        }
    });

    it('TOCTOU: a takedown landing between the check and the write is not clobbered', async () => {
        // The read and the update are two statements. Without an optimistic predicate on
        // the write, a moderator takedown that lands in that window is silently undone by
        // the seller's reopen — and the seller is told it worked.
        seedListing({ status: 'closed' });
        h.takedownDuringRead = true;
        await expect(updateMarketplaceListing('L1', { status: 'active' }, SELLER)).rejects.toThrow(/closed by a moderator/i);
        expect(h.tables.marketplace_listings[0].status).toBe('closed');
    });

    it('a moderator-closed listing can still be EDITED and CLOSED by its owner', async () => {
        // The predicate is scoped to the reopen. Blocking every write would strand the
        // seller's own listing rather than protect anything.
        seedListing({ status: 'closed', moderation_closed_at: '2026-06-18T00:00:00Z' });
        await updateMarketplaceListing('L1', { title: 'Renamed' }, SELLER);
        expect(h.tables.marketplace_listings[0].title).toBe('Renamed');
        expect(h.tables.marketplace_listings[0].status).toBe('closed');
    });
});

describe('My Listings — the owner-scoped surface a Pause button depends on', () => {
    // browseMarketplaceListings is status='active' only. Without an owner-scoped read that
    // returns EVERY status, pausing a listing removes it from the only surface that showed
    // it and the seller can never reopen it — the button would be a one-way trap.
    function seedMany() {
        h.tables.marketplace_listings = [
            { id: 'L1', seller_id: SELLER, kind: 'item', listing_type: 'sell', title: 'Live one', quantity: 10, quantity_claimed: 0, status: 'active', warehouse_stock_id: null },
            { id: 'L2', seller_id: SELLER, kind: 'item', listing_type: 'sell', title: 'Paused one', quantity: 10, quantity_claimed: 0, status: 'paused', warehouse_stock_id: null },
            { id: 'L3', seller_id: SELLER, kind: 'item', listing_type: 'sell', title: 'Closed one', quantity: 10, quantity_claimed: 0, status: 'closed', warehouse_stock_id: null },
            { id: 'L4', seller_id: BUYER, kind: 'item', listing_type: 'sell', title: 'Someone else', quantity: 10, quantity_claimed: 0, status: 'paused', warehouse_stock_id: null },
        ];
    }

    it('returns the caller listings in EVERY status', async () => {
        seedMany();
        const mine = await listMyMarketplaceListings(SELLER);
        expect(mine.map((l) => l.id).sort()).toEqual(['L1', 'L2', 'L3']);
        expect(mine.map((l) => l.status).sort()).toEqual(['active', 'closed', 'paused']);
    });

    it('never returns another member listings, including their withdrawn ones', async () => {
        seedMany();
        const mine = await listMyMarketplaceListings(SELLER);
        expect(mine.some((l) => l.id === 'L4')).toBe(false);
        expect(await listMyMarketplaceListings(STRANGER)).toEqual([]);
    });

    it('rides the marketplace subset, so the panel needs no second round-trip', async () => {
        seedMany();
        h.tables.marketplace_contracts = [];
        const state = await getMarketplaceState(SELLER);
        expect(state.marketplaceMyListings.map((l) => l.id).sort()).toEqual(['L1', 'L2', 'L3']);
        // The public board stays active-only — the new key must not widen it.
        expect(state.marketplaceListings.map((l) => l.id)).toEqual(['L1']);
    });

    it('the shared listing projection does NOT carry moderation_closed_at', () => {
        // LISTING_SELECT/toListing/MarketplaceListing are one shared triple used by the
        // public board too, and marketplace:view is customer-grantable. Adding the column
        // for the seller panel would tell every viewer which listings a moderator actioned.
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'marketplace.ts'), 'utf8');
        const at = src.indexOf("const LISTING_SELECT =");
        expect(at, "LISTING_SELECT was renamed").toBeGreaterThan(-1);
        const decl = src.slice(at, src.indexOf(";", at));
        expect(decl).toContain("quantity_claimed");   // sanity: we sliced the real declaration
        expect(decl).not.toContain("moderation_closed_at");
    });
});

describe('the SQL half of the moderation guard (marketplace_release_listing)', () => {
    // updateMarketplaceListing closes the SELLER's route to reopening a taken-down
    // listing. There is a second route that never goes through it at all:
    // marketplace_release_listing runs on contract CANCEL and flips a 'closed' listing
    // back to 'active' if it had auto-closed on quantity. Its reopen CASE had no
    // moderation predicate, so cancelling any contract against a moderator-closed
    // listing resurrected it onto the public board — with moderation_closed_at still
    // stamped, and with no moderator involved. Cancel is the BUYER's control too, so
    // this is not even a route the seller has to walk.
    const SQL = readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8');
    const body = (() => {
        const at = SQL.indexOf('CREATE OR REPLACE FUNCTION public.marketplace_release_listing');
        expect(at, 'marketplace_release_listing is not defined in schema.sql').toBeGreaterThan(-1);
        const open = SQL.indexOf('$$', at);
        return SQL.slice(open + 2, SQL.indexOf('$$', open + 2));
    })();

    it('the reopen arm refuses to resurrect a moderator-closed listing', () => {
        const reopen = /status = CASE([\s\S]*?)THEN 'active' ELSE status END/.exec(body);
        expect(reopen, 'the reopen CASE is gone or was reshaped').not.toBeNull();
        expect(reopen![1]).toContain('moderation_closed_at IS NULL');
    });

    it('still reopens on the ordinary quantity/expiry conditions', () => {
        // The predicate must NARROW the arm, not replace it: a listing that auto-closed
        // on quantity and was never moderated has to come back when stock is released.
        const reopen = /status = CASE([\s\S]*?)THEN 'active' ELSE status END/.exec(body)![1];
        expect(reopen).toContain("status = 'closed'");
        expect(reopen).toContain('quantity_claimed - p_qty) < quantity');
        expect(reopen).toContain('expires_at > now()');
    });
});

describe('propose (M9 no over-claim, own-listing block)', () => {
    it('rejects contracting your own listing', async () => {
        seedListing();
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, SELLER)).rejects.toThrow(/your own listing/i);
    });
    it('rejects over-claiming remaining quantity', async () => {
        seedListing({ quantity: 5, quantity_claimed: 4 }); // only 1 remaining
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 2 }, BUYER)).rejects.toThrow(/remaining/i);
    });
    it('derives parties (sell ⇒ owner=seller, proposer=buyer) and emits an id only', async () => {
        seedListing();
        h.tables.marketplace_contracts = [];
        await proposeMarketplaceContract({ listingId: 'L1', quantity: 2 }, BUYER);
        const c = h.tables.marketplace_contracts[0];
        expect(c.seller_id).toBe(SELLER);
        expect(c.buyer_id).toBe(BUYER);
        expect(c.proposed_by_id).toBe(BUYER);
        // realtime payload carries an id, never the row body.
        expect(ids().length).toBeGreaterThan(0);
        expect(JSON.stringify(h.orgEmits.filter((e) => e.event === 'marketplace:update'))).not.toContain('Widget');
    });
});

describe('contract lifecycle party checks (M3/M4)', () => {
    it('accept: only the NON-proposer party; the proposer cannot self-accept', async () => {
        seedListing(); seedContract({ proposed_by_id: BUYER });
        await expect(acceptMarketplaceContract('C1', BUYER)).rejects.toThrow(/not found or access denied/i);   // proposer
        await expect(acceptMarketplaceContract('C1', STRANGER)).rejects.toThrow(/not found or access denied/i); // outsider
        await acceptMarketplaceContract('C1', SELLER);                       // the counterparty
        expect(h.tables.marketplace_contracts[0].status).toBe('accepted');
    });
    it('mark_delivered: seller only', async () => {
        seedContract({ status: 'accepted' });
        await expect(markMarketplaceDelivered('C1', BUYER)).rejects.toThrow(/not found or access denied/i);
        await expect(markMarketplaceDelivered('C1', STRANGER)).rejects.toThrow(/not found or access denied/i);
        await markMarketplaceDelivered('C1', SELLER);
        expect(h.tables.marketplace_contracts[0].status).toBe('delivered');
    });
    it('confirm_received: buyer only', async () => {
        seedContract({ status: 'delivered' });
        await expect(confirmMarketplaceReceived('C1', SELLER)).rejects.toThrow(/not found or access denied/i);
        await confirmMarketplaceReceived('C1', BUYER);
        expect(h.tables.marketplace_contracts[0].status).toBe('completed');
    });
    it('cancel: a party only; an outsider cannot', async () => {
        seedListing(); seedContract({ status: 'accepted', quantity: 2 });
        await expect(cancelMarketplaceContract('C1', STRANGER, 'x')).rejects.toThrow(/not found or access denied/i);
        await cancelMarketplaceContract('C1', SELLER, 'changed mind');
        expect(h.tables.marketplace_contracts[0].status).toBe('cancelled');
    });
    it('get_contract returns null for a non-party (no existence disclosure)', async () => {
        seedContract({ status: 'accepted' });
        expect(await getMarketplaceContract('C1', STRANGER)).toBeNull();
    });
});

describe('detail-read scoping mirrors the list gate (M3 read-path drift)', () => {
    it('get_listing hides a withdrawn (paused/closed) listing from non-owners, shows it to the owner', async () => {
        seedListing({ status: 'paused' });
        expect(await getMarketplaceListing('L1', STRANGER)).toBeNull();
        expect(await getMarketplaceListing('L1', SELLER)).not.toBeNull();
    });
    it('get_listing returns an active listing to anyone', async () => {
        seedListing({ status: 'active' });
        expect(await getMarketplaceListing('L1', STRANGER)).not.toBeNull();
    });
    it('get_contract_ratings is party-only (no cross-contract feedback enumeration)', async () => {
        seedContract({ status: 'completed' });
        await expect(getContractRatings('C1', STRANGER)).rejects.toThrow(/not found or access denied/i);
        await expect(getContractRatings('C1', BUYER)).resolves.toBeDefined();
    });
});

describe('warehouse fulfilment (M7)', () => {
    // Moving warehouse stock via the marketplace requires the same
    // warehouse:manage bar as a direct stock movement.
    const WAREHOUSE_ACTOR = { permissions: ['warehouse:manage'] };
    it('fires the deliver RPC on a warehouse-linked sell delivery (warehouse:manage)', async () => {
        seedContract({ status: 'accepted', kind: 'item', warehouse_stock_id: 7 });
        await markMarketplaceDelivered('C1', SELLER, WAREHOUSE_ACTOR);
        expect(h.rpcCalls.find((r) => r.fn === 'warehouse_marketplace_deliver')).toMatchObject({ args: { p_contract_id: 'C1', p_actor_id: SELLER } });
    });
    it('M8: rejects warehouse-linked delivery WITHOUT warehouse:manage (no stock moved)', async () => {
        seedContract({ status: 'accepted', kind: 'item', warehouse_stock_id: 7 });
        await expect(markMarketplaceDelivered('C1', SELLER, { permissions: [] })).rejects.toThrow(/warehouse:manage/i);
        expect(h.rpcCalls.find((r) => r.fn === 'warehouse_marketplace_deliver')).toBeUndefined();
    });
    it('does NOT fire the RPC for an unlinked contract', async () => {
        seedContract({ status: 'accepted', kind: 'item', warehouse_stock_id: null });
        await markMarketplaceDelivered('C1', SELLER, WAREHOUSE_ACTOR);
        expect(h.rpcCalls.find((r) => r.fn === 'warehouse_marketplace_deliver')).toBeUndefined();
    });
    it('posts a compensating reversal when a DELIVERED warehouse-linked contract is cancelled (with warehouse:manage)', async () => {
        // The reversal is a real stock movement, so cancelling a delivered
        // warehouse-linked contract requires the warehouse:manage bar (mirrors deliver).
        seedListing(); seedContract({ status: 'delivered', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        await cancelMarketplaceContract('C1', SELLER, 'oops', WAREHOUSE_ACTOR);
        expect(h.rpcCalls.find((r) => r.fn === 'warehouse_marketplace_reverse')).toMatchObject({ args: { p_contract_id: 'C1' } });
    });
    it('mkt#1: rejects cancelling a DELIVERED warehouse-linked contract WITHOUT warehouse:manage (no reversal)', async () => {
        seedListing(); seedContract({ status: 'delivered', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        await expect(cancelMarketplaceContract('C1', SELLER, 'oops', { permissions: [] })).rejects.toThrow(/warehouse:manage/i);
        expect(h.rpcCalls.find((r) => r.fn === 'warehouse_marketplace_reverse')).toBeUndefined();
    });
});

describe('trader profile + listing warehouse link (M3/M8)', () => {
    it('M3: getMarketplaceTraderProfile exposes NO recentRatings (party-confidential feedback withheld)', async () => {
        h.tables.users = [{ id: SELLER, name: 'Trader', rsi_handle: 'trader', avatar_url: null, deleted_at: null }];
        h.tables.marketplace_ratings = [{ id: 'r1', ratee_id: SELLER, rater_id: BUYER, stars: 5, feedback: 'SECRET private feedback', created_at: 't' }];
        h.tables.marketplace_listings = [];
        const profile = await getMarketplaceTraderProfile(SELLER);
        expect(profile).not.toBeNull();
        expect('recentRatings' in (profile as object)).toBe(false);
        // aggregate reputation still derived from stars
        expect(profile!.reputation.ratingCount).toBe(1);
        expect(JSON.stringify(profile)).not.toContain('SECRET private feedback');
    });

    it('M8: createMarketplaceListing rejects a warehouse link without warehouse:manage', async () => {
        h.tables.warehouse_stock = [{ id: 7 }];
        await expect(createMarketplaceListing(
            { kind: 'item', listingType: 'sell', title: 'Stock sale', quantity: 1, warehouseStockId: 7 },
            SELLER, { permissions: [] },
        )).rejects.toThrow(/warehouse:manage/i);
    });

    it('M8: createMarketplaceListing allows a warehouse link WITH warehouse:manage', async () => {
        h.tables.warehouse_stock = [{ id: 7 }];
        await expect(createMarketplaceListing(
            { kind: 'item', listingType: 'sell', title: 'Stock sale', quantity: 1, warehouseStockId: 7 },
            SELLER, { permissions: ['warehouse:manage'] },
        )).resolves.toBeDefined();
    });

    it('I2: strips HTML from listing free-text on create (latent stored-XSS guard)', async () => {
        await createMarketplaceListing(
            { kind: 'item', listingType: 'sell', title: '<b>Widget</b>', description: '<script>steal()</script>desc', location: '<i>HUR</i>', quantity: 1 },
            SELLER,
        );
        const stored = h.tables.marketplace_listings[0];
        // stripHtml removes the MARKUP (tags), leaving harmless plain text — so
        // no '<' survives to be re-interpreted as HTML by a future consumer.
        expect(String(stored.title)).not.toContain('<');
        expect(String(stored.description ?? '')).not.toContain('<');
        expect(String(stored.location ?? '')).not.toContain('<');
    });

    it('L10: clamps a negative / non-finite listing price to null', async () => {
        await createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'A', quantity: 1, priceUec: -500 }, SELLER);
        expect(h.tables.marketplace_listings[0].price_uec).toBeNull();
        h.tables.marketplace_listings = [];
        await createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'B', quantity: 1, priceUec: Number.POSITIVE_INFINITY }, SELLER);
        expect(h.tables.marketplace_listings[0].price_uec).toBeNull();
    });

    it('L10: keeps a valid price (floored)', async () => {
        await createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'C', quantity: 1, priceUec: 1234.9 }, SELLER);
        expect(h.tables.marketplace_listings[0].price_uec).toBe(1234);
    });

    it('I2 (sweep): strips HTML from proposed milestone title/description', async () => {
        seedListing();
        await proposeMarketplaceContract(
            { listingId: 'L1', quantity: 1, milestones: [{ title: '<b>Phase</b>', description: '<script>x</script>do it' }] },
            BUYER,
        );
        const ms = h.tables.marketplace_contract_milestones?.[0];
        expect(ms).toBeDefined();
        expect(String(ms.title)).not.toContain('<');
        expect(String(ms.description ?? '')).not.toContain('<');
    });

    it('I2 (sweep): strips HTML from cancel_reason (it rides CONTRACT_SELECT to the wire)', async () => {
        seedListing(); seedContract({ status: 'accepted' });
        await cancelMarketplaceContract('C1', SELLER, '<img src=x onerror=alert(1)>reason');
        expect(String(h.tables.marketplace_contracts[0].cancel_reason)).not.toContain('<');
    });
});

describe('rating (M9)', () => {
    it('only on a completed contract', async () => {
        seedContract({ status: 'delivered' });
        await expect(rateMarketplaceContract('C1', { stars: 5 }, BUYER)).rejects.toThrow(/completed/i);
    });
    it('rejects a non-party', async () => {
        seedContract({ status: 'completed' });
        await expect(rateMarketplaceContract('C1', { stars: 5 }, STRANGER)).rejects.toThrow(/not found or access denied/i);
    });
    it('maps the UNIQUE violation to a friendly "already rated"', async () => {
        seedContract({ status: 'completed' });
        h.insertError = { code: '23505', message: 'duplicate key' };
        await expect(rateMarketplaceContract('C1', { stars: 4 }, BUYER)).rejects.toThrow(/already rated/i);
    });
});

describe('a trader profile is scoped to the MARKET, not to the users table', () => {
    // marketplace:get_profile takes a caller-chosen targetUserId and used to answer it
    // for any live member — name, RSI handle, avatar. That is a directory side door out
    // of a module whose whole authz model is per-user ownership with no role gate: walk
    // the id space and rebuild the roster. Phase 3 took the roster off the boot bundle
    // for exactly this reason, and an id-addressed identity lookup here hands it back.
    const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'marketplace.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function getMarketplaceTraderProfile'), src.indexOf('export async function filterContractIdsForParty'));

    it('returns nothing for a member who is not in the market and is not the caller', () => {
        expect(fn).toMatch(/if \(!isSelf && !inMarket\) return null;/);
    });

    it('judges participation on listings AND rating history, not on existence', () => {
        expect(fn).toMatch(/listingRows[\s\S]*\.length > 0 \|\| reputation\.ratingCount > 0/);
    });

    it('the caller identity comes from the dispatcher actor, never the payload', () => {
        const actions = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'marketplace.ts'), 'utf8');
        const handler = actions.slice(actions.indexOf("'marketplace:get_profile'"), actions.indexOf("'marketplace:get_contract_ratings'"));
        expect(handler).toMatch(/getMarketplaceTraderProfile\(targetUserId, userId\)/);
        // ACTOR_ID_FIELDS forces `userId`; targetUserId is deliberately NOT forced.
        expect(handler).toMatch(/TargetUserPayload & Actor/);
    });
});
