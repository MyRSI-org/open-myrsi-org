import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/actions/blueprints.ts — handler-level behaviour of the blueprint:* RPCs.
// tests/blueprintSecurity.test.ts pins the db layer (consent, A-B-A, the amplifier's
// fail-closed count) and the dispatcher wiring; this file pins what the HANDLERS own:
//   · canManage / canCraft are plain permission tests on the dispatcher's `user`;
//   · the update patch is the rest-spread minus blueprintId/userId/user;
//   · the crafting-request fan-out (generic body, id-only metadata, best-effort);
//   · the Discord post: narrower than the board (no requester, no materials note),
//     embeds only, settings read by primary key, failures swallowed;
//   · lifecycle notifications reach every party EXCEPT the actor, once each;
//   · releasedCrafterId is a notification target only and never crosses the wire.

const h = vi.hoisted(() => {
    const names = [
        'listBlueprints', 'listCraftableItems', 'registerBlueprint', 'updateBlueprint', 'deleteBlueprint',
        'listBlueprintRequests', 'createBlueprintRequest', 'getCraftNotifyIds', 'claimBlueprintRequest',
        'releaseBlueprintRequest', 'markBlueprintRequestReady', 'markBlueprintRequestDelivered',
        'confirmBlueprintRequestReceived', 'cancelBlueprintRequest',
    ];
    const db: Record<string, unknown> = {};
    for (const n of names) db[n] = vi.fn();
    const sb = {
        queries: [] as Array<{ table: string; ops: Array<[string, unknown[]]>; terminal?: string }>,
        settings: {} as Record<string, unknown>,
        fail: null as Error | null,
    };
    db.supabase = {
        from: (table: string) => {
            const q = { table, ops: [] as Array<[string, unknown[]]>, terminal: undefined as string | undefined };
            sb.queries.push(q);
            const builder: Record<string, unknown> = {};
            for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
                builder[m] = (...args: unknown[]) => { q.ops.push([m, args]); return builder; };
            }
            builder.maybeSingle = () => {
                q.terminal = 'maybeSingle';
                if (sb.fail) return Promise.reject(sb.fail);
                const key = q.ops.find(([m, a]) => m === 'eq' && a[0] === 'key')?.[1][1] as string;
                return Promise.resolve({ data: key in sb.settings ? { value: sb.settings[key] } : null, error: null });
            };
            return builder;
        },
    };
    return { db, names, sb, notify: vi.fn(), discordSend: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

vi.mock('../lib/db', () => h.db);
vi.mock('../lib/db/notifications', () => ({ createNotification: h.notify }));
vi.mock('../lib/discord', () => ({ sendDiscordChannelMessage: h.discordSend }));
vi.mock('../lib/log', () => {
    const logger = { info: vi.fn(), debug: vi.fn(), warn: h.warn, error: h.error, child: () => logger };
    return { log: logger };
});

import { blueprintActions } from '../api/actions/blueprints';

type Handler = (payload: unknown) => Promise<unknown>;
const ACTIONS = blueprintActions as unknown as Record<string, Handler>;
const run = (action: string, payload: unknown = {}) => ACTIONS[action](payload);
const fn = (name: string) => h.db[name] as ReturnType<typeof vi.fn>;

const MANAGER = { permissions: ['blueprint:view', 'blueprint:manage'] };
const CRAFTER = { permissions: ['blueprint:view', 'blueprint:craft'] };
const MEMBER = { permissions: ['blueprint:view', 'blueprint:request'] };

beforeEach(() => {
    vi.resetAllMocks();
    h.notify.mockResolvedValue(null);
    h.discordSend.mockResolvedValue({ messageId: 'm' });
    fn('getCraftNotifyIds').mockResolvedValue([]);
    h.sb.queries = [];
    h.sb.settings = {};
    h.sb.fail = null;
});
afterEach(() => {
    vi.useRealTimers();
});

describe('registry handlers', () => {
    it('list_registry forwards the four filters and nothing else', async () => {
        fn('listBlueprints').mockResolvedValueOnce([{ id: 1 }]);
        await expect(run('blueprint:list_registry', { userId: 7, search: 'p4', craftableOnly: true, ownerId: 3, limit: 50, user: MEMBER }))
            .resolves.toStrictEqual([{ id: 1 }]);
        expect(fn('listBlueprints').mock.calls).toStrictEqual([[{ search: 'p4', craftableOnly: true, ownerId: 3, limit: 50 }]]);
    });

    it('list_craftable binds viewerId to the forced actor — a payload viewerId is ignored', async () => {
        fn('listCraftableItems').mockResolvedValueOnce([]);
        await run('blueprint:list_craftable', { userId: 7, viewerId: 99, search: 's', limit: 10, category: 'weapon' });
        expect(fn('listCraftableItems').mock.calls).toStrictEqual([[{ search: 's', limit: 10, category: 'weapon', viewerId: 7 }]]);
    });

    it('register forwards the four fields with the actor as owner', async () => {
        fn('registerBlueprint').mockResolvedValueOnce({ id: 5 });
        await expect(run('blueprint:register', { userId: 7, qmCatalogId: 4, itemName: 'P4-AR', notes: 'n', offersCrafting: true, ownerId: 99 }))
            .resolves.toStrictEqual({ id: 5 });
        expect(fn('registerBlueprint').mock.calls).toStrictEqual([[{ qmCatalogId: 4, itemName: 'P4-AR', notes: 'n', offersCrafting: true }, 7]]);
    });

    it('update: the patch is everything except blueprintId/userId/user, and canManage comes from the permission', async () => {
        fn('updateBlueprint').mockResolvedValue({ id: 5 });
        await run('blueprint:update', { blueprintId: 5, userId: 7, user: MANAGER, notes: 'n', offersCrafting: false, creatorId: 7 });
        await run('blueprint:update', { blueprintId: 5, userId: 7, user: CRAFTER, notes: 'x' });
        expect(fn('updateBlueprint').mock.calls).toStrictEqual([
            [5, { notes: 'n', offersCrafting: false, creatorId: 7 }, 7, true],
            [5, { notes: 'x' }, 7, false],
        ]);
    });

    it('delete: canManage is false without the permission, without permissions at all, and without a user', async () => {
        fn('deleteBlueprint').mockResolvedValue(undefined);
        await run('blueprint:delete', { blueprintId: 5, userId: 7, user: MANAGER });
        await run('blueprint:delete', { blueprintId: 5, userId: 7, user: MEMBER });
        await run('blueprint:delete', { blueprintId: 5, userId: 7, user: {} });
        await run('blueprint:delete', { blueprintId: 5, userId: 7 });
        // A role NAME is not a permission.
        await run('blueprint:delete', { blueprintId: 5, userId: 7, user: { role: 'Admin', permissions: [] } });
        expect(fn('deleteBlueprint').mock.calls.map((c) => c[2])).toStrictEqual([true, false, false, false, false]);
        expect(fn('deleteBlueprint').mock.calls[0]).toStrictEqual([5, 7, true]);
    });

    it('list_requests derives canCraft and canManage independently', async () => {
        fn('listBlueprintRequests').mockResolvedValue([]);
        await run('blueprint:list_requests', { userId: 7, user: CRAFTER, status: 'open', limit: 20 });
        await run('blueprint:list_requests', { userId: 7, user: MANAGER });
        await run('blueprint:list_requests', { userId: 7, user: MEMBER });
        expect(fn('listBlueprintRequests').mock.calls).toStrictEqual([
            [7, { canCraft: true, canManage: false, status: 'open', limit: 20 }],
            [7, { canCraft: false, canManage: true, status: undefined, limit: undefined }],
            [7, { canCraft: false, canManage: false, status: undefined, limit: undefined }],
        ]);
    });
});

describe('blueprint:create_request — in-app fan-out', () => {
    const payload = { userId: 7, qmCatalogId: 4, itemName: 'P4-AR', quantity: 2, materialsNote: 'bring 3 SCU', offerPriceUec: 1500, requesterId: 99 };
    const request = { id: 31, itemName: 'P4-AR', quantity: 2, offerPriceUec: 1500, requesterId: 7, crafterId: null, materialsNote: 'bring 3 SCU' };

    it('creates as the actor and notifies each crafter with a generic body and the id only', async () => {
        fn('createBlueprintRequest').mockResolvedValueOnce(request);
        fn('getCraftNotifyIds').mockResolvedValueOnce([3, 4]);
        await expect(run('blueprint:create_request', payload)).resolves.toBe(request);
        expect(fn('createBlueprintRequest').mock.calls).toStrictEqual([[
            { qmCatalogId: 4, itemName: 'P4-AR', quantity: 2, materialsNote: 'bring 3 SCU', offerPriceUec: 1500 }, 7]]);
        expect(fn('getCraftNotifyIds').mock.calls).toStrictEqual([[7]]);
        const body = { type: 'blueprint_request', title: 'New crafting request', body: 'A new crafting request is open on the board.', link: 'blueprints', metadata: { blueprintRequestId: 31 } };
        expect(h.notify.mock.calls).toStrictEqual([[3, body], [4, body]]);
        // Data-minimisation: neither the item, the price nor the materials note.
        expect(JSON.stringify(h.notify.mock.calls)).not.toMatch(/P4-AR|1500|SCU/);
    });

    it('one recipient failing does not stop the others or fail the request', async () => {
        fn('createBlueprintRequest').mockResolvedValueOnce(request);
        fn('getCraftNotifyIds').mockResolvedValueOnce([3, 4, 5]);
        h.notify.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('row insert failed')).mockResolvedValueOnce(null);
        await expect(run('blueprint:create_request', payload)).resolves.toBe(request);
        expect(h.notify.mock.calls.map((c) => c[0])).toStrictEqual([3, 4, 5]);
        expect(h.error).not.toHaveBeenCalled();
    });

    it('a failed recipient lookup is logged, and the Discord post still goes out', async () => {
        fn('createBlueprintRequest').mockResolvedValueOnce(request);
        const err = new Error('perm read failed');
        fn('getCraftNotifyIds').mockRejectedValueOnce(err);
        h.sb.settings = { discordConfig: { craftingRequestChannelId: 'chan-1' } };
        await expect(run('blueprint:create_request', payload)).resolves.toBe(request);
        expect(h.error).toHaveBeenCalledWith('crafting request notification failed', { requestId: 31, err });
        expect(h.notify).not.toHaveBeenCalled();
        expect(h.discordSend).toHaveBeenCalledTimes(1);
    });

    it('a refused request notifies nobody and posts nothing', async () => {
        fn('createBlueprintRequest').mockRejectedValueOnce(new Error('Nobody currently offers to craft that item.'));
        await expect(run('blueprint:create_request', payload)).rejects.toThrow('Nobody currently offers');
        expect(fn('getCraftNotifyIds')).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
        expect(h.sb.queries).toStrictEqual([]);
        expect(h.discordSend).not.toHaveBeenCalled();
    });
});

describe('blueprint:create_request — the Discord post', () => {
    const base = { id: 31, itemName: 'P4-AR', quantity: 2, offerPriceUec: 1500, requesterId: 7, crafterId: null, materialsNote: 'bring 3 SCU from Hurston' };
    const create = async (request: Record<string, unknown>) => {
        fn('createBlueprintRequest').mockResolvedValueOnce(request);
        return run('blueprint:create_request', { userId: 7, itemName: String(request.itemName) });
    };

    it('reads the two settings rows by primary key and posts an embed-only message', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-02T10:00:00.000Z'));
        h.sb.settings = {
            discordConfig: { craftingRequestChannelId: 'chan-craft', newRequestChannelId: 'chan-req', botToken: 'SECRET-TOKEN' },
            brandingConfig: { name: 'Night Owls', iconUrl: 'https://cdn.example/icon.png' },
        };
        await create(base);
        expect(h.sb.queries).toStrictEqual([
            { table: 'settings', ops: [['select', ['value']], ['eq', ['key', 'discordConfig']]], terminal: 'maybeSingle' },
            { table: 'settings', ops: [['select', ['value']], ['eq', ['key', 'brandingConfig']]], terminal: 'maybeSingle' },
        ]);
        expect(h.discordSend.mock.calls).toStrictEqual([['chan-craft', {
            embeds: [{
                title: '🔧 NEW CRAFTING REQUEST',
                description: 'A new request is open on the crafting board.',
                color: 0xa855f7,
                fields: [
                    { name: 'Item', value: 'P4-AR', inline: true },
                    { name: 'Quantity', value: '2', inline: true },
                    { name: 'Offered', value: '1,500 aUEC', inline: true },
                ],
                timestamp: '2026-11-02T10:00:00.000Z',
                footer: { text: 'Night Owls Blueprint Manager', icon_url: 'https://cdn.example/icon.png' },
            }],
        }]]);
        // No `content` → nothing a mention could ride in. No requester, no materials
        // note, and no settings secret.
        const posted = JSON.stringify(h.discordSend.mock.calls[0][1]);
        expect(Object.keys(h.discordSend.mock.calls[0][1] as object)).toStrictEqual(['embeds']);
        expect(posted).not.toMatch(/Hurston|SECRET-TOKEN|requester/i);
    });

    it('falls back to the service-request channel when no crafting channel is configured', async () => {
        h.sb.settings = { discordConfig: { newRequestChannelId: 'chan-req' } };
        await create(base);
        expect(h.discordSend.mock.calls[0][0]).toBe('chan-req');
    });

    it('no channel configured (or no discord settings row) posts nothing', async () => {
        h.sb.settings = { discordConfig: { craftingRequestChannelId: '' } };
        await create(base);
        h.sb.settings = {};
        await create(base);
        expect(h.discordSend).not.toHaveBeenCalled();
        expect(h.error).not.toHaveBeenCalled();
    });

    it('no offered price (or zero) omits the Offered field; branding defaults when unset', async () => {
        h.sb.settings = { discordConfig: { craftingRequestChannelId: 'c' } };
        await create({ ...base, offerPriceUec: 0 });
        await create({ ...base, offerPriceUec: null });
        for (const call of h.discordSend.mock.calls) {
            const embed = (call[1] as { embeds: Array<{ fields: Array<{ name: string }>; footer: Record<string, unknown> }> }).embeds[0];
            expect(embed.fields.map((f) => f.name)).toStrictEqual(['Item', 'Quantity']);
            expect(embed.footer).toStrictEqual({ text: 'Organization Blueprint Manager' });
        }
    });

    it('a non-http icon URL is dropped from the footer', async () => {
        h.sb.settings = {
            discordConfig: { craftingRequestChannelId: 'c' },
            brandingConfig: { name: 'Org', iconUrl: 'javascript:alert(1)' },
        };
        await create(base);
        const embed = (h.discordSend.mock.calls[0][1] as { embeds: Array<{ footer: Record<string, unknown> }> }).embeds[0];
        expect(embed.footer).toStrictEqual({ text: 'Org Blueprint Manager' });
    });

    it('item and quantity are defaulted when blank and truncated at their field caps', async () => {
        h.sb.settings = { discordConfig: { craftingRequestChannelId: 'c' } };
        await create({ ...base, itemName: '   ', quantity: null, offerPriceUec: undefined });
        await create({ ...base, itemName: 'A'.repeat(300), quantity: '9'.repeat(40) });
        const fields = h.discordSend.mock.calls.map((c) =>
            (c[1] as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }).embeds[0].fields);
        expect(fields[0]).toStrictEqual([
            { name: 'Item', value: 'Unspecified item', inline: true },
            { name: 'Quantity', value: '1', inline: true },
        ]);
        expect(fields[1][0].value).toBe('A'.repeat(253) + '...');
        expect(fields[1][0].value).toHaveLength(256);
        expect(fields[1][1].value).toBe('9'.repeat(29) + '...');
    });

    it('a Discord failure is logged with the request id and never fails the submission', async () => {
        h.sb.settings = { discordConfig: { craftingRequestChannelId: 'c' } };
        const err = new Error('discord 500');
        h.discordSend.mockRejectedValueOnce(err);
        await expect(create(base)).resolves.toStrictEqual(base);
        expect(h.error).toHaveBeenCalledWith('crafting request discord notification failed', { requestId: 31, err });
    });

    it('a settings read failure is swallowed the same way', async () => {
        const err = new Error('settings down');
        h.sb.fail = err;
        await expect(create(base)).resolves.toStrictEqual(base);
        expect(h.discordSend).not.toHaveBeenCalled();
        expect(h.error).toHaveBeenCalledWith('crafting request discord notification failed', { requestId: 31, err });
    });
});

describe('lifecycle notifications reach every party except the actor', () => {
    const note = (target: number, title: string, body: string, id = 9) =>
        [target, { type: 'blueprint_request', title, body, link: 'blueprints', metadata: { blueprintRequestId: id } }];
    const row = { id: 9, itemName: 'P4-AR', requesterId: 1, crafterId: 2, status: 'claimed' };

    it('claim: the crafter claims, the requester is told', async () => {
        fn('claimBlueprintRequest').mockResolvedValueOnce(row);
        await expect(run('blueprint:claim_request', { requestId: 9, userId: 2, user: CRAFTER })).resolves.toBe(row);
        expect(fn('claimBlueprintRequest').mock.calls).toStrictEqual([[9, 2]]);
        expect(h.notify.mock.calls).toStrictEqual([note(1, 'Crafting request claimed', 'Someone has claimed your request for "P4-AR".')]);
    });

    it('release by a manager reaches BOTH the requester and the released crafter; releasedCrafterId is not returned', async () => {
        fn('releaseBlueprintRequest').mockResolvedValueOnce({ ...row, crafterId: null, status: 'open', releasedCrafterId: 2 });
        const out = await run('blueprint:release_request', { requestId: 9, userId: 5, user: MANAGER });
        expect(out).toStrictEqual({ ...row, crafterId: null, status: 'open' });
        expect(out).not.toHaveProperty('releasedCrafterId');
        expect(fn('releaseBlueprintRequest').mock.calls).toStrictEqual([[9, 5, true]]);
        const body = 'The request for "P4-AR" is back on the open board.';
        expect(h.notify.mock.calls).toStrictEqual([note(1, 'Crafting request released', body), note(2, 'Crafting request released', body)]);
    });

    it('release by the crafter themselves tells only the requester, with canManage false', async () => {
        fn('releaseBlueprintRequest').mockResolvedValueOnce({ ...row, crafterId: null, releasedCrafterId: 2 });
        await run('blueprint:release_request', { requestId: 9, userId: 2, user: CRAFTER });
        expect(fn('releaseBlueprintRequest').mock.calls[0]).toStrictEqual([9, 2, false]);
        expect(h.notify.mock.calls.map((c) => c[0])).toStrictEqual([1]);
    });

    it('ready / delivered: the crafter acts, the requester is told', async () => {
        fn('markBlueprintRequestReady').mockResolvedValueOnce(row);
        fn('markBlueprintRequestDelivered').mockResolvedValueOnce(row);
        await run('blueprint:mark_ready', { requestId: 9, userId: 2 });
        await run('blueprint:mark_delivered', { requestId: 9, userId: 2 });
        expect(fn('markBlueprintRequestReady').mock.calls).toStrictEqual([[9, 2]]);
        expect(fn('markBlueprintRequestDelivered').mock.calls).toStrictEqual([[9, 2]]);
        expect(h.notify.mock.calls).toStrictEqual([
            note(1, 'Craft ready', '"P4-AR" is ready for delivery.'),
            note(1, 'Craft delivered', '"P4-AR" has been marked delivered — confirm when you have it.'),
        ]);
    });

    it('confirm received: the requester acts, the crafter is told', async () => {
        fn('confirmBlueprintRequestReceived').mockResolvedValueOnce(row);
        await run('blueprint:confirm_received', { requestId: 9, userId: 1 });
        expect(fn('confirmBlueprintRequestReceived').mock.calls).toStrictEqual([[9, 1]]);
        expect(h.notify.mock.calls).toStrictEqual([note(2, 'Craft confirmed received', 'The requester confirmed receipt of "P4-AR".')]);
    });

    it('cancel by a manager reaches both parties and forwards the reason', async () => {
        fn('cancelBlueprintRequest').mockResolvedValueOnce(row);
        await run('blueprint:cancel_request', { requestId: 9, userId: 5, user: MANAGER, reason: 'duplicate' });
        expect(fn('cancelBlueprintRequest').mock.calls).toStrictEqual([[9, 5, true, 'duplicate']]);
        const body = 'The request for "P4-AR" was cancelled.';
        expect(h.notify.mock.calls).toStrictEqual([note(1, 'Crafting request cancelled', body), note(2, 'Crafting request cancelled', body)]);
    });

    it('cancel by the requester of an unclaimed request notifies nobody', async () => {
        fn('cancelBlueprintRequest').mockResolvedValueOnce({ ...row, crafterId: null });
        await run('blueprint:cancel_request', { requestId: 9, userId: 1, user: MEMBER });
        expect(fn('cancelBlueprintRequest').mock.calls[0]).toStrictEqual([9, 1, false, undefined]);
        expect(h.notify).not.toHaveBeenCalled();
    });

    it('the same person in both slots is notified once, not twice', async () => {
        fn('cancelBlueprintRequest').mockResolvedValueOnce({ ...row, requesterId: 3, crafterId: 3 });
        await run('blueprint:cancel_request', { requestId: 9, userId: 5, user: MANAGER });
        expect(h.notify.mock.calls.map((c) => c[0])).toStrictEqual([3]);
    });

    it('a failed notification is logged, the next party is still told, and the transition still returns', async () => {
        fn('cancelBlueprintRequest').mockResolvedValueOnce(row);
        const err = new Error('insert failed');
        h.notify.mockRejectedValueOnce(err).mockResolvedValueOnce(null);
        await expect(run('blueprint:cancel_request', { requestId: 9, userId: 5, user: MANAGER })).resolves.toBe(row);
        expect(h.warn).toHaveBeenCalledWith('blueprint notification failed', { err });
        expect(h.notify.mock.calls.map((c) => c[0])).toStrictEqual([1, 2]);
    });

    it('a refused transition notifies nobody', async () => {
        fn('claimBlueprintRequest').mockRejectedValueOnce(new Error('You cannot claim your own request.'));
        await expect(run('blueprint:claim_request', { requestId: 9, userId: 1 })).rejects.toThrow('cannot claim your own');
        expect(h.notify).not.toHaveBeenCalled();
    });
});

describe('module surface', () => {
    it('every exported blueprint handler is exercised by this file', () => {
        expect(Object.keys(ACTIONS).sort()).toStrictEqual([
            'blueprint:cancel_request', 'blueprint:claim_request', 'blueprint:confirm_received', 'blueprint:create_request',
            'blueprint:delete', 'blueprint:list_craftable', 'blueprint:list_registry', 'blueprint:list_requests',
            'blueprint:mark_delivered', 'blueprint:mark_ready', 'blueprint:register', 'blueprint:release_request',
            'blueprint:update',
        ]);
    });
});
