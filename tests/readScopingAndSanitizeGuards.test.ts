import { describe, it, expect, vi, beforeEach } from 'vitest';

// Through-the-call-site tests for behaviour that lives in the wiring (not a pure
// helper): intel SQL clearance ceiling, .or() search builders routing through
// safeSearchTerm, allied-participant sanitize, warehouse limit clamp. A
// call-recording fake supabase captures the query chain.

const h = vi.hoisted(() => ({
    calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
    data: {} as Record<string, unknown>,
    captured: {} as Record<string, Record<string, unknown>>, // table → last insert/upsert values
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'or', 'contains', 'range', 'update', 'delete']) {
            b[m] = (...args: unknown[]) => { h.calls.push({ table, method: m, args }); return b; };
        }
        b.insert = (v: Record<string, unknown>) => { h.calls.push({ table, method: 'insert', args: [v] }); h.captured[table] = v; return b; };
        b.upsert = (v: Record<string, unknown>) => { h.calls.push({ table, method: 'upsert', args: [v] }); h.captured[table] = v; return b; };
        const settle = () => Promise.resolve({ data: h.data[table] ?? [], error: null });
        b.single = () => Promise.resolve({ data: h.data[table] ?? null, error: null });
        b.maybeSingle = () => Promise.resolve({ data: h.data[table] ?? null, error: null });
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {},
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fb: unknown) => {
            try { const { data, error } = await q; return error ? fb : (data ?? fb); } catch { return fb; }
        },
        getSystemRoles: async () => ({}),
    };
});

import { listIntelReports } from '../lib/db/intel';
import { searchPlatformLocations } from '../lib/db/locations';
import { upsertAlliedParticipant } from '../lib/db/operations-federation';
import { listWarehouseMovements } from '../lib/db/warehouse';

beforeEach(() => { h.calls = []; h.data = {}; h.captured = {}; });

const lte = () => h.calls.filter(c => c.method === 'lte');

describe('listIntelReports clearance-level ceiling', () => {
    it('applies classification_level <= viewer level for a non-manager', async () => {
        await listIntelReports({ viewer: { clearanceLevel: { level: 2 }, permissions: [], role: 'Member' } });
        const ceiling = lte().find(c => c.args[0] === 'classification_level');
        expect(ceiling).toBeDefined();
        expect(ceiling!.args[1]).toBe(2);
    });
    it('does NOT apply a ceiling for an intel:manage holder', async () => {
        await listIntelReports({ viewer: { clearanceLevel: { level: 0 }, permissions: ['intel:manage'], role: 'Member' } });
        expect(lte().some(c => c.args[0] === 'classification_level')).toBe(false);
    });
    it('does NOT apply a ceiling for an Admin', async () => {
        await listIntelReports({ viewer: { clearanceLevel: { level: 0 }, permissions: [], role: 'Admin' } });
        expect(lte().some(c => c.args[0] === 'classification_level')).toBe(false);
    });
});

describe('search builders route through safeSearchTerm', () => {
    it('a malicious term cannot inject .or() structure (no leaked .eq. operator)', async () => {
        await searchPlatformLocations({ query: 'a,is_internal.eq.true' });
        const orCall = h.calls.find(c => c.method === 'or');
        expect(orCall).toBeDefined();
        const clause = String(orCall!.args[0]);
        // The injected `,is_internal.eq.true` is stripped to alphanumerics+_, so
        // the built clause carries NO injected operator (`.eq.`) and NO injected
        // 4th OR condition — exactly the 3 intended `.ilike.` sub-clauses.
        expect(clause).not.toContain('.eq.');
        expect(clause.split(',').length).toBe(3); // name/path/nickname only — no extra comma-delimited condition
    });
});

describe('upsertAlliedParticipant sanitization', () => {
    it('nulls an unsafe avatar scheme and length-caps free text', async () => {
        h.data.operation_allied_orgs = { accepted: true };
        h.data.operations = { is_joint: false, joint_version: 0 };
        h.data.alliance_peers = { channels: { operations: true } }; // ops channel must be enabled for the ingest to proceed
        await upsertAlliedParticipant('op1', 'peer1', {
            remoteUserHandle: 'ally-member',
            avatarUrl: 'javascript:alert(1)',
            displayName: 'D'.repeat(500),
            role: 'R'.repeat(500),
            shipText: 'S'.repeat(500),
            rsvpStatus: 'going',
        });
        const v = h.captured.operation_allied_participants;
        expect(v).toBeDefined();
        expect(v.avatar_url).toBeNull();                       // javascript: rejected
        expect(String(v.display_name).length).toBe(120);
        expect(String(v.role).length).toBe(120);
        expect(String(v.ship_text).length).toBe(200);
    });
    it('rejects the RSVP ingest (writes nothing) when the peer\'s operations channel is disabled', async () => {
        // Accepted invite alone is not enough — a peer whose "Joint Ops" channel was
        // toggled off must not keep writing its members' RSVP rows into the host op.
        h.data.operation_allied_orgs = { accepted: true };
        h.data.alliance_peers = { channels: { operations: false } }; // Joint Ops disabled
        await expect(upsertAlliedParticipant('op1', 'peer1', {
            remoteUserHandle: 'ally-member',
            rsvpStatus: 'going',
        })).rejects.toThrow('forbidden');
        expect(h.captured.operation_allied_participants).toBeUndefined(); // no write occurred
    });
});

describe('listWarehouseMovements limit clamp', () => {
    it('clamps an oversized client limit to 500 rows', async () => {
        await listWarehouseMovements({ limit: 100000 });
        const range = h.calls.find(c => c.method === 'range');
        expect(range).toBeDefined();
        // range(offset, offset + clampedLimit - 1) → 500 rows max
        expect((range!.args[1] as number) - (range!.args[0] as number) + 1).toBe(500);
    });
});
