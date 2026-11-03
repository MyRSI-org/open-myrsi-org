import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    toSpecializationTag, toCertification, toCommendation, inferUserRoleTier,
    toUser, toMiniUser, minifyUser, toRank, toUnit, toUnitPost, toPersonnelPosition,
    toAnnouncement,
} from '../lib/db/mappers';
import { ROSTER_SAFE_FIELDS } from '../lib/db/userFilters';
import { UserRole } from '../types';

// lib/db/mappers.ts — the identity / personnel row mappers.
//
// Every mapper is the LAST field-by-field narrowing between a PostgREST row and the
// wire (Security rule 1), so each test pins the EXACT output shape with toStrictEqual:
// a key that is present-but-undefined, or an input column that rides through, fails.
// Input rows deliberately carry columns no mapper reads (`*_LEAK` sentinels, auth ids,
// tokens) so a future `...row` spread is caught here rather than in production.

const NOW = '2026-03-04T05:06:07.000Z';
const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

// The exact key set an EMBEDDED user may carry: the roster allow-list plus the four
// keys buildRosterSafeUser re-adds present-and-empty.
const MINI_KEYS = [...new Set([...ROSTER_SAFE_FIELDS, 'discordId', 'permissions', 'conductRecord', 'limitingMarkers'])].sort();

/** A users row carrying every private column a widened embed SELECT could pull in. */
function secretUserRow(id: number, name: string): Record<string, unknown> {
    return {
        id, name, discord_id: '990000000000000001', avatar_url: `${name}.png`, rsi_handle: `${name}_rsi`,
        role_id: 9, reputation: 12, is_duty: true, created_at: '2025-01-01T00:00:00.000Z',
        role: { id: 9, name: 'Admin', role_permissions: [{ permission: { name: 'admin:access' } }] },
        admin_notes: 'SECRET-admin-notes', personnel_notes: 'SECRET-personnel-notes',
        rsi_verification_code: 'SECRET-verify-code', rsi_handle_pending: 'SECRET-pending',
        job_title: 'SECRET-job', voice_channel_name: 'SECRET-voice', timezone: 'SECRET-tz',
        probation_start: 'SECRET-ps', probation_end: 'SECRET-pe', tenure_start_date: 'SECRET-tenure',
        tokens_valid_from: 'SECRET-tvf', auth_user_id: 'SECRET-auth-uid',
        clearance_level: { id: 1, level: 5, name: 'SECRET-clearance' },
        limiting_markers: [{ marker: 'SECRET-marker' }],
        conductRecord: [{ id: 1, type: 'warning', reason: 'SECRET-conduct', created_at: 'x' }],
    };
}

/** Asserts `u` is an embed-safe projection of secretUserRow(id, name). */
function expectMiniUser(u: unknown, id: number, name: string) {
    expect(u).toBeDefined();
    const rec = u as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(MINI_KEYS);
    expect(rec.id).toBe(id);
    expect(rec.name).toBe(name);
    expect(rec.avatarUrl).toBe(`${name}.png`);
    expect(rec.discordId).toBe('');
    expect(rec.permissions).toEqual([]);
    expect(rec.conductRecord).toEqual([]);
    expect(rec.limitingMarkers).toEqual([]);
    expect(JSON.stringify(rec)).not.toContain('SECRET');
    expect(JSON.stringify(rec)).not.toContain('990000000000000001');
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

describe('toSpecializationTag / toCertification / toCommendation', () => {
    const cases = [
        ['toSpecializationTag', toSpecializationTag],
        ['toCertification', toCertification],
        ['toCommendation', toCommendation],
    ] as const;

    for (const [label, fn] of cases) {
        it(`${label}: maps a full row and drops unmapped columns`, () => {
            expect(fn({ id: 3, name: 'Medic', description: 'heals', icon: 'fa-plus', image_url: 'm.png', created_at: 'LEAK', secret_LEAK: 1 } as never))
                .toStrictEqual({ id: 3, name: 'Medic', description: 'heals', icon: 'fa-plus', imageUrl: 'm.png' });
        });

        it(`${label}: empty optional columns become undefined, missing id/name get placeholders`, () => {
            expect(fn({ id: 0, name: '', description: null, icon: '', image_url: null } as never))
                .toStrictEqual({ id: 0, name: 'Unknown', description: undefined, icon: undefined, imageUrl: undefined });
        });

        it(`${label}: tolerates a null relation (dangling embed) without throwing`, () => {
            expect(fn(null as never))
                .toStrictEqual({ id: 0, name: 'Unknown', description: undefined, icon: undefined, imageUrl: undefined });
        });
    }
});

describe('inferUserRoleTier — display tier only, byte-exact names then permission fallback', () => {
    it.each([
        ['Admin', [], UserRole.Admin],
        ['  Admin  ', [], UserRole.Admin],
        ['Dispatcher', [], UserRole.Dispatcher],
        ['Member', [], UserRole.Member],
        ['Client', ['admin:access'], UserRole.Client],
        ['', ['admin:access'], UserRole.Client],
        [null, ['admin:access'], UserRole.Client],
        [undefined, [], UserRole.Client],
        // Case folding is gone: 'admin' must NOT inherit the Admin tier by name.
        ['admin', [], UserRole.Client],
        ['Commander', ['admin:access'], UserRole.Admin],
        ['Commander', ['request:dispatch'], UserRole.Dispatcher],
        ['Commander', ['request:triage'], UserRole.Dispatcher],
        ['Commander', ['request:accept'], UserRole.Member],
        ['Commander', ['user:toggle_duty'], UserRole.Member],
        // admin:config:* is delegated to Dispatchers — only admin:access counts.
        ['Commander', ['admin:config:notices'], UserRole.Client],
        ['Commander', [], UserRole.Client],
    ] as const)('name=%j perms=%j -> %s', (name, perms, tier) => {
        expect(inferUserRoleTier(name, [...perms])).toBe(tier);
    });
});

describe('toUser', () => {
    it('rejects non-object input', () => {
        expect(toUser(null)).toBeUndefined();
        expect(toUser(undefined)).toBeUndefined();
        expect(toUser('7' as never)).toBeUndefined();
        expect(toUser(7 as never)).toBeUndefined();
    });

    it('maps a fully-hydrated row field-by-field (and no unmapped column survives)', () => {
        const row = {
            id: 7, discord_id: '123456789012345678', name: 'DiscordName', display_name: '  Custom Name  ',
            avatar_url: 'av.png', rsi_handle: 'Handle', role_id: 3, reputation: 50,
            is_duty: true, is_affiliate: true, is_vip: true, created_at: '2025-05-05T00:00:00.000Z',
            admin_notes: 'an', personnel_notes: 'pn',
            role: {
                id: 3, name: 'Member',
                role_permissions: [
                    { permission: { name: 'user:toggle_duty' } },
                    { permission: null },
                    { permission: { name: 'request:accept' } },
                ],
            },
            rank: { id: 2, name: 'Sergeant', icon_url: 'r.png', sort_order: 5, created_at: 'LEAK' },
            unit: { id: 4, name: 'Alpha', sort_order: 1, has_radio_channel: false, leader: secretUserRow(11, 'Leader') },
            position: { id: 5, name: 'Pilot', description: 'flies', icon: 'fa-jet', department: 'Flight', secret_LEAK: 1 },
            secondaryPosition: { id: 6, name: 'Medic', description: null, icon: null, department: null },
            clearance_level: { id: 1, level: 3, name: 'Secret' },
            limiting_markers: [{ marker: 'NOFORN' }, { marker: null }, { marker: 'ORCON' }],
            specializations: [
                { specialization: { id: 1, name: 'Sniper', description: 'd', icon: 'i', image_url: 'u' } },
                { specialization: null },
            ],
            certifications: [
                { certification: { id: 21, name: 'EVA', description: null, icon: null, image_url: null }, awarded_at: 't1', awardedBy: { id: 9, name: 'Boss' } },
                { certification: { id: 22, name: 'Pilot', description: 'p', icon: 'pi', image_url: 'pu' }, awarded_at: 't2', awardedBy: { id: 0, name: 'Ghost' } },
                { certification: null, awarded_at: 't3', awardedBy: null },
            ],
            commendations: [
                { commendation: { id: 31, name: 'Valour', description: 'v', icon: 'vi', image_url: 'vu' }, reason: 'brave', awarded_at: 'c1', awardedBy: { id: 8, name: 'Chief' } },
                { commendation: null, reason: null, awarded_at: 'c2', awardedBy: { id: 0, name: 'x' } },
                { commendation: { id: 32, name: 'Merit', description: null, icon: null, image_url: null }, reason: 'r', awarded_at: 'c3', awardedBy: null },
            ],
            conductRecord: [
                { id: 1, type: 'warning', reason: 'late', enteredBy: { id: 2, name: 'Sgt' }, created_at: 'cr1' },
                { id: 2, type: 'note', reason: 'fine', enteredBy: null, created_at: 'cr2' },
            ],
            rsi_handle_pending: 'NewHandle', rsi_verification_code: 'CODE-1', rsi_verified: false,
            job_title: 'Quartermaster', voice_channel_name: 'Ops 1', timezone: 'Europe/London',
            date_format: 'DD/MM/YYYY', probation_start: 'ps', probation_end: 'pe',
            tenure_start_date: '2024-01-01', tokens_valid_from: '2026-01-01T00:00:00.000Z',
            // Never mapped.
            discord_access_token: 'LEAK-token', auth_user_id: 'LEAK-auth', deleted_at: 'LEAK-del',
        };
        const u = toUser(row as never)!;
        const leader = u.unit!.leader;
        expectMiniUser(leader, 11, 'Leader');

        expect(u).toStrictEqual({
            id: 7, discordId: '123456789012345678', name: 'Custom Name', displayName: '  Custom Name  ',
            discordName: 'DiscordName', avatarUrl: 'av.png', rsiHandle: 'Handle', roleId: 3,
            role: UserRole.Member,
            rank: { id: 2, name: 'Sergeant', iconUrl: 'r.png', sortOrder: 5 },
            unit: {
                id: 4, name: 'Alpha', parentUnitId: undefined, sortOrder: 1, leaderId: undefined,
                logoUrl: undefined, bannerUrl: undefined, motto: undefined, description: undefined,
                hasRadioChannel: false, linkedChannelId: undefined, leader, isRestricted: undefined,
            },
            position: { id: 5, name: 'Pilot', description: 'flies', icon: 'fa-jet', department: 'Flight' },
            secondaryPosition: { id: 6, name: 'Medic', description: null, icon: null, department: null },
            reputation: 50, isDuty: true, isAffiliate: true, isVip: true,
            permissions: ['user:toggle_duty', 'request:accept'],
            createdAt: '2025-05-05T00:00:00.000Z',
            adminNotes: 'an', personnelNotes: 'pn',
            clearanceLevel: { id: 1, level: 3, name: 'Secret' },
            limitingMarkers: ['NOFORN', 'ORCON'],
            specializations: [{ id: 1, name: 'Sniper', description: 'd', icon: 'i', imageUrl: 'u' }],
            certifications: [
                { id: 21, name: 'EVA', description: undefined, icon: undefined, imageUrl: undefined, awardedAt: 't1', awardedBy: { id: 9, name: 'Boss' } },
                // A falsy awarder id is a dangling FK: replaced, not passed through.
                { id: 22, name: 'Pilot', description: 'p', icon: 'pi', imageUrl: 'pu', awardedAt: 't2', awardedBy: { id: 0, name: 'Unknown' } },
                { id: 0, name: 'Unknown', description: undefined, icon: undefined, imageUrl: undefined, awardedAt: 't3', awardedBy: { id: 0, name: 'Unknown' } },
            ],
            commendations: [
                { id: 31, name: 'Valour', description: 'v', icon: 'vi', imageUrl: 'vu', reason: 'brave', awardedAt: 'c1', awardedBy: { id: 8, name: 'Chief' } },
                { id: 0, name: 'Unknown', description: undefined, icon: undefined, imageUrl: undefined, reason: null, awardedAt: 'c2', awardedBy: { id: 0, name: 'Unknown' } },
                { id: 32, name: 'Merit', description: undefined, icon: undefined, imageUrl: undefined, reason: 'r', awardedAt: 'c3', awardedBy: { id: 0, name: 'Unknown' } },
            ],
            conductRecord: [
                { id: 1, type: 'warning', reason: 'late', enteredBy: { id: 2, name: 'Sgt' }, createdAt: 'cr1' },
                { id: 2, type: 'note', reason: 'fine', enteredBy: { id: 0, name: 'Unknown' }, createdAt: 'cr2' },
            ],
            rsiHandlePending: 'NewHandle', rsiVerificationCode: 'CODE-1', rsiVerified: false,
            jobTitle: 'Quartermaster', voiceChannelName: 'Ops 1', timezone: 'Europe/London',
            dateFormat: 'DD/MM/YYYY', probationStart: 'ps', probationEnd: 'pe',
            tenureStartDate: '2024-01-01', tokensValidFrom: '2026-01-01T00:00:00.000Z',
        });
    });

    it('a bare row falls back to safe defaults (Client tier, empty arrays, now-timestamp)', () => {
        expect(toUser({} as never)).toStrictEqual({
            id: 0, discordId: '', name: 'Unknown', displayName: null, discordName: 'Unknown',
            avatarUrl: DEFAULT_AVATAR, rsiHandle: '', roleId: 0, role: UserRole.Client,
            rank: undefined, unit: undefined, position: undefined, secondaryPosition: undefined,
            reputation: 0, isDuty: false, isAffiliate: false, isVip: false, permissions: [],
            createdAt: NOW, adminNotes: undefined, personnelNotes: undefined, clearanceLevel: undefined,
            limitingMarkers: [], specializations: [], certifications: [], commendations: [], conductRecord: [],
            rsiHandlePending: undefined, rsiVerificationCode: undefined,
            // Pre-migration rows (no rsi_verified column) are treated as verified.
            rsiVerified: true,
            jobTitle: undefined, voiceChannelName: undefined, timezone: null, dateFormat: null,
            probationStart: undefined, probationEnd: undefined, tenureStartDate: null,
            // Pre-migration rows carry no per-user revocation watermark.
            tokensValidFrom: null,
        });
    });

    it('a whitespace-only display_name does not override the Discord name', () => {
        const u = toUser({ id: 1, name: 'Disc', display_name: '   ' } as never)!;
        expect(u.name).toBe('Disc');
        expect(u.displayName).toBe('   ');
        expect(u.discordName).toBe('Disc');
    });

    it('reads the un-aliased `units` relation when `unit` is absent', () => {
        const u = toUser({ id: 1, units: { id: 8, name: 'Bravo', sort_order: 3, is_restricted: true } } as never)!;
        expect(u.unit).toMatchObject({ id: 8, name: 'Bravo', sortOrder: 3, isRestricted: true, hasRadioChannel: true });
    });

    it('a role row with no role_permissions yields an empty permission set and name-based tier', () => {
        const u = toUser({ id: 1, role: { id: 2, name: 'Dispatcher', role_permissions: null } } as never)!;
        expect(u.permissions).toEqual([]);
        expect(u.role).toBe(UserRole.Dispatcher);
    });

    it('a custom-named role is tiered by its permissions', () => {
        const u = toUser({ id: 1, role: { id: 5, name: 'Quartermasters', role_permissions: [{ permission: { name: 'request:triage' } }] } } as never)!;
        expect(u.role).toBe(UserRole.Dispatcher);
        expect(u.permissions).toEqual(['request:triage']);
    });
});

describe('toMiniUser / minifyUser — the embed boundary', () => {
    it('blanks every private column of a widened embed row', () => {
        expectMiniUser(toMiniUser(secretUserRow(4, 'Embedded') as never), 4, 'Embedded');
    });

    it('keeps the public card fields the embed renders', () => {
        const m = toMiniUser(secretUserRow(4, 'Embedded') as never)!;
        expect(m).toMatchObject({ rsiHandle: 'Embedded_rsi', reputation: 12, isDuty: true, role: UserRole.Admin, roleId: 9 });
    });

    it('passes nullish through as undefined', () => {
        expect(toMiniUser(null)).toBeUndefined();
        expect(toMiniUser(undefined)).toBeUndefined();
        expect(minifyUser(null)).toBeUndefined();
    });

    it('minifyUser projects an already-mapped User to the same allow-list', () => {
        const full = toUser(secretUserRow(5, 'Mapped') as never)!;
        expect(full.adminNotes).toBe('SECRET-admin-notes');
        expectMiniUser(minifyUser(full), 5, 'Mapped');
    });
});

describe('toRank / toPersonnelPosition', () => {
    it('toRank maps a row, defaults gaps, and returns the sentinel for a missing relation', () => {
        expect(toRank({ id: 2, name: 'Sgt', icon_url: 'r.png', sort_order: 4, secret_LEAK: 1 } as never))
            .toStrictEqual({ id: 2, name: 'Sgt', iconUrl: 'r.png', sortOrder: 4 });
        expect(toRank({} as never)).toStrictEqual({ id: 0, name: 'Unknown', iconUrl: '', sortOrder: 0 });
        expect(toRank(null)).toStrictEqual({ id: 0, name: 'Unknown', iconUrl: '', sortOrder: 999 });
        expect(toRank(undefined)).toStrictEqual({ id: 0, name: 'Unknown', iconUrl: '', sortOrder: 999 });
    });

    it('toPersonnelPosition maps a row, defaults id/name, and returns the sentinel for a missing relation', () => {
        expect(toPersonnelPosition({ id: 5, name: 'Pilot', description: 'd', icon: 'i', department: 'Flight', created_at: 'LEAK' } as never))
            .toStrictEqual({ id: 5, name: 'Pilot', description: 'd', icon: 'i', department: 'Flight' });
        expect(toPersonnelPosition({} as never))
            .toStrictEqual({ id: 0, name: 'Unknown', description: undefined, icon: undefined, department: undefined });
        expect(toPersonnelPosition(null)).toStrictEqual({ id: 0, name: 'Unknown' });
    });
});

describe('toUnit', () => {
    it('maps a full row; the leader embed is minified', () => {
        const unit = toUnit({
            id: 4, name: 'Alpha', parent_unit_id: 1, sort_order: 2, leader_id: 11, logo_url: 'l.png',
            banner_url: 'b.png', motto: 'Onward', description: 'desc', has_radio_channel: true,
            linked_channel_id: 'chan-1', is_restricted: true, leader: secretUserRow(11, 'Leader'),
            created_at: 'LEAK', secret_LEAK: 'x',
        } as never);
        expectMiniUser(unit.leader, 11, 'Leader');
        expect(unit).toStrictEqual({
            id: 4, name: 'Alpha', parentUnitId: 1, sortOrder: 2, leaderId: 11, logoUrl: 'l.png',
            bannerUrl: 'b.png', motto: 'Onward', description: 'desc', hasRadioChannel: true,
            linkedChannelId: 'chan-1', leader: unit.leader, isRestricted: true,
        });
    });

    it('defaults a sparse row: radio on, not restricted, no leader', () => {
        expect(toUnit({ is_restricted: false, linked_channel_id: '' } as never)).toStrictEqual({
            id: 0, name: 'Unknown', parentUnitId: undefined, sortOrder: 0, leaderId: undefined,
            logoUrl: undefined, bannerUrl: undefined, motto: undefined, description: undefined,
            hasRadioChannel: true, linkedChannelId: undefined, leader: undefined, isRestricted: undefined,
        });
    });

    it('returns the sentinel unit for a missing relation', () => {
        expect(toUnit(null)).toStrictEqual({ id: 0, name: 'Unknown', sortOrder: 999 });
        expect(toUnit(undefined)).toStrictEqual({ id: 0, name: 'Unknown', sortOrder: 999 });
    });
});

describe('toUnitPost', () => {
    it('maps the post and minifies the author', () => {
        const post = toUnitPost({
            id: 1, unit_id: 4, author_id: 11, content: 'hello', created_at: 't', pinned: true,
            author: secretUserRow(11, 'Author'), secret_LEAK: 1,
        } as never);
        expectMiniUser(post.author, 11, 'Author');
        expect(post).toStrictEqual({
            id: 1, unitId: 4, authorId: 11, content: 'hello', createdAt: 't', pinned: true, author: post.author,
        });
    });

    it('an author-less post has no author', () => {
        expect(toUnitPost({ id: 2, unit_id: 4, author_id: null, content: 'c', created_at: 't', pinned: false, author: null } as never))
            .toStrictEqual({ id: 2, unitId: 4, authorId: null, content: 'c', createdAt: 't', pinned: false, author: undefined });
    });
});

describe('toAnnouncement', () => {
    it('maps every column and nothing else', () => {
        expect(toAnnouncement({
            id: 1, title: 'T', body: 'B', author: 'A', type: 'Info', audience: ['Member'],
            publish_date: 'p', expiry_date: 'e', created_at: 'LEAK', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, title: 'T', body: 'B', author: 'A', type: 'Info', audience: ['Member'], publishDate: 'p', expiryDate: 'e',
        });
    });

    it('a null audience becomes an empty list (which the audience filter then fails closed on)', () => {
        expect(toAnnouncement({ id: 2, title: 'T', body: 'B', author: 'A', type: 'Info', audience: null, publish_date: 'p', expiry_date: null } as never))
            .toStrictEqual({ id: 2, title: 'T', body: 'B', author: 'A', type: 'Info', audience: [], publishDate: 'p', expiryDate: null });
    });
});
