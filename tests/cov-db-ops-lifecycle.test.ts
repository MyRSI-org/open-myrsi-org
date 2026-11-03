import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/ops.ts — the WRITE side of an operation's lifecycle: create (with its
// schema-drift retries and rollback-on-reject paths), edit, status, delete,
// membership, money (cost / payout / UEC) and readiness.
//
// The join-PIN path is pinned in tests/joinPinLockout.test.ts and the RPC/ownership
// basics in tests/opsShipOwnership.test.ts; this suite extends around them (RPC
// fault handling, the fallback capacity check, the audit log) rather than repeating.

vi.mock('../lib/db/common', async () => (await import('./cov-db-ops-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-ops-fake')).logMock);
vi.mock('../lib/db/operations-federation', async () => (await import('./cov-db-ops-fake')).fed);
vi.mock('../lib/push', async () => ({ sendPushToUsers: (await import('./cov-db-ops-fake')).collab.sendPushToUsers }));
vi.mock('../lib/db/users', async () => {
    const f = await import('./cov-db-ops-fake');
    return { getUserById: f.collab.getUserById, getActorLabel: f.collab.getActorLabel };
});
vi.mock('../lib/db/notifications', async () => ({ createNotification: (await import('./cov-db-ops-fake')).collab.createNotification }));
vi.mock('../lib/db/securityEvents', async () => ({ recordSecurityEvent: (await import('./cov-db-ops-fake')).collab.recordSecurityEvent }));

import {
    fake, resetFake, resetCollaborators, on, onRpc, route, fed, collab, queriesOn, writesOn, readsOn, argsOf, cols, eqs,
    payload, warnings, opUpdates, newOpId, flush,
} from './cov-db-ops-fake';
import {
    createOperation, deleteOperation, updateOperationDetails, updateOperationStatus, joinOperation,
    notifyOperationAssignee, leaveOperation, notifyOperationRemoval, addOperationParticipant,
    updateOperationParticipant, logOperationEntry, addOperationCost, setOperationPayoutMode,
    setOperationPayoutSplits, toggleParticipantPayoutPaid, addOperationUec, toggleParticipantReady,
    updateParticipantLiveStatus, resetOperationReadiness, rsvpOperation, createOperationReminders, updateLiveStatus,
} from '../lib/db/ops';
import { JOIN_PIN_MAX_FAILURES } from '../lib/joinPinLockout';

const MANAGER = { id: 20, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['operations:manage'] };
const CREATOR = { id: 7, clearanceLevel: { level: 2 }, limitingMarkers: [{ id: 3 }], permissions: ['operations:create'] };

const createdRow = (over: Record<string, unknown> = {}) => ({
    id: 'new-op', name: 'Op', owner_id: 7, status: 'Planning', type: 'Combat', description: 'd',
    tracks_uec: false, total_uec: 0, total_costs: null, payout_mode: null, created_at: 'c', updated_at: 'u',
    active_start_time: null, active_end_time: null, is_special: false, join_code: null, clearance_level: 0,
    is_training: false, max_participants: null, unit_id: null, is_joint: false, roe: null,
    commander_notes: null, comms_plan: null, live_status: null, ...over,
});

/** Queue the verifyOperationAccess existence read for `id`. */
const grantAccess = () => on('operations', { data: { is_joint: false } });

const logEntries = () => writesOn('operation_log_entries', 'insert').map((q) => payload(q) as Record<string, unknown>);

beforeEach(() => {
    resetFake();
    resetCollaborators();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('createOperation — validation and the row payload', () => {
    it('refuses without an owner, before any write', async () => {
        await expect(createOperation({ name: 'x' })).rejects.toThrow('Cannot create operation: Missing Owner ID');
        expect(fake.queries).toHaveLength(0);
    });

    it('operations:create is not a clearance bypass: classifying above the creator refuses with no write', async () => {
        await expect(createOperation({ userId: 7, user: CREATOR, clearanceLevel: 3 })).rejects.toThrow('You cannot classify content above your own clearance level.');
        await expect(createOperation({ userId: 7, user: CREATOR, clearanceLevel: 1, markerIds: [9] })).rejects.toThrow('You cannot apply a limiting marker you do not hold.');
        expect(fake.queries).toHaveLength(0);
    });

    it('writes a sanitised, normalised row owned by the forced actor', async () => {
        on('operations', { data: createdRow() });
        await createOperation({
            userId: 7, ownerId: 999, user: CREATOR,
            name: 'Op', type: 'Combat', description: '<b onclick="x()">Brief</b>', tracksUec: true,
            clearanceLevel: 2, isScheduled: true, unitId: 0, isTraining: undefined, maxParticipants: 12,
            locationText: '  Crusader  ', additionalLocationTexts: [' Yela ', '', 5, '  '],
            scheduledStart: '2026-05-01T10:00:00Z', scheduledEnd: '', isJoint: false, roe: '', commanderNotes: 'n',
            templateId: null, postDiscordAnnouncement: true, discordAnnouncementChannelId: ' 123456789012345678 ',
            discordStartNotice: 1,
        });
        const ins = payload(writesOn('operations', 'insert')[0]) as Record<string, unknown>;
        expect(ins).toEqual({
            name: 'Op', type: 'Combat', description: 'Brief', tracks_uec: true, owner_id: 7,
            is_special: undefined, join_code: null, clearance_level: 2, status: 'Scheduled', unit_id: null,
            is_training: false, max_participants: 12, location_id: null, location_text: 'Crusader',
            additional_location_texts: ['Yela'], scheduled_start: '2026-05-01T10:00:00Z', scheduled_end: null,
            is_joint: false, roe: null, commander_notes: 'n', template_id: null,
            discord_announcement_channel_id: '123456789012345678', discord_start_notice: true,
        });
        expect(cols(writesOn('operations', 'insert')[0])).not.toMatch(/\*/);
    });

    it('drops a junk announcement channel id to null, and stores none unless announcing', async () => {
        on('operations', { data: createdRow() });
        await createOperation({ userId: 7, postDiscordAnnouncement: true, discordAnnouncementChannelId: 'not-a-snowflake', locationText: '   ', additionalLocationTexts: 'x' });
        const a = payload(writesOn('operations', 'insert')[0]) as Record<string, unknown>;
        expect(a.discord_announcement_channel_id).toBeNull();
        expect(a.location_text).toBeNull();
        expect(a.additional_location_texts).toEqual([]);
        expect(a.status).toBe('Planning');
        expect(a.discord_start_notice).toBe(false);

        resetFake();
        on('operations', { data: createdRow() });
        await createOperation({ userId: 7, postDiscordAnnouncement: false, discordAnnouncementChannelId: '123456789012345678' });
        expect((payload(writesOn('operations', 'insert')[0]) as Record<string, unknown>).discord_announcement_channel_id).toBeNull();
    });

    it('seeds the owner as the Command participant, logs CREATE and emits one id-only update', async () => {
        on('operations', { data: createdRow() });
        await createOperation({ userId: 7, name: 'Op' });
        const part = payload(writesOn('operation_participants', 'insert')[0]);
        expect(part).toEqual({ operation_id: 'new-op', user_id: 7, is_ready: false, role_requested: 'Command', attendance_status: 'Registered' });
        expect(logEntries()).toEqual([{ operation_id: 'new-op', entry_type: 'CREATE', log_entry: 'Operation channel established.', author_id: 7, uec_amount: undefined }]);
        expect(opUpdates()).toEqual([{ operationId: 'new-op' }]);
        // No markers / locations requested → no such writes.
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(queriesOn('operation_locations')).toHaveLength(0);
    });

    it('the response is the mapped row with a MINIFIED owner card', async () => {
        on('operations', { data: createdRow({ total_costs: null, payout_mode: null, comms_plan: null }) });
        collab.getUserById.mockResolvedValueOnce({
            id: 7, name: 'Cmdr', avatarUrl: 'av', discordId: 'SECRET-DISCORD', rsiHandle: 'h', role: 'Member', roleId: 2,
            reputation: 0, isDuty: true, permissions: ['admin:all'], adminNotes: 'private', createdAt: 'c',
        });
        const op = await createOperation({ userId: 7 });
        expect(op).toMatchObject({ id: 'new-op', ownerId: 7, totalCosts: 0, payoutMode: 'equal', commsPlan: [], isJoint: false, participants: [], phases: [] });
        expect(op.owner.name).toBe('Cmdr');
        expect(JSON.stringify(op.owner)).not.toContain('SECRET-DISCORD');
        expect(JSON.stringify(op.owner)).not.toContain('private');
        expect(op.owner.permissions ?? []).toEqual([]);
    });

    it('an owner hydrate fault after commit returns a blank fallback owner card, not a failed create', async () => {
        on('operations', { data: createdRow() });
        collab.getUserById.mockRejectedValueOnce(new Error('read fault'));
        const op = await createOperation({ userId: 7 });
        expect(op.owner).toMatchObject({ id: 7, name: 'Commander', discordId: '', permissions: [] });
        expect(warnings(/owner hydrate failed/)).toHaveLength(1);
    });

    it('a final insert fault throws the high-level message; a missing row throws too', async () => {
        on('operations', { error: { code: '23514', message: 'check violation' } });
        await expect(createOperation({ userId: 7 })).rejects.toThrow('Failed to create operation');
        expect(queriesOn('operation_participants')).toHaveLength(0);

        resetFake();
        on('operations', { data: null });
        await expect(createOperation({ userId: 7 })).rejects.toThrow('Failed to create operation: no row returned.');
    });
});

describe('createOperation — schema-drift retries', () => {
    it('22P02 on a Training type retries as Non-Combat with is_training forced on', async () => {
        on('operations', { error: { code: '22P02' } }, { data: createdRow() });
        await createOperation({ userId: 7, type: 'Training' });
        const inserts = writesOn('operations', 'insert').map((q) => payload(q) as Record<string, unknown>);
        expect(inserts).toHaveLength(2);
        expect(inserts[0].type).toBe('Training');
        expect(inserts[1]).toMatchObject({ type: 'Non-Combat', is_training: true });
        expect(warnings(/operation type not supported/)).toHaveLength(1);
    });

    it('22P02 on a Social type retries as Non-Combat but does NOT mark it training', async () => {
        on('operations', { error: { code: '22P02' } }, { data: createdRow() });
        await createOperation({ userId: 7, type: 'Social' });
        const retry = payload(writesOn('operations', 'insert')[1]) as Record<string, unknown>;
        expect(retry).toMatchObject({ type: 'Non-Combat', is_training: false });
    });

    it('22P02 on any other type is not retried', async () => {
        on('operations', { error: { code: '22P02' } });
        await expect(createOperation({ userId: 7, type: 'Combat' })).rejects.toThrow('Failed to create operation');
        expect(writesOn('operations', 'insert')).toHaveLength(1);
    });

    it('missing columns peel off one migration at a time: template_id, then location texts, then the Discord pair', async () => {
        on('operations',
            { error: { code: '42703' } },
            { error: { code: 'PGRST204' } },
            { error: { code: '42703' } },
            { data: createdRow() });
        await createOperation({ userId: 7, templateId: null, postDiscordAnnouncement: false });
        const keys = writesOn('operations', 'insert').map((q) => Object.keys(payload(q) as object));
        expect(keys).toHaveLength(4);
        expect(keys[0]).toEqual(expect.arrayContaining(['template_id', 'location_text', 'additional_location_texts', 'discord_announcement_channel_id', 'discord_start_notice']));
        expect(keys[1]).not.toContain('template_id');
        expect(keys[1]).toContain('location_text');
        expect(keys[2]).not.toContain('location_text');
        expect(keys[2]).not.toContain('additional_location_texts');
        expect(keys[2]).toContain('discord_announcement_channel_id');
        expect(keys[3]).not.toContain('discord_announcement_channel_id');
        expect(keys[3]).not.toContain('discord_start_notice');
        expect(warnings(/template_id unavailable/)).toHaveLength(1);
        expect(warnings(/location_text/)).toHaveLength(1);
        expect(warnings(/discord_announcement_channel_id unavailable/)).toHaveLength(1);
    });

    it('a missing-column fault that survives every retry still throws', async () => {
        on('operations', { error: { code: '42703' } }, { error: { code: '42703' } }, { error: { code: '42703' } }, { error: { code: '42703' } });
        await expect(createOperation({ userId: 7 })).rejects.toThrow('Failed to create operation');
        expect(writesOn('operations', 'insert')).toHaveLength(4);
    });
});

describe('createOperation — markers, joint sharing and rollback', () => {
    it('a Joint op carrying a sync-restricted marker is rolled back and refused with a coded error', async () => {
        on('operations', { data: createdRow() });
        on('security_limiting_markers', { data: [{ id: 3, code: 'NOFORN' }, { id: 4, code: 'ORCON' }] });
        const err = await createOperation({ userId: 20, user: MANAGER, isJoint: true, markerIds: [3, 4] }).catch((e) => e);
        expect(err.message).toBe('Cannot share an operation as a Joint Operation when sync-restricted markers are attached: NOFORN, ORCON.');
        expect(err.code).toBe('SYNC_RESTRICTED_MARKER_BLOCKS_JOINT');
        const probe = readsOn('security_limiting_markers')[0];
        expect(cols(probe)).toBe('id, code');
        expect(argsOf(probe, 'in')).toEqual([['id', [3, 4]]]);
        expect(eqs(probe)).toEqual([['sync_restricted', true]]);
        const del = writesOn('operations', 'delete');
        expect(del).toHaveLength(1);
        expect(eqs(del[0])).toEqual([['id', 'new-op']]);
        expect(queriesOn('operation_participants')).toHaveLength(0);
        expect(opUpdates()).toEqual([]);
    });

    it('a fault reading the sync-restricted flag refuses (fail closed)', async () => {
        on('operations', { data: createdRow() });
        on('security_limiting_markers', { error: { message: 'x' } });
        await expect(createOperation({ userId: 20, user: MANAGER, isJoint: true, markerIds: [3] }))
            .rejects.toThrow('Failed to check limiting markers for joint sharing');
    });

    it('an unknown marker id rolls the op back', async () => {
        on('operations', { data: createdRow() });
        on('security_limiting_markers', { data: [{ id: 3 }] });
        await expect(createOperation({ userId: 20, user: MANAGER, markerIds: [3, 404] }))
            .rejects.toThrow('One or more limiting markers are not valid for this organization.');
        expect(eqs(writesOn('operations', 'delete')[0])).toEqual([['id', 'new-op']]);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
    });

    it('a null marker lookup also rolls back', async () => {
        on('operations', { data: createdRow() });
        on('security_limiting_markers', { data: null });
        await expect(createOperation({ userId: 20, user: MANAGER, markerIds: [3] })).rejects.toThrow('not valid');
    });

    it('valid markers on a joint op (none sync-restricted) are attached through the ATOMIC writer', async () => {
        on('operations', { data: createdRow() });
        on('security_limiting_markers', { data: [] }, { data: [{ id: 3 }, { id: 5 }] });
        await createOperation({ userId: 20, user: MANAGER, isJoint: true, markerIds: [3, 5] });
        // One transactional RPC with the exact args — never a direct table write.
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'new-op', p_marker_ids: [3, 5] } }]);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        // The sync-restricted guard still ran first, and nothing was rolled back.
        expect(eqs(readsOn('security_limiting_markers')[0])).toEqual([['sync_restricted', true]]);
        expect(writesOn('operations', 'delete')).toHaveLength(0);
    });

    it('no markers requested → the atomic writer is never called', async () => {
        on('operations', { data: createdRow() });
        await createOperation({ userId: 7, markerIds: [] });
        expect(fake.rpcs.filter((r) => r.name === 'op_replace_limiting_markers')).toEqual([]);
    });

    it('locations: primary first, additional ids de-duplicated against it', async () => {
        on('operations', { data: createdRow() });
        await createOperation({ userId: 7, locationId: 11, additionalLocationIds: [11, 0, 12, null, 13] });
        expect(payload(writesOn('operation_locations', 'insert')[0])).toEqual([
            { operation_id: 'new-op', location_id: 11, is_primary: true },
            { operation_id: 'new-op', location_id: 12, is_primary: false },
            { operation_id: 'new-op', location_id: 13, is_primary: false },
        ]);
    });

    it('a location insert fault is a soft warning, never a failed create', async () => {
        on('operations', { data: createdRow() });
        on('operation_locations', { error: { message: 'relation does not exist' } });
        await expect(createOperation({ userId: 7, additionalLocationIds: [12] })).resolves.toMatchObject({ id: 'new-op' });
        expect(warnings(/failed to insert operation_locations/)[0].fields).toMatchObject({ message: 'relation does not exist' });
    });
});

describe('createOperation — phase seeding', () => {
    it('inline phases win and are materialised against the new op', async () => {
        on('operations', { data: createdRow() });
        on('operation_phases', { data: { id: 501 } });
        await createOperation({ userId: 7, templateId: 3, inlinePhases: { phases: [{ name: 'Insert' }] } });
        const ph = payload(writesOn('operation_phases', 'insert')[0]) as Record<string, unknown>;
        expect(ph).toMatchObject({ operation_id: 'new-op', name: 'Insert', sort_order: 0, status: 'Pending' });
        // The template path was not taken.
        expect(queriesOn('operation_templates')).toHaveLength(0);
    });

    it('a template id seeds from the template, gated by the creator\'s clearance', async () => {
        on('operations', { data: createdRow() });
        on('operation_templates', { data: { id: 3, name: 'T', payload: { phases: [{ name: 'From template' }] }, classification_level: 0, limiting_marker_ids: [] } });
        on('operation_phases', { data: { id: 600 } });
        await createOperation({ userId: 7, user: CREATOR, templateId: 3 });
        expect(eqs(readsOn('operation_templates')[0])).toEqual([['id', 3]]);
        expect((payload(writesOn('operation_phases', 'insert')[0]) as Record<string, unknown>).name).toBe('From template');
        expect((payload(writesOn('operations', 'insert')[0]) as Record<string, unknown>).template_id).toBe(3);
    });

    it('a seeding fault is swallowed with a warning — the op still exists', async () => {
        on('operations', { data: createdRow() });
        on('operation_templates', { data: { id: 3, name: 'T', payload: { phases: [] }, classification_level: 9, limiting_marker_ids: [] } });
        await expect(createOperation({ userId: 7, user: CREATOR, templateId: 3 })).resolves.toMatchObject({ id: 'new-op' });
        expect(warnings(/phase seeding failed/)).toHaveLength(1);
        expect(queriesOn('operation_phases')).toHaveLength(0);
        expect(logEntries()[0].entry_type).toBe('CREATE');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('deleteOperation', () => {
    it('tells allies to drop their mirror BEFORE the cascade, then deletes by id and emits', async () => {
        const order: string[] = [];
        fed.pushOperationToAllies.mockImplementationOnce(async (_id: string, reason: string) => { order.push(`push:${reason}:${fake.queries.length}`); });
        await deleteOperation('op-1', 1);
        expect(order).toEqual(['push:cancel:0']);
        expect(eqs(writesOn('operations', 'delete')[0])).toEqual([['id', 'op-1']]);
        expect(opUpdates()).toEqual([{ operationId: 'op-1' }]);
    });

    it('an allied-cancel failure does not block the delete; a delete fault throws', async () => {
        fed.pushOperationToAllies.mockRejectedValueOnce(new Error('peer down'));
        on('operations', { error: { message: 'fk' } });
        await expect(deleteOperation('op-1', 1)).rejects.toThrow('Failed to delete operation');
        expect(opUpdates()).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('updateOperationDetails — field mapping and the start-notice re-arm', () => {
    const live = (over: Record<string, unknown> = {}) => ({ data: { id: 'op-1', clearance_level: 0, is_special: false, join_code: null, limiting_markers: [], ...over } });
    const opUpdatesWritten = () => writesOn('operations', 'update').map((q) => payload(q) as Record<string, unknown>);

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('refuses a missing op before any write', async () => {
        on('operations', { data: null });
        await expect(updateOperationDetails('op-1', { name: 'x' }, 1, MANAGER)).rejects.toThrow('Operation not found or access denied.');
        expect(writesOn('operations')).toHaveLength(0);
    });

    it('maps every editable field, sanitising the free text', async () => {
        on('operations', live());
        await updateOperationDetails('op-1', {
            name: 'New', description: '<b>Desc</b>', type: 'Combat', maxParticipants: 8, tracksUec: true,
            isSpecial: false, unitId: 0, locationId: 4, scheduledEnd: '', clearanceLevel: 0, roe: 'weapons free',
            commanderNotes: 'cn', commsPlan: [{ ch: 1 }], liveStatus: 'green', aarSummary: '<i>sum</i>',
            aarLessonsLearned: '<u>ll</u>', discordStartNotice: 0,
        }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({
            name: 'New', description: 'Desc', type: 'Combat', max_participants: 8, tracks_uec: true, is_special: false,
            unit_id: null, location_id: 4, discord_start_notice: false, scheduled_end: null, clearance_level: 0,
            roe: 'weapons free', commander_notes: 'cn', comms_plan: [{ ch: 1 }], live_status: 'green',
            aar_summary: 'sum', aar_lessons_learned: 'll',
        });
        expect(eqs(writesOn('operations', 'update')[0])).toEqual([['id', 'op-1']]);
        expect(logEntries()).toEqual([expect.objectContaining({ entry_type: 'UPDATE', log_entry: 'User#1 updated operation details', author_id: 1 })]);
        expect(opUpdates()).toEqual([{ operationId: 'op-1' }]);
    });

    it('status Active / Concluded stamp the matching time', async () => {
        on('operations', live());
        await updateOperationDetails('op-1', { status: 'Active' }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({ status: 'Active', active_start_time: '2026-06-01T12:00:00.000Z' });
        resetFake();
        on('operations', live());
        await updateOperationDetails('op-1', { status: 'Concluded' }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({ status: 'Concluded', active_end_time: '2026-06-01T12:00:00.000Z' });
        resetFake();
        on('operations', live());
        await updateOperationDetails('op-1', { status: 'Planning' }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({ status: 'Planning' });
    });

    it('a no-op edit returns early: no write, no log, no broadcast', async () => {
        on('operations', live());
        await updateOperationDetails('op-1', {}, 1, MANAGER);
        expect(writesOn('operations')).toHaveLength(0);
        expect(logEntries()).toEqual([]);
        expect(opUpdates()).toEqual([]);
    });

    it('markers are replaced by ONE atomic RPC; an empty list clears the set and still records the edit', async () => {
        on('operations', live());
        await updateOperationDetails('op-1', { markerIds: [3, 4] }, 1, MANAGER);
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'op-1', p_marker_ids: [3, 4] } }]);
        // No delete-then-insert from Node any more: the set is never empty mid-write.
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(opUpdatesWritten()[0]).toEqual({});

        // Clearing is a CHANGE only against a live set that carries markers (an empty
        // live set cleared to empty is a no-op and is not written — see
        // tests/cov3-ops-server-followups.test.ts).
        resetFake();
        on('operations', live({ limiting_markers: [{ marker: { id: 3, name: 'K', code: 'K' } }] }));
        await updateOperationDetails('op-1', { markerIds: [] }, 1, MANAGER);
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'op-1', p_marker_ids: [] } }]);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(logEntries()).toHaveLength(1);
    });

    it('an edit that does not touch markers never calls the marker writer', async () => {
        on('operations', live());
        await updateOperationDetails('op-1', { name: 'x' }, 1, MANAGER);
        expect(fake.rpcs).toEqual([]);
    });

    it('a rescheduled start CLEARS the sent stamp; the same instant spelled differently does not', async () => {
        on('operations', live(), { data: { scheduled_start: '2026-07-01T18:00:00+00:00' } });
        await updateOperationDetails('op-1', { scheduledStart: '2026-07-01T18:00:00Z' }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({ scheduled_start: '2026-07-01T18:00:00Z' });
        const probe = readsOn('operations')[1];
        expect(cols(probe)).toBe('scheduled_start');
        expect(eqs(probe)).toEqual([['id', 'op-1']]);

        resetFake();
        on('operations', live(), { data: { scheduled_start: '2026-07-01T18:00:00Z' } });
        await updateOperationDetails('op-1', { scheduledStart: '2026-07-02T18:00:00Z' }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({ scheduled_start: '2026-07-02T18:00:00Z', discord_start_notice_sent_at: null });

        resetFake();
        on('operations', live(), { data: { scheduled_start: null } });
        await updateOperationDetails('op-1', { scheduledStart: '' }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({ scheduled_start: null });
    });

    it('fails CLOSED when the prior start cannot be read: the claim stays, a warning is logged', async () => {
        on('operations', live(), { error: { code: '08006' } });
        await updateOperationDetails('op-1', { scheduledStart: '2026-07-02T18:00:00Z' }, 1, MANAGER);
        expect(opUpdatesWritten()[0]).toEqual({ scheduled_start: '2026-07-02T18:00:00Z' });
        expect(warnings(/start-notice re-arm skipped/)[0].fields).toMatchObject({ operationId: 'op-1', code: '08006' });
    });

    it('missing start-notice columns: retries without them, keeping the rest of the edit', async () => {
        on('operations', live(), { data: { scheduled_start: null } }, { error: { code: '42703' } }, { data: null });
        await updateOperationDetails('op-1', { name: 'N', scheduledStart: '2026-07-02T18:00:00Z', discordStartNotice: true }, 1, MANAGER);
        const writes = opUpdatesWritten();
        expect(writes).toHaveLength(2);
        expect(writes[1]).toEqual({ name: 'N', scheduled_start: '2026-07-02T18:00:00Z' });
        expect(warnings(/start-notice columns unavailable/)).toHaveLength(1);
        expect(logEntries()).toHaveLength(1);
    });

    it('missing start-notice columns on an edit of ONLY those columns: no second write, still succeeds', async () => {
        on('operations', live(), { error: { code: 'PGRST204' } });
        await updateOperationDetails('op-1', { discordStartNotice: true }, 1, MANAGER);
        expect(opUpdatesWritten()).toHaveLength(1);
        expect(logEntries()).toHaveLength(1);
        expect(opUpdates()).toEqual([{ operationId: 'op-1' }]);
    });

    it('any other update fault throws, with no audit entry and no broadcast', async () => {
        on('operations', live(), { error: { code: '23514' } });
        await expect(updateOperationDetails('op-1', { name: 'N' }, 1, MANAGER)).rejects.toThrow('Failed to update operation');
        expect(logEntries()).toEqual([]);
        expect(opUpdates()).toEqual([]);
    });

    it('a classification edit by a non-manager falls back to the LIVE level for a marker-only change', async () => {
        const holder = { id: 5, clearanceLevel: { level: 2 }, limitingMarkers: [{ id: 3 }], permissions: [] as string[] };
        on('operations', live({ clearance_level: 2 }));
        await updateOperationDetails('op-1', { markerIds: [3] }, 5, holder);
        on('operations', live({ clearance_level: 2 }));
        await expect(updateOperationDetails('op-1', { markerIds: [9] }, 5, holder)).rejects.toThrow('You cannot apply a limiting marker you do not hold.');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('updateOperationStatus', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    });
    afterEach(() => { vi.useRealTimers(); });

    it('Active stamps the start, logs the change and pushes to allies', async () => {
        await updateOperationStatus('op-1', 'Active', 3);
        expect(payload(writesOn('operations', 'update')[0])).toEqual({ status: 'Active', active_start_time: '2026-06-01T12:00:00.000Z' });
        expect(logEntries()).toEqual([expect.objectContaining({ entry_type: 'STATUS_CHANGE', log_entry: 'User#3 changed status to Active' })]);
        expect(queriesOn('operation_participants')).toHaveLength(0);
        expect(opUpdates()).toEqual([{ operationId: 'op-1' }]);
        expect(fed.pushOperationToAllies).toHaveBeenCalledWith('op-1', 'status_change');
    });

    it('Concluded resets every active participant, clears seats, and drops participants off radio', async () => {
        on('operation_participants', { data: null }, { data: [{ user_id: 4 }, { user_id: 5 }] });
        await updateOperationStatus('op-1', 'Concluded', 3);
        expect(payload(writesOn('operations', 'update')[0])).toEqual({ status: 'Concluded', active_end_time: '2026-06-01T12:00:00.000Z', live_status: null });
        const reset = writesOn('operation_participants', 'update')[0];
        expect(payload(reset)).toEqual({ is_ready: false, live_status: null, time_left: '2026-06-01T12:00:00.000Z' });
        expect(eqs(reset)).toEqual([['operation_id', 'op-1']]);
        expect(argsOf(reset, 'is')).toEqual([['time_left', null]]);
        expect(eqs(writesOn('operation_slot_assignments', 'delete')[0])).toEqual([['operation_id', 'op-1']]);
        const radio = writesOn('users', 'update')[0];
        expect(payload(radio)).toEqual({ voice_channel_name: null });
        expect(argsOf(radio, 'in')).toEqual([['id', [4, 5]]]);
        expect(argsOf(radio, 'not')).toEqual([['voice_channel_name', 'is', null]]);
    });

    it('Concluded with nobody on the roster skips the radio write; a seat-clear fault only warns', async () => {
        on('operation_slot_assignments', { error: { message: 'gone' } });
        await updateOperationStatus('op-1', 'Concluded', 3);
        expect(writesOn('users')).toHaveLength(0);
        expect(warnings(/failed to clear seat assignments on conclusion/)[0].fields).toMatchObject({ operationId: 'op-1', message: 'gone' });
    });

    it('a status write fault throws with no audit entry and no reset', async () => {
        on('operations', { error: { message: 'x' } });
        await expect(updateOperationStatus('op-1', 'Concluded', 3)).rejects.toThrow('Failed to update operation status');
        expect(logEntries()).toEqual([]);
        expect(queriesOn('operation_participants')).toHaveLength(0);
    });

    it('an allied status push rejection is swallowed', async () => {
        fed.pushOperationToAllies.mockRejectedValueOnce(new Error('peer down'));
        await expect(updateOperationStatus('op-1', 'Planning', 3)).resolves.toBeUndefined();
        await flush();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('joinOperation — around the PIN: RPC faults, the fallback cap, the audit trail', () => {
    it('a successful join logs JOIN with the joiner label and emits', async () => {
        const op = newOpId();
        grantAccess();
        on('operations', { data: { id: op, is_special: false, join_code: null, max_participants: null } });
        await joinOperation(op, 4, undefined, 'Pilot', 'Gladius', 2);
        expect(fake.rpcs[0]).toEqual({ name: 'op_join_participant', args: {
            p_operation_id: op, p_user_id: 4, p_role_requested: 'Pilot', p_ship_utilized: 'Gladius', p_ship_id: 2, p_user_ship_id: null,
        } });
        expect(logEntries()).toEqual([expect.objectContaining({ entry_type: 'JOIN', log_entry: 'User#4 joined the operation', author_id: 4 })]);
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('any other RPC fault throws and joins nobody', async () => {
        const op = newOpId();
        grantAccess();
        on('operations', { data: { id: op, is_special: false, max_participants: null } });
        onRpc('op_join_participant', { error: { code: '23503', message: 'fk violation' } });
        await expect(joinOperation(op, 4)).rejects.toThrow('Failed to join operation');
        expect(writesOn('operation_participants')).toHaveLength(0);
        expect(logEntries()).toEqual([]);
    });

    it('fallback path (RPC missing): refuses when the head count is already at capacity', async () => {
        const op = newOpId();
        grantAccess();
        on('operations', { data: { id: op, is_special: false, max_participants: 2 } });
        onRpc('op_join_participant', { error: { code: '42883', message: 'function does not exist' } });
        on('operation_participants', { count: 2 });
        await expect(joinOperation(op, 4)).rejects.toThrow('Operation is full.');
        const head = queriesOn('operation_participants')[0];
        expect(argsOf(head, 'select')[0]).toEqual(['user_id', { count: 'exact', head: true }]);
        expect(writesOn('operation_participants', 'upsert')).toHaveLength(0);
    });

    it('fallback path: an upsert fault throws', async () => {
        const op = newOpId();
        grantAccess();
        on('operations', { data: { id: op, is_special: false, max_participants: null } });
        onRpc('op_join_participant', { error: { code: 'PGRST202' } });
        on('operation_participants', { error: { message: 'x' } });
        await expect(joinOperation(op, 4)).rejects.toThrow('Failed to join operation');
        expect(logEntries()).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('assignment / removal notifications — generic bodies, participant precondition', () => {
    it.each([
        ['task', 'New task assignment', 'You have been assigned a task in an operation.'],
        ['command', 'Command role assigned', 'You have been assigned a command position in an operation.'],
        ['seat', 'Seat assigned', 'You have been assigned a seat in an operation.'],
    ] as const)('%s: notifies an existing participant with operation-free copy', async (kind, title, body) => {
        on('operation_participants', { data: { user_id: 4 } });
        await notifyOperationAssignee('op-1', 4, 1, kind);
        expect(collab.createNotification).toHaveBeenCalledWith(4, { type: 'operation_assigned', title, body, link: 'operations', metadata: { operationId: 'op-1' } });
        const q = queriesOn('operation_participants')[0];
        expect(cols(q)).toBe('user_id');
        expect(eqs(q)).toEqual([['operation_id', 'op-1'], ['user_id', 4]]);
    });

    it('never notifies self, a non-integer, zero, or a null assignee — and does not even query', async () => {
        for (const id of [1, 0, -3, 2.5, null, undefined, Number.NaN]) {
            await notifyOperationAssignee('op-1', id as number, 1, 'task');
        }
        expect(fake.queries).toHaveLength(0);
        expect(collab.createNotification).not.toHaveBeenCalled();
    });

    it('a non-participant or a read fault means NO notification (no arbitrary-recipient amplifier)', async () => {
        on('operation_participants', { data: null }, { error: { message: 'x' } });
        await notifyOperationAssignee('op-1', 4, 1, 'task');
        await notifyOperationAssignee('op-1', 4, 1, 'command');
        expect(collab.createNotification).not.toHaveBeenCalled();
    });

    it('a notification fault never fails the write it follows', async () => {
        on('operation_participants', { data: { user_id: 4 } });
        collab.createNotification.mockRejectedValueOnce(new Error('push down'));
        await expect(notifyOperationAssignee('op-1', 4, 1, 'seat')).resolves.toBeUndefined();
    });

    it('removal: notifies the removed member, never self or an invalid id; faults swallowed', async () => {
        await notifyOperationRemoval('op-1', 4, 1);
        expect(collab.createNotification).toHaveBeenCalledWith(4, { type: 'operation_removed', title: 'Removed from an operation', body: 'You were removed from an operation.', link: 'operations', metadata: { operationId: 'op-1' } });
        await notifyOperationRemoval('op-1', 1, 1);
        await notifyOperationRemoval('op-1', 0, 1);
        expect(collab.createNotification).toHaveBeenCalledTimes(1);
        collab.createNotification.mockRejectedValueOnce(new Error('x'));
        await expect(notifyOperationRemoval('op-1', 5, 1)).resolves.toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('leaveOperation', () => {
    it('a real removal returns true, drops the member\'s seats, logs LEAVE and emits', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 4 }] });
        await expect(leaveOperation(op, 4)).resolves.toBe(true);
        const del = writesOn('operation_participants', 'delete')[0];
        expect(eqs(del)).toEqual([['operation_id', op], ['user_id', 4]]);
        expect(argsOf(del, 'select')).toEqual([['user_id']]);
        expect(eqs(writesOn('operation_slot_assignments', 'delete')[0])).toEqual([['operation_id', op], ['user_id', 4]]);
        expect(logEntries()).toEqual([expect.objectContaining({ entry_type: 'LEAVE', log_entry: 'User#4 left the operation' })]);
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('a no-op delete (never a participant) returns false and touches no seats', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: [] });
        await expect(leaveOperation(op, 4)).resolves.toBe(false);
        expect(queriesOn('operation_slot_assignments')).toHaveLength(0);
    });

    it('a seat-clear fault is only a warning — the departure succeeds', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 4 }] });
        on('operation_slot_assignments', { error: { message: 'x' } });
        await expect(leaveOperation(op, 4)).resolves.toBe(true);
        expect(warnings(/failed to clear seat assignments on departure/)[0].fields).toMatchObject({ operationId: op, userId: 4 });
    });

    it('a delete fault throws with no audit entry', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: null, error: { message: 'x' } });
        await expect(leaveOperation(op, 4)).rejects.toThrow('Failed to leave operation');
        expect(logEntries()).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('addOperationParticipant — notify only a genuinely NEW participant', () => {
    it('new member: upsert, audit "<target> added by <admin>", one notification', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: null });
        await addOperationParticipant(op, 4, 1);
        const up = writesOn('operation_participants', 'upsert')[0];
        // time_left: null re-activates a FORMER row on a re-add (tests/cov3-ops-server-followups.test.ts).
        expect(payload(up)).toEqual({ operation_id: op, user_id: 4, attendance_status: 'Registered', time_left: null });
        expect(argsOf(up, 'upsert')[0][1]).toEqual({ onConflict: 'operation_id,user_id', ignoreDuplicates: false });
        expect(logEntries()).toEqual([expect.objectContaining({ entry_type: 'ADD_MEMBER', log_entry: 'User#4 added by User#1', author_id: 1 })]);
        expect(collab.createNotification).toHaveBeenCalledWith(4, expect.objectContaining({ type: 'operation_assigned', title: 'Added to an operation', metadata: { operationId: op } }));
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('re-adding an existing participant does not notify', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: { user_id: 4 } });
        await addOperationParticipant(op, 4, 1);
        expect(collab.createNotification).not.toHaveBeenCalled();
        expect(logEntries()).toHaveLength(1);
    });

    it('a faulted prior read fails closed to "already a participant" (no notify)', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { error: { message: 'x' } });
        await addOperationParticipant(op, 4, 1);
        expect(collab.createNotification).not.toHaveBeenCalled();
    });

    it('adding yourself never notifies', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: null });
        await addOperationParticipant(op, 1, 1);
        expect(collab.createNotification).not.toHaveBeenCalled();
    });

    it('a notification fault is swallowed; an upsert fault throws with no audit', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: null });
        collab.createNotification.mockRejectedValueOnce(new Error('x'));
        await expect(addOperationParticipant(op, 4, 1)).resolves.toBeUndefined();

        const op2 = newOpId();
        resetFake();
        grantAccess();
        on('operation_participants', { data: null }, { error: { message: 'x' } });
        await expect(addOperationParticipant(op2, 4, 1)).rejects.toThrow('Failed to add participant');
        expect(logEntries()).toEqual([]);
    });
});

describe('updateOperationParticipant — field mapping', () => {
    it('maps fields; a non-numeric userShipId clears the binding without an ownership read', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: { user_id: 4 } });
        await updateOperationParticipant(op, 4, { roleRequested: 'Medic', shipUtilized: 'Cutlass', attendanceStatus: 'Attended', shipId: 0, userShipId: 'x' });
        const up = writesOn('operation_participants', 'update')[0];
        expect(payload(up)).toEqual({ role_requested: 'Medic', ship_utilized: 'Cutlass', attendance_status: 'Attended', ship_id: null, user_ship_id: null });
        expect(eqs(up)).toEqual([['operation_id', op], ['user_id', 4]]);
        expect(queriesOn('user_ships')).toHaveLength(0);
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('a ship-ownership read fault refuses the edit', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: { user_id: 4 } });
        on('user_ships', { error: { message: 'x' } });
        await expect(updateOperationParticipant(op, 4, { userShipId: 9 })).rejects.toThrow('updateOperationParticipant: failed to verify ship ownership');
        expect(writesOn('operation_participants')).toHaveLength(0);
    });

    it('an update fault throws', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: { user_id: 4 } }, { error: { message: 'x' } });
        await expect(updateOperationParticipant(op, 4, { roleRequested: 'x' })).rejects.toThrow('Failed to update participant');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('logOperationEntry', () => {
    it('writes the typed cost fields when supplied', async () => {
        await logOperationEntry('op-1', 'UEC_COST', 'txt', 3, 500, 'Fuel', 'refuel');
        expect(logEntries()).toEqual([{ operation_id: 'op-1', entry_type: 'UEC_COST', log_entry: 'txt', author_id: 3, uec_amount: 500, cost_category: 'Fuel', cost_description: 'refuel' }]);
    });

    it('pre-migration: retries without the typed cost columns (text keeps the record)', async () => {
        on('operation_log_entries', { error: { code: '42703' } }, { data: null });
        await logOperationEntry('op-1', 'UEC_COST', 'txt', 3, 500, 'Fuel');
        const entries = logEntries();
        expect(entries).toHaveLength(2);
        expect(entries[1]).toEqual({ operation_id: 'op-1', entry_type: 'UEC_COST', log_entry: 'txt', author_id: 3, uec_amount: 500 });
        expect(warnings(/cost_category\/description unavailable/)).toHaveLength(1);
    });

    it('a retry that still fails throws', async () => {
        on('operation_log_entries', { error: { code: 'PGRST204' } }, { error: { code: 'XX000' } });
        await expect(logOperationEntry('op-1', 'UEC_COST', 'txt', 3, 1, undefined, 'd')).rejects.toThrow('Failed to log operation entry');
    });

    it('a missing-column fault WITHOUT cost fields is not retried — it throws', async () => {
        on('operation_log_entries', { error: { code: '42703' } });
        await expect(logOperationEntry('op-1', 'JOIN', 'txt', 3)).rejects.toThrow('Failed to log operation entry');
        expect(logEntries()).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('money: costs, payout mode, splits, paid flags, deposits', () => {
    it('addOperationCost rejects a non-positive / non-finite amount before touching the op', async () => {
        for (const amt of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(addOperationCost('op-1', amt, 'Fuel', undefined, 3)).rejects.toThrow('Cost amount must be a positive number.');
        }
        expect(fake.queries).toHaveLength(0);
        expect(fake.rpcs).toHaveLength(0);
    });

    it('addOperationCost: floored atomic accumulate, then a typed UEC_COST audit line', async () => {
        const op = newOpId();
        grantAccess();
        await addOperationCost(op, 120.9, 'Fuel', '  refuel at Port Olisar ', 3);
        expect(fake.rpcs).toEqual([{ name: 'add_cost_to_operation', args: { op_id: op, amount_to_add: 120 } }]);
        expect(logEntries()[0]).toEqual({
            operation_id: op, entry_type: 'UEC_COST', log_entry: 'User#3 recorded 120.9 aUEC cost (Fuel). refuel at Port Olisar',
            author_id: 3, uec_amount: 120.9, cost_category: 'Fuel', cost_description: 'refuel at Port Olisar',
        });
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('addOperationCost: no category / description → bare audit text', async () => {
        const op = newOpId();
        grantAccess();
        await addOperationCost(op, 5, '', '   ', 3);
        expect(logEntries()[0]).toMatchObject({ log_entry: 'User#3 recorded 5 aUEC cost', cost_category: '' });
        expect(logEntries()[0]).not.toHaveProperty('cost_description');
    });

    it('addOperationCost: a missing RPC degrades to log-only; any other RPC fault throws', async () => {
        const op = newOpId();
        grantAccess();
        onRpc('add_cost_to_operation', { error: { code: '42883' } });
        await addOperationCost(op, 5, 'Fuel', undefined, 3);
        expect(warnings(/add_cost_to_operation\(\) not present/)).toHaveLength(1);
        expect(logEntries()).toHaveLength(1);

        const op2 = newOpId();
        grantAccess();
        onRpc('add_cost_to_operation', { error: { code: '23514' } });
        await expect(addOperationCost(op2, 5, 'Fuel', undefined, 3)).rejects.toThrow('Failed to record cost');
    });

    it('setOperationPayoutMode: validates the mode, writes it scoped to the op, emits', async () => {
        await expect(setOperationPayoutMode('op-1', 'random' as 'equal', 3)).rejects.toThrow('Invalid payout mode: random');
        expect(fake.queries).toHaveLength(0);

        const op = newOpId();
        grantAccess();
        await setOperationPayoutMode(op, 'weighted', 3);
        const up = writesOn('operations', 'update')[0];
        expect(payload(up)).toEqual({ payout_mode: 'weighted' });
        expect(eqs(up)).toEqual([['id', op]]);
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('setOperationPayoutMode: a missing column skips quietly (no emit); other faults throw', async () => {
        const op = newOpId();
        grantAccess();
        on('operations', { error: { code: '42703' } });
        await setOperationPayoutMode(op, 'equal', 3);
        expect(opUpdates()).toEqual([]);
        expect(warnings(/payout_mode unavailable/)).toHaveLength(1);

        const op2 = newOpId();
        grantAccess();
        on('operations', { error: { code: '23514' } });
        await expect(setOperationPayoutMode(op2, 'equal', 3)).rejects.toThrow('Failed to update payout mode');
    });

    it('setOperationPayoutSplits validates shape, bounds and the 100% sum before any read', async () => {
        await expect(setOperationPayoutSplits('op-1', [], 3)).rejects.toThrow('At least one split row is required.');
        await expect(setOperationPayoutSplits('op-1', null as unknown as [], 3)).rejects.toThrow('At least one split row is required.');
        await expect(setOperationPayoutSplits('op-1', [{ userId: 1, percent: 120 }, { userId: 2, percent: -20 }], 3)).rejects.toThrow('Each payout share must be between 0 and 100 percent.');
        // A negative share offset by larger positives still sums to 100% — refused on its own.
        await expect(setOperationPayoutSplits('op-1', [{ userId: 1, percent: -10 }, { userId: 2, percent: 60 }, { userId: 3, percent: 50 }], 3)).rejects.toThrow('Each payout share must be between 0 and 100 percent.');
        await expect(setOperationPayoutSplits('op-1', [{ userId: 1, percent: Number.NaN }], 3)).rejects.toThrow('between 0 and 100');
        await expect(setOperationPayoutSplits('op-1', [{ userId: 1, percent: 50 }, { userId: 2, percent: 40 }], 3)).rejects.toThrow('Splits must sum to 100% (got 90.00%).');
        expect(fake.queries).toHaveLength(0);
    });

    it('setOperationPayoutSplits refuses a non-participant', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 1 }] });
        await expect(setOperationPayoutSplits(op, [{ userId: 1, percent: 50 }, { userId: 2, percent: 50 }], 3)).rejects.toThrow('User 2 is not a participant of this operation.');
        expect(writesOn('operation_participants')).toHaveLength(0);
    });

    it('setOperationPayoutSplits writes every share scoped to (op, user) and emits', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] });
        await setOperationPayoutSplits(op, [{ userId: 1, percent: 50 }, { userId: 2, percent: 25 }, { userId: 3, percent: 25 }], 3);
        const ups = writesOn('operation_participants', 'update');
        expect(ups.map((q) => [payload(q), eqs(q)])).toEqual([
            [{ payout_share_percent: 50 }, [['operation_id', op], ['user_id', 1]]],
            [{ payout_share_percent: 25 }, [['operation_id', op], ['user_id', 2]]],
            [{ payout_share_percent: 25 }, [['operation_id', op], ['user_id', 3]]],
        ]);
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('setOperationPayoutSplits: a missing column is a loud migration error; other probe faults throw', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: null }, { error: { code: 'PGRST204' } });
        // participants read null → every split is a non-participant
        await expect(setOperationPayoutSplits(op, [{ userId: 1, percent: 100 }], 3)).rejects.toThrow('User 1 is not a participant');

        const op2 = newOpId();
        resetFake();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 1 }] }, { error: { code: '42703' } });
        await expect(setOperationPayoutSplits(op2, [{ userId: 1, percent: 100 }], 3)).rejects.toThrow('Custom splits require a database migration');

        const op3 = newOpId();
        resetFake();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 1 }] }, { error: { code: '23514' } });
        await expect(setOperationPayoutSplits(op3, [{ userId: 1, percent: 100 }], 3)).rejects.toThrow('Failed to set payout splits');
    });

    describe('toggleParticipantPayoutPaid', () => {
        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        });
        afterEach(() => { vi.useRealTimers(); });

        it('is locked once the op is concluded', async () => {
            const op = newOpId();
            grantAccess();
            on('operations', { data: { status: 'Concluded' } });
            await expect(toggleParticipantPayoutPaid(op, 4, true, 3)).rejects.toThrow('Cannot modify payout state on a concluded operation.');
            expect(writesOn('operation_participants')).toHaveLength(0);
        });

        it('paid stamps time + actor; unpaid clears both', async () => {
            const op = newOpId();
            grantAccess();
            on('operations', { data: { status: 'Active' } }, { data: { status: 'Active' } });
            await toggleParticipantPayoutPaid(op, 4, true, 3);
            await toggleParticipantPayoutPaid(op, 4, false, 3);
            const ups = writesOn('operation_participants', 'update');
            expect(payload(ups[0])).toEqual({ payout_paid_at: '2026-06-01T12:00:00.000Z', payout_paid_by: 3 });
            expect(payload(ups[1])).toEqual({ payout_paid_at: null, payout_paid_by: null });
            expect(eqs(ups[0])).toEqual([['operation_id', op], ['user_id', 4]]);
            expect(opUpdates()).toHaveLength(2);
        });

        it('a missing column skips quietly; other faults throw', async () => {
            const op = newOpId();
            grantAccess();
            on('operations', { data: { status: 'Active' } }, { data: null });
            on('operation_participants', { error: { code: '42703' } }, { error: { code: '23514' } });
            await toggleParticipantPayoutPaid(op, 4, true, 3);
            expect(opUpdates()).toEqual([]);
            expect(warnings(/payout_paid_at\/by unavailable/)).toHaveLength(1);
            await expect(toggleParticipantPayoutPaid(op, 4, true, 3)).rejects.toThrow('Failed to update payout status');
        });
    });

    it('addOperationUec bounds the deposit, then accumulates atomically with an audit line', async () => {
        for (const amt of [0, -1, Number.NaN, 1_000_000_000_001]) {
            await expect(addOperationUec('op-1', amt, 'r', 3)).rejects.toThrow('Deposit amount must be a positive number.');
        }
        expect(fake.queries).toHaveLength(0);

        const op = newOpId();
        grantAccess();
        await addOperationUec(op, 2500, 'Bounty', 3);
        expect(fake.rpcs).toEqual([{ name: 'add_uec_to_operation', args: { op_id: op, amount_to_add: 2500 } }]);
        expect(logEntries()[0]).toMatchObject({ entry_type: 'UEC_DEPOSIT', log_entry: 'User#3 deposited 2500 aUEC. Reason: Bounty', uec_amount: 2500 });
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('addOperationUec: an RPC fault throws with no audit line', async () => {
        const op = newOpId();
        grantAccess();
        onRpc('add_uec_to_operation', { error: { message: 'x' } });
        await expect(addOperationUec(op, 5, 'r', 3)).rejects.toThrow('Failed to add UEC');
        expect(logEntries()).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('readiness, live status, RSVP, reminders', () => {
    it('toggleParticipantReady flips the caller\'s own flag (a missing row reads as not-ready)', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: { is_ready: true } });
        await toggleParticipantReady(op, 4);
        expect(payload(writesOn('operation_participants', 'update')[0])).toEqual({ is_ready: false });
        expect(eqs(writesOn('operation_participants', 'update')[0])).toEqual([['operation_id', op], ['user_id', 4]]);

        resetFake();
        on('operation_participants', { data: null });
        await toggleParticipantReady(op, 4);
        expect(payload(writesOn('operation_participants', 'update')[0])).toEqual({ is_ready: true });
    });

    it('toggleParticipantReady: an update fault throws', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: { is_ready: false } }, { error: { message: 'x' } });
        await expect(toggleParticipantReady(op, 4)).rejects.toThrow('Failed to toggle ready status');
        expect(opUpdates()).toEqual([]);
    });

    it('updateParticipantLiveStatus: a write fault throws before any audit line', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { error: { message: 'x' } });
        await expect(updateParticipantLiveStatus(op, 4, 'RTB')).rejects.toThrow('Failed to update participant live status');
        expect(logEntries()).toEqual([]);
    });

    it('resetOperationReadiness clears every participant on the op; a fault throws', async () => {
        const op = newOpId();
        grantAccess();
        await resetOperationReadiness(op);
        const up = writesOn('operation_participants', 'update')[0];
        expect(payload(up)).toEqual({ is_ready: false });
        expect(eqs(up)).toEqual([['operation_id', op]]);
        expect(opUpdates()).toEqual([{ operationId: op }]);

        on('operation_participants', { error: { message: 'x' } });
        await expect(resetOperationReadiness(op)).rejects.toThrow('Failed to reset readiness');
    });

    it('rsvpOperation writes status + time and only the ship fields supplied', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        try {
            const op = newOpId();
            grantAccess();
            await rsvpOperation(op, 4, 'Going');
            expect(payload(writesOn('operation_participants', 'update')[0])).toEqual({ rsvp_status: 'Going', rsvp_at: '2026-06-01T12:00:00.000Z' });

            resetFake();
            on('user_ships', { data: { user_id: 4 } });
            await rsvpOperation(op, 4, 'Maybe', 0, 9);
            expect(payload(writesOn('operation_participants', 'update')[0])).toEqual({ rsvp_status: 'Maybe', rsvp_at: '2026-06-01T12:00:00.000Z', ship_id: null, user_ship_id: 9 });
            expect(eqs(writesOn('operation_participants', 'update')[0])).toEqual([['operation_id', op], ['user_id', 4]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rsvpOperation: a write fault throws', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { error: { message: 'x' } });
        await expect(rsvpOperation(op, 4, 'Going')).rejects.toThrow('Failed to update RSVP');
    });

    describe('createOperationReminders', () => {
        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        });
        afterEach(() => { vi.useRealTimers(); });

        it('schedules T-30 and T-5 for a future start', async () => {
            await createOperationReminders('op-1', '2026-06-01T14:00:00Z');
            expect(payload(writesOn('operation_reminders', 'insert')[0])).toEqual([
                { operation_id: 'op-1', remind_at: '2026-06-01T13:30:00.000Z', sent: false },
                { operation_id: 'op-1', remind_at: '2026-06-01T13:55:00.000Z', sent: false },
            ]);
        });

        it('only future reminders: a start 10 minutes out gets just T-5', async () => {
            await createOperationReminders('op-1', '2026-06-01T12:10:00Z');
            expect(payload(writesOn('operation_reminders', 'insert')[0])).toEqual([
                { operation_id: 'op-1', remind_at: '2026-06-01T12:05:00.000Z', sent: false },
            ]);
        });

        it('a past start writes nothing', async () => {
            await createOperationReminders('op-1', '2026-06-01T11:00:00Z');
            expect(fake.queries).toHaveLength(0);
        });

        it('an insert fault is logged, never thrown (it must not fail operation:create)', async () => {
            on('operation_reminders', { error: { code: '42P01', message: 'missing' } });
            await expect(createOperationReminders('op-1', '2026-06-01T14:00:00Z')).resolves.toBeUndefined();
            expect(warnings(/failed to create operation reminders/)[0].fields).toMatchObject({ operationId: 'op-1', code: '42P01', message: 'missing' });
        });
    });

    it('updateLiveStatus writes, audits and emits; a fault throws with no audit', async () => {
        await updateLiveStatus('op-1', 'Engaged', 3);
        const up = writesOn('operations', 'update')[0];
        expect(payload(up)).toEqual({ live_status: 'Engaged' });
        expect(eqs(up)).toEqual([['id', 'op-1']]);
        expect(logEntries()[0]).toMatchObject({ entry_type: 'STATUS_CHANGE', log_entry: 'User#3 set live status to Engaged' });
        expect(opUpdates()).toEqual([{ operationId: 'op-1' }]);

        resetFake();
        on('operations', { error: { message: 'x' } });
        await expect(updateLiveStatus('op-1', 'x', 3)).rejects.toThrow('Failed to update live status');
        expect(logEntries()).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('edge shapes on the lifecycle writes', () => {
    it('createOperation: announcing with no channel id stores no channel', async () => {
        on('operations', { data: createdRow() });
        await createOperation({ userId: 7, postDiscordAnnouncement: true });
        expect((payload(writesOn('operations', 'insert')[0]) as Record<string, unknown>).discord_announcement_channel_id).toBeNull();
    });

    it('createOperation: a template seed with no acting user is gated as a null viewer (level 0 only)', async () => {
        on('operations', { data: createdRow() });
        on('operation_templates', { data: { id: 3, name: 'T', payload: { phases: [{ name: 'P' }] }, classification_level: 1, limiting_marker_ids: [] } });
        await createOperation({ userId: 7, templateId: 3 });
        // The classified template resolved to not-found for a null viewer, so nothing was seeded.
        expect(queriesOn('operation_phases')).toHaveLength(0);
        expect(warnings(/phase seeding failed/)).toHaveLength(1);
    });

    it('updateOperationDetails: a live row with no markers / no level reads as unclassified', async () => {
        const plain = { id: 5, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: [] as string[] };
        on('operations', { data: { id: 'op-1', clearance_level: null, is_special: false, join_code: null } });
        await updateOperationDetails('op-1', { markerIds: [], locationId: 0 }, 5, plain);
        expect(payload(writesOn('operations', 'update')[0])).toEqual({ location_id: null });
    });

    it('updateOperationDetails: arming Special on a STORED valid PIN validates it but does not rewrite it', async () => {
        on('operations', { data: { id: 'op-1', clearance_level: 0, is_special: false, join_code: ' STORED-PIN ', limiting_markers: [] } });
        await updateOperationDetails('op-1', { isSpecial: true }, 1, MANAGER);
        const w = payload(writesOn('operations', 'update')[0]) as Record<string, unknown>;
        expect(w).toEqual({ is_special: true });
        expect(w).not.toHaveProperty('join_code');
    });

    it('updateOperationDetails: a non-string PIN is rejected by the floor (no type-confusion bypass)', async () => {
        on('operations', { data: { id: 'op-1', clearance_level: 0, is_special: true, join_code: null, limiting_markers: [] } });
        await expect(updateOperationDetails('op-1', { joinCode: 12345678 }, 1, MANAGER)).rejects.toThrow('Special Operations require a join PIN of at least 6 characters.');
        expect(writesOn('operations')).toHaveLength(0);
    });

    it('joinOperation fallback: a null head count is read as zero (the join proceeds)', async () => {
        const op = newOpId();
        grantAccess();
        on('operations', { data: { id: op, is_special: false, max_participants: 3 } });
        onRpc('op_join_participant', { error: { code: 'PGRST202' } });
        on('operation_participants', { count: null });
        await joinOperation(op, 4, undefined, 'Pilot');
        const up = writesOn('operation_participants', 'upsert')[0];
        expect(payload(up)).toEqual({ operation_id: op, user_id: 4, role_requested: 'Pilot', ship_utilized: undefined, ship_id: null, user_ship_id: null, attendance_status: 'Registered', is_ready: false });
        expect(logEntries()).toHaveLength(1);
    });

    it('joinOperation: an audit-sink fault on the lockout trip never changes the refusal', async () => {
        const op = newOpId();
        const user = 4242;
        route('operations', () => ({ data: { id: op, is_joint: false, is_special: true, join_code: 'RIGHT-PIN-1', max_participants: null } }));
        collab.recordSecurityEvent.mockImplementation(() => { throw new Error('audit sink gone'); });
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES; i++) {
            await expect(joinOperation(op, user, 'wrong-pin')).rejects.toThrow('Invalid Join Code.');
        }
        expect(collab.recordSecurityEvent).toHaveBeenCalledTimes(1);
        expect(collab.recordSecurityEvent.mock.calls[0][0]).toMatchObject({ event: 'auth.join_pin.locked_out', actorUserId: user, outcome: 'denied' });
        expect(JSON.stringify(collab.recordSecurityEvent.mock.calls[0][0])).not.toContain('wrong-pin');
        expect(warnings(/security event emit threw/)).toHaveLength(1);
        // Locked: even the right PIN gets the same copy, and nobody was joined.
        await expect(joinOperation(op, user, 'RIGHT-PIN-1')).rejects.toThrow('Invalid Join Code.');
        expect(fake.rpcs).toHaveLength(0);
    });

    it('setOperationPayoutSplits: a 0% share is valid and counts as zero in the sum', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 1 }, { user_id: 2 }] });
        await setOperationPayoutSplits(op, [{ userId: 1, percent: 100 }, { userId: 2, percent: 0 }], 3);
        expect(writesOn('operation_participants', 'update').map((q) => payload(q))).toEqual([{ payout_share_percent: 100 }, { payout_share_percent: 0 }]);
    });

    it('rsvpOperation: a zero userShipId clears the binding with no ownership read', async () => {
        const op = newOpId();
        grantAccess();
        await rsvpOperation(op, 4, 'Going', undefined, 0);
        expect(payload(writesOn('operation_participants', 'update')[0])).toMatchObject({ user_ship_id: null });
        expect(payload(writesOn('operation_participants', 'update')[0])).not.toHaveProperty('ship_id');
        expect(queriesOn('user_ships')).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUGS PINNED. Each of these writes used to discard the `error` supabase-js RESOLVES
// with, so a DB blip silently produced the permissive outcome.
describe('fail-closed marker and payout writes', () => {
    it('createOperation: a marker-attach fault rolls the op back instead of leaving it UNmarked', async () => {
        on('operations', { data: createdRow() });
        on('security_limiting_markers', { data: [{ id: 3 }] });
        onRpc('op_replace_limiting_markers', { error: { code: '08006', message: 'connection reset' } });
        await expect(createOperation({ userId: 20, user: MANAGER, markerIds: [3] })).rejects.toThrow('Failed to attach limiting markers');
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'new-op', p_marker_ids: [3] } }]);
        const del = writesOn('operations', 'delete');
        expect(del).toHaveLength(1);
        expect(eqs(del[0])).toEqual([['id', 'new-op']]);
        // No partial marker write from Node, and nothing after the failed attach ran:
        // no owner row, no audit, no broadcast.
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(queriesOn('operation_participants')).toHaveLength(0);
        expect(logEntries()).toEqual([]);
        expect(opUpdates()).toEqual([]);
    });

    it.each([['42883'], ['PGRST202']])('createOperation: the marker writer NOT DEPLOYED (%s) refuses, rolls back, and never falls back', async (code) => {
        on('operations', { data: createdRow() });
        on('security_limiting_markers', { data: [{ id: 3 }] });
        onRpc('op_replace_limiting_markers', { error: { code, message: 'function public.op_replace_limiting_markers does not exist' } });
        await expect(createOperation({ userId: 20, user: MANAGER, markerIds: [3] }))
            .rejects.toThrow('Database update required — re-run schema.sql (op_replace_limiting_markers is missing).');
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(eqs(writesOn('operations', 'delete')[0])).toEqual([['id', 'new-op']]);
        expect(queriesOn('operation_participants')).toHaveLength(0);
        expect(opUpdates()).toEqual([]);
        expect(fake.logs.find((l) => l.level === 'error' && /not deployed/.test(l.msg))?.fields).toMatchObject({ operationId: 'new-op', code });
    });

    it('createOperation: a rollback that itself fails is logged loudly, and the refusal still propagates', async () => {
        on('operations', { data: createdRow() }, { error: { code: '08006', message: 'down' } });
        on('security_limiting_markers', { data: [{ id: 3 }] });
        onRpc('op_replace_limiting_markers', { error: { code: 'XX000', message: 'boom' } });
        await expect(createOperation({ userId: 20, user: MANAGER, markerIds: [3] })).rejects.toThrow('Failed to attach limiting markers');
        const err = fake.logs.find((l) => l.level === 'error' && /could not be rolled back/.test(l.msg));
        expect(err?.fields).toMatchObject({ operationId: 'new-op', code: '08006' });
    });

    const markedLive = { data: { id: 'op-1', clearance_level: 0, is_special: false, join_code: null, limiting_markers: [{ marker: { id: 3, code: 'K' } }, { marker: { id: 4, code: 'L' } }] } };

    it('updateOperationDetails: a marker-writer fault refuses the WHOLE edit with no partial write', async () => {
        on('operations', markedLive);
        onRpc('op_replace_limiting_markers', { error: { message: 'timeout' } });
        await expect(updateOperationDetails('op-1', { markerIds: [3], name: 'renamed' }, 1, MANAGER)).rejects.toThrow('Failed to update operation markers');
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'op-1', p_marker_ids: [3] } }]);
        // The function is one transaction, so there is no cleared-then-failed state for
        // Node to restore — and Node issues no marker write of its own.
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(writesOn('operations')).toHaveLength(0);
        expect(logEntries()).toEqual([]);
        expect(opUpdates()).toEqual([]);
    });

    it.each([['42883'], ['PGRST202']])('updateOperationDetails: the marker writer NOT DEPLOYED (%s) refuses with a re-run instruction, never the old path', async (code) => {
        on('operations', markedLive);
        onRpc('op_replace_limiting_markers', { error: { code, message: 'Could not find the function' } });
        await expect(updateOperationDetails('op-1', { markerIds: [5] }, 1, MANAGER))
            .rejects.toThrow('Database update required — re-run schema.sql (op_replace_limiting_markers is missing).');
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(writesOn('operations')).toHaveLength(0);
        expect(opUpdates()).toEqual([]);
        expect(fake.logs.find((l) => l.level === 'error' && /not deployed/.test(l.msg))?.fields).toMatchObject({ operationId: 'op-1', code });
    });

    it('updateOperationDetails: the function\'s own validation codes map to plain refusals', async () => {
        on('operations', markedLive);
        onRpc('op_replace_limiting_markers', { error: { code: 'P0001', message: 'OP_MARKERS_UNKNOWN: 1 of 2 marker ids exist' } });
        await expect(updateOperationDetails('op-1', { markerIds: [3, 404] }, 1, MANAGER))
            .rejects.toThrow('One or more limiting markers are not valid for this organization.');

        resetFake();
        on('operations', markedLive);
        onRpc('op_replace_limiting_markers', { error: { code: 'P0001', message: 'OP_MARKERS_INVALID: duplicate marker id' } });
        await expect(updateOperationDetails('op-1', { markerIds: [3, 3] }, 1, MANAGER)).rejects.toThrow('Invalid limiting marker list.');
        expect(writesOn('operations')).toHaveLength(0);
        expect(opUpdates()).toEqual([]);
    });

    it('updateOperationDetails: a non-array marker list is refused before any RPC', async () => {
        on('operations', markedLive);
        await expect(updateOperationDetails('op-1', { markerIds: '3' as unknown as number[] }, 1, MANAGER)).rejects.toThrow('Invalid limiting marker list.');
        expect(fake.rpcs).toEqual([]);
        expect(writesOn('operations')).toHaveLength(0);
    });

    it('setOperationPayoutSplits: a share that fails to persist is reported, not swallowed', async () => {
        const op = newOpId();
        grantAccess();
        on('operation_participants', { data: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] }, { data: null }, { data: null }, { error: { message: 'x' } });
        await expect(setOperationPayoutSplits(op, [{ userId: 1, percent: 40 }, { userId: 2, percent: 30 }, { userId: 3, percent: 30 }], 3)).rejects.toThrow('Failed to set payout splits');
        expect(opUpdates()).toEqual([]);
    });

    it('toggleParticipantPayoutPaid: a fault reading the status no longer unlocks a concluded op', async () => {
        const op = newOpId();
        grantAccess();
        on('operations', { error: { code: '08006' } });
        await expect(toggleParticipantPayoutPaid(op, 4, true, 3)).rejects.toThrow('Failed to update payout status');
        expect(writesOn('operation_participants')).toHaveLength(0);
    });
});
