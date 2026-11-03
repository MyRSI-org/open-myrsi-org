import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db.ts — the get*State aggregators behind /api/query (boot, `main`, and the
// per-domain subsets). These are the READ boundary: per-viewer query scoping
// (own-requests only), per-viewer projection (service-type routing, sync-restricted
// markers, request feedback), audience filtering (announcements, external tools),
// clearance filtering (intel bulletins) and per-slice permission gating (getState).
//
// HARNESS: lib/db/common's supabase client is replaced by a builder that RECORDS every
// from(<table>) and its call chain, so each test pins the exact table, explicit column
// list, filters and ordering — and, for the denied caller, that a query was never
// issued at all. The heavy producers owned by other modules (ops/hr/intel/system/users)
// are vi.fn stand-ins so this file asserts exactly what THIS module composes.

type Call = { m: string; args: unknown[] };
type Query = { table: string; calls: Call[] };
type Result = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
    queries: [] as Query[],
    handlers: {} as Record<string, (q: Query) => Result>,
    logs: [] as Array<{ module: unknown; level: string; msg: string; fields?: unknown }>,
    getServiceTypes: vi.fn(),
    getOrgFeatures: vi.fn(),
    getSecurityClearances: vi.fn(),
    getLimitingMarkers: vi.fn(),
    getAllSettings: vi.fn(),
    isAnyStaffOnDuty: vi.fn(),
    getOperations: vi.fn(),
    listOperationTemplates: vi.fn(),
    getIntelTargetIndex: vi.fn(),
    getIntelHubStats: vi.fn(),
    getActiveBulletins: vi.fn(),
    getHRState: vi.fn(),
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const q: Query = { table, calls: [] };
        h.queries.push(q);
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'contains', 'range', 'gt', 'gte', 'lt', 'lte', 'ilike', 'filter']) {
            b[m] = (...args: unknown[]) => { q.calls.push({ m, args }); return b; };
        }
        const settle = (): Promise<Result> => {
            const handler = h.handlers[table];
            return Promise.resolve(handler ? handler(q) : { data: [], error: null });
        };
        b.single = () => { q.calls.push({ m: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { q.calls.push({ m: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({}),
        safeFetch: async (q: PromiseLike<Result>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const mk = (bindings: Record<string, unknown> = {}): Record<string, unknown> => ({
        debug: () => {},
        info: () => {},
        warn: (msg: string, fields?: unknown) => { h.logs.push({ module: bindings.module, level: 'warn', msg, fields }); },
        error: (msg: string, fields?: unknown) => { h.logs.push({ module: bindings.module, level: 'error', msg, fields }); },
        child: (b: Record<string, unknown>) => mk({ ...bindings, ...b }),
    });
    return { ...actual, log: mk() };
});
vi.mock('../lib/cache', () => ({
    cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} },
    TTL: {},
}));
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {} }));
vi.mock('../lib/db/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/db/system')>()),
    getServiceTypes: h.getServiceTypes,
    getOrgFeatures: h.getOrgFeatures,
    getSecurityClearances: h.getSecurityClearances,
    getLimitingMarkers: h.getLimitingMarkers,
    getAllSettings: h.getAllSettings,
}));
vi.mock('../lib/db/users', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/db/users')>()),
    isAnyStaffOnDuty: h.isAnyStaffOnDuty,
}));
vi.mock('../lib/db/ops', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/db/ops')>()),
    getOperations: h.getOperations,
}));
vi.mock('../lib/db/operation-templates', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/db/operation-templates')>()),
    listOperationTemplates: h.listOperationTemplates,
}));
vi.mock('../lib/db/intel', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/db/intel')>()),
    getIntelTargetIndex: h.getIntelTargetIndex,
    getIntelHubStats: h.getIntelHubStats,
    getActiveBulletins: h.getActiveBulletins,
}));
vi.mock('../lib/db/hr', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/db/hr')>()),
    getHRState: h.getHRState,
}));

import {
    getMainState, getRequestsState, getRequestDetail, getAnnouncementsState, getLoginScreenAnnouncements,
    getDiscordState, resolveOrgAppUrl, getOrgTenantUrl, getOperationsState, getWarrantsState,
    getExternalToolsState, getIntelState, getState,
} from '../lib/db';
import { USER_ROSTER_SELECT_QUERY } from '../lib/db/users';
import { WARRANT_SELECT } from '../lib/db/intel';

const queriesFor = (table: string) => h.queries.filter(q => q.table === table);
const onlyQuery = (table: string) => {
    const qs = queriesFor(table);
    expect(qs, `exactly one ${table} query`).toHaveLength(1);
    return qs[0];
};
const barrelLogs = () => h.logs.filter(l => l.module === 'db.barrel');

const SERVICE_TYPES = [
    { id: 1, name: 'Security', icon: 'fa-shield', color: '#fff', description: 'd1', isActive: true, discordChannelId: '111222333444555666' },
    { id: 2, name: 'Retired', icon: 'fa-x', color: '#000', description: null, isActive: false, discordChannelId: undefined },
];
const MARKERS = [
    { id: 1, name: 'Ironclad', code: 'IRON', description: 'd', sync_restricted: true },
    { id: 2, name: 'Open', code: 'OPEN', description: null, sync_restricted: null },
];

beforeEach(() => {
    h.queries = [];
    h.handlers = {};
    h.logs = [];
    h.getServiceTypes.mockReset().mockResolvedValue(SERVICE_TYPES);
    h.getOrgFeatures.mockReset().mockResolvedValue({ academy: { enabled: true } });
    h.getSecurityClearances.mockReset().mockResolvedValue([{ id: 1, name: 'Secret', level: 3, description: null }]);
    h.getLimitingMarkers.mockReset().mockResolvedValue(MARKERS);
    h.getAllSettings.mockReset().mockResolvedValue({});
    h.isAnyStaffOnDuty.mockReset().mockResolvedValue(true);
    h.getOperations.mockReset().mockResolvedValue([]);
    h.listOperationTemplates.mockReset().mockResolvedValue([]);
    h.getIntelTargetIndex.mockReset().mockResolvedValue([]);
    h.getIntelHubStats.mockReset().mockResolvedValue({});
    h.getActiveBulletins.mockReset().mockResolvedValue([]);
    h.getHRState.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// getMainState
// ---------------------------------------------------------------------------

describe('getMainState — staff half', () => {
    const ADMIN = { isSystemAdmin: true, permissions: ['admin:access', 'admin:config:servicetypes'] };

    beforeEach(() => {
        h.handlers = {
            users: () => ({ data: [{ id: 9, name: 'Member', role_id: 2, admin_notes: 'an', role: { id: 2, name: 'Member', role_permissions: [{ permission: { name: 'user:toggle_duty' } }] } }], error: null }),
            ranks: () => ({ data: [{ id: 1, name: 'Recruit', icon_url: 'r.png', sort_order: 1 }], error: null }),
            units: () => ({ data: [{ id: 1, name: 'Alpha', sort_order: 1 }], error: null }),
            roles: () => ({ data: [{ id: 2, name: 'Member', description: null, is_system: true }], error: null }),
            locations: () => ({ data: [{ id: 1, name: 'Port Olisar', parent_id: null, type: 'station' }], error: null }),
            specialization_tags: () => ({ data: [{ id: 1, name: 'Medic', description: null, icon: null, image_url: null }], error: null }),
            certifications: () => ({ data: [{ id: 2, name: 'EVA', description: 'd', icon: 'i', image_url: 'u' }], error: null }),
            commendations: () => ({ data: [{ id: 3, name: 'Valour', description: null, icon: null, image_url: null }], error: null }),
            radio_channels: () => ({ data: [{ id: 1, name: 'Command', color: '#f00', sort_order: 1, type: 'base' }], error: null }),
        };
    });

    it('issues every staff query with an explicit column list, filter and ordering', async () => {
        await getMainState(ADMIN);
        expect(onlyQuery('users').calls).toEqual([
            { m: 'select', args: [USER_ROSTER_SELECT_QUERY] },
            { m: 'is', args: ['deleted_at', null] },
            { m: 'order', args: ['id', { ascending: true }] },
            { m: 'limit', args: [1000] },
        ]);
        expect(onlyQuery('ranks').calls).toEqual([
            { m: 'select', args: ['id, name, icon_url, sort_order'] },
            { m: 'order', args: ['sort_order'] }, { m: 'order', args: ['name'] },
        ]);
        expect(onlyQuery('units').calls).toEqual([
            { m: 'select', args: ['id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted'] },
            { m: 'order', args: ['sort_order'] }, { m: 'order', args: ['name'] },
        ]);
        expect(onlyQuery('roles').calls).toEqual([{ m: 'select', args: ['id, name, description, is_system'] }, { m: 'order', args: ['name'] }]);
        expect(onlyQuery('locations').calls).toEqual([{ m: 'select', args: ['id, name, parent_id, type'] }]);
        for (const t of ['specialization_tags', 'certifications', 'commendations']) {
            expect(onlyQuery(t).calls, t).toEqual([{ m: 'select', args: ['id, name, description, icon, image_url'] }]);
        }
        expect(onlyQuery('radio_channels').calls).toEqual([{ m: 'select', args: ['id, name, color, sort_order, type'] }]);
        expect(h.getSecurityClearances).toHaveBeenCalledTimes(1);
        expect(h.getLimitingMarkers).toHaveBeenCalledTimes(1);
        for (const q of h.queries) {
            for (const c of q.calls.filter(c => c.m === 'select')) expect(String(c.args[0]), q.table).not.toContain('*');
        }
    });

    it('maps every staff table and gives the apex admin syncRestricted + service routing', async () => {
        const s = await getMainState(ADMIN);
        expect(s.users).toHaveLength(1);
        expect(s.users![0]).toMatchObject({ id: 9, name: 'Member', role: 'Member', permissions: ['user:toggle_duty'] });
        expect(s.ranks).toStrictEqual([{ id: 1, name: 'Recruit', iconUrl: 'r.png', sortOrder: 1 }]);
        expect(s.units![0]).toMatchObject({ id: 1, name: 'Alpha', sortOrder: 1, hasRadioChannel: true });
        expect(s.roles).toStrictEqual([{ id: 2, name: 'Member', description: null, is_system: true }]);
        expect(s.locations).toStrictEqual([{ id: 1, name: 'Port Olisar', parent_id: null, type: 'station' }]);
        expect(s.specializationTags).toStrictEqual([{ id: 1, name: 'Medic', description: undefined, icon: undefined, imageUrl: undefined }]);
        expect(s.certifications).toStrictEqual([{ id: 2, name: 'EVA', description: 'd', icon: 'i', imageUrl: 'u' }]);
        expect(s.commendations).toStrictEqual([{ id: 3, name: 'Valour', description: undefined, icon: undefined, imageUrl: undefined }]);
        expect(s.radioChannels).toStrictEqual([{ id: 1, name: 'Command', color: '#f00', sort_order: 1, type: 'base' }]);
        expect(s.securityClearances).toStrictEqual([{ id: 1, name: 'Secret', level: 3, description: null }]);
        expect(s.limitingMarkers).toStrictEqual([
            { id: 1, name: 'Ironclad', code: 'IRON', description: 'd', syncRestricted: true },
            { id: 2, name: 'Open', code: 'OPEN', description: null, syncRestricted: false },
        ]);
        expect(s.serviceTypes).toBe(SERVICE_TYPES);
        expect(s.anyStaffOnDuty).toBe(true);
        expect(s.orgMeta).toStrictEqual({ features: { academy: { enabled: true } } });
        expect(barrelLogs()).toEqual([]);
    });

    it('admin:access WITHOUT the system-admin identity still sees syncRestricted', async () => {
        const s = await getMainState({ isSystemAdmin: false, permissions: ['admin:access'] });
        expect(s.limitingMarkers![0]).toStrictEqual({ id: 1, name: 'Ironclad', code: 'IRON', description: 'd', syncRestricted: true });
    });

    it('staff below admin:access: syncRestricted is OMITTED (never false) and routing is stripped by allow-list', async () => {
        const s = await getMainState({ isSystemAdmin: false, permissions: ['user:view:roster'] });
        expect(s.users).toHaveLength(1);
        expect(s.limitingMarkers).toStrictEqual([
            { id: 1, name: 'Ironclad', code: 'IRON', description: 'd' },
            { id: 2, name: 'Open', code: 'OPEN', description: null },
        ]);
        for (const m of s.limitingMarkers!) expect('syncRestricted' in m).toBe(false);
        expect(s.serviceTypes).toStrictEqual([
            { id: 1, name: 'Security', icon: 'fa-shield', color: '#fff', description: 'd1', isActive: true },
            // Inactive types are KEPT (historic requests look their type up by name).
            { id: 2, name: 'Retired', icon: 'fa-x', color: '#000', description: null, isActive: false },
        ]);
        expect(JSON.stringify(s.serviceTypes)).not.toContain('111222333444555666');
    });

    it('a roster-authority-only role (admin:view:roster) receives the staff half', async () => {
        const s = await getMainState({ permissions: ['admin:view:roster'] });
        expect(s.users).toHaveLength(1);
        expect(queriesFor('ranks')).toHaveLength(1);
    });

    it('warns when the roster hits the 1000-row cap', async () => {
        h.handlers.users = () => ({ data: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `U${i}` })), error: null });
        const s = await getMainState(ADMIN);
        expect(s.users).toHaveLength(1000);
        expect(barrelLogs()).toEqual([{
            module: 'db.barrel', level: 'warn', fields: undefined,
            msg: 'getMainState roster hit the 1000-row cap — rows beyond it are not shipped; the roster needs pagination at this org size',
        }]);
    });

    it('null query data degrades to empty arrays, not a crash', async () => {
        h.handlers = {};
        for (const t of ['users', 'ranks', 'units', 'roles', 'locations', 'specialization_tags', 'certifications', 'commendations', 'radio_channels']) {
            h.handlers[t] = () => ({ data: null, error: null });
        }
        h.getLimitingMarkers.mockResolvedValue(null);
        const s = await getMainState(ADMIN);
        for (const k of ['users', 'ranks', 'units', 'roles', 'locations', 'specializationTags', 'certifications', 'commendations', 'radioChannels', 'limitingMarkers'] as const) {
            expect(s[k], k).toEqual([]);
        }
        expect(barrelLogs()).toEqual([]);
    });
});

describe('getMainState — non-staff caller and degraded reads', () => {
    it('a Client is never ISSUED a staff query; only the always-present half ships', async () => {
        const s = await getMainState({ isSystemAdmin: false, permissions: ['request:create', 'request:cancel', 'request:rate'] });
        expect(h.queries.map(q => q.table)).toEqual([]);
        expect(h.getSecurityClearances).not.toHaveBeenCalled();
        expect(h.getLimitingMarkers).not.toHaveBeenCalled();
        expect(s).toStrictEqual({
            serviceTypes: [
                { id: 1, name: 'Security', icon: 'fa-shield', color: '#fff', description: 'd1', isActive: true },
                { id: 2, name: 'Retired', icon: 'fa-x', color: '#000', description: null, isActive: false },
            ],
            anyStaffOnDuty: true,
            orgMeta: { features: { academy: { enabled: true } } },
        });
    });

    it('a null / undefined viewer is treated as non-staff (fail closed)', async () => {
        for (const viewer of [null, undefined, {}, { permissions: null }]) {
            h.queries = [];
            const s = await getMainState(viewer as never) as Record<string, unknown>;
            expect('users' in s, JSON.stringify(viewer)).toBe(false);
            expect(h.queries, JSON.stringify(viewer)).toEqual([]);
            expect(s.serviceTypes).toEqual([
                { id: 1, name: 'Security', icon: 'fa-shield', color: '#fff', description: 'd1', isActive: true },
                { id: 2, name: 'Retired', icon: 'fa-x', color: '#000', description: null, isActive: false },
            ]);
        }
    });

    it('a features read fault is logged and degrades to {} instead of failing boot', async () => {
        const boom = new Error('settings down');
        h.getOrgFeatures.mockRejectedValue(boom);
        h.isAnyStaffOnDuty.mockResolvedValue(null);
        const s = await getMainState({ permissions: [] });
        expect(s.orgMeta).toStrictEqual({ features: {} });
        expect(s.anyStaffOnDuty).toBeNull();
        expect(barrelLogs()).toEqual([{ module: 'db.barrel', level: 'error', msg: 'org features read failed; optional-module nav will hide', fields: { err: boom } }]);
    });
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const REQUEST_ROW = {
    id: 'req-1', client_id: 5, unregistered_client_rsi_handle: null, service_type: 'Medical', location: 'L',
    description: 'd', status: 'Submitted', urgency: 'High', threat_level: 'Low', lead_responder_id: null,
    created_at: 'c', updated_at: 'u', uec_earned: 0, medigel_consumed: 0, client_rating: 2,
    client_feedback: 'candid feedback', rated: true, party_info: null, secondary_client_handles: null,
    request_responders: [{ user: { id: 11, name: 'Resp', avatar_url: 'r.png', rsi_handle: 'resp', role_id: 2, rank_id: 1 } }],
    statusHistory: [],
};

describe('getRequestsState', () => {
    beforeEach(() => { h.handlers.service_requests = () => ({ data: [REQUEST_ROW], error: null }); });

    it('selects explicit columns with narrow user embeds, newest first, capped at 200', async () => {
        await getRequestsState({ id: 11, permissions: ['request:dispatch', 'request:view:feedback'] });
        const q = onlyQuery('service_requests');
        expect(q.calls.map(c => c.m)).toEqual(['select', 'order', 'order', 'limit']);
        const sel = String(q.calls[0].args[0]);
        expect(sel).not.toContain('*');
        expect(sel).toContain('client:users!service_requests_client_id_fkey(id, name, avatar_url, rsi_handle, role_id, rank_id, reputation)');
        expect(sel).toContain('user:users!request_responders_user_id_fkey(id, name, avatar_url, rsi_handle, role_id, rank_id)');
        expect(sel).toContain('updated_by:users!status_history_updated_by_fkey(id, name, avatar_url)');
        for (const col of ['admin_notes', 'discord_id', 'personnel_notes']) expect(sel).not.toContain(col);
        expect(q.calls.slice(1)).toEqual([
            { m: 'order', args: ['created_at', { ascending: false }] },
            { m: 'order', args: ['id', { ascending: false }] },
            { m: 'limit', args: [200] },
        ]);
    });

    it.each([['request:dispatch'], ['request:triage'], ['request:accept']])('%s sees the full log (no client_id filter)', async (perm) => {
        await getRequestsState({ id: 11, permissions: [perm] });
        expect(onlyQuery('service_requests').calls.some(c => c.m === 'eq')).toBe(false);
    });

    it('a non-duty caller is scoped to their own requests IN SQL', async () => {
        await getRequestsState({ id: 5, permissions: ['request:create'] });
        expect(onlyQuery('service_requests').calls.filter(c => c.m === 'eq')).toEqual([{ m: 'eq', args: ['client_id', 5] }]);
    });

    it('a missing caller / non-array permissions is scoped to client_id -1 (matches nothing)', async () => {
        await getRequestsState(null);
        await getRequestsState({ id: 7, permissions: 'request:dispatch' as never });
        const [a, b] = queriesFor('service_requests');
        expect(a.calls.filter(c => c.m === 'eq')).toEqual([{ m: 'eq', args: ['client_id', -1] }]);
        expect(b.calls.filter(c => c.m === 'eq')).toEqual([{ m: 'eq', args: ['client_id', 7] }]);
    });

    it('strips the candid feedback from a responder without request:view:feedback, keeps it for holders and the client', async () => {
        const member = await getRequestsState({ id: 11, permissions: ['request:accept'] });
        expect(member.requests[0].clientFeedback).toBeNull();
        expect(member.requests[0]).toMatchObject({ id: 'req-1', clientId: 5, clientRating: 2, assignedMemberIds: [11] });
        const viewer = await getRequestsState({ id: 12, permissions: ['request:accept', 'request:view:feedback'] });
        expect(viewer.requests[0].clientFeedback).toBe('candid feedback');
        const own = await getRequestsState({ id: 5, permissions: ['request:create'] });
        expect(own.requests[0].clientFeedback).toBe('candid feedback');
    });

    it('null data yields an empty list; a read error throws (fail closed)', async () => {
        h.handlers.service_requests = () => ({ data: null, error: null });
        await expect(getRequestsState({ id: 1, permissions: ['request:dispatch'] })).resolves.toEqual({ requests: [] });
        h.handlers.service_requests = () => ({ data: null, error: { message: 'boom' } });
        await expect(getRequestsState({ id: 1, permissions: ['request:dispatch'] })).rejects.toThrow('Failed to get requests');
    });
});

describe('getRequestDetail', () => {
    beforeEach(() => { h.handlers.service_requests = () => ({ data: REQUEST_ROW, error: null }); });

    it('fetches the one row by id with .single()', async () => {
        await getRequestDetail('req-1', { id: 11, permissions: ['request:dispatch'] });
        const q = onlyQuery('service_requests');
        expect(q.calls.map(c => c.m)).toEqual(['select', 'eq', 'single']);
        expect(q.calls[1].args).toEqual(['id', 'req-1']);
    });

    it('a missing row (PGRST116) is null; any other error is rethrown as-is', async () => {
        h.handlers.service_requests = () => ({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
        await expect(getRequestDetail('x', { id: 1, permissions: ['request:dispatch'] })).resolves.toBeNull();
        const err = { code: '42501', message: 'denied' };
        h.handlers.service_requests = () => ({ data: null, error: err });
        await expect(getRequestDetail('x', { id: 1, permissions: ['request:dispatch'] })).rejects.toBe(err);
    });

    it('a non-duty caller who is neither client nor responder gets null (indistinguishable from 404)', async () => {
        await expect(getRequestDetail('req-1', { id: 99, permissions: ['request:create'] })).resolves.toBeNull();
        await expect(getRequestDetail('req-1', null)).resolves.toBeNull();
        await expect(getRequestDetail('req-1', undefined)).resolves.toBeNull();
    });

    it('the client sees their own request with feedback', async () => {
        const r = await getRequestDetail('req-1', { id: 5, permissions: ['request:create'] });
        expect(r).toMatchObject({ id: 'req-1', clientFeedback: 'candid feedback' });
    });

    it('a non-duty responder may read it, minus the feedback', async () => {
        const r = await getRequestDetail('req-1', { id: 11, permissions: [] });
        expect(r).toMatchObject({ id: 'req-1', clientFeedback: null, assignedMemberIds: [11] });
    });

    it('a duty holder reads any request; feedback only with request:view:feedback', async () => {
        expect((await getRequestDetail('req-1', { id: 50, permissions: ['request:triage'] }))!.clientFeedback).toBeNull();
        expect((await getRequestDetail('req-1', { id: 50, permissions: ['request:triage', 'request:view:feedback'] }))!.clientFeedback).toBe('candid feedback');
    });
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const ANN = (id: number, audience: unknown) => ({ id, title: `T${id}`, body: `B${id}`, author: 'A', type: 'Info', audience, publish_date: 'p', expiry_date: null });
const ANN_ROWS = [
    ANN(1, ['Member']), ANN(2, ['Dispatcher']), ANN(3, ['Client']), ANN(4, ['Admin']),
    ANN(5, null), ANN(6, 'Member'), ANN(7, ['Login Screen']),
];

describe('getAnnouncementsState', () => {
    beforeEach(() => { h.handlers.announcements = () => ({ data: ANN_ROWS, error: null }); });

    it('selects explicit columns, newest first, capped at 100', async () => {
        await getAnnouncementsState({ role: 'Member', permissions: [] });
        expect(onlyQuery('announcements').calls).toEqual([
            { m: 'select', args: ['id, title, body, author, type, audience, publish_date, expiry_date'] },
            { m: 'order', args: ['publish_date', { ascending: false }] },
            { m: 'order', args: ['id', { ascending: false }] },
            { m: 'limit', args: [100] },
        ]);
    });

    it('an admin:config:notices holder sees every notice (management tab)', async () => {
        const { announcements } = await getAnnouncementsState({ role: 'Client', permissions: ['admin:config:notices'] });
        expect(announcements.map(a => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(announcements[0]).toStrictEqual({ id: 1, title: 'T1', body: 'B1', author: 'A', type: 'Info', audience: ['Member'], publishDate: 'p', expiryDate: null });
    });

    it.each([
        ['Member', [1]],
        ['Dispatcher', [1, 2]],
        ['Client', [3]],
        // The role STRING is audience data, not privilege: no Admin bypass without the perm.
        ['Admin', [4]],
    ])('role %s receives only its audience', async (role, ids) => {
        const { announcements } = await getAnnouncementsState({ role, permissions: [] });
        expect(announcements.map(a => a.id)).toEqual(ids);
    });

    it('no viewer, no role, or non-array permissions → nothing (and a malformed audience never matches)', async () => {
        expect((await getAnnouncementsState(null)).announcements).toEqual([]);
        expect((await getAnnouncementsState({ permissions: [] })).announcements).toEqual([]);
        const { announcements } = await getAnnouncementsState({ role: 'Member', permissions: 'admin:config:notices' as never });
        expect(announcements.map(a => a.id)).toEqual([1]);
    });

    it('null data is an empty list; a read error throws', async () => {
        h.handlers.announcements = () => ({ data: null, error: null });
        expect(await getAnnouncementsState({ role: 'Member' })).toEqual({ announcements: [] });
        h.handlers.announcements = () => ({ data: null, error: { message: 'x' } });
        await expect(getAnnouncementsState({ role: 'Member' })).rejects.toThrow('Failed to get announcements');
    });
});

describe('getLoginScreenAnnouncements', () => {
    it('scopes to the Login Screen audience IN THE QUERY and maps rows', async () => {
        h.handlers.announcements = () => ({ data: [ANN(7, ['Login Screen'])], error: null });
        const { announcements } = await getLoginScreenAnnouncements();
        expect(onlyQuery('announcements').calls).toEqual([
            { m: 'select', args: ['id, title, body, author, type, audience, publish_date, expiry_date'] },
            { m: 'contains', args: ['audience', ['Login Screen']] },
            { m: 'order', args: ['publish_date', { ascending: false }] },
            { m: 'order', args: ['id', { ascending: false }] },
            { m: 'limit', args: [50] },
        ]);
        expect(announcements).toStrictEqual([{ id: 7, title: 'T7', body: 'B7', author: 'A', type: 'Info', audience: ['Login Screen'], publishDate: 'p', expiryDate: null }]);
    });

    it('null data is empty; an error throws', async () => {
        h.handlers.announcements = () => ({ data: null, error: null });
        expect(await getLoginScreenAnnouncements()).toEqual({ announcements: [] });
        h.handlers.announcements = () => ({ data: null, error: { message: 'x' } });
        await expect(getLoginScreenAnnouncements()).rejects.toThrow('Failed to get login screen announcements');
    });
});

// ---------------------------------------------------------------------------
// Discord / app URL
// ---------------------------------------------------------------------------

describe('getDiscordState', () => {
    it('reads the three admin tables and builds the string-keyed role/rank maps', async () => {
        h.handlers = {
            settings: () => ({ data: { value: { clientId: 'cid', guildId: 'g' } }, error: null }),
            synced_discord_roles: () => ({ data: [{ id: 'd1', name: 'Pilot', color: 1 }], error: null }),
            rank_mappings: () => ({
                data: [
                    { discord_role_id: 'd1', rank_id: 3, role_id: null },
                    { discord_role_id: 'd2', rank_id: null, role_id: 4 },
                    { discord_role_id: 'd3', rank_id: 5, role_id: 6 },
                ], error: null,
            }),
        };
        const s = await getDiscordState();
        expect(onlyQuery('settings').calls).toEqual([{ m: 'select', args: ['value'] }, { m: 'eq', args: ['key', 'discordConfig'] }, { m: 'maybeSingle', args: [] }]);
        expect(onlyQuery('synced_discord_roles').calls).toEqual([{ m: 'select', args: ['id, name, color'] }]);
        expect(onlyQuery('rank_mappings').calls).toEqual([{ m: 'select', args: ['discord_role_id, rank_id, role_id'] }]);
        expect(s).toStrictEqual({
            discordConfig: { clientId: 'cid', guildId: 'g' },
            syncedDiscordRoles: [{ id: 'd1', name: 'Pilot', color: 1 }],
            rankMappings: { d1: '3', d3: '5' },
            roleMappings: { d2: '4', d3: '6' },
        });
    });

    it('missing rows degrade to empty config/maps', async () => {
        h.handlers = {
            settings: () => ({ data: null, error: null }),
            synced_discord_roles: () => ({ data: null, error: null }),
            rank_mappings: () => ({ data: null, error: null }),
        };
        expect(await getDiscordState()).toStrictEqual({ discordConfig: {}, syncedDiscordRoles: [], rankMappings: {}, roleMappings: {} });
    });
});

describe('resolveOrgAppUrl / getOrgTenantUrl', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('reads settings.systemConfig and uses the stored URL when APP_URL is unset', async () => {
        vi.stubEnv('APP_URL', '');
        h.handlers.settings = () => ({ data: { value: { appUrl: 'https://ops.alpha-org.net/' } }, error: null });
        const r = await resolveOrgAppUrl();
        expect(onlyQuery('settings').calls).toEqual([{ m: 'select', args: ['value'] }, { m: 'eq', args: ['key', 'systemConfig'] }, { m: 'maybeSingle', args: [] }]);
        expect(r).toMatchObject({ url: 'https://ops.alpha-org.net', source: 'stored' });
        expect(await getOrgTenantUrl()).toBe('https://ops.alpha-org.net');
    });

    it('APP_URL wins over the stored value', async () => {
        vi.stubEnv('APP_URL', 'https://env.alpha-org.net');
        h.handlers.settings = () => ({ data: { value: { appUrl: 'https://ops.alpha-org.net' } }, error: null });
        expect(await resolveOrgAppUrl()).toMatchObject({ url: 'https://env.alpha-org.net', source: 'env' });
    });

    it('no stored row and no env → the localhost fallback', async () => {
        vi.stubEnv('APP_URL', '');
        h.handlers.settings = () => ({ data: null, error: null });
        expect(await getOrgTenantUrl()).toBe('http://localhost:3000');
    });
});

// ---------------------------------------------------------------------------
// Operations / warrants / external tools / intel
// ---------------------------------------------------------------------------

describe('getOperationsState', () => {
    it('no user → empty lists without calling either producer', async () => {
        expect(await getOperationsState(undefined)).toStrictEqual({ operations: [], operationTemplates: [] });
        expect(h.getOperations).not.toHaveBeenCalled();
        expect(h.listOperationTemplates).not.toHaveBeenCalled();
    });

    it('passes the viewer to both producers and returns their results', async () => {
        const user = { id: 1, permissions: ['operations:view'] };
        h.getOperations.mockResolvedValue([{ id: 'op-1' }]);
        h.listOperationTemplates.mockResolvedValue([{ id: 't-1' }]);
        expect(await getOperationsState(user)).toStrictEqual({ operations: [{ id: 'op-1' }], operationTemplates: [{ id: 't-1' }] });
        expect(h.getOperations).toHaveBeenCalledWith(user);
        expect(h.listOperationTemplates).toHaveBeenCalledWith(user);
        expect(barrelLogs()).toEqual([]);
    });

    it('each producer soft-fails independently and is logged', async () => {
        const e1 = new Error('ops down');
        h.getOperations.mockRejectedValue(e1);
        h.listOperationTemplates.mockResolvedValue([{ id: 't-1' }]);
        expect(await getOperationsState({ id: 1 })).toStrictEqual({ operations: [], operationTemplates: [{ id: 't-1' }] });
        expect(barrelLogs()).toEqual([{ module: 'db.barrel', level: 'error', msg: 'getoperations rejected', fields: { err: e1 } }]);

        h.logs = [];
        const e2 = new Error('templates down');
        h.getOperations.mockResolvedValue([{ id: 'op-1' }]);
        h.listOperationTemplates.mockRejectedValue(e2);
        expect(await getOperationsState({ id: 1 })).toStrictEqual({ operations: [{ id: 'op-1' }], operationTemplates: [] });
        expect(barrelLogs()).toEqual([{ module: 'db.barrel', level: 'error', msg: 'listoperationtemplates rejected', fields: { err: e2 } }]);
    });
});

describe('getWarrantsState', () => {
    it('selects the shared WARRANT_SELECT, newest first, capped, and minifies embeds', async () => {
        h.handlers.warrants = () => ({
            data: [{
                id: 'w1', target_rsi_handle: 'Pirate', reason: 'r', action: 'KOS', uec_reward: 10, status: 'Active',
                issued_by: 11, claimed_by: null, source_feed_id: null, external_id: null, notes: null, created_at: 'c',
                issuedBy: { id: 11, name: 'Issuer', avatar_url: 'i.png', role_id: 2, admin_notes: 'SECRET' }, claimedBy: null, feed: null,
            }], error: null,
        });
        const { warrants } = await getWarrantsState();
        expect(onlyQuery('warrants').calls).toEqual([
            { m: 'select', args: [WARRANT_SELECT] },
            { m: 'order', args: ['created_at', { ascending: false }] },
            { m: 'order', args: ['id', { ascending: false }] },
            { m: 'limit', args: [200] },
        ]);
        expect(warrants).toHaveLength(1);
        expect(warrants[0]).toMatchObject({ id: 'w1', targetRsiHandle: 'Pirate', issuedBy: 11, issuedByUser: { id: 11, name: 'Issuer', discordId: '' } });
        expect(JSON.stringify(warrants)).not.toContain('SECRET');
    });

    it('null data is empty; an error throws', async () => {
        h.handlers.warrants = () => ({ data: null, error: null });
        expect(await getWarrantsState()).toEqual({ warrants: [] });
        h.handlers.warrants = () => ({ data: null, error: { message: 'x' } });
        await expect(getWarrantsState()).rejects.toThrow('Failed to get warrants');
    });
});

describe('getExternalToolsState', () => {
    const TOOL = (id: number, title: string, audience: unknown, category: string | null, sort_order: unknown) =>
        ({ id, title, description: `d${id}`, url: `https://t${id}`, icon: `i${id}`, audience, category, sort_order, secret_LEAK: 'x' });
    const TOOLS = [
        TOOL(1, 'Zeta', ['Member'], 'B', 2),
        TOOL(2, 'Alpha', ['Member', 'Client'], 'B', 2),
        TOOL(3, 'Mid', ['Member'], 'A', 5),
        TOOL(4, 'Uncat', ['Member'], null, '7'),
        TOOL(5, 'First', ['Member'], 'B', 1),
        TOOL(6, 'Staff', ['Dispatcher'], 'A', 0),
        TOOL(7, 'Broken', 'Member', 'A', 0),
        // Two uncategorised tools, so the comparator meets an uncategorised item on BOTH sides.
        TOOL(8, 'Uncat2', ['Member'], null, 0),
    ];
    beforeEach(() => { h.handlers.external_tools = () => ({ data: TOOLS, error: null }); });

    it('selects explicit columns and maps each row field-by-field', async () => {
        const { externalTools } = await getExternalToolsState({ role: 'Member', permissions: [] });
        expect(onlyQuery('external_tools').calls).toEqual([{ m: 'select', args: ['id, title, description, url, icon, audience, category, sort_order'] }]);
        expect(externalTools.find(t => t.id === 4)).toStrictEqual({
            id: 4, title: 'Uncat', description: 'd4', url: 'https://t4', icon: 'i4', audience: ['Member'], category: undefined, sortOrder: 0,
        });
    });

    it('audience-filters a non-manager and sorts by category (uncategorised last), sortOrder, title', async () => {
        const { externalTools } = await getExternalToolsState({ role: 'Member', permissions: [] });
        expect(externalTools.map(t => t.id)).toEqual([3, 5, 2, 1, 4, 8]);
        expect((await getExternalToolsState({ role: 'Client' })).externalTools.map(t => t.id)).toEqual([2]);
    });

    it('an admin:config:tools holder gets the full, sorted list', async () => {
        const { externalTools } = await getExternalToolsState({ role: 'Client', permissions: ['admin:config:tools'] });
        expect(externalTools.map(t => t.id)).toEqual([7, 6, 3, 5, 2, 1, 4, 8]);
    });

    it('no viewer / no role → nothing', async () => {
        expect((await getExternalToolsState(null)).externalTools).toEqual([]);
        expect((await getExternalToolsState({ permissions: [] })).externalTools).toEqual([]);
    });

    it('null data is empty; an error throws', async () => {
        h.handlers.external_tools = () => ({ data: null, error: null });
        expect(await getExternalToolsState({ role: 'Member' })).toEqual({ externalTools: [] });
        h.handlers.external_tools = () => ({ data: null, error: { message: 'x' } });
        await expect(getExternalToolsState({ role: 'Member' })).rejects.toThrow('Failed to get tools');
    });
});

describe('getIntelState', () => {
    const BULLETINS = [
        { id: 'b0', classificationLevel: 0, limitingMarkers: [] },
        { id: 'b3', classificationLevel: 3, limitingMarkers: [] },
        { id: 'bm', classificationLevel: 0, limitingMarkers: ['NOFORN'] },
    ];

    it('passes the viewer to the clearance-ceilinged aggregates and filters bulletins by clearance', async () => {
        const viewer = { id: 1, permissions: ['intel:view'], clearanceLevel: { level: 1 }, limitingMarkers: [] };
        h.getIntelTargetIndex.mockResolvedValue([{ targetId: 't' }]);
        h.getIntelHubStats.mockResolvedValue({ total: 1 });
        h.getActiveBulletins.mockResolvedValue(BULLETINS);
        const s = await getIntelState(viewer);
        expect(h.getIntelTargetIndex).toHaveBeenCalledWith(viewer);
        expect(h.getIntelHubStats).toHaveBeenCalledWith(viewer);
        expect(h.getActiveBulletins).toHaveBeenCalledWith();
        expect(s).toStrictEqual({ intelTargetIndex: [{ targetId: 't' }], intelHubStats: { total: 1 }, activeBulletins: [BULLETINS[0]] });
    });

    it('the marker holder at clearance sees the compartmented bulletins; intel:manage sees all', async () => {
        h.getActiveBulletins.mockResolvedValue(BULLETINS);
        const cleared = await getIntelState({ permissions: ['intel:view'], clearanceLevel: { level: 3 }, limitingMarkers: ['NOFORN'] });
        expect(cleared.activeBulletins.map((b: { id: string }) => b.id)).toEqual(['b0', 'b3', 'bm']);
        const manager = await getIntelState({ permissions: ['intel:manage'] });
        expect(manager.activeBulletins.map((b: { id: string }) => b.id)).toEqual(['b0', 'b3', 'bm']);
        const anon = await getIntelState(undefined);
        expect(anon.activeBulletins.map((b: { id: string }) => b.id)).toEqual(['b0']);
    });
});

// ---------------------------------------------------------------------------
// getState — the boot aggregate
// ---------------------------------------------------------------------------

describe('getState — per-slice permission gating', () => {
    // The four permission-gated slices getState composes, each mirroring the
    // SUBSET_REQUIRED_PERMISSION of its dedicated subset in api/query.ts. hrConfig
    // is a settings key, but it is gated on hr:view by the settings projection, so
    // it belongs to the HR slice for the purposes of "what hr:view unlocks".
    type Slice = 'ops' | 'warrants' | 'hr' | 'intel';
    const SLICES: readonly Slice[] = ['ops', 'warrants', 'hr', 'intel'];
    const SLICE_KEYS: Record<Slice, readonly string[]> = {
        ops: ['operations', 'operationTemplates'],
        warrants: ['warrants'],
        hr: ['hrApplications', 'hrConfig'],
        intel: ['intelTargetIndex', 'intelHubStats', 'activeBulletins'],
    };
    const BOOT_BULLETIN = { id: 'b-boot', classificationLevel: 0, limitingMarkers: [] };
    const WARRANT_ROW = {
        id: 'w-boot', target_rsi_handle: 'Pirate', reason: 'r', action: 'KOS', uec_reward: 10, status: 'Active',
        issued_by: null, claimed_by: null, source_feed_id: null, external_id: null, notes: null, created_at: 'c',
        issuedBy: null, claimedBy: null, feed: null,
    };

    // The producer for a slice ran, exactly once, with the viewer.
    const expectProduced = (slice: Slice, viewer: unknown) => {
        switch (slice) {
            case 'ops':
                expect(h.getOperations).toHaveBeenCalledTimes(1);
                expect(h.getOperations).toHaveBeenCalledWith(viewer);
                expect(h.listOperationTemplates).toHaveBeenCalledTimes(1);
                expect(h.listOperationTemplates).toHaveBeenCalledWith(viewer);
                break;
            case 'warrants':
                expect(onlyQuery('warrants').calls[0]).toEqual({ m: 'select', args: [WARRANT_SELECT] });
                break;
            case 'hr':
                expect(h.getHRState).toHaveBeenCalledTimes(1);
                expect(h.getHRState).toHaveBeenCalledWith(viewer);
                break;
            case 'intel':
                expect(h.getIntelTargetIndex).toHaveBeenCalledTimes(1);
                expect(h.getIntelTargetIndex).toHaveBeenCalledWith(viewer);
                expect(h.getIntelHubStats).toHaveBeenCalledTimes(1);
                expect(h.getIntelHubStats).toHaveBeenCalledWith(viewer);
                expect(h.getActiveBulletins).toHaveBeenCalledTimes(1);
                break;
        }
    };
    // The producer for a slice was never invoked (for warrants: the table was never queried).
    const expectNotProduced = (slice: Slice) => {
        switch (slice) {
            case 'ops':
                expect(h.getOperations, 'getOperations').not.toHaveBeenCalled();
                expect(h.listOperationTemplates, 'listOperationTemplates').not.toHaveBeenCalled();
                break;
            case 'warrants':
                expect(queriesFor('warrants'), 'warrants query').toEqual([]);
                break;
            case 'hr':
                expect(h.getHRState, 'getHRState').not.toHaveBeenCalled();
                break;
            case 'intel':
                expect(h.getIntelTargetIndex, 'getIntelTargetIndex').not.toHaveBeenCalled();
                expect(h.getIntelHubStats, 'getIntelHubStats').not.toHaveBeenCalled();
                expect(h.getActiveBulletins, 'getActiveBulletins').not.toHaveBeenCalled();
                break;
        }
    };
    // The slice's keys carry exactly what its producer returned.
    const expectSliceValues = (slice: Slice, s: Record<string, unknown>) => {
        const picked = Object.fromEntries(SLICE_KEYS[slice].map(k => [k, s[k]]));
        switch (slice) {
            case 'ops':
                expect(picked).toStrictEqual({ operations: [{ id: 'op-1' }], operationTemplates: [{ id: 't-1' }] });
                break;
            case 'warrants':
                expect(s.warrants).toHaveLength(1);
                expect((s.warrants as unknown[])[0]).toMatchObject({ id: 'w-boot', targetRsiHandle: 'Pirate', action: 'KOS' });
                break;
            case 'hr':
                expect(picked).toStrictEqual({ hrApplications: [{ id: 'a1' }], hrConfig: { stages: ['Applied'] } });
                break;
            case 'intel':
                expect(picked).toStrictEqual({ intelTargetIndex: [{ targetId: 't' }], intelHubStats: { total: 1 }, activeBulletins: [BOOT_BULLETIN] });
                break;
        }
    };
    const expectSliceAbsent = (slice: Slice, s: Record<string, unknown>, why: string) => {
        for (const k of SLICE_KEYS[slice]) expect(k in s, `${why} must not receive ${k}`).toBe(false);
    };

    beforeEach(() => {
        h.getAllSettings.mockResolvedValue({
            brandingConfig: { name: 'ORG' }, schema_version: '15', wikiHomeConfig: { w: 1 }, hrConfig: { stages: ['Applied'] },
        });
        h.getOperations.mockResolvedValue([{ id: 'op-1' }]);
        h.listOperationTemplates.mockResolvedValue([{ id: 't-1' }]);
        h.getHRState.mockResolvedValue({ hrApplications: [{ id: 'a1' }] });
        h.getIntelTargetIndex.mockResolvedValue([{ targetId: 't' }]);
        h.getIntelHubStats.mockResolvedValue({ total: 1 });
        h.getActiveBulletins.mockResolvedValue([BOOT_BULLETIN]);
        h.handlers.warrants = () => ({ data: [WARRANT_ROW], error: null });
        h.handlers.service_requests = () => ({ data: [], error: null });
        h.handlers.announcements = () => ({ data: [], error: null });
        h.handlers.external_tools = () => ({ data: [], error: null });
    });

    it('a Client never triggers the ops/warrant/hr/intel producers and receives none of their keys', async () => {
        const client = { id: 5, role: 'Client', permissions: ['request:create'], isSystemAdmin: false };
        const s = await getState(client) as Record<string, unknown>;
        for (const slice of SLICES) {
            expectNotProduced(slice);
            expectSliceAbsent(slice, s, 'a Client');
        }
        expect('users' in s).toBe(false);
        // Always-present slices + the projected settings (never the raw blob).
        expect(s).toMatchObject({ requests: [], announcements: [], externalTools: [], brandingConfig: { name: 'ORG' }, anyStaffOnDuty: true });
        expect('schema_version' in s).toBe(false);
        expect('wikiHomeConfig' in s).toBe(false);
        expect(h.getAllSettings).toHaveBeenCalledWith({ decryptSecrets: false });
    });

    // Each permission ALONE: its own producer runs and its keys ship; the other three
    // producers never run and their keys are absent. A swap of the permission string
    // between two `want*` gates in getState (e.g. HR gated on warrant:view) fails here.
    it.each([
        ['operations:view', 'ops'],
        ['warrant:view', 'warrants'],
        ['hr:view', 'hr'],
        ['intel:view', 'intel'],
    ] as const)('%s alone unlocks the %s slice and no other', async (perm, slice) => {
        const viewer = { id: 6, role: 'Member', permissions: [perm] };
        const s = await getState(viewer) as Record<string, unknown>;
        expectProduced(slice, viewer);
        expectSliceValues(slice, s);
        for (const other of SLICES.filter(x => x !== slice)) {
            expectNotProduced(other);
            expectSliceAbsent(other, s, perm);
        }
        expect('wikiHomeConfig' in s, `${perm} must not receive wikiHomeConfig`).toBe(false);
    });

    it('composition: all four read permissions plus wiki:view merge every gated slice and gated setting into one payload', async () => {
        const viewer = { id: 6, role: 'Member', permissions: ['operations:view', 'warrant:view', 'hr:view', 'intel:view', 'wiki:view'] };
        const s = await getState(viewer) as Record<string, unknown>;
        for (const slice of SLICES) {
            expectProduced(slice, viewer);
            expectSliceValues(slice, s);
        }
        expect(s.wikiHomeConfig).toStrictEqual({ w: 1 });
        expect('schema_version' in s).toBe(false);
    });

    it('intel:view:clearance satisfies the intel gate through the implication table — and nothing else', async () => {
        const viewer = { id: 7, role: 'Member', permissions: ['intel:view:clearance'] };
        const s = await getState(viewer) as Record<string, unknown>;
        expectProduced('intel', viewer);
        expectSliceValues('intel', s);
        expect(queriesFor('warrants')).toEqual([]);
        for (const other of ['ops', 'warrants', 'hr'] as const) {
            expectNotProduced(other);
            expectSliceAbsent(other, s, 'intel:view:clearance');
        }
    });

    it('an Admin role NAME without the permissions gets no gated slice (no name bypass)', async () => {
        const s = await getState({ id: 8, role: 'Admin', permissions: [] }) as Record<string, unknown>;
        for (const slice of SLICES) {
            expectNotProduced(slice);
            expectSliceAbsent(slice, s, 'a permissionless Admin name');
        }
    });

    it('no viewer at all fails closed on every gated slice', async () => {
        const s = await getState(undefined) as Record<string, unknown>;
        for (const slice of SLICES) {
            expectNotProduced(slice);
            expectSliceAbsent(slice, s, 'no viewer');
        }
        // Own-requests scoping still applies: client_id -1 matches nothing.
        expect(onlyQuery('service_requests').calls.filter(c => c.m === 'eq')).toEqual([{ m: 'eq', args: ['client_id', -1] }]);
    });
});
