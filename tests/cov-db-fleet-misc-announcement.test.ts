import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/opAnnouncement.ts — the Discord operation-announcement embed INPUT.
//
// The announcement channel is a GENERAL channel with no per-recipient clearance
// filter, so the `restricted` flag on the returned input is the whole egress
// contract. It must come from operationIsRestricted (the ONE fail-closed
// definition, including is_special) — never re-derived inline from clearance —
// and it must ride every non-null result. These tests pin that delegation plus
// the degrade-don't-blank behaviour of the optional lookups and the error paths.

const h = vi.hoisted(() => ({
    restricted: vi.fn(async (_id: string) => false),
    tenantUrl: vi.fn(async () => 'https://org.example.com/'),
}));

vi.mock('../lib/log', async () => (await import('./cov-db-fleet-misc-sb')).logModule);
vi.mock('../lib/db/common', async () => ({ supabase: (await import('./cov-db-fleet-misc-sb')).fakeSupabase }));
vi.mock('../lib/db/ops', () => ({ operationIsRestricted: h.restricted }));
vi.mock('../lib/db', () => ({ getOrgTenantUrl: h.tenantUrl }));

import { resetAll, route, queriesFor, filterValue, assertExplicitColumns, logged, type Q } from './cov-db-fleet-misc-sb';
import { buildAnnouncementEmbedInput } from '../lib/db/opAnnouncement';

const OP_ID = '11111111-2222-3333-4444-555555555555';
const BASE_COLS = 'id, name, description, type, scheduled_start, scheduled_end, clearance_level, unit_id, location_id';

const opRow = (over: Record<string, unknown> = {}) => ({
    id: OP_ID, name: 'Operation Nightfall', description: 'Escort run', type: 'Escort',
    scheduled_start: '2026-05-01T20:00:00Z', scheduled_end: '2026-05-01T22:00:00Z',
    clearance_level: 3, unit_id: 4, location_id: 9, location_text: '  Port Olisar  ', ...over,
});

function routeHappy(op: Record<string, unknown> = opRow()) {
    route('operations:select', { data: op });
    route('units:select', { data: { name: 'Black Watch' } });
    route('locations:select', { data: { name: 'Crusader' } });
    route('settings:select', { data: [{ key: 'brandingConfig', value: { name: 'Test Org', iconUrl: 'https://cdn/icon.png' } }] });
    route('security_clearances:select', { data: { name: 'Secret', level: 3 } });
}

beforeEach(() => {
    resetAll();
    h.restricted.mockReset();
    h.restricted.mockResolvedValue(false);
    h.tenantUrl.mockReset();
    h.tenantUrl.mockResolvedValue('https://org.example.com/');
});

afterEach(() => {
    assertExplicitColumns();
});

describe('buildAnnouncementEmbedInput — happy path', () => {
    it('assembles a self-contained embed input from narrow, explicit reads', async () => {
        routeHappy();
        const out = await buildAnnouncementEmbedInput(OP_ID);

        expect(out).toEqual({
            name: 'Operation Nightfall',
            description: 'Escort run',
            type: 'Escort',
            scheduledStart: '2026-05-01T20:00:00Z',
            scheduledEnd: '2026-05-01T22:00:00Z',
            clearanceLabel: 'L3 — Secret',
            unitName: 'Black Watch',
            // Free-text location wins (trimmed) over the catalog location name.
            locationLabel: 'Port Olisar',
            // Trailing slash on the tenant URL is not doubled.
            operationDeepLink: `https://org.example.com/operations/${OP_ID}`,
            branding: { name: 'Test Org', iconUrl: 'https://cdn/icon.png' },
            restricted: false,
        });

        const [op] = queriesFor('operations', 'select');
        expect(op.columns).toBe(`${BASE_COLS}, location_text`);
        expect(op.filters).toEqual([['eq', 'id', OP_ID]]);
        expect(op.terminal).toBe('single');

        const [unit] = queriesFor('units', 'select');
        expect([unit.columns, unit.filters, unit.terminal]).toEqual(['name', [['eq', 'id', 4]], 'maybeSingle']);
        const [loc] = queriesFor('locations', 'select');
        expect([loc.columns, loc.filters, loc.terminal]).toEqual(['name', [['eq', 'id', 9]], 'maybeSingle']);
        // Only the branding key is read from settings — never the whole table.
        const [settings] = queriesFor('settings', 'select');
        expect(settings.columns).toBe('key, value');
        expect(filterValue(settings, 'in', 'key')).toEqual(['brandingConfig']);
        const [clr] = queriesFor('security_clearances', 'select');
        expect([clr.columns, clr.filters]).toEqual(['name, level', [['eq', 'level', 3]]]);
    });

    it('takes `restricted` from operationIsRestricted for THIS operation and passes it through verbatim', async () => {
        routeHappy(opRow({ clearance_level: 0 }));
        h.restricted.mockResolvedValue(true);
        const out = await buildAnnouncementEmbedInput(OP_ID);

        // Clearance 0 would look "unrestricted" to an inline clearance check — the
        // shared predicate (markers + is_special too) is what decides.
        expect(h.restricted).toHaveBeenCalledTimes(1);
        expect(h.restricted).toHaveBeenCalledWith(OP_ID);
        expect(out?.restricted).toBe(true);
    });
});

describe('optional lookups degrade instead of blanking the embed', () => {
    it('skips the unit/location reads when the op has no FK, and the clearance read at level 0', async () => {
        routeHappy(opRow({ unit_id: null, location_id: null, clearance_level: 0, location_text: null }));
        const out = await buildAnnouncementEmbedInput(OP_ID);

        expect(queriesFor('units')).toEqual([]);
        expect(queriesFor('locations')).toEqual([]);
        expect(queriesFor('security_clearances')).toEqual([]);
        expect(out).toMatchObject({ unitName: null, locationLabel: null, clearanceLabel: null });
    });

    it('treats a null clearance level as unclassified (no label, no lookup)', async () => {
        routeHappy(opRow({ clearance_level: null }));
        const out = await buildAnnouncementEmbedInput(OP_ID);
        expect(out?.clearanceLabel).toBeNull();
        expect(queriesFor('security_clearances')).toEqual([]);
    });

    it('falls back to a bare "Level N" label when the clearance row is missing', async () => {
        routeHappy(opRow({ clearance_level: 2 }));
        route('security_clearances:select', { data: null });
        const out = await buildAnnouncementEmbedInput(OP_ID);
        expect(out?.clearanceLabel).toBe('Level 2');
    });

    it('uses the catalog location name when location_text is blank', async () => {
        routeHappy(opRow({ location_text: '   ' }));
        const out = await buildAnnouncementEmbedInput(OP_ID);
        expect(out?.locationLabel).toBe('Crusader');
    });

    it('yields null unit/location when the lookups return nothing', async () => {
        routeHappy(opRow({ location_text: null }));
        route('units:select', { data: null });
        route('locations:select', { data: null });
        const out = await buildAnnouncementEmbedInput(OP_ID);
        expect(out).toMatchObject({ unitName: null, locationLabel: null });
    });

    it('omits the deep link when no tenant URL is configured', async () => {
        routeHappy();
        h.tenantUrl.mockResolvedValue('');
        const out = await buildAnnouncementEmbedInput(OP_ID);
        expect(out?.operationDeepLink).toBeNull();
    });

    it('builds the deep link from a tenant URL without a trailing slash', async () => {
        routeHappy();
        h.tenantUrl.mockResolvedValue('https://org.example.com');
        const out = await buildAnnouncementEmbedInput(OP_ID);
        expect(out?.operationDeepLink).toBe(`https://org.example.com/operations/${OP_ID}`);
    });

    it('returns empty branding when no brandingConfig row exists', async () => {
        routeHappy();
        route('settings:select', { data: null });
        const out = await buildAnnouncementEmbedInput(OP_ID);
        expect(out?.branding).toEqual({ name: undefined, iconUrl: undefined });

        route('settings:select', { data: [{ key: 'otherKey', value: { name: 'nope' } }] });
        const again = await buildAnnouncementEmbedInput(OP_ID);
        expect(again?.branding).toEqual({ name: undefined, iconUrl: undefined });
    });
});

describe('location_text schema fallback', () => {
    for (const code of ['42703', 'PGRST204']) {
        it(`retries without location_text on ${code} and still builds the embed`, async () => {
            routeHappy();
            route('operations:select', (q: Q) => (q.columns!.includes('location_text')
                ? { error: { code, message: 'column operations.location_text does not exist' } }
                : { data: opRow({ location_text: undefined }) }));
            const out = await buildAnnouncementEmbedInput(OP_ID);

            const ops = queriesFor('operations', 'select');
            expect(ops.map((q) => q.columns)).toEqual([`${BASE_COLS}, location_text`, BASE_COLS]);
            expect(ops[1].filters).toEqual([['eq', 'id', OP_ID]]);
            expect(ops[1].terminal).toBe('single');
            expect(out?.locationLabel).toBe('Crusader');
            expect(logged('warn', 'operations.location_text unavailable — retrying without')?.fields).toMatchObject({ code });
        });
    }

    it('returns null and logs when the retry also fails', async () => {
        routeHappy();
        route('operations:select', (q: Q) => (q.columns!.includes('location_text')
            ? { error: { code: '42703', message: 'missing column' } }
            : { error: { code: '57014', message: 'statement timeout', hint: 'h', details: 'd' } }));
        await expect(buildAnnouncementEmbedInput(OP_ID)).resolves.toBeNull();
        expect(logged('error', 'operation lookup failed')?.fields).toEqual({
            operationId: OP_ID, code: '57014', message: 'statement timeout', hint: 'h', details: 'd',
        });
        // Nothing downstream ran: no restriction probe, no settings read, no egress input.
        expect(h.restricted).not.toHaveBeenCalled();
        expect(queriesFor('settings')).toEqual([]);
    });
});

describe('operation lookup failures', () => {
    it('does not retry on an unrelated error code and returns null', async () => {
        route('operations:select', { error: { code: '42501', message: 'permission denied' } });
        await expect(buildAnnouncementEmbedInput(OP_ID)).resolves.toBeNull();
        expect(queriesFor('operations', 'select')).toHaveLength(1);
        expect(logged('error', 'operation lookup failed')?.fields).toEqual({
            operationId: OP_ID, code: '42501', message: 'permission denied', hint: '', details: '',
        });
        expect(h.restricted).not.toHaveBeenCalled();
    });

    it('returns null without logging an error for a missing operation', async () => {
        route('operations:select', { data: null });
        await expect(buildAnnouncementEmbedInput(OP_ID)).resolves.toBeNull();
        expect(logged('error', 'operation lookup failed')).toBeUndefined();
        expect(h.tenantUrl).not.toHaveBeenCalled();
    });
});
