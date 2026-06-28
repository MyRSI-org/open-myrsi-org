import { describe, it, expect } from 'vitest';
import { toAllyRosterMember } from '../lib/db/alliances';

type RosterRowArg = Parameters<typeof toAllyRosterMember>[0];

// A user row carrying sensitive fields the ally projection must never emit.
function makeRow(extra: Record<string, unknown> = {}): RosterRowArg {
    return {
        id: 7, name: 'Pilot', rsi_handle: 'PilotHandle', avatar_url: 'a.png', is_duty: true,
        rank: { name: 'Captain', icon_url: 'r.png' },
        unit: { id: 2, name: 'Alpha Squadron' },
        role: { name: 'Member' },
        specializations: [
            { specialization: { name: 'Pilot', icon: 'p' } },
            { specialization: { name: 'Medic', icon: 'm' } },
            { specialization: { name: 'Engineer', icon: 'e' } },
            { specialization: { name: 'Gunner', icon: 'g' } },
        ],
        // Sensitive — must NOT survive the projection:
        discord_id: 'discord-secret-123',
        admin_notes: 'flagged for vetting',
        personnel_notes: 'internal hr note',
        clearance_level_id: 5,
        permissions: ['admin:access'],
        email: 'secret@org.test',
        ...extra,
    } as unknown as RosterRowArg;
}

describe('toAllyRosterMember (ally roster PII guard)', () => {
    it('emits only safe fields — no PII / secrets in the output', () => {
        const blob = JSON.stringify(toAllyRosterMember(makeRow(), 1));
        expect(blob).not.toContain('discord-secret-123');
        expect(blob).not.toContain('flagged for vetting');
        expect(blob).not.toContain('internal hr note');
        expect(blob).not.toContain('secret@org.test');
        expect(blob).not.toContain('admin:access');
        const out = toAllyRosterMember(makeRow(), 1) as unknown as Record<string, unknown>;
        expect(out.discordId).toBeUndefined();
        expect(out.adminNotes).toBeUndefined();
        expect(out.clearanceLevelId).toBeUndefined();
        expect(out.permissions).toBeUndefined();
        expect(out.email).toBeUndefined();
    });

    it('maps the safe fields correctly', () => {
        const out = toAllyRosterMember(makeRow(), 1);
        expect(out.rsiHandle).toBe('PilotHandle');
        expect(out.rankName).toBe('Captain');
        expect(out.unitName).toBe('Alpha Squadron');
        expect(out.roleName).toBe('Member');
        expect(out.isDuty).toBe(true);
    });

    it('caps specializations at 3', () => {
        expect(toAllyRosterMember(makeRow(), 1).specializations).toHaveLength(3);
    });

    it('handles array-shaped to-one embeds (PostgREST type inference)', () => {
        const out = toAllyRosterMember(makeRow({
            rank: [{ name: 'Major', icon_url: 'x' }],
            unit: [{ id: 1, name: 'HQ' }],
            role: [{ name: 'Dispatcher' }],
        }), 1);
        expect(out.rankName).toBe('Major');
        expect(out.unitName).toBe('HQ');
        expect(out.roleName).toBe('Dispatcher');
    });
});
