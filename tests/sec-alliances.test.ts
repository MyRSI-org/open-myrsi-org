import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Federation roster data-minimization: the ally roster projection must NOT leak
// the real internal users.id across the org boundary. toAllyRosterMember(row,
// synthId) must emit the per-share synthetic index in `id`, mirroring
// projectOperationSnapshot's ownerId:0 / userId:i+1 id-neutralization.
// getAllyRosterProjection must feed it i+1 so the real PK never survives the
// projection served by GET /api/alliance/roster.
// =============================================================================

// Mock the db barrel-common module so getAllyRosterProjection can run without a
// live Supabase: safeFetch returns our crafted rows, getSystemRoles has no
// client role (so the .neq branch is skipped).
const safeFetchMock = vi.fn();
vi.mock('../lib/db/common.js', () => ({
    supabase: { from: () => ({ select: () => ({ is: () => ({}) }) }) },
    handleSupabaseError: vi.fn(),
    broadcastToOrg: vi.fn(),
    safeFetch: (...args: unknown[]) => safeFetchMock(...args),
    getSystemRoles: vi.fn(async () => ({})),
}));

import { toAllyRosterMember, getAllyRosterProjection } from '../lib/db/alliances';

type RosterRowArg = Parameters<typeof toAllyRosterMember>[0];

function makeRow(extra: Record<string, unknown> = {}): RosterRowArg {
    return {
        id: 7, name: 'Pilot', rsi_handle: 'PilotHandle', avatar_url: 'a.png', is_duty: true,
        rank: { name: 'Captain', icon_url: 'r.png' },
        unit: { id: 2, name: 'Alpha Squadron' },
        role: { name: 'Member' },
        specializations: [],
        ...extra,
    } as unknown as RosterRowArg;
}

describe('toAllyRosterMember — internal users.id neutralization', () => {
    it('emits the per-share synthetic index in id, never the real PK', () => {
        const out = toAllyRosterMember(makeRow({ id: 7 }), 1);
        expect(out.id).toBe(1);          // synthetic per-share index
        expect(out.id).not.toBe(7);      // the real internal users.id never crosses
    });

    it('does not let the real users.id survive the projection JSON', () => {
        // A distinctive real PK so the contains-guard is unambiguous.
        const out = toAllyRosterMember(makeRow({ id: 90217 }), 1);
        expect(out.id).toBe(1);
        expect(JSON.stringify(out)).not.toContain('90217');
    });

    it('still maps the display-only fields the ally renders', () => {
        const out = toAllyRosterMember(makeRow({ id: 7 }), 3);
        expect(out.id).toBe(3);
        expect(out.rsiHandle).toBe('PilotHandle');
        expect(out.name).toBe('Pilot');
        expect(out.rankName).toBe('Captain');
        expect(out.unitName).toBe('Alpha Squadron');
        expect(out.roleName).toBe('Member');
    });
});

describe('getAllyRosterProjection — aggregator feeds synthetic ids', () => {
    beforeEach(() => {
        safeFetchMock.mockReset();
    });

    it('replaces every real users.id with a 1..N per-share index', async () => {
        safeFetchMock.mockResolvedValueOnce([
            makeRow({ id: 555, rsi_handle: 'Alpha', name: 'A' }),
            makeRow({ id: 888, rsi_handle: 'Bravo', name: 'B' }),
        ]);
        const out = await getAllyRosterProjection({ channels: { roster: true } });
        expect(out).not.toBeNull();
        expect(out!.memberCount).toBe(2);
        expect(out!.members.map((m) => m.id)).toEqual([1, 2]);
        const blob = JSON.stringify(out);
        expect(blob).not.toContain('555');
        expect(blob).not.toContain('888');
    });

    it('fails closed (null) when the peer does not have the roster channel enabled', async () => {
        expect(await getAllyRosterProjection({ channels: {} })).toBeNull();
        expect(await getAllyRosterProjection({ channels: { roster: false } })).toBeNull();
        expect(safeFetchMock).not.toHaveBeenCalled();
    });
});
