import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/system.ts behaviour:
//   - Federation echo loop guard: an ingested report or warrant (source_feed_id
//     set) is not re-shared via collectShareableIntel.
//   - Warrant over-share: a non-active (Cancelled/Claimed) warrant never leaves
//     the org; only Active/Standing warrants share.
//   - Outbound egress fails CLOSED: a marker / association / item read fault
//     throws an opaque error instead of serving a 200 with an EMPTY exclusion set
//     (which federates exactly the sync_restricted rows) or an empty page (which
//     burns the peer's cursor — the receiver writes _meta.fetchedAt straight into
//     alliance_peers.intel_synced_at).
//   - OG config validation: updateOpenGraphConfig strips a javascript:/non-image
//     faviconUrl and an invalid themeColor before persist.
//
// The mock supabase builder records .is()/.in()/.gt()/.order()/.limit() and applies
// them to the seeded tables, so the test exercises the real query predicates, the
// real ASC page cap and the real cursor clamp.

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    upserts: [] as Array<{ key: string; value: Record<string, unknown> }>,
    // Per-table error injection: what a PostgREST fault looks like at the destructure.
    errors: {} as Record<string, { message: string } | undefined>,
    // Per-table request counter — proves a disabled channel is never queried.
    queried: {} as Record<string, number>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const eqFilters: Record<string, unknown> = {};
        const isFilters: Record<string, unknown> = {};
        const inFilters: Record<string, unknown[]> = {};
        const gtFilters: Record<string, unknown> = {};
        const orders: Array<{ col: string; ascending: boolean }> = [];
        let limitN: number | null = null;
        let lastUpsert: Record<string, unknown> | null = null;

        const matches = (r: Record<string, unknown>): boolean => {
            for (const [col, val] of Object.entries(eqFilters)) if (r[col] !== val) return false;
            for (const [col, val] of Object.entries(isFilters)) {
                // .is(col, null) means strictly null/undefined.
                if (val === null) { if (r[col] != null) return false; }
                else if (r[col] !== val) return false;
            }
            for (const [col, vals] of Object.entries(inFilters)) {
                if (!vals.includes(r[col])) return false;
            }
            for (const [col, val] of Object.entries(gtFilters)) {
                if (!((r[col] as string) > (val as string))) return false;
            }
            return true;
        };
        const rows = () => {
            let out = (h.tables[table] ?? []).filter(matches);
            // Applied last-key-first over a stable sort ⇒ real multi-key ordering.
            for (const o of [...orders].reverse()) {
                out = [...out].sort((x, y) => {
                    const xv = x[o.col] as string | number;
                    const yv = y[o.col] as string | number;
                    if (xv === yv) return 0;
                    return (xv < yv ? -1 : 1) * (o.ascending ? 1 : -1);
                });
            }
            return limitN === null ? out : out.slice(0, limitN);
        };
        const result = (): { data: Array<Record<string, unknown>> | null; error: { message: string } | null } => {
            h.queried[table] = (h.queried[table] ?? 0) + 1;
            const error = h.errors[table];
            return error ? { data: null, error } : { data: rows(), error: null };
        };

        const b: any = {};
        b.select = () => b;
        b.eq = (col: string, val: unknown) => { eqFilters[col] = val; return b; };
        b.is = (col: string, val: unknown) => { isFilters[col] = val; return b; };
        b.in = (col: string, vals: unknown[]) => { inFilters[col] = vals; return b; };
        b.gt = (col: string, val: unknown) => { gtFilters[col] = val; return b; };
        b.order = (col: string, o?: { ascending?: boolean }) => { orders.push({ col, ascending: o?.ascending !== false }); return b; };
        b.limit = (n: number) => { limitN = n; return b; };
        b.upsert = (value: Record<string, unknown>) => { lastUpsert = value; return b; };
        const firstRow = () => { const r = result(); return { data: r.data ? (r.data[0] ?? null) : null, error: r.error }; };
        b.maybeSingle = () => Promise.resolve(firstRow());
        b.single = () => Promise.resolve(firstRow());
        b.then = (resolve: any, reject: any) => {
            if (lastUpsert) {
                const v = lastUpsert as { key: string; value: Record<string, unknown> };
                h.upserts.push({ key: v.key, value: v.value });
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            }
            return Promise.resolve(result()).then(resolve, reject);
        };
        return b;
    }
    return {
        supabase: { from: (table: string) => builder(table) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import { collectShareableIntel, updateOpenGraphConfig } from '../lib/db/system';

// Marker ids are `integer GENERATED BY DEFAULT AS IDENTITY` (schema.sql:331), so the
// exclusion set and the association rows are keyed by NUMBER, not text.
const NOFORN = { id: 1, code: 'NOFORN', name: 'No Foreign', sync_restricted: true };
const OPEN = { id: 2, code: 'OPEN', name: 'Releasable', sync_restricted: false };

const FEED_UNAVAILABLE = 'Feed temporarily unavailable';
const T0 = Date.parse('2026-06-06T00:00:00.000Z');
const at = (i: number) => new Date(T0 + i * 1000).toISOString();

function report(id: string, extra: Record<string, unknown> = {}) {
    return {
        id, target_id: 'Bandit', subject_type: 'Person', threat_level: 'High', tags: [],
        summary: 'spotted', created_at: at(0), affiliated_org: 'X', classification_level: 0,
        source_feed_id: null, ...extra,
    };
}
function bulletin(id: string, extra: Record<string, unknown> = {}) {
    return {
        id, title: 'T', body: 'B', threat_level: 'Medium', location: null,
        expires_at: '2099-01-01T00:00:00.000Z', classification_level: 0, created_at: at(0),
        source_bulletin_id: null, source_organization_id: null, shared_with_allies: true, ...extra,
    };
}

beforeEach(() => {
    h.upserts = [];
    h.errors = {};
    h.queried = {};
    h.tables = {
        security_limiting_markers: [NOFORN, OPEN],
        intel_report_limiting_markers: [],
        intel_bulletin_limiting_markers: [],
        intel_bulletins: [],
        intel_reports: [
            // Locally-authored report — source_feed_id null → shareable.
            report('rep-local'),
            // Ingested from ally feedA — must never be re-shared.
            report('rep-ingested', { target_id: 'Pirate', summary: 'relayed', affiliated_org: 'Y', source_feed_id: 'feedA' }),
        ],
        warrants: [
            // Locally-issued Active warrant → shareable.
            { id: 'war-active', target_rsi_handle: 'Outlaw', reason: 'piracy', action: 'Detain', uec_reward: 100, status: 'Active', created_at: at(0), source_feed_id: null },
            // Standing warrant → shareable.
            { id: 'war-standing', target_rsi_handle: 'Fugitive', reason: 'KOS', action: 'Eliminate', uec_reward: 200, status: 'Standing', created_at: at(0), source_feed_id: null },
            // Cancelled → must not leave the org.
            { id: 'war-cancelled', target_rsi_handle: 'Reformed', reason: 'rescinded', action: 'Detain', uec_reward: 0, status: 'Cancelled', created_at: at(0), source_feed_id: null },
            // Claimed → no longer an actionable bounty; must not leave.
            { id: 'war-claimed', target_rsi_handle: 'Caught', reason: 'done', action: 'Detain', uec_reward: 0, status: 'Claimed', created_at: at(0), source_feed_id: null },
            // Ingested-from-ally Active warrant — loop guard must exclude.
            { id: 'war-ingested', target_rsi_handle: 'Relayed', reason: 'via ally', action: 'Detain', uec_reward: 50, status: 'Active', created_at: at(0), source_feed_id: 'feedA' },
        ],
    };
});

const opts = {
    maxClearance: 5,
    channels: { reports: true, warrants: true, bulletins: true },
    bulletinsRequireSharedFlag: false,
};

// A resolved value here is the bug: the fail-open served a 200.
async function rejection(promise: Promise<unknown>): Promise<Error> {
    const e = await promise.then(() => null, (err) => err);
    expect(e).toBeInstanceOf(Error);
    return e as Error;
}

describe('collectShareableIntel — federation echo loop guard (fed#4)', () => {
    it('excludes an ingested report (source_feed_id set) from the outbound projection', async () => {
        const res = await collectShareableIntel(opts);
        const ids = res.reports.map((r: { id: string }) => r.id);
        expect(ids).toContain('rep-local');
        expect(ids).not.toContain('rep-ingested');
    });

    it('excludes an ingested warrant (source_feed_id set) from the outbound projection', async () => {
        const res = await collectShareableIntel(opts);
        const ids = res.warrants.map((w: { id: string }) => w.id);
        expect(ids).not.toContain('war-ingested');
    });
});

describe('collectShareableIntel — warrant over-share (fed#5)', () => {
    it('shares only Active/Standing warrants; Cancelled and Claimed never leave the org', async () => {
        const res = await collectShareableIntel(opts);
        const ids = res.warrants.map((w: { id: string }) => w.id).sort();
        expect(ids).toEqual(['war-active', 'war-standing']);
        expect(ids).not.toContain('war-cancelled');
        expect(ids).not.toContain('war-claimed');
    });

    it('honours a sub-zero clearance ceiling by withholding all warrants', async () => {
        const res = await collectShareableIntel({ ...opts, maxClearance: -1 });
        expect(res.warrants).toHaveLength(0);
    });
});

describe('collectShareableIntel — limiting-marker exclusion', () => {
    beforeEach(() => {
        h.tables.intel_reports = [report('rep-noforn'), report('rep-open')];
        h.tables.intel_report_limiting_markers = [
            { report_id: 'rep-noforn', marker_id: NOFORN.id },
            { report_id: 'rep-open', marker_id: OPEN.id },
        ];
        h.tables.intel_bulletins = [bulletin('bul-noforn'), bulletin('bul-open')];
        h.tables.intel_bulletin_limiting_markers = [
            { bulletin_id: 'bul-noforn', marker_id: NOFORN.id },
            { bulletin_id: 'bul-open', marker_id: OPEN.id },
        ];
    });

    it('withholds a sync_restricted-marked report and tags a releasable one with its code', async () => {
        const res = await collectShareableIntel(opts);
        const ids = res.reports.map((r: { id: string }) => r.id);
        expect(ids).toEqual(['rep-open']);
        expect(res.reports[0].limiting_markers).toEqual(['OPEN']);
    });

    it('withholds a sync_restricted-marked bulletin and tags a releasable one with its code', async () => {
        const res = await collectShareableIntel(opts);
        const ids = res.bulletins.map((b: { id: string }) => b.id);
        expect(ids).toEqual(['bul-open']);
        expect(res.bulletins[0].limiting_markers).toEqual(['OPEN']);
    });

    it('withholds an item whose association points at a marker we could not resolve', async () => {
        // A marker created between the marker read and the association read is an
        // UNKNOWN restriction — deny by default rather than share the row unmarked.
        h.tables.intel_report_limiting_markers = [{ report_id: 'rep-open', marker_id: 99 }];
        const res = await collectShareableIntel(opts);
        const ids = res.reports.map((r: { id: string }) => r.id);
        expect(ids).not.toContain('rep-open');
    });
});

describe('collectShareableIntel — federation egress fails closed', () => {
    it('a marker-table read fault throws instead of federating with an empty exclusion set', async () => {
        h.tables.intel_report_limiting_markers = [{ report_id: 'rep-local', marker_id: NOFORN.id }];
        h.errors.security_limiting_markers = { message: 'boom: relation "security_limiting_markers"' };
        const err = await rejection(collectShareableIntel(opts));
        expect(err.message).toBe(FEED_UNAVAILABLE);
        // The PostgREST text must not reach a peer org (or an ally's admin UI).
        expect(err.message).not.toContain('boom');
    });

    it('refuses to federate against a marker set that hit the read cap', async () => {
        h.tables.security_limiting_markers = Array.from({ length: 500 }, (_, i) => ({
            id: i + 1, code: `M${i}`, name: `M${i}`, sync_restricted: i === 499,
        }));
        const err = await rejection(collectShareableIntel(opts));
        expect(err.message).toBe(FEED_UNAVAILABLE);
    });

    it('a report-association read fault throws instead of resolving with the restricted report', async () => {
        h.tables.intel_report_limiting_markers = [{ report_id: 'rep-local', marker_id: NOFORN.id }];
        h.errors.intel_report_limiting_markers = { message: 'x' };
        const err = await rejection(collectShareableIntel(opts));
        expect(err.message).toBe(FEED_UNAVAILABLE);
    });

    it('a bulletin-association read fault throws instead of resolving with the restricted bulletin', async () => {
        h.tables.intel_bulletins = [bulletin('bul-noforn')];
        h.tables.intel_bulletin_limiting_markers = [{ bulletin_id: 'bul-noforn', marker_id: NOFORN.id }];
        h.errors.intel_bulletin_limiting_markers = { message: 'x' };
        const err = await rejection(collectShareableIntel(opts));
        expect(err.message).toBe(FEED_UNAVAILABLE);
    });

    it.each(['intel_reports', 'warrants', 'intel_bulletins'])(
        'a %s read fault throws — a 200 with an empty page would burn the peer cursor',
        async (table) => {
            h.errors[table] = { message: 'x' };
            const err = await rejection(collectShareableIntel(opts));
            expect(err.message).toBe(FEED_UNAVAILABLE);
        },
    );
});

describe('collectShareableIntel — page cap and cursor clamp', () => {
    const seedReports = (n: number, ts: (i: number) => string) => {
        h.tables.intel_reports = Array.from({ length: n }, (_, i) =>
            report(`rep-${String(i).padStart(4, '0')}`, { created_at: ts(i) }));
    };

    it('caps the page at 500 and clamps _meta.fetchedAt back behind the last row served', async () => {
        seedReports(501, at);
        const res = await collectShareableIntel(opts);
        expect(res.reports).toHaveLength(500);
        // The clamp lands on the last created_at STRICTLY BELOW the final served row's,
        // so the peer's next .gt(created_at, cursor) cannot skip rows sharing that tail.
        expect(res._meta.fetchedAt).toBe(at(498));
    });

    it('clamps behind a shared tail timestamp rather than skipping the rows behind it', async () => {
        seedReports(500, (i) => (i < 497 ? at(i) : at(497)));
        const res = await collectShareableIntel(opts);
        expect(res._meta.fetchedAt).toBe(at(496));
        expect(res._meta.fetchedAt < at(497)).toBe(true);
    });

    it('refuses a full page that shares one timestamp — the cursor could not advance', async () => {
        seedReports(500, () => at(0));
        const err = await rejection(collectShareableIntel(opts));
        expect(err.message).toBe(FEED_UNAVAILABLE);
    });

    it('leaves _meta.fetchedAt at wall-clock when no channel saturated', async () => {
        seedReports(3, at);
        const res = await collectShareableIntel(opts);
        expect(res._meta.fetchedAt > at(2)).toBe(true);
    });

    it('never queries a disabled channel, so its saturation cannot clamp the shared cursor', async () => {
        seedReports(501, at);
        const res = await collectShareableIntel({ ...opts, channels: { reports: false, warrants: true, bulletins: false } });
        expect(h.queried.intel_reports ?? 0).toBe(0);
        expect(h.queried.intel_bulletins ?? 0).toBe(0);
        expect(res.reports).toEqual([]);
        expect(res._meta.fetchedAt > at(500)).toBe(true);
    });
});

describe('updateOpenGraphConfig — write-time validation (input-injection#3)', () => {
    const persisted = () => h.upserts.find(u => u.key === 'openGraphConfig')?.value ?? {};

    it('strips a javascript: faviconUrl and a non-image imageUrl to empty string', async () => {
        await updateOpenGraphConfig({
            title: 'T',
            faviconUrl: 'javascript:alert(1)',
            imageUrl: 'https://tracker.example/pixel',   // no image extension
        });
        const v = persisted();
        expect(v.faviconUrl).toBe('');
        expect(v.imageUrl).toBe('');
        // Non-URL fields survive untouched.
        expect(v.title).toBe('T');
    });

    it('keeps a valid https image url and a valid hex themeColor', async () => {
        await updateOpenGraphConfig({
            imageUrl: 'https://cdn.example/og.png',
            faviconUrl: 'https://cdn.example/icon.png',
            themeColor: '#0F172A',
        });
        const v = persisted();
        expect(v.imageUrl).toBe('https://cdn.example/og.png');
        expect(v.faviconUrl).toBe('https://cdn.example/icon.png');
        expect(v.themeColor).toBe('#0F172A');
    });

    it('drops an invalid themeColor so it never reaches the SSR meta tag', async () => {
        await updateOpenGraphConfig({ themeColor: 'red; } body{display:none}' });
        const v = persisted();
        expect('themeColor' in v).toBe(false);
    });
});
