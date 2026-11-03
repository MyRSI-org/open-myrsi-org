import { describe, it, expect, vi, beforeEach } from 'vitest';

// api/actions/warehouse.ts — the warehouse:* RPC handlers. The dispatcher has already
// feature-gated the namespace, checked the permission and forced the actor id
// (userId), so what these own is:
//   · exact forwarding (positional arg order matters: adjust/set/transfer take the
//     actor in a fixed slot, and a swap would book a movement against the wrong user);
//   · the coercions on loosely-typed client values (ids, paging, source, archive);
//   · the cross-module gate on the movement log: contract-linked fields ride only when
//     the marketplace module is ON;
//   · who gets pushed about a withdrawal, and that a push fault never fails a write.

const h = vi.hoisted(() => {
    const names = [
        'listWarehouseCatalog', 'searchWarehouseCatalog', 'createWarehouseCatalogItem', 'updateWarehouseCatalogItem',
        'archiveWarehouseCatalogItem', 'deleteWarehouseCatalogItem', 'exportWarehouseCatalog',
        'previewWarehouseCatalogImport', 'bulkUpsertWarehouseCatalog', 'listQmLocations', 'createQmLocation',
        'updateQmLocation', 'deleteQmLocation', 'listWarehouseStock', 'listWarehouseStockCount', 'createWarehouseStock',
        'deleteWarehouseStock', 'adjustWarehouseStock', 'setWarehouseStockTotal', 'transferWarehouseStock',
        'isOptionalFeatureEnabled', 'listWarehouseMovements', 'exportWarehouseCsv', 'createWithdrawalRequest',
        'listWithdrawalRequests', 'approveWithdrawalRequest', 'denyWithdrawalRequest', 'cancelWithdrawalRequest',
        'fulfilWithdrawalRequest', 'getWarehouseOverview', 'handleSupabaseError',
    ];
    const db: Record<string, unknown> = {};
    for (const n of names) db[n] = vi.fn();
    db.MAX_WAREHOUSE_IMPORT_BATCH_SIZE = 100;

    // Recording fake for the one direct primary-key read the module makes.
    const sb = {
        queries: [] as Array<{ table: string; ops: Array<[string, unknown[]]>; terminal?: string }>,
        response: { data: null as unknown, error: null as unknown },
    };
    db.supabase = {
        from: (table: string) => {
            const q = { table, ops: [] as Array<[string, unknown[]]>, terminal: undefined as string | undefined };
            sb.queries.push(q);
            const builder: Record<string, unknown> = {};
            for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
                builder[m] = (...args: unknown[]) => { q.ops.push([m, args]); return builder; };
            }
            builder.maybeSingle = () => { q.terminal = 'maybeSingle'; return Promise.resolve(sb.response); };
            builder.single = () => { q.terminal = 'single'; return Promise.resolve(sb.response); };
            return builder;
        },
    };
    return { db, names, sb, pushPerm: vi.fn(), pushUsers: vi.fn(), warn: vi.fn() };
});

vi.mock('../lib/db', () => h.db);
vi.mock('../lib/push', () => ({ sendPushToPermission: h.pushPerm, sendPushToUsers: h.pushUsers }));
vi.mock('../lib/log', () => {
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: h.warn, child: () => logger };
    return { log: logger };
});

import { warehouseActions } from '../api/actions/warehouse';

type Handler = (payload: unknown) => Promise<unknown>;
const ACTIONS = warehouseActions as unknown as Record<string, Handler>;
const run = (action: string, payload: unknown = {}) => ACTIONS[action](payload);
const fn = (name: string) => h.db[name] as ReturnType<typeof vi.fn>;
const dbCallCount = () => h.names.reduce((n, name) => n + fn(name).mock.calls.length, 0);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
    vi.resetAllMocks();
    h.pushPerm.mockResolvedValue(undefined);
    h.pushUsers.mockResolvedValue(undefined);
    // Mirrors the real contract (lib/supabaseServer): throw on an error, else no-op.
    fn('handleSupabaseError').mockImplementation(({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    });
    h.sb.queries = [];
    h.sb.response = { data: null, error: null };
});

// [action, payload, db fn, expected args, expected return given the db result R]
type Case = [string, Record<string, unknown>, string, unknown[], ((r: unknown) => unknown)?];
const applied = () => ({ applied: true });
const movement = (r: unknown) => ({ movementId: r });

const CASES: Case[] = [
    ['warehouse:list_catalog', { evil: 1 }, 'listWarehouseCatalog', []],
    ['warehouse:search_catalog', { query: 'quant', source: 'both', limit: 9, evil: 1 }, 'searchWarehouseCatalog',
        [{ query: 'quant', source: 'both', limit: 9 }]],
    ['warehouse:create_catalog_item', { name: 'Quantanium', category: 'ore', qualityLabel: 'Q1', unit: 'SCU', description: 'd', id: 5, source: 'platform' },
        'createWarehouseCatalogItem', [{ name: 'Quantanium', category: 'ore', qualityLabel: 'Q1', unit: 'SCU', description: 'd' }]],
    ['warehouse:update_catalog_item', { catalogId: 3, name: 'Q', category: 'refined', qualityLabel: null, unit: 'cSCU', description: null, source: 'platform' },
        'updateWarehouseCatalogItem', [{ id: 3, name: 'Q', category: 'refined', qualityLabel: null, unit: 'cSCU', description: null }]],
    ['warehouse:delete_catalog_item', { catalogId: 3 }, 'deleteWarehouseCatalogItem', [3], applied],
    ['warehouse:preview_import_catalog', { items: [{ name: 'x' }], offset: 5 }, 'previewWarehouseCatalogImport', [[{ name: 'x' }]]],
    ['warehouse:list_locations', {}, 'listQmLocations', []],
    // sortOrder is a QM-only field — the warehouse dialog does not get to set it.
    ['warehouse:create_location', { name: 'Hold', type: 'ship', parentId: 1, description: 'd', sortOrder: 9 }, 'createQmLocation',
        [{ name: 'Hold', type: 'ship', parentId: 1, description: 'd' }]],
    ['warehouse:update_location', { locationId: 2, name: 'Hold', type: 'station', parentId: null, description: null, sortOrder: 9 }, 'updateQmLocation',
        [{ id: 2, name: 'Hold', type: 'station', parentId: null, description: null }]],
    ['warehouse:delete_location', { locationId: 2 }, 'deleteQmLocation', [2], applied],
    ['warehouse:adjust_stock', { userId: 7, stockId: 4, delta: -3, reason: 'consumption', notes: 'n', targetTotal: 0 }, 'adjustWarehouseStock',
        [4, -3, 'consumption', 7, 'n'], movement],
    ['warehouse:set_stock_total', { userId: 7, stockId: 4, targetTotal: 20, reason: 'audit', notes: null, delta: 1 }, 'setWarehouseStockTotal',
        [4, 20, 'audit', 7, null], movement],
    ['warehouse:transfer_stock', { userId: 7, fromStockId: 4, toStockId: 5, quantity: 6, notes: 'n' }, 'transferWarehouseStock',
        [4, 5, 6, 7, 'n'], movement],
    ['warehouse:list_withdrawals', { status: 'open', requesterUserId: 3, stockId: 4, limit: 10, userId: 7 }, 'listWithdrawalRequests',
        [{ status: 'open', requesterUserId: 3, stockId: 4, limit: 10 }]],
    ['warehouse:approve_withdrawal', { userId: 7, requestId: 'r-1', status: 'fulfilled' }, 'approveWithdrawalRequest', ['r-1', 7], applied],
    ['warehouse:deny_withdrawal', { userId: 7, requestId: 'r-1', denialReason: 'no' }, 'denyWithdrawalRequest', ['r-1', 7, 'no'], applied],
    ['warehouse:cancel_withdrawal', { userId: 7, requestId: 'r-1' }, 'cancelWithdrawalRequest', ['r-1', 7], applied],
    ['warehouse:get_overview', {}, 'getWarehouseOverview', []],
];

describe('warehouse handlers forward exactly their own fields, in the right slots', () => {
    it.each(CASES)('%s → %s', async (action, payload, dbFn, args, wrap) => {
        const result = { marker: action };
        fn(dbFn).mockResolvedValueOnce(result);
        const out = await run(action, payload);
        expect(out).toStrictEqual(wrap ? wrap(result) : result);
        expect(fn(dbFn).mock.calls).toStrictEqual([args]);
        expect(dbCallCount()).toBe(1);
        expect(h.pushPerm).not.toHaveBeenCalled();
        expect(h.pushUsers).not.toHaveBeenCalled();
    });

    it('a db failure is never reported as { applied: true }', async () => {
        fn('deleteWarehouseCatalogItem').mockRejectedValueOnce(new Error('Catalog item still has stock'));
        await expect(run('warehouse:delete_catalog_item', { catalogId: 3 })).rejects.toThrow('Catalog item still has stock');
        fn('deleteQmLocation').mockRejectedValueOnce(new Error('in use'));
        await expect(run('warehouse:delete_location', { locationId: 2 })).rejects.toThrow('in use');
        fn('approveWithdrawalRequest').mockRejectedValueOnce(new Error('Failed to approve withdrawal request'));
        await expect(run('warehouse:approve_withdrawal', { userId: 7, requestId: 'r' })).rejects.toThrow('Failed to approve');
        fn('deleteWarehouseStock').mockRejectedValueOnce(new Error('denied'));
        await expect(run('warehouse:delete_stock', { stockId: 1 })).rejects.toThrow('denied');
    });
});

describe('coercions on loosely-typed client values', () => {
    it('archive_catalog_item archives unless archive is explicitly false', async () => {
        fn('archiveWarehouseCatalogItem').mockResolvedValue(undefined);
        await run('warehouse:archive_catalog_item', { catalogId: 3 });
        await run('warehouse:archive_catalog_item', { catalogId: 3, archive: true });
        await run('warehouse:archive_catalog_item', { catalogId: 3, archive: false });
        await run('warehouse:archive_catalog_item', { catalogId: 3, archive: 0 });
        expect(fn('archiveWarehouseCatalogItem').mock.calls).toStrictEqual([[3, true], [3, true], [3, false], [3, true]]);
    });

    it('export_catalog / export_csv pass numeric paging only, and return the db output verbatim', async () => {
        const csv = { csv: 'name\n"\'=HYPERLINK(1)"\n', total: 1 };
        fn('exportWarehouseCatalog').mockResolvedValueOnce([{ name: 'x' }]).mockResolvedValueOnce([]);
        fn('exportWarehouseCsv').mockResolvedValueOnce(csv).mockResolvedValueOnce(csv);
        await expect(run('warehouse:export_catalog', { offset: 100, limit: 50 })).resolves.toStrictEqual([{ name: 'x' }]);
        await run('warehouse:export_catalog', { offset: '100', limit: '50' });
        await expect(run('warehouse:export_csv', { offset: 0, limit: 500 })).resolves.toBe(csv);
        await run('warehouse:export_csv', {});
        expect(fn('exportWarehouseCatalog').mock.calls).toStrictEqual([[{ offset: 100, limit: 50 }], [{ offset: undefined, limit: undefined }]]);
        expect(fn('exportWarehouseCsv').mock.calls).toStrictEqual([[{ offset: 0, limit: 500 }], [{ offset: undefined, limit: undefined }]]);
    });

    it('import_catalog defaults to offset 0 and the server batch ceiling, never "unbounded"', async () => {
        fn('bulkUpsertWarehouseCatalog').mockResolvedValue({ inserted: 1 });
        const items = [{ name: 'Agricium' }];
        await expect(run('warehouse:import_catalog', { items, offset: 200, limit: 25 })).resolves.toStrictEqual({ inserted: 1 });
        await run('warehouse:import_catalog', { items, offset: '200', limit: '100000' });
        expect(fn('bulkUpsertWarehouseCatalog').mock.calls).toStrictEqual([
            [items, { offset: 200, limit: 25 }],
            [items, { offset: 0, limit: 100 }],
        ]);
    });

    it('list_stock / count_stock coerce ids with Number and keep 0; absent ids become null', async () => {
        fn('listWarehouseStock').mockResolvedValue([]);
        fn('listWarehouseStockCount').mockResolvedValue(4);
        await run('warehouse:list_stock', { catalogId: '3', locationId: 0, limit: 25, offset: 50 });
        await run('warehouse:list_stock', { catalogId: null, limit: '25', offset: '50' });
        await expect(run('warehouse:count_stock', { catalogId: '3', locationId: '9', limit: 25 })).resolves.toBe(4);
        await run('warehouse:count_stock', {});
        expect(fn('listWarehouseStock').mock.calls).toStrictEqual([
            [{ catalogId: 3, locationId: 0, limit: 25, offset: 50 }],
            [{ catalogId: null, locationId: null, limit: undefined, offset: undefined }],
        ]);
        expect(fn('listWarehouseStockCount').mock.calls).toStrictEqual([
            [{ catalogId: 3, locationId: 9 }],
            [{ catalogId: null, locationId: null }],
        ]);
    });

    it('create_stock: source is "platform" only when exactly that, quality label only when a string', async () => {
        fn('createWarehouseStock').mockResolvedValue({ id: 1 });
        await expect(run('warehouse:create_stock', { catalogId: 3, locationId: 4, notes: 'n', source: 'platform', qualityLabel: 'Q2', quantity: 50 }))
            .resolves.toStrictEqual({ id: 1 });
        await run('warehouse:create_stock', { catalogId: 3, locationId: 4, source: 'PLATFORM', qualityLabel: 5 });
        await run('warehouse:create_stock', { catalogId: 3, locationId: 4 });
        expect(fn('createWarehouseStock').mock.calls).toStrictEqual([
            [{ catalogId: 3, locationId: 4, notes: 'n', source: 'platform', qualityLabel: 'Q2' }],
            [{ catalogId: 3, locationId: 4, notes: undefined, source: 'custom', qualityLabel: null }],
            [{ catalogId: 3, locationId: 4, notes: undefined, source: 'custom', qualityLabel: null }],
        ]);
    });

    it('delete_stock coerces a string id to a number before it reaches the db', async () => {
        fn('deleteWarehouseStock').mockResolvedValue(undefined);
        await expect(run('warehouse:delete_stock', { stockId: '42' })).resolves.toStrictEqual({ applied: true });
        expect(fn('deleteWarehouseStock').mock.calls).toStrictEqual([[42]]);
    });
});

describe('warehouse:list_movements — contract-linked fields ride only with the marketplace ON', () => {
    const payload = { userId: 7, stockId: 4, reason: 'contract_delivery', actorUserId: 3, sinceIso: 's', untilIso: 'u', limit: 10, offset: 20, contractId: 'c' };
    const filters = { stockId: 4, reason: 'contract_delivery', actorUserId: 3, sinceIso: 's', untilIso: 'u', limit: 10, offset: 20 };

    it('marketplace ON → the viewer id is passed, so the db layer can attach contract fields for that viewer', async () => {
        fn('isOptionalFeatureEnabled').mockResolvedValueOnce(true);
        fn('listWarehouseMovements').mockResolvedValueOnce([{ id: 1 }]);
        await expect(run('warehouse:list_movements', payload)).resolves.toStrictEqual([{ id: 1 }]);
        expect(fn('isOptionalFeatureEnabled').mock.calls).toStrictEqual([['marketplace']]);
        expect(fn('listWarehouseMovements').mock.calls).toStrictEqual([[filters, 7]]);
    });

    it('marketplace OFF → the viewer id is withheld (undefined), which withholds every contract field', async () => {
        fn('isOptionalFeatureEnabled').mockResolvedValueOnce(false);
        fn('listWarehouseMovements').mockResolvedValueOnce([]);
        await run('warehouse:list_movements', payload);
        expect(fn('listWarehouseMovements').mock.calls).toStrictEqual([[filters, undefined]]);
    });

    it('a failed feature-flag read fails closed: no movements are read at all', async () => {
        fn('isOptionalFeatureEnabled').mockRejectedValueOnce(new Error('settings unavailable'));
        await expect(run('warehouse:list_movements', payload)).rejects.toThrow('settings unavailable');
        expect(fn('listWarehouseMovements')).not.toHaveBeenCalled();
    });
});

describe('warehouse:request_withdrawal', () => {
    const payload = { userId: 7, stockId: 4, requestedQuantity: 12, reasonCategory: 'operation', reasonNotes: 'n', status: 'approved' };

    it('creates as the actor and pushes warehouse:manage an alert carrying the request id', async () => {
        const request = { id: 'r-9', requestedByUserId: 7 };
        fn('createWithdrawalRequest').mockResolvedValueOnce(request);
        await expect(run('warehouse:request_withdrawal', payload)).resolves.toBe(request);
        expect(fn('createWithdrawalRequest').mock.calls).toStrictEqual([[7,
            { stockId: 4, requestedQuantity: 12, reasonCategory: 'operation', reasonNotes: 'n' }]]);
        expect(h.pushPerm.mock.calls).toStrictEqual([['warehouse:manage', {
            title: 'Withdrawal request',
            body: '12 requested · operation',
            tag: 'wh-request-r-9',
            data: { view: 'warehouse', tab: 'withdrawals', requestId: 'r-9' },
        }]]);
    });

    it('a push fault is logged and swallowed; a refused request pushes nothing', async () => {
        const request = { id: 'r-10' };
        fn('createWithdrawalRequest').mockResolvedValueOnce(request);
        const err = new Error('push down');
        h.pushPerm.mockRejectedValueOnce(err);
        await expect(run('warehouse:request_withdrawal', payload)).resolves.toBe(request);
        await flush();
        expect(h.warn).toHaveBeenCalledWith('withdrawal request push failed', { err });

        h.pushPerm.mockClear();
        fn('createWithdrawalRequest').mockRejectedValueOnce(new Error('Insufficient stock'));
        await expect(run('warehouse:request_withdrawal', payload)).rejects.toThrow('Insufficient stock');
        expect(h.pushPerm).not.toHaveBeenCalled();
    });
});

describe('warehouse:fulfil_withdrawal pushes the requester of THE request it fulfilled', () => {
    it('reads that request by primary key with explicit columns and pushes its requester an id-only route', async () => {
        fn('fulfilWithdrawalRequest').mockResolvedValueOnce('mv-1');
        h.sb.response = { data: { requested_by_user_id: 4, requested_quantity: 12 }, error: null };
        await expect(run('warehouse:fulfil_withdrawal', { userId: 7, requestId: 'r-1' })).resolves.toStrictEqual({ movementId: 'mv-1' });
        expect(fn('fulfilWithdrawalRequest').mock.calls).toStrictEqual([['r-1', 7]]);
        expect(h.sb.queries).toStrictEqual([{
            table: 'warehouse_requests',
            ops: [['select', ['requested_by_user_id, requested_quantity']], ['eq', ['id', 'r-1']]],
            terminal: 'maybeSingle',
        }]);
        expect(h.pushUsers.mock.calls).toStrictEqual([[[4], {
            title: 'Withdrawal fulfilled',
            body: 'Your withdrawal of 12 has been released.',
            tag: 'wh-fulfilled-r-1',
            data: { view: 'warehouse', tab: 'withdrawals', requestId: 'r-1' },
        }]]);
    });

    // REGRESSION: the handler used to list the single NEWEST request and .find() the
    // fulfilled id in it, so the requester was pushed only when their request happened
    // to be the most recently created one org-wide. Any older request — the normal
    // case for a queue — was released in silence.
    it('does not depend on the fulfilled request being the newest one', async () => {
        fn('fulfilWithdrawalRequest').mockResolvedValueOnce('mv-2');
        fn('listWithdrawalRequests').mockResolvedValue([{ id: 'r-newer', requestedByUserId: 5, requestedQuantity: 1 }]);
        h.sb.response = { data: { requested_by_user_id: 4, requested_quantity: 3 }, error: null };
        await run('warehouse:fulfil_withdrawal', { userId: 7, requestId: 'r-older' });
        expect(h.pushUsers).toHaveBeenCalledTimes(1);
        expect(h.pushUsers.mock.calls[0][0]).toStrictEqual([4]);
        expect(fn('listWithdrawalRequests')).not.toHaveBeenCalled();
    });

    it('fulfilling your own request pushes nobody', async () => {
        fn('fulfilWithdrawalRequest').mockResolvedValueOnce('mv-3');
        h.sb.response = { data: { requested_by_user_id: 7, requested_quantity: 3 }, error: null };
        await expect(run('warehouse:fulfil_withdrawal', { userId: 7, requestId: 'r-1' })).resolves.toStrictEqual({ movementId: 'mv-3' });
        expect(h.pushUsers).not.toHaveBeenCalled();
    });

    it('a request row that is gone pushes nobody', async () => {
        fn('fulfilWithdrawalRequest').mockResolvedValueOnce('mv-4');
        h.sb.response = { data: null, error: null };
        await expect(run('warehouse:fulfil_withdrawal', { userId: 7, requestId: 'r-1' })).resolves.toStrictEqual({ movementId: 'mv-4' });
        expect(h.pushUsers).not.toHaveBeenCalled();
    });

    it('a failed lookup surfaces as an error (same contract as before) and pushes nobody', async () => {
        fn('fulfilWithdrawalRequest').mockResolvedValueOnce('mv-5');
        h.sb.response = { data: null, error: { code: '57014', message: 'statement timeout' } };
        await expect(run('warehouse:fulfil_withdrawal', { userId: 7, requestId: 'r-1' })).rejects.toThrow('Failed to load withdrawal request');
        expect(fn('handleSupabaseError').mock.calls).toStrictEqual([[{
            error: { code: '57014', message: 'statement timeout' },
            message: 'Failed to load withdrawal request',
        }]]);
        expect(h.pushUsers).not.toHaveBeenCalled();
    });

    it('a push fault is logged and swallowed', async () => {
        fn('fulfilWithdrawalRequest').mockResolvedValueOnce('mv-6');
        h.sb.response = { data: { requested_by_user_id: 4, requested_quantity: 3 }, error: null };
        const err = new Error('push down');
        h.pushUsers.mockRejectedValueOnce(err);
        await expect(run('warehouse:fulfil_withdrawal', { userId: 7, requestId: 'r-1' })).resolves.toStrictEqual({ movementId: 'mv-6' });
        await flush();
        expect(h.warn).toHaveBeenCalledWith('withdrawal fulfil push failed', { err });
    });

    it('a fulfil the db refuses reads nothing further and pushes nobody', async () => {
        fn('fulfilWithdrawalRequest').mockRejectedValueOnce(new Error('Request not found in this organization.'));
        await expect(run('warehouse:fulfil_withdrawal', { userId: 7, requestId: 'r-x' })).rejects.toThrow('Request not found');
        expect(h.sb.queries).toStrictEqual([]);
        expect(h.pushUsers).not.toHaveBeenCalled();
    });
});

describe('module surface', () => {
    it('every exported warehouse handler is exercised by this file', () => {
        const covered = new Set([
            ...CASES.map(([a]) => a),
            'warehouse:archive_catalog_item', 'warehouse:export_catalog', 'warehouse:export_csv', 'warehouse:import_catalog',
            'warehouse:list_stock', 'warehouse:count_stock', 'warehouse:create_stock', 'warehouse:delete_stock',
            'warehouse:list_movements', 'warehouse:request_withdrawal', 'warehouse:fulfil_withdrawal',
        ]);
        expect(Object.keys(ACTIONS).sort()).toStrictEqual([...covered].sort());
    });
});
