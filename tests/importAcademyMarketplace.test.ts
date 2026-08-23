import { describe, it, expect, beforeEach, vi } from 'vitest';

// The two modules the hosted exporter newly sends: Academy (ten tables) and the
// Marketplace LISTINGS (only). Both were previously hitting the importer's
// unknown-table guard, so an org migrated with them and found them empty.
//
// Academy needs no transformation at all — column parity with the hosted schema is
// exact once organization_id is stripped — so what is worth pinning is the SEQUENCE
// reset (see tests/importTableSetInvariants) and the fact that nothing is skipped.
//
// Marketplace needs one thing: the category taxonomies are seeded independently per
// install, so the exporter nulls category_id and embeds the stable slug instead. An
// unmatched slug MUST leave the listing uncategorised, never drop it.

const h = vi.hoisted(() => ({
    inserts: [] as { table: string; rows: Record<string, unknown>[] }[],
    resets: [] as string[],
    rows: {} as Record<string, Record<string, unknown>[]>,
    counts: {} as Record<string, number>,
}));

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        const b: Record<string, unknown> = {
            select: () => b,
            insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
                h.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
                return Promise.resolve({ error: null });
            },
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
            delete: () => ({ neq: () => Promise.resolve({ error: null }), eq: () => Promise.resolve({ error: null }), in: () => Promise.resolve({ error: null }) }),
            eq: () => Promise.resolve({ data: [], error: null }),
            in: () => b,
            range: () => Promise.resolve({ data: h.rows[table] || [], error: null }),
            then: (r: (v: unknown) => unknown) => Promise.resolve({ count: h.counts[table] ?? 0, error: null, data: h.rows[table] || [] }).then(r),
        };
        return b;
    };
    return {
        supabase: {
            from: (t: string) => make(t),
            rpc: (_fn: string, args: Record<string, unknown>) => { h.resets.push(String(args.p_table)); return Promise.resolve({ error: null }); },
        },
        handleSupabaseError: () => {},
    };
});

import { importOrgData } from '../lib/db/importer';

beforeEach(() => { h.inserts = []; h.resets = []; h.rows = {}; h.counts = {}; });

const insertedInto = (table: string) => h.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);
const row = (t: string, r: Record<string, unknown>) => JSON.stringify({ kind: 'row', t, r });

// The exporter's manifest order IS the insert order.
const ACADEMY_ORDER = [
    'academy_courses', 'academy_course_instructors', 'academy_modules', 'academy_lessons',
    'academy_outcomes', 'academy_sessions', 'academy_session_instructors',
    'academy_enrollments', 'academy_lesson_progress', 'academy_outcome_results',
];

function academyExport(): string {
    const manifest = Object.fromEntries(ACADEMY_ORDER.map((t) => [t, 1]));
    return [
        `{"kind":"header","version":1,"tableOrder":${JSON.stringify(ACADEMY_ORDER)},"manifest":${JSON.stringify(manifest)}}`,
        row('academy_courses', { id: 'c-1', title: 'Flight School', status: 'published', access: 'gated', delivery: 'cohort', certification_id: 4, created_by: 5, sort_order: 0 }),
        row('academy_course_instructors', { id: 1, course_id: 'c-1', user_id: 5, assigned_by: 5 }),
        row('academy_modules', { id: 1, course_id: 'c-1', title: 'Basics', sort_order: 0 }),
        row('academy_lessons', { id: 1, module_id: 1, title: 'Preflight', content: '{}', sort_order: 0 }),
        row('academy_outcomes', { id: 1, course_id: 'c-1', title: 'Can land', required: true, sort_order: 0 }),
        row('academy_sessions', { id: 's-1', course_id: 'c-1', title: 'Intake 1', status: 'completed', is_implicit: false, created_by: 5 }),
        row('academy_session_instructors', { id: 1, session_id: 's-1', user_id: 5 }),
        row('academy_enrollments', { id: 'e-1', session_id: 's-1', student_id: 6, source: 'assigned', status: 'completed', certified_by: 5 }),
        row('academy_lesson_progress', { id: 1, enrollment_id: 'e-1', lesson_id: 1, completed_by: 6 }),
        row('academy_outcome_results', { id: 1, enrollment_id: 'e-1', outcome_id: 1, verdict: 'competent', assessed_by: 5 }),
    ].join('\n');
}

describe('academy import', () => {
    it('imports all ten tables verbatim, skipping nothing', async () => {
        const result = await importOrgData(academyExport());
        expect(result.rowsInserted).toBe(10);
        expect(result.rowsSkipped).toBe(0);
        expect(result.tablesProcessed).toBe(10);
        for (const t of ACADEMY_ORDER) expect(insertedInto(t), `${t} imported`).toHaveLength(1);
    });

    it('preserves the explicit ids the export carries (the FKs between the ten depend on it)', async () => {
        await importOrgData(academyExport());
        expect(insertedInto('academy_courses')[0].id).toBe('c-1');
        expect(insertedInto('academy_lessons')[0].module_id).toBe(1);
        expect(insertedInto('academy_lesson_progress')[0].enrollment_id).toBe('e-1');
        expect(insertedInto('academy_outcome_results')[0].outcome_id).toBe(1);
        // Outward FKs (users, certifications) ride through untouched.
        expect(insertedInto('academy_courses')[0].certification_id).toBe(4);
        expect(insertedInto('academy_courses')[0].created_by).toBe(5);
    });

    it('re-anchors the sequence of exactly the seven identity-PK tables', async () => {
        const result = await importOrgData(academyExport());
        const academyResets = result.sequencesReset.filter((t) => t.startsWith('academy_')).sort();
        expect(academyResets).toEqual([
            'academy_course_instructors', 'academy_lesson_progress', 'academy_lessons',
            'academy_modules', 'academy_outcome_results', 'academy_outcomes', 'academy_session_instructors',
        ]);
        // The uuid-PK three own no sequence and must not be reset.
        for (const t of ['academy_courses', 'academy_sessions', 'academy_enrollments']) {
            expect(h.resets, `${t} has a uuid PK`).not.toContain(t);
        }
    });
});

const LISTING_HEADER = '{"kind":"header","version":1,"tableOrder":["marketplace_listings"],"manifest":{"marketplace_listings":1}}';

describe('marketplace listing import', () => {
    it('re-maps the embedded category slug to THIS instance\'s category id and strips the embed', async () => {
        h.rows.marketplace_categories = [{ id: 3, slug: 'services' }, { id: 4, slug: 'consumables' }];
        const ndjson = [
            LISTING_HEADER,
            row('marketplace_listings', {
                id: 'l-1', seller_id: 5, kind: 'service', listing_type: 'offer', category_id: null,
                title: 'Escort', quantity: null, quantity_claimed: 0, price_type: 'hourly',
                status: 'active', tags: ['escort'], marketplace_categories: { slug: 'services' },
            }),
        ].join('\n');

        const result = await importOrgData(ndjson);
        const listing = insertedInto('marketplace_listings')[0];
        expect(result.rowsInserted).toBe(1);
        expect(listing.category_id).toBe(3);
        // Without the STRIP_ALWAYS entry this embed would be inserted as a column.
        expect(listing.marketplace_categories).toBeUndefined();
        expect(listing.tags).toEqual(['escort']);
    });

    it('leaves an unmatched slug UNCATEGORISED rather than dropping the listing', async () => {
        // The two taxonomies are largely disjoint — most hosted slugs have no local
        // counterpart — so this is the common case, not the edge case.
        h.rows.marketplace_categories = [{ id: 3, slug: 'services' }];
        const ndjson = [
            LISTING_HEADER,
            row('marketplace_listings', {
                id: 'l-1', seller_id: 5, kind: 'item', listing_type: 'sell', category_id: null,
                title: 'Titanium', quantity: 100, quantity_claimed: 0, price_type: 'per_unit',
                status: 'active', marketplace_categories: { slug: 'com-metals' },
            }),
        ].join('\n');

        const result = await importOrgData(ndjson);
        const listing = insertedInto('marketplace_listings')[0];
        expect(result.rowsInserted).toBe(1);
        expect(result.rowsSkipped).toBe(0);
        expect(result.skipBreakdown.catalogMiss).toBe(0);
        expect(listing.category_id).toBeNull();
        expect(result.warnings.some((w) => w.includes('marketplace_listings') && w.includes('com-metals'))).toBe(true);
    });

    it('says so up front when this instance has no category taxonomy seeded at all', async () => {
        h.rows.marketplace_categories = [];
        const ndjson = [
            LISTING_HEADER,
            row('marketplace_listings', { id: 'l-1', seller_id: 5, kind: 'item', listing_type: 'sell', title: 'Ore', quantity: 1, marketplace_categories: { slug: 'com-metals' } }),
        ].join('\n');
        const result = await importOrgData(ndjson);
        expect(result.rowsInserted).toBe(1);
        expect(result.warnings.some((w) => w.includes('no marketplace categories seeded'))).toBe(true);
    });

    it('imports a listing with no category embed at all without warning', async () => {
        h.rows.marketplace_categories = [{ id: 3, slug: 'services' }];
        const ndjson = [
            LISTING_HEADER,
            row('marketplace_listings', { id: 'l-1', seller_id: 5, kind: 'service', listing_type: 'offer', title: 'Towing', quantity: null, marketplace_categories: null }),
        ].join('\n');
        const result = await importOrgData(ndjson);
        expect(result.rowsInserted).toBe(1);
        expect(result.warnings.filter((w) => w.startsWith('marketplace_listings:'))).toHaveLength(0);
    });

    it('never re-anchors a sequence for the uuid-PK listings table', async () => {
        h.rows.marketplace_categories = [{ id: 3, slug: 'services' }];
        const ndjson = [LISTING_HEADER, row('marketplace_listings', { id: 'l-1', seller_id: 5, kind: 'service', listing_type: 'offer', title: 'Towing' })].join('\n');
        const result = await importOrgData(ndjson);
        expect(result.sequencesReset).not.toContain('marketplace_listings');
        expect(h.resets).not.toContain('marketplace_listings');
    });
});
