import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/actions/quartermaster.ts — the qm:* RPC handlers. The dispatcher has already
// authorised the action and forced the actor id (userId) by the time these run, so
// what they own is:
//   · forwarding EXACTLY the fields each db function takes (nothing the caller adds
//     rides through, and the actor id is never confused with a filter);
//   · the facet parser shared by list + count — the attribute keys land in a JSONB
//     containment filter, so the server-side allowlist and length caps are the bound;
//   · the side effects: who gets told about an issuance, with what, and that a failed
//     notification never fails a committed write.

const h = vi.hoisted(() => {
    const names = [
        'listCatalog', 'searchCatalog', 'createCatalogItem', 'updateCatalogItem', 'deleteCatalogItem',
        'getCatalogItemById', 'listQmLocations', 'createQmLocation', 'updateQmLocation', 'deleteQmLocation',
        'getQmLocationById', 'listInventory', 'listInventoryCount', 'getArmoryFacets', 'createInventoryItem',
        'updateInventoryItem', 'adjustInventoryStock', 'setInventoryTotal', 'listIssuances', 'getIssuanceById',
        'requestIssuance', 'fulfilIssuance', 'issueDirect', 'issueDirectBulk', 'returnIssuance',
        'returnIssuanceBulk', 'listMemberRecords', 'writeOffIssuance', 'getQuartermasterOverview',
        'listLowStockInventory', 'exportInventoryCsv', 'listOverdueIssuances', 'createNotification',
    ];
    const db: Record<string, ReturnType<typeof vi.fn>> & { FACETABLE_ATTR_KEYS?: readonly string[] } = {};
    for (const n of names) db[n] = vi.fn();
    db.FACETABLE_ATTR_KEYS = ['Grade', 'Class', 'Weapon Type'];
    return {
        db,
        names,
        push: vi.fn(),
        warn: vi.fn(),
    };
});

vi.mock('../lib/db', () => h.db);
vi.mock('../lib/push', () => ({ sendPushToPermission: h.push }));
vi.mock('../lib/log', () => {
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: h.warn, child: () => logger };
    return { log: logger };
});

import { quartermasterActions } from '../api/actions/quartermaster';

type Handler = (payload: unknown) => Promise<unknown>;
const ACTIONS = quartermasterActions as unknown as Record<string, Handler>;
const run = (action: string, payload: unknown = {}) => ACTIONS[action](payload);
const fn = (name: string) => h.db[name] as ReturnType<typeof vi.fn>;
const dbCallCount = () => h.names.reduce((n, name) => n + fn(name).mock.calls.length, 0);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
    vi.resetAllMocks();
    h.push.mockResolvedValue(undefined);
    // The real createNotification is async; the handlers chain .catch() on it.
    fn('createNotification').mockResolvedValue(null);
});
afterEach(() => {
    vi.useRealTimers();
});

// ── Plain forwarding ─────────────────────────────────────────────────────────
// Every payload below carries hostile extras (an `id`, a `source`, a spoofed owner)
// that must NOT reach the db layer; toStrictEqual fails on any extra key.
const PASS_THROUGH: Array<[string, Record<string, unknown>, string, unknown[]]> = [
    ['qm:list_catalog', { evil: 1 }, 'listCatalog', []],
    ['qm:search_catalog', { query: 'arc', source: 'platform', limit: 5, evil: 1 }, 'searchCatalog',
        [{ query: 'arc', source: 'platform', limit: 5 }]],
    ['qm:create_catalog_item',
        { name: 'Arclight', category: 'weapon', subcategory: 'Pistol', attributes: { Grade: 'A' }, thumbnailUrl: 't', wikiUrl: 'w', id: 9, source: 'platform' },
        'createCatalogItem',
        [{ name: 'Arclight', category: 'weapon', subcategory: 'Pistol', attributes: { Grade: 'A' }, thumbnailUrl: 't', wikiUrl: 'w' }]],
    ['qm:update_catalog_item',
        { catalogId: 4, name: 'N', category: 'armor', subcategory: null, attributes: {}, thumbnailUrl: null, wikiUrl: null, source: 'platform' },
        'updateCatalogItem',
        [{ id: 4, name: 'N', category: 'armor', subcategory: null, attributes: {}, thumbnailUrl: null, wikiUrl: null }]],
    ['qm:delete_catalog_item', { catalogId: 4, id: 99 }, 'deleteCatalogItem', [4]],
    ['qm:get_catalog_item', { catalogId: 4 }, 'getCatalogItemById', [4]],
    ['qm:list_locations', {}, 'listQmLocations', []],
    ['qm:create_location', { name: 'Bay', type: 'station', parentId: 2, description: 'd', sortOrder: 3, id: 9 }, 'createQmLocation',
        [{ name: 'Bay', type: 'station', parentId: 2, description: 'd', sortOrder: 3 }]],
    ['qm:update_location', { locationId: 5, name: 'Bay', type: 'ship', parentId: null, description: null, sortOrder: 1 }, 'updateQmLocation',
        [{ id: 5, name: 'Bay', type: 'ship', parentId: null, description: null, sortOrder: 1 }]],
    ['qm:delete_location', { locationId: 5 }, 'deleteQmLocation', [5]],
    ['qm:get_location', { locationId: 5 }, 'getQmLocationById', [5]],
    ['qm:create_inventory',
        { userId: 7, catalogId: 4, customName: 'c', locationId: 5, condition: 'good', initialQuantity: 3, notes: 'n', isArchived: true },
        'createInventoryItem',
        [7, { catalogId: 4, customName: 'c', locationId: 5, condition: 'good', initialQuantity: 3, notes: 'n' }]],
    ['qm:update_inventory',
        { inventoryId: 8, locationId: 5, condition: 'damaged', notes: 'n', customName: 'c', isArchived: false, userId: 7, quantity: 999 },
        'updateInventoryItem',
        [{ id: 8, locationId: 5, condition: 'damaged', notes: 'n', customName: 'c', isArchived: false }]],
    ['qm:adjust_inventory', { userId: 7, inventoryId: 8, delta: -2, reason: 'loss', notes: 'n', targetTotal: 0 }, 'adjustInventoryStock',
        [7, { inventoryId: 8, delta: -2, reason: 'loss', notes: 'n' }]],
    ['qm:set_inventory_total', { userId: 7, inventoryId: 8, targetTotal: 10, reason: 'adjust', notes: null, delta: 5 }, 'setInventoryTotal',
        [7, { inventoryId: 8, targetTotal: 10, reason: 'adjust', notes: null }]],
    ['qm:get_issuance', { issuanceId: 12 }, 'getIssuanceById', [12]],
    ['qm:return_issuance', { userId: 7, issuanceId: 12, returnedQuantity: 1, outcome: 'returned_late', notes: 'n', status: 'closed' }, 'returnIssuance',
        [7, { issuanceId: 12, returnedQuantity: 1, outcome: 'returned_late', notes: 'n' }]],
    ['qm:return_bulk', { userId: 7, lines: [{ issuanceId: 1, returnedQuantity: 1, outcome: 'returned_on_time' }], notes: 'n' }, 'returnIssuanceBulk',
        [7, { lines: [{ issuanceId: 1, returnedQuantity: 1, outcome: 'returned_on_time' }], notes: 'n' }]],
    ['qm:list_member_records', {}, 'listMemberRecords', []],
    ['qm:write_off_issuance', { userId: 7, issuanceId: 12, outcome: 'lost', notes: 'n' }, 'writeOffIssuance',
        [7, { issuanceId: 12, outcome: 'lost', notes: 'n' }]],
    ['qm:get_overview', {}, 'getQuartermasterOverview', []],
    ['qm:list_overdue', {}, 'listOverdueIssuances', []],
];

// Handlers that wrap the db result instead of returning it verbatim.
const WRAPPED: Record<string, (r: unknown) => unknown> = {
    'qm:return_issuance': (r) => ({ applied: r }),
    'qm:return_bulk': (r) => ({ closed: r }),
    'qm:write_off_issuance': (r) => ({ applied: r }),
};

describe('qm handlers forward exactly their own fields to their db function', () => {
    it.each(PASS_THROUGH)('%s → %s', async (action, payload, dbFn, args) => {
        const result = { marker: action };
        fn(dbFn).mockResolvedValueOnce(result);
        const out = await run(action, payload);
        expect(out).toStrictEqual(WRAPPED[action] ? WRAPPED[action](result) : result);
        expect(fn(dbFn)).toHaveBeenCalledTimes(1);
        expect(fn(dbFn).mock.calls[0]).toStrictEqual(args);
        // One db call, and no side effects: no push, no notification.
        expect(dbCallCount()).toBe(1);
        expect(h.push).not.toHaveBeenCalled();
    });

    it('write-wrapping handlers report the db verdict, including a refusal', async () => {
        fn('returnIssuance').mockResolvedValueOnce(false);
        await expect(run('qm:return_issuance', { userId: 1, issuanceId: 2, returnedQuantity: 1, outcome: 'returned_on_time' }))
            .resolves.toStrictEqual({ applied: false });
        fn('writeOffIssuance').mockResolvedValueOnce(true);
        await expect(run('qm:write_off_issuance', { userId: 1, issuanceId: 2, outcome: 'destroyed_in_action' }))
            .resolves.toStrictEqual({ applied: true });
        fn('returnIssuanceBulk').mockResolvedValueOnce(0);
        await expect(run('qm:return_bulk', { userId: 1, lines: [] })).resolves.toStrictEqual({ closed: 0 });
    });

    it('a db failure propagates — no handler turns a thrown write into a success shape', async () => {
        fn('writeOffIssuance').mockRejectedValueOnce(new Error('Issuance not found.'));
        await expect(run('qm:write_off_issuance', { userId: 1, issuanceId: 2, outcome: 'lost' }))
            .rejects.toThrow('Issuance not found.');
        fn('setInventoryTotal').mockRejectedValueOnce(new Error('QM_INSUFFICIENT_STOCK'));
        await expect(run('qm:set_inventory_total', { userId: 1, inventoryId: 2, targetTotal: -1, reason: 'adjust' }))
            .rejects.toThrow('QM_INSUFFICIENT_STOCK');
    });
});

describe('qm:list_issuances filters on userIdFilter, never on the forced actor id', () => {
    it('maps userIdFilter → userId and ignores the actor userId', async () => {
        fn('listIssuances').mockResolvedValueOnce([{ id: 1 }]);
        const out = await run('qm:list_issuances', { userId: 7, status: 'open', userIdFilter: 3, inventoryId: 8, limit: 50 });
        expect(out).toStrictEqual([{ id: 1 }]);
        expect(fn('listIssuances').mock.calls[0]).toStrictEqual([{ status: 'open', userId: 3, inventoryId: 8, limit: 50 }]);
    });

    it('with no filter the actor id does not narrow the list to the officer', async () => {
        fn('listIssuances').mockResolvedValueOnce([]);
        await run('qm:list_issuances', { userId: 7 });
        expect(fn('listIssuances').mock.calls[0]).toStrictEqual([{ status: undefined, userId: undefined, inventoryId: undefined, limit: undefined }]);
    });
});

// ── Inventory facets ─────────────────────────────────────────────────────────
describe('inventory facet parsing (list + count share one parser)', () => {
    const FULL = {
        includeArchived: 'yes',
        locationId: '7',
        catalogId: 0,
        search: 'rifle',
        limit: 25,
        offset: 50,
        category: ' weapon ',
        subcategory: '  Rifles ',
        sizeLabel: ' S3 ',
        manufacturer: 'Behring',
        itemKind: 'vehicle',
        attributes: { Grade: ' A ', Evil: 'x', Class: '   ', 'Weapon Type': 42 },
        userId: 7,
    };
    const FULL_FACETS = {
        category: 'weapon',
        subcategory: 'Rifles',
        sizeLabel: 'S3',
        manufacturer: 'Behring',
        itemKind: 'vehicle',
        attributes: { Grade: 'A' },
    };

    it('list: coerces ids, keeps typed paging, trims facets and drops non-allowlisted attribute keys', async () => {
        fn('listInventory').mockResolvedValueOnce({ rows: [] });
        await expect(run('qm:list_inventory', FULL)).resolves.toStrictEqual({ rows: [] });
        expect(fn('listInventory').mock.calls[0]).toStrictEqual([{
            includeArchived: true,
            locationId: 7,
            // 0 is a real id value, not "absent" — the != null test keeps it.
            catalogId: 0,
            search: 'rifle',
            limit: 25,
            offset: 50,
            ...FULL_FACETS,
        }]);
    });

    it('count: the SAME facet object as the list, and no paging keys at all', async () => {
        fn('listInventory').mockResolvedValueOnce([]);
        fn('listInventoryCount').mockResolvedValueOnce(12);
        await run('qm:list_inventory', FULL);
        await expect(run('qm:count_inventory', FULL)).resolves.toBe(12);
        const listArg = fn('listInventory').mock.calls[0][0] as Record<string, unknown>;
        const countArg = fn('listInventoryCount').mock.calls[0][0] as Record<string, unknown>;
        const { limit: _l, offset: _o, ...listWithoutPaging } = listArg;
        expect(countArg).toStrictEqual(listWithoutPaging);
        expect('limit' in countArg || 'offset' in countArg).toBe(false);
    });

    it('wrongly-typed or unusable inputs collapse to null/undefined rather than reaching the query', async () => {
        fn('listInventory').mockResolvedValueOnce([]);
        await run('qm:list_inventory', {
            locationId: null,
            search: 42,
            limit: '10',
            offset: '5',
            category: 'spaceship',
            subcategory: '   ',
            sizeLabel: 7,
            manufacturer: 'x'.repeat(200),
            itemKind: 'VEHICLE',
            attributes: ['Grade'],
        });
        expect(fn('listInventory').mock.calls[0]).toStrictEqual([{
            includeArchived: false,
            locationId: null,
            catalogId: null,
            search: undefined,
            limit: undefined,
            offset: undefined,
            category: null,
            subcategory: null,
            sizeLabel: null,
            // Bounded at 80 characters, not dropped.
            manufacturer: 'x'.repeat(80),
            itemKind: null,
            attributes: null,
        }]);
    });

    it('every free-text facet has its own length cap', async () => {
        fn('listInventoryCount').mockResolvedValue(0);
        await run('qm:count_inventory', {
            subcategory: 's'.repeat(100),
            sizeLabel: 'z'.repeat(30),
            itemKind: 'personal',
            attributes: { Grade: 'g'.repeat(100) },
            category: 'weaponry',
        });
        const arg = fn('listInventoryCount').mock.calls[0][0] as Record<string, unknown>;
        expect(arg.subcategory).toBe('s'.repeat(80));
        expect(arg.sizeLabel).toBe('z'.repeat(20));
        expect(arg.itemKind).toBe('personal');
        expect(arg.attributes).toStrictEqual({ Grade: 'g'.repeat(60) });
        // A prefix match is not a category.
        expect(arg.category).toBeNull();
    });

    it('accepts every category on the server allowlist, and nothing else', async () => {
        fn('listInventoryCount').mockResolvedValue(0);
        for (const c of ['weapon', 'armor', 'component', 'consumable', 'misc']) {
            await run('qm:count_inventory', { category: c });
        }
        await run('qm:count_inventory', { category: 'Weapon' });
        await run('qm:count_inventory', { category: { toString: () => 'weapon' } });
        const cats = fn('listInventoryCount').mock.calls.map((c) => (c[0] as Record<string, unknown>).category);
        expect(cats).toStrictEqual(['weapon', 'armor', 'component', 'consumable', 'misc', null, null]);
    });

    it('attributes: only allowlisted keys with usable string values survive; all-filtered → null', async () => {
        fn('listInventoryCount').mockResolvedValue(0);
        await run('qm:count_inventory', { attributes: { Evil: 'x', 'Armor Class': 'Heavy' } });
        await run('qm:count_inventory', { attributes: null });
        await run('qm:count_inventory', { attributes: 'Grade' });
        await run('qm:count_inventory', { attributes: { Class: 'Military', 'Weapon Type': ' Rifle ' } });
        const attrs = fn('listInventoryCount').mock.calls.map((c) => (c[0] as Record<string, unknown>).attributes);
        // 'Armor Class' is a real catalogue key but is not on THIS server's allowlist.
        expect(attrs).toStrictEqual([null, null, null, { Class: 'Military', 'Weapon Type': 'Rifle' }]);
    });

    it('qm:list_inventory_facets forwards only a boolean includeArchived', async () => {
        fn('getArmoryFacets').mockResolvedValueOnce({ categories: [] });
        await expect(run('qm:list_inventory_facets', { includeArchived: 1, category: 'weapon' }))
            .resolves.toStrictEqual({ categories: [] });
        fn('getArmoryFacets').mockResolvedValueOnce({});
        await run('qm:list_inventory_facets', {});
        expect(fn('getArmoryFacets').mock.calls).toStrictEqual([[{ includeArchived: true }], [{ includeArchived: false }]]);
    });

    it('qm:list_low_stock passes numeric threshold/limit and drops anything else', async () => {
        fn('listLowStockInventory').mockResolvedValue([]);
        await run('qm:list_low_stock', { threshold: 3, limit: 20 });
        await run('qm:list_low_stock', { threshold: '3', limit: null });
        expect(fn('listLowStockInventory').mock.calls).toStrictEqual([
            [{ threshold: 3, limit: 20 }],
            [{ threshold: undefined, limit: undefined }],
        ]);
    });
});

// ── Issuance side effects ────────────────────────────────────────────────────
describe('qm:request_issuance pushes to qm:manage and never fails the request on a push fault', () => {
    const payload = { userId: 7, inventoryId: 8, issuedToUserId: 9, quantity: 2, dueBackAt: '2026-11-03', notes: 'n', operationId: 4, status: 'active' };

    it('forwards the request fields and pushes an id-carrying alert naming the catalog item', async () => {
        const issuance = { id: 55, inventory: { catalog: { name: 'Arclight' }, customName: 'ignored' } };
        fn('requestIssuance').mockResolvedValueOnce(issuance);
        await expect(run('qm:request_issuance', payload)).resolves.toBe(issuance);
        expect(fn('requestIssuance').mock.calls[0]).toStrictEqual([7,
            { inventoryId: 8, issuedToUserId: 9, quantity: 2, dueBackAt: '2026-11-03', notes: 'n', operationId: 4 }]);
        expect(h.push).toHaveBeenCalledTimes(1);
        expect(h.push.mock.calls[0]).toStrictEqual(['qm:manage', {
            title: 'Issuance request',
            body: '2× requested · Arclight',
            tag: 'qm-request-55',
            data: { view: 'quartermaster', tab: 'issuances', issuanceId: 55 },
        }]);
    });

    it('falls back to the custom name, then to "item"', async () => {
        fn('requestIssuance')
            .mockResolvedValueOnce({ id: 1, inventory: { catalog: null, customName: 'Field kit' } })
            .mockResolvedValueOnce({ id: 2, inventory: null });
        await run('qm:request_issuance', payload);
        await run('qm:request_issuance', payload);
        expect(h.push.mock.calls.map((c) => (c[1] as { body: string }).body))
            .toStrictEqual(['2× requested · Field kit', '2× requested · item']);
    });

    it('a rejected push is logged and swallowed — the persisted request still returns', async () => {
        const issuance = { id: 3, inventory: null };
        fn('requestIssuance').mockResolvedValueOnce(issuance);
        const err = new Error('push down');
        h.push.mockRejectedValueOnce(err);
        await expect(run('qm:request_issuance', payload)).resolves.toBe(issuance);
        await flush();
        expect(h.warn).toHaveBeenCalledWith('request push failed', { err });
    });

    it('a refused request pushes nothing', async () => {
        fn('requestIssuance').mockRejectedValueOnce(new Error('Quantity must be a positive integer.'));
        await expect(run('qm:request_issuance', { ...payload, quantity: 0 })).rejects.toThrow('Quantity must be a positive integer.');
        expect(h.push).not.toHaveBeenCalled();
    });
});

describe('qm:fulfil_issuance notifies the recipient of THE issuance it fulfilled', () => {
    const fulfilled = { id: 12, issuedToUserId: 9, quantity: 3, inventory: { catalog: { name: 'Arclight' }, customName: null } };

    it('a no-op fulfil (not in requested state) reads nothing more and notifies nobody', async () => {
        fn('fulfilIssuance').mockResolvedValueOnce(false);
        await expect(run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 })).resolves.toStrictEqual({ applied: false });
        expect(fn('fulfilIssuance').mock.calls[0]).toStrictEqual([7, 12]);
        expect(fn('getIssuanceById')).not.toHaveBeenCalled();
        expect(fn('listIssuances')).not.toHaveBeenCalled();
        expect(fn('createNotification')).not.toHaveBeenCalled();
    });

    it('reads the fulfilled row BY ID and writes a durable notification to its recipient', async () => {
        fn('fulfilIssuance').mockResolvedValueOnce(true);
        fn('getIssuanceById').mockResolvedValueOnce(fulfilled);
        await expect(run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 })).resolves.toStrictEqual({ applied: true });
        expect(fn('getIssuanceById').mock.calls).toStrictEqual([[12]]);
        expect(fn('createNotification').mock.calls).toStrictEqual([[9, {
            type: 'qm_issuance',
            title: 'Loadout ready',
            body: 'Your issuance of 3× Arclight has been fulfilled.',
            link: 'quartermaster',
            metadata: { issuanceId: 12 },
        }]]);
    });

    // REGRESSION: the handler used to list the single NEWEST issuance and .find() the
    // fulfilled id in it — so the recipient was told only when the fulfilled row
    // happened to be the most recently created in the whole table. Any older request
    // (the normal case: a queue worked oldest-first) was fulfilled in silence.
    it('still notifies when the fulfilled issuance is not the newest one in the table', async () => {
        fn('fulfilIssuance').mockResolvedValueOnce(true);
        fn('listIssuances').mockResolvedValue([{ id: 99, issuedToUserId: 4, quantity: 1, inventory: null }]);
        fn('getIssuanceById').mockResolvedValueOnce(fulfilled);
        await run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 });
        expect(fn('createNotification')).toHaveBeenCalledTimes(1);
        expect(fn('createNotification').mock.calls[0][0]).toBe(9);
        expect(fn('listIssuances')).not.toHaveBeenCalled();
    });

    it('an officer fulfilling their own issuance is not notified', async () => {
        fn('fulfilIssuance').mockResolvedValueOnce(true);
        fn('getIssuanceById').mockResolvedValueOnce({ ...fulfilled, issuedToUserId: 7 });
        await expect(run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 })).resolves.toStrictEqual({ applied: true });
        expect(fn('createNotification')).not.toHaveBeenCalled();
    });

    it('a row that vanished after the fulfil notifies nobody and still reports applied', async () => {
        fn('fulfilIssuance').mockResolvedValueOnce(true);
        fn('getIssuanceById').mockResolvedValueOnce(null);
        await expect(run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 })).resolves.toStrictEqual({ applied: true });
        expect(fn('createNotification')).not.toHaveBeenCalled();
    });

    it('body falls back to the custom name, then "item"', async () => {
        fn('fulfilIssuance').mockResolvedValue(true);
        fn('getIssuanceById')
            .mockResolvedValueOnce({ ...fulfilled, inventory: { catalog: null, customName: 'Med kit' } })
            .mockResolvedValueOnce({ ...fulfilled, inventory: undefined });
        fn('createNotification').mockResolvedValue(null);
        await run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 });
        await run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 });
        expect(fn('createNotification').mock.calls.map((c) => (c[1] as { body: string }).body)).toStrictEqual([
            'Your issuance of 3× Med kit has been fulfilled.',
            'Your issuance of 3× item has been fulfilled.',
        ]);
    });

    it('a failed notification write is logged and does not fail the committed fulfil', async () => {
        fn('fulfilIssuance').mockResolvedValueOnce(true);
        fn('getIssuanceById').mockResolvedValueOnce(fulfilled);
        const err = new Error('notifications table down');
        fn('createNotification').mockRejectedValueOnce(err);
        await expect(run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 })).resolves.toStrictEqual({ applied: true });
        expect(h.warn).toHaveBeenCalledWith('fulfil notification failed', { err });
    });

    it('a fulfil the db refuses propagates and notifies nobody', async () => {
        fn('fulfilIssuance').mockRejectedValueOnce(new Error('QM_INSUFFICIENT_STOCK: have 0, need 3'));
        await expect(run('qm:fulfil_issuance', { userId: 7, issuanceId: 12 })).rejects.toThrow('QM_INSUFFICIENT_STOCK');
        expect(fn('getIssuanceById')).not.toHaveBeenCalled();
        expect(fn('createNotification')).not.toHaveBeenCalled();
    });
});

describe('qm:issue_direct / qm:issue_bulk notify the recipient, never the issuing officer', () => {
    it('issue_direct forwards the fields and notifies a different recipient with the new id only', async () => {
        fn('issueDirect').mockResolvedValueOnce(77);
        await expect(run('qm:issue_direct', { userId: 7, inventoryId: 8, issuedToUserId: 9, quantity: 2, dueBackAt: null, notes: 'n', operationId: 3, status: 'x' }))
            .resolves.toStrictEqual({ issuanceId: 77 });
        expect(fn('issueDirect').mock.calls[0]).toStrictEqual([7,
            { inventoryId: 8, issuedToUserId: 9, quantity: 2, dueBackAt: null, notes: 'n', operationId: 3 }]);
        expect(fn('createNotification').mock.calls).toStrictEqual([[9, {
            type: 'qm_issuance',
            title: 'Loadout issued',
            body: "You've been issued 2× item by an officer.",
            link: 'quartermaster',
            metadata: { issuanceId: 77 },
        }]]);
    });

    it('issue_direct to self is silent', async () => {
        fn('issueDirect').mockResolvedValueOnce(78);
        await run('qm:issue_direct', { userId: 7, inventoryId: 8, issuedToUserId: 7, quantity: 1 });
        expect(fn('createNotification')).not.toHaveBeenCalled();
    });

    it('issue_direct: a failed notification is logged, the issuance id still returns', async () => {
        fn('issueDirect').mockResolvedValueOnce(79);
        const err = new Error('boom');
        fn('createNotification').mockRejectedValueOnce(err);
        await expect(run('qm:issue_direct', { userId: 7, inventoryId: 8, issuedToUserId: 9, quantity: 1 }))
            .resolves.toStrictEqual({ issuanceId: 79 });
        expect(h.warn).toHaveBeenCalledWith('issue notification failed', { err });
    });

    it('issue_bulk forwards the lines and pluralises the count; metadata carries the first id only', async () => {
        const lines = [{ inventoryId: 1, quantity: 2 }, { inventoryId: 2, quantity: 1 }];
        fn('issueDirectBulk').mockResolvedValueOnce([31, 32]).mockResolvedValueOnce([33]);
        await expect(run('qm:issue_bulk', { userId: 7, issuedToUserId: 9, lines, dueBackAt: 'd', notes: 'n', operationId: 2, inventoryId: 99 }))
            .resolves.toStrictEqual({ issuanceIds: [31, 32] });
        await run('qm:issue_bulk', { userId: 7, issuedToUserId: 9, lines: [lines[0]] });
        expect(fn('issueDirectBulk').mock.calls[0]).toStrictEqual([7,
            { issuedToUserId: 9, lines, dueBackAt: 'd', notes: 'n', operationId: 2 }]);
        expect(fn('createNotification').mock.calls).toStrictEqual([
            [9, { type: 'qm_issuance', title: 'Kit issued', body: 'An officer issued 2 items to you.', link: 'quartermaster', metadata: { issuanceId: 31 } }],
            [9, { type: 'qm_issuance', title: 'Kit issued', body: 'An officer issued 1 item to you.', link: 'quartermaster', metadata: { issuanceId: 33 } }],
        ]);
    });

    it('issue_bulk: nothing issued, or issued to self, notifies nobody', async () => {
        fn('issueDirectBulk').mockResolvedValueOnce([]).mockResolvedValueOnce([40]);
        await expect(run('qm:issue_bulk', { userId: 7, issuedToUserId: 9, lines: [] })).resolves.toStrictEqual({ issuanceIds: [] });
        await run('qm:issue_bulk', { userId: 7, issuedToUserId: 7, lines: [{ inventoryId: 1, quantity: 1 }] });
        expect(fn('createNotification')).not.toHaveBeenCalled();
    });

    it('issue_bulk: a failed notification is logged and swallowed', async () => {
        fn('issueDirectBulk').mockResolvedValueOnce([41]);
        const err = new Error('boom');
        fn('createNotification').mockRejectedValueOnce(err);
        await expect(run('qm:issue_bulk', { userId: 7, issuedToUserId: 9, lines: [{ inventoryId: 1, quantity: 1 }] }))
            .resolves.toStrictEqual({ issuanceIds: [41] });
        expect(h.warn).toHaveBeenCalledWith('bulk issue notification failed', { err });
    });
});

describe('qm:export_csv', () => {
    it('returns the db layer\'s CSV verbatim and stamps the filename with the UTC date', async () => {
        // 23:30 UTC on the 4th is already the 5th in AEST — the filename must not
        // depend on the server's zone.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-03-04T23:30:00Z'));
        const csv = 'name,qty\n"\'=SUM(A1)",3\n';
        fn('exportInventoryCsv').mockResolvedValueOnce(csv);
        await expect(run('qm:export_csv', { filename: '../../etc/passwd' }))
            .resolves.toStrictEqual({ csv, filename: 'inventory-2026-03-04.csv' });
        expect(fn('exportInventoryCsv').mock.calls).toStrictEqual([[]]);
    });

    it('an export failure propagates instead of returning an empty file', async () => {
        fn('exportInventoryCsv').mockRejectedValueOnce(new Error('Failed to compute on-hand quantity'));
        await expect(run('qm:export_csv')).rejects.toThrow('Failed to compute on-hand quantity');
    });
});

describe('module surface', () => {
    it('every exported qm handler is exercised by this file', () => {
        const covered = new Set([
            ...PASS_THROUGH.map(([a]) => a),
            'qm:list_issuances', 'qm:list_inventory', 'qm:count_inventory', 'qm:list_inventory_facets',
            'qm:list_low_stock', 'qm:request_issuance', 'qm:fulfil_issuance', 'qm:issue_direct',
            'qm:issue_bulk', 'qm:export_csv',
        ]);
        expect(Object.keys(ACTIONS).sort()).toStrictEqual([...covered].sort());
    });
});
