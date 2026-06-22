import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins for the 2026-06-04 deep-dive audit fixes:
//   1. Request visibility is SERVER-enforced per caller (BOLA fix): non-duty
//      callers get their own requests only; request_detail returns null for
//      non-owners.
//   2. The intel aggregates (target index / hub stats) are clearance-ceilinged
//      per viewer — classified targets no longer leak to low-clearance
//      intel:view holders.
//   3. Realtime content strips: the EAM broadcast carries a timestamp trigger
//      only (no message body, no db-changes copy); the operation alert
//      broadcast carries {operationId, timestamp} only.
//   4. signRealtimeToken mints a standards-compliant authenticated JWT (and
//      fails closed to null without SUPABASE_JWT_SECRET).

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    broadcasts: [] as Array<{ channel: string; event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            const q = { table, calls };
            h.queries.push(q);
            return Promise.resolve(h.resolveQuery(q));
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: () => Promise.resolve({ data: null, error: null }),
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
            if (error) throw new Error(message);
        },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ channel: 'db-changes', event, payload }); },
        broadcastToChannel: (channel: string, event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ channel, event, payload }); },
        getSystemRoles: async () => ({ client: { id: 1 }, member: { id: 2 }, dispatcher: { id: 3 }, admin: { id: 4 } }),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

// Push must not fire real web-push during the EAM test.
vi.mock('../lib/push', () => ({
    sendPushToAll: async () => {},
    sendPushToUsers: async () => {},
    sendPushToRoles: async () => {},
    sendPushToStaff: async () => {},
    sendPushToPermission: async () => {},
}));

import { getRequestsState, getRequestDetail, assertRequestOwnerOrDuty } from '../lib/db';
import { getIntelTargetIndex } from '../lib/db/intel';
import { broadcastEAM } from '../lib/db/system';
import { broadcastOperationAlert, getLatestOperationAlert } from '../lib/db/ops';
import { signRealtimeToken } from '../lib/auth';
import type { User } from '../types';

beforeEach(() => {
    h.resolveQuery = () => ({ data: [], error: null });
    h.queries = [];
    h.broadcasts = [];
});

describe('request visibility is server-enforced per caller (BOLA fix)', () => {
    it('a Client-tier caller gets an own-requests-only SQL scope', async () => {
        await getRequestsState({ id: 5, role: 'Client', permissions: [] });
        const q = h.queries.find(q => q.table === 'service_requests');
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['client_id', 5] });
    });

    it('a duty-permission holder gets the full log (no client_id scope)', async () => {
        await getRequestsState({ id: 6, role: 'Member', permissions: ['request:accept'] });
        const q = h.queries.find(q => q.table === 'service_requests');
        expect(q?.calls.some(c => c.method === 'eq' && c.args[0] === 'client_id')).toBe(false);
    });

    it('an unauthenticated/unresolved caller matches nothing', async () => {
        await getRequestsState(null);
        const q = h.queries.find(q => q.table === 'service_requests');
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['client_id', -1] });
    });

    it('request_detail returns null for a non-owner non-duty caller (404 upstream)', async () => {
        h.resolveQuery = () => ({ data: { id: 'r1', client_id: 99, request_responders: [], statusHistory: [] }, error: null });
        const denied = await getRequestDetail('r1', { id: 5, role: 'Client', permissions: [] });
        expect(denied).toBeNull();
        const owner = await getRequestDetail('r1', { id: 99, role: 'Client', permissions: [] });
        expect(owner?.id).toBe('r1');
    });
});

describe('request WRITE ownership gate (cancel/rate BOLA fix)', () => {
    it('a non-owner Client is rejected', async () => {
        h.resolveQuery = () => ({ data: { client_id: 99 }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 5, role: 'Client', permissions: ['request:cancel'] }))
            .rejects.toThrow(/your own requests/i);
    });
    it('the owner passes', async () => {
        h.resolveQuery = () => ({ data: { client_id: 5 }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 5, role: 'Client', permissions: ['request:rate'] }))
            .resolves.toBeUndefined();
    });
    it('a dispatch-duty holder bypasses without an ownership lookup', async () => {
        h.queries = [];
        await assertRequestOwnerOrDuty('r1', { id: 6, role: 'Member', permissions: ['request:dispatch'] });
        expect(h.queries.find(q => q.table === 'service_requests')).toBeUndefined();
    });
    it('request:accept alone is NOT dispatch duty — a non-owner cannot cancel/rate', async () => {
        h.resolveQuery = () => ({ data: { client_id: 99 }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 6, role: 'Member', permissions: ['request:accept'] }))
            .rejects.toThrow(/your own requests/i);
    });
});

describe('getLatestOperationAlert uses the real column names', () => {
    it('filters on entry_type and reads log_entry (not type/content)', async () => {
        h.resolveQuery = () => ({ data: { log_entry: 'Operations Alert: stand down', created_at: 't', author: { name: 'CO' } }, error: null });
        const alert = await getLatestOperationAlert('op-1');
        expect(alert).toEqual({ message: 'stand down', senderName: 'CO', timestamp: 't' });
        const q = h.queries.find(q => q.table === 'operation_log_entries');
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['entry_type', 'ALERT'] });
        expect(q?.calls.some(c => c.method === 'select' && String(c.args[0]).includes('log_entry'))).toBe(true);
    });
});

describe('intel target index is clearance-ceilinged per viewer', () => {
    const rows = [
        { target_id: 'OpenTarget', threat_level: 'High', classification_level: 0, intel_report_limiting_markers: [] },
        { target_id: 'MarkedTarget', threat_level: 'Critical', classification_level: 0, intel_report_limiting_markers: [{ marker: { id: 9, name: 'NDL', code: 'NDL' } }] },
    ];

    it('applies the SQL classification ceiling for normal viewers', async () => {
        h.resolveQuery = () => ({ data: rows, error: null });
        await getIntelTargetIndex({ role: 'Member', permissions: ['intel:view'], clearanceLevel: { level: 2 }, limitingMarkers: [] } as unknown as User);
        const q = h.queries.find(q => q.table === 'intel_reports');
        expect(q?.calls).toContainEqual({ method: 'lte', args: ['classification_level', 2] });
    });

    it('excludes marker-compartmented targets the viewer lacks', async () => {
        h.resolveQuery = () => ({ data: rows, error: null });
        const idx = await getIntelTargetIndex({ role: 'Member', permissions: ['intel:view'], clearanceLevel: { level: 5 }, limitingMarkers: [] } as unknown as User);
        expect(idx.map(e => e.targetId)).toEqual(['OpenTarget']);
    });

    it('intel:manage bypass sees the full index with no ceiling', async () => {
        h.resolveQuery = () => ({ data: rows, error: null });
        const idx = await getIntelTargetIndex({ role: 'Member', permissions: ['intel:manage'], clearanceLevel: { level: 0 }, limitingMarkers: [] } as unknown as User);
        expect(idx.map(e => e.targetId).sort()).toEqual(['MarkedTarget', 'OpenTarget']);
        const q = h.queries.find(q => q.table === 'intel_reports');
        expect(q?.calls.some(c => c.method === 'lte')).toBe(false);
    });
});

describe('realtime content strips (anon-channel leak fixes)', () => {
    it('broadcastEAM emits a timestamp trigger only — no message body, no db-changes copy', async () => {
        await broadcastEAM('FLASH TRAFFIC: classified directive');
        const eamEmits = h.broadcasts.filter(b => b.event === 'eam_broadcast');
        expect(eamEmits).toHaveLength(1);
        expect(eamEmits[0].channel).toBe('auth-alerts');
        expect(Object.keys(eamEmits[0].payload)).toEqual(['timestamp']);
        expect(JSON.stringify(h.broadcasts)).not.toContain('FLASH TRAFFIC');
    });

    it('broadcastOperationAlert emits {operationId, timestamp} only — no message, no sender name', async () => {
        await broadcastOperationAlert('op-1', 'Abort the approach — hostiles on site');
        const emit = h.broadcasts.find(b => b.event === 'operation_alert');
        expect(emit?.channel).toBe('auth-alerts');
        expect(Object.keys(emit?.payload ?? {}).sort()).toEqual(['operationId', 'timestamp']);
        expect(JSON.stringify(h.broadcasts)).not.toContain('hostiles');
    });
});

describe('signRealtimeToken', () => {
    it('fails closed to null without SUPABASE_JWT_SECRET', () => {
        const prev = process.env.SUPABASE_JWT_SECRET;
        delete process.env.SUPABASE_JWT_SECRET;
        try {
            expect(signRealtimeToken(42)).toBeNull();
        } finally {
            if (prev !== undefined) process.env.SUPABASE_JWT_SECRET = prev;
        }
    });

    it('mints an HS256 authenticated JWT with a uuid sub and the integer user_id claim', () => {
        const prev = process.env.SUPABASE_JWT_SECRET;
        process.env.SUPABASE_JWT_SECRET = 'test-secret';
        try {
            const token = signRealtimeToken(42);
            expect(token).toBeTruthy();
            const [headerB64, payloadB64, sig] = token!.split('.');
            expect(sig).toBeTruthy();
            const fromB64url = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
            const header = fromB64url(headerB64);
            const payload = fromB64url(payloadB64);
            expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
            expect(payload.role).toBe('authenticated');
            expect(payload.user_id).toBe(42);
            expect(payload.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
            expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
        } finally {
            if (prev !== undefined) process.env.SUPABASE_JWT_SECRET = prev;
            else delete process.env.SUPABASE_JWT_SECRET;
        }
    });
});
