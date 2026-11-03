import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/system.ts — organisational reference data: units (incl. the is_restricted
// migration retry and the per-unit access gate), unit feed posts, ranks, specialisations,
// certifications, commendations (single + bulk award), the achievement-catalog import,
// conduct records, Discord rank mappings and external tools. Realtime nudges are asserted
// to carry ids only (Security rule 4); image fields are asserted sanitised on write.

vi.mock('../lib/db/common.js', async () => (await import('./cov-db-system-harness')).commonModule());
vi.mock('../lib/cache.js', async () => (await import('./cov-db-system-harness')).cacheModule());
vi.mock('../lib/push.js', async () => (await import('./cov-db-system-harness')).pushModule());
vi.mock('../lib/db/opReminders.js', async () => (await import('./cov-db-system-harness')).opRemindersModule());
vi.mock('../lib/db/bans.js', async () => (await import('./cov-db-system-harness')).bansModule());
vi.mock('../lib/db/roleDefaults.js', async () => (await import('./cov-db-system-harness')).roleDefaultsModule());
vi.mock('../lib/db/clientRoleLock.js', async () => (await import('./cov-db-system-harness')).clientRoleLockModule());
vi.mock('../lib/crypto.js', async () => (await import('./cov-db-system-harness')).cryptoModule());
vi.mock('../lib/db/secretsRotation.js', async () => (await import('./cov-db-system-harness')).secretsRotationModule());
vi.mock('../lib/db/securityEvents.js', async () => (await import('./cov-db-system-harness')).securityEventsModule());
vi.mock('../lib/db/seeder.js', async () => (await import('./cov-db-system-harness')).seederModule());
vi.mock('../lib/db/public.js', async () => (await import('./cov-db-system-harness')).publicModule());
vi.mock('../lib/discord.js', async () => (await import('./cov-db-system-harness')).discordModule());
vi.mock('../lib/log.js', async () => (await import('./cov-db-system-harness')).logModule());

import { db, mocks, logSpy, resetHarness, has, arg0, type Q } from './cov-db-system-harness';
import {
    addUnit, updateUnit, deleteUnit, addRank, updateRank, deleteRank, addSpecializationTag,
    updateSpecializationTag, deleteSpecializationTag, addCertification, updateCertification,
    deleteCertification, awardCertification, revokeCertification, bulkAwardCertification,
    addCommendation, updateCommendation, deleteCommendation, awardCommendation, revokeCommendation,
    bulkAwardCommendation, previewAchievementImport, bulkUpsertAchievements, MAX_IMPORT_BATCH_SIZE,
    addConductEntry, deleteConductEntry, updateRankMapping, assertUnitAccess, getUnitFeed,
    createUnitPost, deleteUnitPost, addExternalTool, updateExternalTool, reorderExternalTool,
    deleteExternalTool,
} from '../lib/db/system';

const UNIT_COLS = 'id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id';
const AUTHOR_EMBED = 'id, unit_id, author_id, content, created_at, pinned, author:users(id, name, display_name, avatar_url, rsi_handle, role_id, reputation, is_duty, is_affiliate, is_vip, created_at)';
const SAFE_IMG = 'https://cdn.example.com/badge.png';

beforeEach(() => resetHarness());

const codeOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return { code: (e as { code?: string }).code, message: (e as Error).message }; } return null; };

// ─────────────────────────────────────────────────────────────────────────────
describe('units', () => {
    it('addUnit inserts defaults (radio on, unrestricted) and returns the row; nudge carries no content', async () => {
        db.on('units', { data: { id: 7, name: 'Alpha' } });
        const out = await addUnit({ name: 'Alpha', parentUnitId: null, sortOrder: 1, linkedChannelId: '' });
        const [q] = db.q('units');
        expect(arg0(q, 'insert')).toEqual({
            name: 'Alpha', parent_unit_id: null, sort_order: 1, leader_id: undefined, motto: undefined,
            description: undefined, logo_url: undefined, has_radio_channel: true, linked_channel_id: null, is_restricted: false,
        });
        expect(arg0(q, 'select')).toBe(`${UNIT_COLS}, is_restricted`);
        expect(out).toEqual({ id: 7, name: 'Alpha' });
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('user_update', {});
    });

    it('addUnit retries without is_restricted on a pre-migration DB (42703)', async () => {
        db.once('units', { error: { code: '42703' } });
        db.once('units', { data: { id: 8 } });
        const out = await addUnit({ name: 'B', isRestricted: true, hasRadioChannel: false, linkedChannelId: 'ch' });
        const [first, retry] = db.q('units');
        expect(arg0(first, 'insert')).toEqual(expect.objectContaining({ is_restricted: true, has_radio_channel: false, linked_channel_id: 'ch' }));
        expect(arg0(retry, 'insert')).not.toHaveProperty('is_restricted');
        expect(arg0(retry, 'select')).toBe(UNIT_COLS);
        expect(out).toEqual({ id: 8 });
        expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining('units.is_restricted column missing'), { migration: true });
    });

    it('addUnit surfaces a non-migration fault without broadcasting', async () => {
        db.on('units', { error: { code: '23505' } });
        await expect(addUnit({ name: 'Dup' })).rejects.toThrow('Failed to create unit');
        expect(db.q('units')).toHaveLength(1);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('updateUnit only sends is_restricted when provided, scoped by id', async () => {
        db.on('units', { data: { id: 3, name: 'C' } });
        expect(await updateUnit({ id: 3, name: 'C' })).toEqual({ id: 3, name: 'C' });
        const [q] = db.q('units');
        expect(arg0(q, 'update')).not.toHaveProperty('is_restricted');
        expect(arg0(q, 'update')).toEqual(expect.objectContaining({ has_radio_channel: true, linked_channel_id: null }));
        expect(has(q, 'eq', 'id', 3)).toBe(true);
        expect(arg0(q, 'select')).toBe(UNIT_COLS);
        await updateUnit({ id: 3, isRestricted: 0 as unknown as boolean });
        expect(arg0(db.q('units')[1], 'update')).toEqual(expect.objectContaining({ is_restricted: false }));
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('user_update', {});
    });

    it('updateUnit retries without is_restricted on 42703, and surfaces other faults', async () => {
        db.once('units', { error: { code: '42703' } });
        db.once('units', { data: { id: 3 } });
        await updateUnit({ id: 3, isRestricted: true });
        const [, retry] = db.q('units');
        expect(arg0(retry, 'update')).not.toHaveProperty('is_restricted');
        expect(has(retry, 'eq', 'id', 3)).toBe(true);
        resetHarness();
        db.on('units', { error: { code: '42703' } });
        // no is_restricted in payload ⇒ no retry; the error surfaces
        await expect(updateUnit({ id: 3 })).rejects.toThrow('Failed to update unit');
        expect(db.q('units')).toHaveLength(1);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('deleteUnit: FK violation gets an actionable message; other faults the opaque one', async () => {
        await deleteUnit(4);
        const [q] = db.q('units');
        expect(has(q, 'delete')).toBe(true);
        expect(has(q, 'eq', 'id', 4)).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('user_update', {});
        mocks.broadcastToOrg.mockClear();
        db.once('units', { error: { code: '23503', message: 'fk_units_parent' } });
        await expect(deleteUnit(4)).rejects.toThrow('Cannot delete unit: it is still referenced by other records. Reassign members and child units first.');
        db.once('units', { error: { code: '57014' } });
        await expect(deleteUnit(4)).rejects.toThrow('Failed to delete unit');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('assertUnitAccess — restricted units', () => {
    const viewer = (unitId: number | null, perms: Array<string | null>) => ({
        data: { unit_id: unitId, role: { role_permissions: perms.map((name) => ({ permission: name === null ? null : { name } })) } },
    });

    it('missing ids short-circuit without a read', async () => {
        await assertUnitAccess(0, 5);
        await assertUnitAccess(5, 0);
        expect(db.queries).toHaveLength(0);
    });

    it('a pre-migration DB (42703) is treated as open, with a warning', async () => {
        db.on('units', { error: { code: '42703' } });
        await expect(assertUnitAccess(5, 9)).resolves.toBeUndefined();
        expect(logSpy.warn).toHaveBeenCalledWith(expect.stringContaining('units.is_restricted missing'), { migration: true });
        expect(db.q('users')).toHaveLength(0);
    });

    it('an unknown unit throws UNIT_NOT_FOUND', async () => {
        expect(await codeOf(assertUnitAccess(5, 9))).toEqual({ code: 'UNIT_NOT_FOUND', message: 'Unit not found.' });
        const [q] = db.q('units');
        expect(arg0(q, 'select')).toBe('id, is_restricted');
        expect(has(q, 'eq', 'id', 5)).toBe(true);
    });

    it('an unrestricted unit is open without loading the viewer', async () => {
        db.on('units', { data: { id: 5, is_restricted: false } });
        await assertUnitAccess(5, 9);
        expect(db.q('users')).toHaveLength(0);
    });

    it('restricted: members and units:view_all holders pass; everyone else is refused', async () => {
        db.on('units', { data: { id: 5, is_restricted: true } });
        db.once('users', viewer(5, []));
        await expect(assertUnitAccess(5, 9)).resolves.toBeUndefined();
        const [uq] = db.q('users');
        expect(arg0(uq, 'select')).toBe('unit_id, role:roles(role_permissions(permission:permissions(name)))');
        expect(has(uq, 'eq', 'id', 9)).toBe(true);
        db.once('users', viewer(6, [null, 'units:view_all']));
        await expect(assertUnitAccess(5, 9)).resolves.toBeUndefined();
        db.once('users', viewer(6, ['user:view:roster', null]));
        expect(await codeOf(assertUnitAccess(5, 9))).toEqual({ code: 'UNIT_RESTRICTED', message: 'This unit is restricted to its members.' });
        db.once('users', { data: null });
        expect((await codeOf(assertUnitAccess(5, 9)))?.code).toBe('UNIT_RESTRICTED');
    });
});

describe('unit feed', () => {
    it('getUnitFeed embeds ONLY roster-public author columns, newest first, capped at 50', async () => {
        db.on('unit_posts', { data: [{ id: 'p1', unit_id: 5, author_id: 9, content: 'hi', created_at: 't', pinned: false, author: null }] });
        const out = await getUnitFeed(5);
        const [q] = db.q('unit_posts');
        expect(arg0(q, 'select')).toBe(AUTHOR_EMBED);
        expect(String(arg0(q, 'select'))).not.toMatch(/probation|tenure|job_title|timezone|rsi_verified/);
        expect(has(q, 'eq', 'unit_id', 5)).toBe(true);
        expect(has(q, 'order', 'created_at', { ascending: false })).toBe(true);
        expect(has(q, 'order', 'id', { ascending: false })).toBe(true);
        expect(has(q, 'limit', 50)).toBe(true);
        expect(out).toEqual([{ id: 'p1', unitId: 5, authorId: 9, content: 'hi', createdAt: 't', pinned: false, author: undefined }]);
    });

    it('getUnitFeed with no rows is []', async () => {
        expect(await getUnitFeed(5)).toEqual([]);
    });

    it('createUnitPost inserts and returns the mapped post with the same narrow embed', async () => {
        db.on('unit_posts', { data: { id: 'p2', unit_id: 5, author_id: 9, content: 'yo', created_at: 't', pinned: false, author: null } });
        const out = await createUnitPost(5, 9, 'yo');
        const [q] = db.q('unit_posts');
        expect(arg0(q, 'insert')).toEqual({ unit_id: 5, author_id: 9, content: 'yo' });
        expect(arg0(q, 'select')).toBe(AUTHOR_EMBED);
        expect(out).toEqual(expect.objectContaining({ id: 'p2', unitId: 5, authorId: 9, content: 'yo' }));
    });

    it('createUnitPost: a fault or an empty return throws', async () => {
        db.once('unit_posts', { error: { message: 'x' } });
        await expect(createUnitPost(5, 9, 'x')).rejects.toThrow('Failed to post');
        db.once('unit_posts', { data: null });
        await expect(createUnitPost(5, 9, 'x')).rejects.toThrow('Failed to post');
    });

    it('deleteUnitPost authorises against the POST\'s own unit: author, leader, moderator; others refused', async () => {
        const post = { data: { unit_id: 5, author_id: 9 } };
        const deletes = () => db.q('unit_posts').filter((q) => has(q, 'delete'));
        // already gone ⇒ silent no-op
        await deleteUnitPost('p0', { id: 9 });
        expect(deletes()).toHaveLength(0);
        // author
        db.once('unit_posts', post);
        await deleteUnitPost('p1', { id: 9 });
        expect(db.q('units')).toHaveLength(0);
        // unit leader of the post's unit
        db.once('unit_posts', post);
        db.once('units', { data: { leader_id: 11 } });
        await deleteUnitPost('p1', { id: 11 });
        expect(has(db.q('units')[0], 'eq', 'id', 5)).toBe(true);
        // moderator
        db.once('unit_posts', post);
        db.once('units', { data: { leader_id: 1 } });
        await deleteUnitPost('p1', { id: 12, permissions: ['units:view_all'] });
        expect(deletes()).toHaveLength(3);
        expect(has(deletes()[0], 'eq', 'id', 'p1')).toBe(true);
        // stranger, and an anonymous actor
        db.once('unit_posts', post);
        db.once('units', { data: { leader_id: 11 } }); // someone ELSE leads the post's unit
        await expect(deleteUnitPost('p1', { id: 13, permissions: [] })).rejects.toThrow('You are not authorized to delete this post.');
        db.once('unit_posts', post);
        db.once('units', { data: null });
        await expect(deleteUnitPost('p1', { id: 13 })).rejects.toThrow('You are not authorized to delete this post.');
        db.once('unit_posts', post);
        await expect(deleteUnitPost('p1')).rejects.toThrow('You are not authorized to delete this post.');
        expect(deletes()).toHaveLength(3);
    });

    it('deleteUnitPost surfaces a delete fault', async () => {
        db.on('unit_posts', { data: { unit_id: null, author_id: 9 } }, (q) => has(q, 'maybeSingle'));
        db.on('unit_posts', { error: { message: 'x' } }, (q) => has(q, 'delete'));
        await expect(deleteUnitPost('p1', { id: 9 })).rejects.toThrow('Failed to delete post');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ranks, specialisations, certifications, commendations — catalog writers', () => {
    it('rank icons accept a shipped local path or https image; anything else is stored null', async () => {
        await addRank({ name: 'Ensign', iconUrl: '/media/rank-1.png', sortOrder: 1 });
        await updateRank({ id: 2, name: 'Lt', iconUrl: 'javascript:alert(1)', sortOrder: 2 });
        await deleteRank(2);
        await addRank({ name: 'Spy', iconUrl: 'https://tracker.example/pixel.php' });
        const [a, u, d, a2] = db.q('ranks');
        expect(arg0(a2, 'insert')).toEqual({ name: 'Spy', icon_url: null, sort_order: undefined });
        expect(arg0(a, 'insert')).toEqual({ name: 'Ensign', icon_url: '/media/rank-1.png', sort_order: 1 });
        expect(arg0(u, 'update')).toEqual({ name: 'Lt', icon_url: null, sort_order: 2 });
        expect(has(u, 'eq', 'id', 2)).toBe(true);
        expect(has(d, 'delete')).toBe(true);
        expect(has(d, 'eq', 'id', 2)).toBe(true);
    });

    it.each([
        ['specialization_tags', addSpecializationTag, updateSpecializationTag, deleteSpecializationTag],
        ['certifications', addCertification, updateCertification, deleteCertification],
        ['commendations', addCommendation, updateCommendation, deleteCommendation],
    ] as const)('%s: image_url is sanitised (https image only) on insert and update', async (table, add, update, del) => {
        await add({ name: 'N', description: 'D', icon: 'star', imageUrl: SAFE_IMG });
        await update({ id: 3, name: 'N2', description: 'D2', icon: 'moon', imageUrl: '/media/local.png' });
        await del(3);
        const [a, u, d] = db.q(table);
        expect(arg0(a, 'insert')).toEqual({ name: 'N', description: 'D', icon: 'star', image_url: SAFE_IMG });
        // the strict variant: a local path is NOT accepted for these
        expect(arg0(u, 'update')).toEqual({ name: 'N2', description: 'D2', icon: 'moon', image_url: null });
        expect(has(u, 'eq', 'id', 3)).toBe(true);
        expect(has(d, 'delete')).toBe(true);
        expect(has(d, 'eq', 'id', 3)).toBe(true);
    });

    it('awardCertification upserts idempotently and nudges the recipient by id', async () => {
        await awardCertification(9, 4, 1);
        const [q] = db.q('user_certifications');
        expect(q.ops[0]).toEqual(['upsert', [{ user_id: 9, certification_id: 4, awarded_by: 1 }, { onConflict: 'user_id,certification_id', ignoreDuplicates: true }]]);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('user_update', { userId: 9 });
    });

    it('awardCertification surfaces a fault without a nudge', async () => {
        db.on('user_certifications', { error: { message: 'x' } });
        await expect(awardCertification(9, 4, 1)).rejects.toThrow('Failed to award certification');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('revokeCertification deletes the exact pair and nudges by id', async () => {
        await revokeCertification(9, 4);
        const [q] = db.q('user_certifications');
        expect(has(q, 'delete')).toBe(true);
        expect(has(q, 'eq', 'user_id', 9)).toBe(true);
        expect(has(q, 'eq', 'certification_id', 4)).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('user_update', { userId: 9 });
    });

    it('awardCommendation inserts with reason and nudges by id', async () => {
        await awardCommendation(9, 2, 'Valour', 1);
        expect(arg0(db.q('user_commendations')[0], 'insert')).toEqual({ user_id: 9, commendation_id: 2, reason: 'Valour', awarded_by: 1 });
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('user_update', { userId: 9 });
    });

    it('revokeCommendation resolves the recipient first; an unknown row nudges broadly', async () => {
        db.once('user_commendations', { data: { user_id: 9 } });
        await revokeCommendation(30);
        const [sel, del] = db.q('user_commendations');
        expect(arg0(sel, 'select')).toBe('user_id');
        expect(has(sel, 'eq', 'id', 30)).toBe(true);
        expect(has(del, 'delete')).toBe(true);
        expect(has(del, 'eq', 'id', 30)).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenLastCalledWith('user_update', { userId: 9 });
        await revokeCommendation(31);
        expect(mocks.broadcastToOrg).toHaveBeenLastCalledWith('user_update', {});
    });
});

describe.each([
    ['certification', 'certifications', 'user_certifications', (ids: number[]) => bulkAwardCertification(ids, 4, 1)],
    ['commendation', 'commendations', 'user_commendations', (ids: number[]) => bulkAwardCommendation(ids, 4, 'Team effort', 1)],
] as const)('bulk award — %s', (kind, catalog, junction, run) => {
    const fname = kind === 'certification' ? 'bulkAwardCertification' : 'bulkAwardCommendation';

    it('an empty or non-array target list is a no-op', async () => {
        expect(await run([])).toEqual({ updated: 0, total: 0, skipped: 0 });
        expect(await run(null as unknown as number[])).toEqual({ updated: 0, total: 0, skipped: 0 });
        expect(db.queries).toHaveLength(0);
    });

    it('refuses more than 100 targets per call', async () => {
        await expect(run(Array.from({ length: 101 }, (_, i) => i + 1))).rejects.toThrow(`${fname}: bulk action capped at 100 users per call (got 101).`);
        expect(db.queries).toHaveLength(0);
    });

    it(`refuses an unknown ${kind}`, async () => {
        await expect(run([1])).rejects.toThrow(`${fname}: ${kind} not found`);
        const [q] = db.q(catalog);
        expect(arg0(q, 'select')).toBe('id');
        expect(has(q, 'eq', 'id', 4)).toBe(true);
        expect(db.q(junction)).toHaveLength(0);
    });

    it('awards existing users, skips missing/failed/throwing ones, and broadcasts only awarded ids', async () => {
        db.on(catalog, { data: { id: 4 } });
        const userIs = (id: number) => (q: Q) => has(q, 'eq', 'id', id);
        db.on('users', { data: { id: 1 } }, userIs(1));
        db.on('users', { data: null }, userIs(2));
        db.on('users', { data: { id: 3 } }, userIs(3));
        db.on('users', () => { throw new Error('socket'); }, userIs(4));
        db.on('users', { data: { id: 5 } }, userIs(5));
        db.on(junction, { error: { message: 'dup' } }, (q) => JSON.stringify(q.ops).includes('"user_id":3'));
        const out = await run([1, 2, 3, 4, 5]);
        expect(out).toEqual({ updated: 2, total: 5, skipped: 3 });
        expect(db.q(junction)).toHaveLength(3);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('user_update', { bulk: true, count: 2, userIds: [1, 5] });
        expect(logSpy.warn).toHaveBeenCalledWith(`${fname} skipped user`, expect.objectContaining({ userId: 4 }));
        const first = db.q(junction)[0];
        if (kind === 'certification') {
            expect(first.ops[0]).toEqual(['upsert', [{ user_id: 1, certification_id: 4, awarded_by: 1 }, { onConflict: 'user_id,certification_id', ignoreDuplicates: true }]]);
        } else {
            expect(arg0(first, 'insert')).toEqual({ user_id: 1, commendation_id: 4, reason: 'Team effort', awarded_by: 1 });
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('achievement catalog import', () => {
    it('rejects an unknown kind and a non-array payload', async () => {
        await expect(previewAchievementImport('ships' as never, [])).rejects.toThrow('Unknown achievement kind: ships');
        await expect(previewAchievementImport('certifications', 'x' as never)).rejects.toThrow('items must be an array.');
        await expect(bulkUpsertAchievements('ships' as never, [], 0, 10)).rejects.toThrow('Unknown achievement kind: ships');
        await expect(bulkUpsertAchievements('commendations', {} as never, 0, 10)).rejects.toThrow('items must be an array.');
        expect(db.queries).toHaveLength(0);
    });

    it('preview: all-invalid input reports per-row reasons without a DB read', async () => {
        const out = await previewAchievementImport('specializations', [null, { name: '   ' }, { name: 5 }, 'str']);
        expect(out).toEqual({ newCount: 0, updateCount: 0, skipCount: 0, conflicts: [], total: 4, invalid: [
            { index: 0, name: undefined, reason: 'Missing or invalid name.' },
            { index: 1, name: '   ', reason: 'Missing or invalid name.' },
            { index: 2, name: undefined, reason: 'Missing or invalid name.' },
            { index: 3, name: undefined, reason: 'Missing or invalid name.' },
        ] });
        expect(db.queries).toHaveLength(0);
    });

    it('preview: classifies new / unchanged / changed by case-insensitive name and diffs sanitised images', async () => {
        db.on('certifications', { data: [
            { name: 'Pilot', description: 'Flies', icon: 'plane', image_url: SAFE_IMG },
            { name: 'medic', description: null, icon: null, image_url: null },
        ] });
        const out = await previewAchievementImport('certifications', [
            { name: ' Pilot ', description: 'Flies', icon: 'plane', imageUrl: SAFE_IMG }, // unchanged
            { name: 'Medic', description: 42, icon: 'cross', imageUrl: 'javascript:x' },  // changed (image sanitises to null ⇒ no diff)
            { name: 'Gunner' },                                                           // new
            { name: 'PILOT' },                                                            // duplicate within file
        ]);
        const [q] = db.q('certifications');
        expect(arg0(q, 'select')).toBe('name, description, icon, image_url');
        expect(has(q, 'in', 'name', ['Pilot', 'Medic', 'Gunner'])).toBe(true);
        expect(out.newCount).toBe(1);
        expect(out.skipCount).toBe(1);
        expect(out.updateCount).toBe(1);
        expect(out.conflicts).toEqual([{ name: 'Medic', changes: {
            description: { from: null, to: '42' },
            icon: { from: null, to: 'cross' },
        } }]);
        expect(out.invalid).toEqual([{ index: 3, name: 'PILOT', reason: 'Duplicate name within import file.' }]);
        expect(out.total).toBe(4);
    });

    it('preview: an image change is reported against the sanitised value', async () => {
        db.on('commendations', { data: [{ name: 'Star', description: 'd', icon: 'i', image_url: null }] });
        const out = await previewAchievementImport('commendations', [{ name: 'Star', description: 'd', icon: 'i', imageUrl: SAFE_IMG }]);
        expect(out.conflicts).toEqual([{ name: 'Star', changes: { imageUrl: { from: null, to: SAFE_IMG } } }]);
    });

    it('preview: non-string fields are stringified, a sparse stored row diffs against null, a null read is "all new"', async () => {
        db.once('specialization_tags', { data: [{ name: 'Scout' }] });
        const out = await previewAchievementImport('specializations', [{ name: 'Scout', description: null, icon: 7, imageUrl: 123 }]);
        expect(out.conflicts).toEqual([{ name: 'Scout', changes: { icon: { from: null, to: '7' } } }]);
        db.once('specialization_tags', { data: null });
        const fresh = await previewAchievementImport('specializations', [{ name: 'Scout' }, { name: 'Sniper' }]);
        expect(fresh).toEqual(expect.objectContaining({ newCount: 2, updateCount: 0, skipCount: 0 }));
    });

    it('preview: a read fault throws the kind-specific message', async () => {
        db.on('specialization_tags', { error: { message: 'x' } });
        await expect(previewAchievementImport('specializations', [{ name: 'Scout' }])).rejects.toThrow('Failed to load existing specializations for import preview');
    });

    it('upsert: inserts new names, updates changed ones by id, skips unchanged, reports per-row faults', async () => {
        db.on('certifications', { data: [
            { id: 1, name: 'Pilot', description: 'old', icon: 'plane', image_url: null },
            { id: 2, name: 'Medic', description: 'd', icon: 'i', image_url: null },
            { id: 3, name: 'Broken', description: 'old', icon: null, image_url: null },
        ] }, (q) => has(q, 'select'));
        db.on('certifications', { error: { message: 'insert denied' } }, (q) => (arg0(q, 'insert') as { name?: string } | undefined)?.name === 'Bad');
        db.on('certifications', { error: { message: 'update denied' } }, (q) => has(q, 'update') && has(q, 'eq', 'id', 3));
        const items = [
            { name: 'Pilot', description: 'new', icon: 'plane', imageUrl: SAFE_IMG },
            { name: 'Medic', description: 'd', icon: 'i' },
            { name: 'Gunner', imageUrl: 'http://insecure/x.png' },
            { name: 'Bad' },
            { name: 'Broken', description: 'new' },
            { bogus: true },
        ];
        const out = await bulkUpsertAchievements('certifications', items, 0, 50);
        const lookup = db.q('certifications').find((q) => has(q, 'select'))!;
        expect(arg0(lookup, 'select')).toBe('id, name, description, icon, image_url');
        expect(has(lookup, 'in', 'name', ['Pilot', 'Medic', 'Gunner', 'Bad', 'Broken'])).toBe(true);
        const upd = db.q('certifications').filter((q) => has(q, 'update'));
        expect(arg0(upd[0], 'update')).toEqual({ description: 'new', icon: 'plane', image_url: SAFE_IMG });
        expect(has(upd[0], 'eq', 'id', 1)).toBe(true);
        const ins = db.q('certifications').filter((q) => has(q, 'insert'));
        expect(arg0(ins[0], 'insert')).toEqual({ name: 'Gunner', description: null, icon: null, image_url: null });
        expect(out).toEqual({
            processed: 6, total: 6, nextOffset: null, inserted: 1, updated: 1,
            errors: [
                { index: 5, name: undefined, reason: 'Missing or invalid name.' },
                { index: 3, name: 'Bad', reason: 'insert denied' },
                { index: 4, name: 'Broken', reason: 'update denied' },
            ],
        });
    });

    it('upsert: clamps limit/offset and reports the next offset while rows remain', async () => {
        const items = Array.from({ length: 150 }, (_, i) => ({ name: `n${i}` }));
        const first = await bulkUpsertAchievements('commendations', items, -4, 1000);
        expect(first.processed).toBe(MAX_IMPORT_BATCH_SIZE);
        expect(first.nextOffset).toBe(100);
        expect(first.inserted).toBe(100);
        const tiny = await bulkUpsertAchievements('commendations', items, Number.NaN, -9);
        expect(tiny.processed).toBe(1);
        expect(tiny.nextOffset).toBe(1);
        const dflt = await bulkUpsertAchievements('commendations', items, 140, 0);
        expect(dflt.processed).toBe(10);
        expect(dflt.nextOffset).toBeNull();
    });

    it('upsert: a failed lookup fails every row in the slice individually and writes nothing', async () => {
        db.on('specialization_tags', { error: { message: 'lookup timeout' } });
        const out = await bulkUpsertAchievements('specializations', [{ name: 'A' }, { name: 'B' }, { name: 'C' }], 0, 2);
        expect(out).toEqual({
            processed: 2, total: 3, nextOffset: 2, inserted: 0, updated: 0,
            errors: [{ index: 0, name: 'A', reason: 'lookup timeout' }, { index: 1, name: 'B', reason: 'lookup timeout' }],
        });
        const last = await bulkUpsertAchievements('specializations', [{ name: 'A' }], 0, 5);
        expect(last.nextOffset).toBeNull();
        expect(db.q('specialization_tags').some((q) => has(q, 'insert') || has(q, 'update'))).toBe(false);
    });

    it('upsert: a blank string name is reported with the name it carried', async () => {
        const out = await bulkUpsertAchievements('certifications', [{ name: '   ' }], 0, 10);
        expect(out.errors).toEqual([{ index: 0, name: '   ', reason: 'Missing or invalid name.' }]);
    });

    it('upsert: a null lookup payload treats every row as new', async () => {
        db.on('certifications', { data: null }, (q) => has(q, 'select'));
        const out = await bulkUpsertAchievements('certifications', [{ name: 'A' }], 0, 10);
        expect(out.inserted).toBe(1);
    });

    it('upsert: an all-invalid slice skips the lookup', async () => {
        const out = await bulkUpsertAchievements('certifications', [{}, null], 0, 10);
        expect(out.errors).toHaveLength(2);
        expect(db.queries).toHaveLength(0);
    });

    it('upsert: a thrown write is captured per row, with a fallback reason', async () => {
        db.on('commendations', { data: [] }, (q) => has(q, 'select'));
        db.on('commendations', () => { throw new Error('socket closed'); }, (q) => (arg0(q, 'insert') as { name?: string } | undefined)?.name === 'A');
        db.on('commendations', () => { throw new Error(''); }, (q) => (arg0(q, 'insert') as { name?: string } | undefined)?.name === 'B');
        db.on('commendations', () => { throw 'string-thrown'; }, (q) => (arg0(q, 'insert') as { name?: string } | undefined)?.name === 'C');
        const out = await bulkUpsertAchievements('commendations', [{ name: 'A' }, { name: 'B' }, { name: 'C' }], 0, 10);
        expect(out.errors).toEqual([
            { index: 0, name: 'A', reason: 'socket closed' },
            { index: 1, name: 'B', reason: 'Unknown error.' },
            { index: 2, name: 'C', reason: 'Unknown error.' },
        ]);
        expect(out.inserted).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('conduct records & Discord rank mappings', () => {
    it('addConductEntry refuses an unknown user and records the entering admin otherwise', async () => {
        await expect(addConductEntry(9, 'warning', 'r', 1)).rejects.toThrow('User not found');
        expect(db.q('conduct_records')).toHaveLength(0);
        db.on('users', { data: { id: 9 } });
        await addConductEntry(9, 'warning', 'Late to muster', 1);
        expect(arg0(db.q('users')[0], 'select')).toBe('id');
        expect(arg0(db.q('conduct_records')[0], 'insert')).toEqual({ user_id: 9, type: 'warning', reason: 'Late to muster', entered_by_id: 1 });
    });

    it('deleteConductEntry deletes by id', async () => {
        await deleteConductEntry(12);
        const [q] = db.q('conduct_records');
        expect(has(q, 'delete')).toBe(true);
        expect(has(q, 'eq', 'id', 12)).toBe(true);
    });

    it('updateRankMapping: clearing both deletes the mapping; otherwise upserts parsed ids; always an empty nudge', async () => {
        await updateRankMapping('111', 0, undefined);
        const [del] = db.q('rank_mappings');
        expect(has(del, 'delete')).toBe(true);
        expect(has(del, 'eq', 'discord_role_id', '111')).toBe(true);
        await updateRankMapping('222', '3');
        await updateRankMapping('333', '', 4);
        const [, up1, up2] = db.q('rank_mappings');
        expect(up1.ops[0]).toEqual(['upsert', [{ discord_role_id: '222', rank_id: 3, role_id: null }, { onConflict: 'discord_role_id' }]]);
        expect(arg0(up2, 'upsert')).toEqual({ discord_role_id: '333', rank_id: null, role_id: 4 });
        expect(mocks.broadcastToOrg).toHaveBeenCalledTimes(3);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('discord_config_update', {});
    });
});

describe('external tools', () => {
    it('addExternalTool trims the category, defaults sort order, and nudges', async () => {
        await addExternalTool({ title: 'Erkul', description: 'd', url: 'https://erkul.games', icon: 'i', audience: ['Member'], category: '  Loadouts ', sortOrder: 3 });
        await addExternalTool({ title: 'X', category: '   ' });
        const [a, b] = db.q('external_tools');
        expect(arg0(a, 'insert')).toEqual({ title: 'Erkul', description: 'd', url: 'https://erkul.games', icon: 'i', audience: ['Member'], category: 'Loadouts', sort_order: 3 });
        expect(arg0(b, 'insert')).toEqual(expect.objectContaining({ category: null, sort_order: 0 }));
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('external_tools_update', {});
    });

    it('addExternalTool retries without category/sort_order on 42703; other faults propagate raw', async () => {
        db.once('external_tools', { error: { code: '42703' } });
        await addExternalTool({ title: 'T', category: 'C' });
        const [, retry] = db.q('external_tools');
        expect(arg0(retry, 'insert')).not.toHaveProperty('category');
        expect(arg0(retry, 'insert')).not.toHaveProperty('sort_order');
        resetHarness();
        const fault = { code: '23505', message: 'dup' };
        db.on('external_tools', { error: fault });
        await expect(addExternalTool({ title: 'T' })).rejects.toBe(fault);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('updateExternalTool defaults a non-numeric sort order to 0 and keeps a trimmed category', async () => {
        await updateExternalTool({ id: 6, title: 'T', category: ' Mining ', sortOrder: '3' as unknown as number });
        expect(arg0(db.q('external_tools')[0], 'update')).toEqual(expect.objectContaining({ category: 'Mining', sort_order: 0 }));
    });

    it('updateExternalTool / reorderExternalTool scope by id with the same retry', async () => {
        await updateExternalTool({ id: 5, title: 'T', sortOrder: 2 });
        const [u] = db.q('external_tools');
        expect(arg0(u, 'update')).toEqual(expect.objectContaining({ title: 'T', sort_order: 2, category: null }));
        expect(has(u, 'eq', 'id', 5)).toBe(true);
        db.once('external_tools', { error: { code: '42703' } });
        await reorderExternalTool(5, 9);
        const [, first, retry] = db.q('external_tools');
        expect(arg0(first, 'update')).toEqual({ sort_order: 9 });
        expect(arg0(retry, 'update')).toEqual({});
        expect(has(retry, 'eq', 'id', 5)).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledTimes(2);
        resetHarness();
        db.on('external_tools', { error: { code: '42703' } });
        await expect(reorderExternalTool(5, 1)).rejects.toEqual({ code: '42703' });
    });

    it('deleteExternalTool deletes by id and nudges', async () => {
        await deleteExternalTool(5);
        const [q] = db.q('external_tools');
        expect(has(q, 'delete')).toBe(true);
        expect(has(q, 'eq', 'id', 5)).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('external_tools_update', {});
    });
});
