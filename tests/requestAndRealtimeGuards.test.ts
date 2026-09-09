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
    pushes: [] as Array<{ userIds: number[]; payload: Record<string, unknown> }>,
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
    sendPushToUsers: async (userIds: number[], payload: Record<string, unknown>) => { h.pushes.push({ userIds, payload }); },
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
    h.pushes = [];
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
        await expect(assertRequestOwnerOrDuty('r1', { id: 5, permissions: ['request:cancel'] }, 'rate'))
            .rejects.toThrow(/your own requests/i);
    });
    it('the owner passes', async () => {
        h.resolveQuery = () => ({ data: { client_id: 5 }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 5, permissions: ['request:rate'] }, 'rate'))
            .resolves.toBeUndefined();
    });
    it('a dispatch-duty holder bypasses without an ownership lookup', async () => {
        h.queries = [];
        await assertRequestOwnerOrDuty('r1', { id: 6, permissions: ['request:dispatch'] }, 'rate');
        expect(h.queries.find(q => q.table === 'service_requests')).toBeUndefined();
    });
    it('request:accept alone is NOT dispatch duty — a non-owner cannot cancel/rate', async () => {
        h.resolveQuery = () => ({ data: { client_id: 99 }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 6, permissions: ['request:accept'] }, 'rate'))
            .rejects.toThrow(/your own requests/i);
    });
    it('a role NAME alone is not duty — the bypass is permission-only', async () => {
        h.resolveQuery = () => ({ data: { client_id: 99 }, error: null });
        await expect(assertRequestOwnerOrDuty(
            'r1',
            { id: 6, role: 'Admin', permissions: [] } as unknown as Parameters<typeof assertRequestOwnerOrDuty>[1],
            'rate',
        )).rejects.toThrow(/your own requests/i);
    });

    // The status half of the same predicate. Both client copies gate Cancel on
    // status === Submitted; the server checked ownership and nothing else, so a Client could
    // flip their OWN completed job to Cancelled and delete it from the public scoreboard.
    it('the owner may cancel a Submitted request', async () => {
        h.resolveQuery = () => ({ data: { client_id: 5, status: 'Submitted' }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 5, permissions: ['request:cancel'] }, 'cancel'))
            .resolves.toBeUndefined();
    });
    it('the owner may NOT cancel a request that has been picked up', async () => {
        for (const status of ['Accepted', 'In-Progress', 'Success', 'Cancelled']) {
            h.resolveQuery = () => ({ data: { client_id: 5, status }, error: null });
            await expect(assertRequestOwnerOrDuty('r1', { id: 5, permissions: ['request:cancel'] }, 'cancel'))
                .rejects.toThrow(/no longer be cancelled/i);
        }
    });
    it('a duty holder may still cancel from any status', async () => {
        h.resolveQuery = () => ({ data: { client_id: 99, status: 'Success' }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 6, permissions: ['request:dispatch'] }, 'cancel'))
            .resolves.toBeUndefined();
    });
    it('the RATE kind does not apply the cancel status precondition', async () => {
        h.resolveQuery = () => ({ data: { client_id: 5, status: 'Success' }, error: null });
        await expect(assertRequestOwnerOrDuty('r1', { id: 5, permissions: ['request:rate'] }, 'rate'))
            .resolves.toBeUndefined();
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

describe('the operation-alert PUSH is clearance-aware, not just the broadcast', () => {
    // The broadcast was carefully reduced to {operationId, timestamp} and the read is
    // gated behind operations:view + assertOpVisibleToUser — and then the push carried
    // the raw alert text to every active participant with no filter at all. A push lands
    // on a lock screen, outside the app, so it is the LEAST gated surface of the three.
    //
    // Being a participant is not being cleared to read the op: addOperationParticipant
    // does not check the target's clearance, updateOperation can add limiting markers
    // after people have joined, and clearance can be revoked afterwards. That is exactly
    // why the reminder job (lib/db/opReminders.ts) already withholds the op NAME on a
    // restricted op; the alert path now mirrors it.
    const ALERT = 'Abort the approach — hostiles on site';

    /** Drive operationIsRestricted's three dimensions plus the participant read. */
    const withOp = (op: { clearance_level?: number; is_special?: boolean }, markerCount = 0) => {
        h.resolveQuery = (q) => {
            if (q.table === 'operations') return { data: { clearance_level: op.clearance_level ?? 0, is_special: !!op.is_special }, error: null };
            if (q.table === 'operation_limiting_markers') return { data: [], error: null, count: markerCount } as never;
            if (q.table === 'operation_participants') return { data: [{ user_id: 7 }, { user_id: 8 }], error: null };
            return { data: [], error: null };
        };
    };

    it('an UNRESTRICTED op still pushes the alert text — the fix must not mute everything', async () => {
        withOp({ clearance_level: 0, is_special: false }, 0);
        await broadcastOperationAlert('op-1', ALERT);
        expect(h.pushes).toHaveLength(1);
        expect(h.pushes[0].payload.body).toBe(ALERT);
    });

    it('a CLEARANCE-GATED op pushes a content-free notice instead', async () => {
        withOp({ clearance_level: 3, is_special: false }, 0);
        await broadcastOperationAlert('op-1', ALERT);
        expect(h.pushes).toHaveLength(1);
        expect(h.pushes[0].payload.body).not.toContain('hostiles');
        expect(JSON.stringify(h.pushes), 'the alert text reached a push on a restricted op').not.toContain('hostiles');
    });

    it('a SPECIAL op does too', async () => {
        withOp({ clearance_level: 0, is_special: true }, 0);
        await broadcastOperationAlert('op-1', ALERT);
        expect(JSON.stringify(h.pushes)).not.toContain('hostiles');
    });

    it('and so does an op carrying a LIMITING MARKER', async () => {
        withOp({ clearance_level: 0, is_special: false }, 1);
        await broadcastOperationAlert('op-1', ALERT);
        expect(JSON.stringify(h.pushes)).not.toContain('hostiles');
    });

    it('routing is unchanged, so a cleared member still taps through to the gated read', async () => {
        withOp({ clearance_level: 3 }, 0);
        await broadcastOperationAlert('op-9', ALERT);
        expect(h.pushes[0].payload.data).toMatchObject({ type: 'operation_alert', operationId: 'op-9' });
        expect(h.pushes[0].userIds).toEqual([7, 8]);
    });

    it('fails CLOSED — an unreadable operation row withholds the text', async () => {
        // operationIsRestricted returns true on any read fault; the alert must follow it.
        h.resolveQuery = (q) => {
            if (q.table === 'operations') return { data: null, error: { message: 'boom' } };
            if (q.table === 'operation_participants') return { data: [{ user_id: 7 }], error: null };
            return { data: [], error: null };
        };
        await broadcastOperationAlert('op-1', ALERT);
        expect(JSON.stringify(h.pushes)).not.toContain('hostiles');
    });
});
