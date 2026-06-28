import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Coverage for lib/db/alliances.ts federation ingest paths.
//
// Inbound peer profile fields must be capped: refreshPeerProfile() persists a
//   paired peer's advertised orgName/orgTag/blurb into the unconstrained `text`
//   columns on alliance_peers, then re-serves them to every member with
//   alliance:view (getAllianceDirectory) and renders them in the admin browser.
//   A paired-but-hostile peer could park multi-MB strings, so the inbound text is
//   capped to mirror the self-profile caps (saveAllianceSelfProfile: 120/32/500)
//   via the pure, exported sanitizePeerProfileText helper.
//
// Peer lookup must use an exact comparator: previously .ilike('base_url', origin)
//   where origin is derived from caller-influenced input. ilike treats `_`/`%` as
//   LIKE wildcards, so an origin like https://my_org.example.com could mis-match
//   https://myXorg... The normalized origin demands .eq(), not .ilike().
// =============================================================================

// Record every supabase query-builder method call so we can assert the
// comparator used for the base_url lookup. Hoisted so the vi.mock factory
// (which is itself hoisted above the imports) can safely reference it.
const hoisted = vi.hoisted(() => ({
    calls: [] as { table: string; method: string; args: unknown[] }[],
}));

vi.mock('../lib/db/common.js', () => {
    const makeBuilder = (table: string) => {
        const builder: Record<string, unknown> = {};
        const rec = (method: string) => (...args: unknown[]) => {
            hoisted.calls.push({ table, method, args });
            return builder;
        };
        for (const m of ['select', 'eq', 'ilike', 'neq', 'not', 'order', 'insert', 'update', 'delete', 'limit', 'is', 'upsert']) {
            builder[m] = rec(m);
        }
        builder.maybeSingle = (...args: unknown[]) => {
            hoisted.calls.push({ table, method: 'maybeSingle', args });
            // getLocalCode() reads the singleton local pairing code from settings;
            // return a fresh, non-expired value so respondToPair reaches the
            // base_url lookup before any later validation throws.
            if (table === 'settings') {
                return Promise.resolve({ data: { value: { codeEnc: 'enc:localcode', expiresAt: new Date(Date.now() + 600_000).toISOString() } } });
            }
            // No existing/matching alliance_peers row: createOrUpdatePeer takes the
            // insert branch; respondToPair throws no_pending_pairing — both AFTER
            // the base_url comparator has been recorded.
            return Promise.resolve({ data: null });
        };
        builder.single = (...args: unknown[]) => {
            hoisted.calls.push({ table, method: 'single', args });
            return Promise.resolve({ data: { id: 'new-peer-id' }, error: null });
        };
        return builder;
    };
    return {
        supabase: { from: (table: string) => makeBuilder(table) },
        handleSupabaseError: vi.fn(),
        broadcastToOrg: vi.fn(),
        safeFetch: vi.fn(async () => []),
        getSystemRoles: vi.fn(async () => ({})),
    };
});

// Avoid needing SECRETS_ENCRYPTION_KEY — encrypt/decrypt are exercised elsewhere.
vi.mock('../lib/crypto.js', () => ({
    encryptSecret: (s: string) => `enc:${s}`,
    decryptSecret: (s: string) => (typeof s === 'string' && s.startsWith('enc:') ? s.slice(4) : s),
}));

import { sanitizePeerProfileText, createOrUpdatePeer, respondToPair } from '../lib/db/alliances';

beforeEach(() => {
    hoisted.calls.length = 0;
});

// ---------------------------------------------------------------------------
// sanitizePeerProfileText caps + strips inbound directory-card text.
// ---------------------------------------------------------------------------
describe('sanitizePeerProfileText — inbound peer card bound', () => {
    it('caps orgName at 120, orgTag at 32, blurb at 500', () => {
        const out = sanitizePeerProfileText({
            orgName: 'a'.repeat(5_000),
            orgTag: 'b'.repeat(5_000),
            blurb: 'c'.repeat(5_000),
        });
        expect(out.orgName!.length).toBe(120);
        expect(out.orgTag!.length).toBe(32);
        expect(out.blurb!.length).toBe(500);
    });

    it('rejects a multi-MB advertised card (storage-bloat guard)', () => {
        const huge = 'x'.repeat(2_000_000); // ~2 MB
        const out = sanitizePeerProfileText({ orgName: huge, orgTag: huge, blurb: huge });
        expect(out.orgName!.length).toBeLessThanOrEqual(120);
        expect(out.orgTag!.length).toBeLessThanOrEqual(32);
        expect(out.blurb!.length).toBeLessThanOrEqual(500);
    });

    it('strips HTML markup from the inbound fields', () => {
        const out = sanitizePeerProfileText({
            orgName: '<b>Org</b>',
            orgTag: '<i>TAG</i>',
            blurb: '<script>alert(1)</script>Hello',
        });
        expect(out.orgName).toBe('Org');
        expect(out.orgTag).toBe('TAG');
        expect(out.blurb).toBe('alert(1)Hello');
        expect(out.blurb).not.toContain('<');
    });

    it('passes null/undefined/empty through as null (fail-closed)', () => {
        expect(sanitizePeerProfileText(null)).toEqual({ orgName: null, orgTag: null, blurb: null });
        expect(sanitizePeerProfileText(undefined)).toEqual({ orgName: null, orgTag: null, blurb: null });
        expect(sanitizePeerProfileText({})).toEqual({ orgName: null, orgTag: null, blurb: null });
        expect(sanitizePeerProfileText({ orgName: '', orgTag: '   ', blurb: '<br>' }))
            .toEqual({ orgName: null, orgTag: null, blurb: null });
    });

    it('preserves a legitimate (small) directory card unchanged', () => {
        const out = sanitizePeerProfileText({ orgName: 'Friendly Org', orgTag: 'FRND', blurb: 'We fly together.' });
        expect(out).toEqual({ orgName: 'Friendly Org', orgTag: 'FRND', blurb: 'We fly together.' });
    });
});

// ---------------------------------------------------------------------------
// base_url lookup must use the exact comparator .eq(), never .ilike().
// ---------------------------------------------------------------------------
function baseUrlComparators() {
    return hoisted.calls.filter((c) => c.table === 'alliance_peers' && (c.method === 'eq' || c.method === 'ilike') && c.args[0] === 'base_url');
}

describe('peer base_url lookup uses exact .eq(), not wildcard .ilike()', () => {
    it('createOrUpdatePeer matches base_url with .eq and the normalized origin', async () => {
        await createOrUpdatePeer({ label: 'Peer', baseUrl: 'https://my_org.example.com', peerCode: 'CODE123' });
        const cmp = baseUrlComparators();
        expect(cmp.length).toBeGreaterThanOrEqual(1);
        for (const c of cmp) {
            expect(c.method).toBe('eq');                       // exact comparator, not 'ilike'
            expect(c.args[1]).toBe('https://my_org.example.com'); // exact normalized origin
        }
        // No ilike on base_url anywhere — the underscore must not be a wildcard.
        expect(hoisted.calls.some((c) => c.method === 'ilike' && c.args[0] === 'base_url')).toBe(false);
    });

    it('respondToPair matches base_url with .eq and the normalized origin', async () => {
        await respondToPair({
            fromBaseUrl: 'https://my_org.example.com',
            ephemeralPub: 'pub', nonce: 'nonce', codeProof: 'proof',
        }).catch(() => { /* throws later (no matching row); we only assert the comparator */ });
        const cmp = baseUrlComparators();
        expect(cmp.length).toBeGreaterThanOrEqual(1);
        for (const c of cmp) {
            expect(c.method).toBe('eq');                       // exact comparator, not 'ilike'
            expect(c.args[1]).toBe('https://my_org.example.com');
        }
        expect(hoisted.calls.some((c) => c.method === 'ilike' && c.args[0] === 'base_url')).toBe(false);
    });
});
