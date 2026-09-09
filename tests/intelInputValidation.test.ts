import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { escapeLikePattern } from '../lib/pgrest';

// Input-validation cluster:
//   F7  intel target lookups escape the LIKE pattern (no '%' wildcard dump) + cap rows
//   G5  federation-ingested bulletin threat_level is normalised to the known set
//   F14 createServiceRequest maps the one-active-request unique violation (23505)

const cap = vi.hoisted(() => ({
    ilikeArgs: [] as Array<[string, unknown]>,
    insertError: null as null | { code?: string },
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select' };
        const b: any = {};
        b.select = () => b;
        b.insert = () => { state.op = 'insert'; return b; };
        b.update = () => { state.op = 'update'; return b; };
        b.ilike = (col: string, val: unknown) => { cap.ilikeArgs.push([col, val]); return b; };
        b.eq = () => b; b.is = () => b; b.in = () => b; b.not = () => b; b.order = () => b; b.limit = () => b;
        const settle = (mode: 'single' | 'many') => {
            if (state.op === 'insert' && table === 'service_requests') return Promise.resolve({ data: null, error: cap.insertError });
            // createServiceRequest now reads the actor's standing before inserting (the server
            // half of the reputation floor that used to live only in React), so the double has
            // to answer it — otherwise every create test fails on 'could not verify standing'.
            if (state.op === 'select' && table === 'users') return Promise.resolve({ data: mode === 'single' ? { reputation: 50 } : [], error: null, count: 0 });
            return Promise.resolve({ data: mode === 'single' ? null : [], error: null, count: 0 });
        };
        b.single = () => settle('single'); b.maybeSingle = () => settle('single');
        b.then = (r: any, j: any) => settle('many').then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});
vi.mock('../lib/push', () => ({ sendPushToStaff: () => {}, sendPushToUsers: async () => {} }));

import { getIntelReportsForTarget, updateIntelAffiliation, normalizeThreatLevel } from '../lib/db/intel';
import { createServiceRequest } from '../lib/db/requests';

beforeEach(() => { cap.ilikeArgs = []; cap.insertError = null; });

describe('F7 — intel target lookups escape the LIKE pattern', () => {
    it('passes the escaped (literal) pattern to .ilike, not a raw wildcard', async () => {
        await getIntelReportsForTarget('%');
        const targetCall = cap.ilikeArgs.find(([col]) => col === 'target_id');
        expect(targetCall?.[1]).toBe(escapeLikePattern('%'));
        // escaping a bare % must change it (otherwise it stays a wildcard)
        expect(targetCall?.[1]).not.toBe('%');
    });

    // The one target lookup in this file that keys a WRITE. PostgREST rewrites a
    // bare `*` to `%` in a like/ilike operand, so before the escaper covered `*`
    // this .update().ilike() overwrote affiliated_org on EVERY intel_reports row
    // for any intel:manage holder. Asserted against the literal, not against
    // escapeLikePattern's own output — comparing a helper to itself passes
    // whatever the helper does.
    it('updateIntelAffiliation cannot mass-overwrite via the * wildcard alias', async () => {
        await updateIntelAffiliation('*', 'Some Org');
        const targetCall = cap.ilikeArgs.find(([col]) => col === 'target_id');
        expect(targetCall?.[1]).toBe('\\*');
        expect(targetCall?.[1]).not.toBe('*');
    });
});

describe('G5 — federation bulletin threat_level normalisation', () => {
    it('keeps a valid level', () => {
        for (const v of ['None', 'Low', 'Medium', 'High', 'Critical']) expect(normalizeThreatLevel(v)).toBe(v);
    });
    it('falls back to Medium for unknown / non-string input', () => {
        expect(normalizeThreatLevel('PWNED')).toBe('Medium');
        expect(normalizeThreatLevel('')).toBe('Medium');
        expect(normalizeThreatLevel(99)).toBe('Medium');
        expect(normalizeThreatLevel(null)).toBe('Medium');
    });

    it('is applied to BOTH the bulletin and the report federation-ingest inserts', () => {
        const src = readFileSync(resolve(__dirname, '..', 'lib/db/intel.ts'), 'utf8');
        // both inbound inserts normalise the peer-supplied threat_level
        const occurrences = (src.match(/threat_level: normalizeThreatLevel\(/g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(2);
    });
});

describe('F14 — one-active-request unique violation maps to a friendly error', () => {
    it('translates a 23505 insert conflict into the active-request message', async () => {
        cap.insertError = { code: '23505' };
        await expect(createServiceRequest({ serviceType: 'Rescue', location: 'L', description: 'D' } as any, 7))
            .rejects.toThrow(/already have an active service request/i);
    });
});
