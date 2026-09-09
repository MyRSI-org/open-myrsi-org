import { describe, it, expect, vi, beforeEach } from 'vitest';

// Server half of the slice contracts:
//   1. Every single-row fetcher THROWS on query errors (never a silent
//      null) — the client merge treats null as "row gone" and EVICTS it, so
//      a transient DB blip must surface as a 500 → full-refetch fallback.
//   2. getBulletinByIdForViewer re-applies the SAME clearance/marker filter
//      as the bulk activeBulletins path — null for filtered viewers.
//   3. Broadcast payload contracts: warrant emits carry warrantId(s); the
//      dossier-summary save emits {kind:'dossier'} (clients skip refetch);
//      bulletin deletion emits its bulletinId and NO id-less intel_update
//      companion; finances reverse carries BOTH affected ledger ids + the
//      account id.

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: number },
    resolveRpc: ((_fn: string, _args: unknown) => ({ data: null as unknown, error: null as unknown })) as (fn: string, args: unknown) => { data?: unknown; error?: unknown },
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: unknown) => Promise.resolve(h.resolveRpc(fn, args)),
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
            if (error) throw new Error(message);
        },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); },
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({
            client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' },
            dispatcher: { id: 3, name: 'Dispatcher' }, admin: { id: 4, name: 'Admin' },
        }),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

import {
    getWarrantByIdHydrated, getBulletinByIdForViewer,
    updateWarrant, bulkDeleteWarrants, saveDossierSummary, deleteIntelBulletin,
} from '../lib/db/intel';
import { getWikiPageById } from '../lib/db/wiki';
import { reverseLedgerEntry, getTreasuryAccount, getLedgerEntry } from '../lib/db/finances';
import { redactApplicantsForViewer, isHrRecruiter } from '../lib/db/hr';
import type { User } from '../types';

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    h.resolveRpc = () => ({ data: null, error: null });
    h.broadcasts = [];
});

describe('single-row fetchers throw on query error (eviction safety)', () => {
    it('getWarrantByIdHydrated', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'blip' } });
        await expect(getWarrantByIdHydrated('w1')).rejects.toThrow(/warrant slice/i);
    });
    it('getBulletinByIdForViewer', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'blip' } });
        await expect(getBulletinByIdForViewer('b1', null)).rejects.toThrow(/bulletin slice/i);
    });
    it('getWikiPageById', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'blip' } });
        await expect(getWikiPageById('p1')).rejects.toThrow(/wiki page slice/i);
    });
    it('getTreasuryAccount', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'blip' } });
        await expect(getTreasuryAccount(1)).rejects.toThrow(/account slice/i);
    });
    it('getLedgerEntry', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'blip' } });
        await expect(getLedgerEntry('e1')).rejects.toThrow(/ledger entry/i);
    });
    it('getLedgerEntry — 42P01 too (a missing table is not a deleted entry)', async () => {
        // The one code this fetcher used to map to null. FinancesView feeds the
        // result to mergeRowSlice, where null EVICTS the row, so the exemption
        // bought a wrong eviction and nothing else.
        h.resolveQuery = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
        await expect(getLedgerEntry('e1')).rejects.toThrow(/ledger entry/i);
    });
    it('all return null on genuine absence', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        expect(await getWarrantByIdHydrated('w1')).toBeNull();
        expect(await getBulletinByIdForViewer('b1', null)).toBeNull();
        expect(await getWikiPageById('p1')).toBeNull();
        expect(await getTreasuryAccount(1)).toBeNull();
        expect(await getLedgerEntry('e1')).toBeNull();
    });
});

describe('getBulletinByIdForViewer clearance parity (H3)', () => {
    const bulletinRow = (over: Record<string, unknown> = {}) => ({
        id: 'b1', title: 'Contact', body: 'classified body', threat_level: 'High',
        duration_minutes: 60, expires_at: '2099-01-01', classification_level: 3,
        created_by_id: 9, created_at: '2026-01-01',
        intel_bulletin_limiting_markers: [],
        ...over,
    });
    const viewer = (over: Partial<User> = {}): User => ({
        id: 6, role: 'Member', permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [],
        ...over,
    } as unknown as User);

    it('null for a below-clearance viewer (body never leaves the server)', async () => {
        h.resolveQuery = () => ({ data: bulletinRow(), error: null });
        expect(await getBulletinByIdForViewer('b1', viewer())).toBeNull();
    });
    it('returned for an at-clearance viewer', async () => {
        h.resolveQuery = () => ({ data: bulletinRow(), error: null });
        const b = await getBulletinByIdForViewer('b1', viewer({ clearanceLevel: { level: 3 } } as Partial<User>));
        expect(b?.id).toBe('b1');
    });
    it('null for a viewer missing a limiting marker even at clearance', async () => {
        h.resolveQuery = () => ({ data: bulletinRow({ intel_bulletin_limiting_markers: [{ marker: { id: 9, name: 'NDL', code: 'NDL' } }] }), error: null });
        expect(await getBulletinByIdForViewer('b1', viewer({ clearanceLevel: { level: 5 } } as Partial<User>))).toBeNull();
    });
    it('intel:manage bypasses (same as the bulk filter)', async () => {
        h.resolveQuery = () => ({ data: bulletinRow(), error: null });
        const b = await getBulletinByIdForViewer('b1', viewer({ permissions: ['intel:manage'] }));
        expect(b?.id).toBe('b1');
    });
});

describe('broadcast payload contracts', () => {
    it('updateWarrant emits { warrantId }', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await updateWarrant('w42', { updates: { reason: 'updated' } });
        expect(h.broadcasts).toContainEqual({ event: 'warrant_update', payload: { warrantId: 'w42' } });
    });

    it('bulkDeleteWarrants emits { warrantIds }', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await bulkDeleteWarrants(['w1', 'w2']);
        expect(h.broadcasts).toContainEqual({ event: 'warrant_update', payload: { warrantIds: ['w1', 'w2'] } });
    });

    it('saveDossierSummary emits {kind:dossier} with NO targetId (M4 — db-changes is org-wide)', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        await saveDossierSummary('TargetHandle', 'summary text');
        const emit = h.broadcasts.find(b => b.event === 'intel_update');
        expect(emit?.payload.kind).toBe('dossier');
        // targetId is the dossier SUBJECT — restricted; it must NOT ride the
        // anon-authorized org channel. Clients skip the refetch on kind.
        expect(emit?.payload.targetId).toBeUndefined();
    });

    it('deleteIntelBulletin emits bulletin_deleted WITH the id and NO intel_update companion', async () => {
        h.resolveQuery = (q) => {
            // existence probe returns a row; the delete returns no error
            const probing = q.calls.some(c => c.method === 'maybeSingle');
            return { data: probing ? { id: 'b9' } : null, error: null };
        };
        await deleteIntelBulletin('b9');
        const bulletinEmit = h.broadcasts.find(b => b.event === 'bulletin_update');
        expect(bulletinEmit?.payload).toEqual({ type: 'bulletin_deleted', bulletinId: 'b9' });
        expect(h.broadcasts.find(b => b.event === 'intel_update')).toBeUndefined();
    });

    it('reverseLedgerEntry emits BOTH ledger ids + the account id companion', async () => {
        h.resolveQuery = () => ({ data: { id: 'e1', status: 'confirmed', account_id: 7 }, error: null });
        h.resolveRpc = () => ({ data: 'e2-reversal', error: null });
        await reverseLedgerEntry(9, 'e1', 'fat finger');
        expect(h.broadcasts).toContainEqual({ event: 'finances:ledger_update', payload: { entryIds: ['e1', 'e2-reversal'] } });
        expect(h.broadcasts).toContainEqual({ event: 'finances:account_update', payload: { accountId: 7 } });
    });
});

describe('HR redaction helpers (pure)', () => {
    const applicant = {
        id: 'a1', status: 'pending',
        applicantName: 'Real Name', rsiHandle: 'handle', applicantDiscordId: '123',
        referralSource: 'REFERRAL', notes: 'recruiter-only', vettingData: { x: 1 },
        interviews: [{ id: 'i1', overallNotes: 'notes', finalScore: 4, isRecommended: true, responses: [{ q: 'r' }] }],
    } as never;

    it('non-recruiter: identity blanked, internals stripped, nested interviews redacted', () => {
        const [a] = redactApplicantsForViewer([applicant], false) as unknown as Array<Record<string, unknown>>;
        expect(a.applicantName).toBe('');
        expect(a.rsiHandle).toBe('');
        expect(a.applicantDiscordId).toBe('');
        expect(a.referralSource).toBeUndefined();
        expect(a.notes).toBeUndefined();
        expect(a.vettingData).toBeUndefined();
        const i = (a.interviews as Array<Record<string, unknown>>)[0];
        expect(i.overallNotes).toBeUndefined();
        expect(i.finalScore).toBeUndefined();
        expect(i.responses).toEqual([]);
    });

    it('recruiter passthrough; hr:recruiter (not the role NAME) is what counts', () => {
        const [a] = redactApplicantsForViewer([applicant], true) as unknown as Array<Record<string, unknown>>;
        expect(a.applicantName).toBe('Real Name');
        expect(isHrRecruiter({ permissions: ['hr:recruiter'] })).toBe(true);
        expect(isHrRecruiter({ permissions: ['hr:view'] })).toBe(false);
        // A forged Admin tier (name-derived, zero permissions) is NOT a recruiter.
        expect(isHrRecruiter({ role: 'Admin', permissions: [] } as unknown as Parameters<typeof isHrRecruiter>[0])).toBe(false);
    });
});
