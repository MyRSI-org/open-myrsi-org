import { describe, it, expect } from 'vitest';
import {
    toServiceRequest, toHydratedOperation, toOperationAlliedOrg, toAlliedParticipant,
    toMirroredOperation, toOperationPhase, toOperationScheduleEntry, toOperationTask,
    toOperationCommandNode, toOperationSlotAssignment, toOperationShipSlot,
    toOperationBoardElement, toOperationLogisticsItem, toAAREntry,
} from '../lib/db/mappers';
import { ROSTER_SAFE_FIELDS } from '../lib/db/userFilters';
import { UserRole } from '../types';

// lib/db/mappers.ts — service-request and operation mappers (the op command board's
// sub-resources included). Exact-shape assertions throughout: an unmapped input column
// (`*_LEAK`) must never reach the output, and every embedded user must be minified.

const MINI_KEYS = [...new Set([...ROSTER_SAFE_FIELDS, 'discordId', 'permissions', 'conductRecord', 'limitingMarkers'])].sort();

function secretUserRow(id: number, name: string): Record<string, unknown> {
    return {
        id, name, discord_id: '990000000000000001', avatar_url: `${name}.png`, rsi_handle: `${name}_rsi`,
        role: { id: 9, name: 'Admin', role_permissions: [{ permission: { name: 'admin:access' } }] },
        admin_notes: 'SECRET-admin', personnel_notes: 'SECRET-personnel', rsi_verification_code: 'SECRET-code',
        job_title: 'SECRET-job', tokens_valid_from: 'SECRET-tvf', clearance_level: { level: 5, name: 'SECRET-cl' },
        limiting_markers: [{ marker: 'SECRET-marker' }],
    };
}

function expectMiniUser(u: unknown, id: number, name: string) {
    expect(u).toBeDefined();
    const rec = u as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(MINI_KEYS);
    expect(rec.id).toBe(id);
    expect(rec.name).toBe(name);
    expect(rec.discordId).toBe('');
    expect(rec.permissions).toEqual([]);
    expect(JSON.stringify(rec)).not.toContain('SECRET');
    expect(JSON.stringify(rec)).not.toContain('990000000000000001');
}

const UNKNOWN_USER = {
    id: 0, discordId: '', name: 'Unknown Agent', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
    rsiHandle: 'Unknown', role: UserRole.Client, roleId: 1, reputation: 0, isDuty: false, permissions: [],
    createdAt: expect.any(String),
};

describe('toServiceRequest', () => {
    const baseCols = {
        id: 'req-1', client_id: 5, unregistered_client_rsi_handle: 'Walkin', service_type: 'Medical',
        location: 'Crusader', description: 'help', status: 'Submitted', urgency: 'High', threat_level: 'Low',
        created_at: 'c', updated_at: 'u', uec_earned: 100, medigel_consumed: 2, client_rating: 5,
        client_feedback: 'great', rated: true, party_info: 'party', secondary_client_handles: ['h2'],
    };

    it('maps a full row: minified client/responders, lead resolved, history sorted ascending', () => {
        const r = toServiceRequest({
            ...baseCols,
            lead_responder_id: 12,
            client: secretUserRow(5, 'Client'),
            request_responders: [
                { user_id: 11, user: secretUserRow(11, 'Resp') },
                { user_id: 12, user: secretUserRow(12, 'Lead') },
                // A responder whose user embed is missing still counts by user_id.
                { user_id: 13, user: null },
            ],
            statusHistory: [
                { status: 'Completed', updated_at: '2026-01-03T00:00:00Z', note: 'done', updated_by: secretUserRow(12, 'Lead'), id: 3 },
                { status: 'Submitted', updated_at: '2026-01-01T00:00:00Z', note: null, updated_by: null, id: 1 },
                { status: 'Accepted', updated_at: '2026-01-02T00:00:00Z', note: 'go', updated_by: secretUserRow(11, 'Resp'), id: 2 },
            ],
            secret_LEAK: 'x',
        } as never);

        expectMiniUser(r.client, 5, 'Client');
        expectMiniUser(r.leadResponder, 12, 'Lead');
        expect(r.assignedMembers).toHaveLength(2);
        expectMiniUser(r.assignedMembers![0], 11, 'Resp');
        expectMiniUser(r.assignedMembers![1], 12, 'Lead');
        expect(r.statusHistory.map(h => h.status)).toEqual(['Submitted', 'Accepted', 'Completed']);
        expect(r.statusHistory[0]).toStrictEqual({ status: 'Submitted', updatedAt: '2026-01-01T00:00:00Z', updatedBy: undefined, note: null });
        expectMiniUser(r.statusHistory[1].updatedBy, 11, 'Resp');
        expect(r.hydratedStatusHistory).toBe(r.statusHistory);

        expect(r).toStrictEqual({
            id: 'req-1', clientId: 5, unregisteredClientRsiHandle: 'Walkin', serviceType: 'Medical',
            location: 'Crusader', description: 'help', status: 'Submitted', urgency: 'High', threatLevel: 'Low',
            leadResponderId: 12, createdAt: 'c', updatedAt: 'u', uecEarned: 100, medigelConsumed: 2,
            clientRating: 5, clientFeedback: 'great', rated: true, partyInfo: 'party', secondaryClientHandles: ['h2'],
            client: r.client, assignedMemberIds: [11, 12, 13], assignedMembers: r.assignedMembers,
            leadResponder: r.leadResponder, statusHistory: r.statusHistory, hydratedStatusHistory: r.statusHistory,
        });
    });

    it('reads the raw status_history relation when the alias is absent', () => {
        const r = toServiceRequest({ ...baseCols, status_history: [{ status: 'Submitted', updated_at: 't', note: 'n', updated_by: null }] } as never);
        expect(r.statusHistory).toStrictEqual([{ status: 'Submitted', updatedAt: 't', updatedBy: undefined, note: 'n' }]);
    });

    it('a sparse row has no history, no responders, no client, no lead', () => {
        const r = toServiceRequest({ ...baseCols, lead_responder_id: 9 } as never);
        expect(r.statusHistory).toEqual([]);
        expect(r.assignedMemberIds).toEqual([]);
        expect(r.assignedMembers).toEqual([]);
        expect(r.client).toBeUndefined();
        // lead id set but no responder rows to resolve it from.
        expect(r.leadResponder).toBeUndefined();
    });

    it('a lead whose responder row has no user embed resolves to no lead user', () => {
        const r = toServiceRequest({ ...baseCols, lead_responder_id: 13, request_responders: [{ user_id: 13, user: null }] } as never);
        expect(r.leadResponder).toBeUndefined();
        expect(r.assignedMemberIds).toEqual([13]);
        expect(r.assignedMembers).toEqual([]);
    });

    it('a lead id that matches no responder resolves to no lead user', () => {
        const r = toServiceRequest({ ...baseCols, lead_responder_id: 99, request_responders: [{ user_id: 11, user: secretUserRow(11, 'Resp') }] } as never);
        expect(r.leadResponder).toBeUndefined();
    });

    it('no lead id: responders are listed but none is promoted', () => {
        const r = toServiceRequest({ ...baseCols, lead_responder_id: null, request_responders: [{ user_id: 11, user: secretUserRow(11, 'Resp') }] } as never);
        expect(r.leadResponder).toBeUndefined();
        expect(r.assignedMemberIds).toEqual([11]);
    });
});

describe('operation sub-resource mappers', () => {
    it('toOperationAlliedOrg maps the cached peer directory fields and nothing else from the peer', () => {
        expect(toOperationAlliedOrg({
            id: 1, operation_id: 'op', peer_id: 'peer', accepted: true, invited_at: 'i', accepted_at: 'a',
            peer: { label: 'L', peer_org_name: 'Org', peer_org_tag: 'TAG', peer_icon_url: 'ic.png', api_key: 'LEAK-key', base_url: 'LEAK-url' },
        } as never)).toStrictEqual({
            id: 1, operationId: 'op', peerId: 'peer', accepted: true, invitedAt: 'i', acceptedAt: 'a',
            label: 'L', peerOrgName: 'Org', peerOrgTag: 'TAG', peerIconUrl: 'ic.png',
        });
        const bare = { id: 2, operation_id: 'op', peer_id: 'peer', accepted: false, invited_at: 'i', accepted_at: null };
        const expected = { id: 2, operationId: 'op', peerId: 'peer', accepted: false, invitedAt: 'i', acceptedAt: undefined, label: null, peerOrgName: null, peerOrgTag: null, peerIconUrl: null };
        expect(toOperationAlliedOrg({ ...bare, peer: null } as never)).toStrictEqual(expected);
        expect(toOperationAlliedOrg({ ...bare, peer: { label: null, peer_org_name: null, peer_org_tag: null, peer_icon_url: null } } as never)).toStrictEqual(expected);
    });

    it('toAlliedParticipant maps the federated participant row and nothing else', () => {
        expect(toAlliedParticipant({
            operation_id: 'op', peer_id: 'p', remote_user_handle: 'h', display_name: null, avatar_url: 'a',
            role: 'Pilot', ship_text: 'Gladius', rsvp_status: 'Accepted', is_ready: true, updated_at: 'u',
            remote_user_id: 'LEAK-id', discord_id: 'LEAK-discord',
        } as never)).toStrictEqual({
            operationId: 'op', peerId: 'p', remoteUserHandle: 'h', displayName: null, avatarUrl: 'a',
            role: 'Pilot', shipText: 'Gladius', rsvpStatus: 'Accepted', isReady: true, updatedAt: 'u',
        });
    });

    it('toMirroredOperation prefers the peer org name, falls back to the label, then null', () => {
        const base = {
            id: 'm1', host_peer_id: 'peer', snapshot: { name: 'Op' }, version: 3, snapshot_updated_at: 's',
            accepted: true, invited_at: 'i', accepted_at: 'a', last_polled_at: 'l', api_key: 'LEAK',
        };
        expect(toMirroredOperation({ ...base, peer: { peer_org_name: 'Org', label: 'Lbl', peer_icon_url: 'ic' } } as never)).toStrictEqual({
            id: 'm1', hostPeerId: 'peer', hostPeerName: 'Org', hostPeerIconUrl: 'ic', snapshot: { name: 'Op' },
            version: 3, snapshotUpdatedAt: 's', accepted: true, invitedAt: 'i', acceptedAt: 'a', lastPolledAt: 'l',
        });
        expect(toMirroredOperation({ ...base, peer: { peer_org_name: null, label: 'Lbl', peer_icon_url: null } } as never).hostPeerName).toBe('Lbl');
        const none = toMirroredOperation({ ...base, snapshot: null, peer: null } as never);
        expect(none.hostPeerName).toBeNull();
        expect(none.hostPeerIconUrl).toBeNull();
        expect(none.snapshot).toBeNull();
        expect(toMirroredOperation({ ...base, snapshot: undefined, peer: { peer_org_name: null, label: null } } as never).snapshot).toBeNull();
    });

    it('toOperationPhase: full and defaulted', () => {
        expect(toOperationPhase({
            id: 1, operation_id: 'op', name: 'Insert', description: 'd', phase_type: 'parallel', sort_order: 2,
            status: 'Active', color: '#f00', created_at: 'c', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, operationId: 'op', name: 'Insert', description: 'd', phaseType: 'parallel', sortOrder: 2, status: 'Active', color: '#f00', createdAt: 'c',
        });
        expect(toOperationPhase({ id: 2, operation_id: 'op', name: 'N', description: null, phase_type: null, sort_order: null, status: null, color: null, created_at: 'c' } as never))
            .toStrictEqual({ id: 2, operationId: 'op', name: 'N', description: undefined, phaseType: 'sequential', sortOrder: 0, status: 'Pending', color: undefined, createdAt: 'c' });
    });

    it('toOperationScheduleEntry: full and defaulted', () => {
        expect(toOperationScheduleEntry({
            id: 1, operation_id: 'op', label: 'Muster', scheduled_time: 't', phase_id: 4, notes: 'n', status: 'Done', sort_order: 3, created_at: 'c', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, operationId: 'op', label: 'Muster', scheduledTime: 't', phaseId: 4, notes: 'n', status: 'Done', sortOrder: 3, createdAt: 'c',
        });
        expect(toOperationScheduleEntry({ id: 2, operation_id: 'op', label: 'L', scheduled_time: 't', phase_id: null, notes: null, status: null, sort_order: null, created_at: 'c' } as never))
            .toStrictEqual({ id: 2, operationId: 'op', label: 'L', scheduledTime: 't', phaseId: undefined, notes: undefined, status: undefined, sortOrder: 0, createdAt: 'c' });
    });

    it('toOperationTask: full (assignee minified) and defaulted', () => {
        const t = toOperationTask({
            id: 1, operation_id: 'op', title: 'Hold', description: 'd', task_type: 'secondary', assigned_unit_id: 4,
            assigned_user_id: 11, assigned_user: secretUserRow(11, 'Assignee'), assigned_unit: { id: 4, name: 'Alpha', sort_order: 1 },
            phase_id: 2, status: 'Done', priority: 'High', sort_order: 5, created_at: 'c', secret_LEAK: 1,
        } as never);
        expectMiniUser(t.assignedUser, 11, 'Assignee');
        expect(t).toStrictEqual({
            id: 1, operationId: 'op', title: 'Hold', description: 'd', taskType: 'secondary', assignedUnitId: 4,
            assignedUserId: 11, assignedUser: t.assignedUser,
            assignedUnit: {
                id: 4, name: 'Alpha', parentUnitId: undefined, sortOrder: 1, leaderId: undefined, logoUrl: undefined,
                bannerUrl: undefined, motto: undefined, description: undefined, hasRadioChannel: true,
                linkedChannelId: undefined, leader: undefined, isRestricted: undefined,
            },
            phaseId: 2, status: 'Done', priority: 'High', sortOrder: 5, createdAt: 'c',
        });
        expect(toOperationTask({
            id: 2, operation_id: 'op', title: 'T', description: null, task_type: null, assigned_unit_id: null, assigned_user_id: null,
            phase_id: null, status: null, priority: null, sort_order: null, created_at: 'c',
        } as never)).toStrictEqual({
            id: 2, operationId: 'op', title: 'T', description: undefined, taskType: 'primary', assignedUnitId: undefined,
            assignedUserId: undefined, assignedUser: undefined, assignedUnit: undefined, phaseId: undefined,
            status: 'Pending', priority: 'Normal', sortOrder: 0, createdAt: 'c',
        });
    });

    it('toOperationCommandNode: full (assignee minified) and defaulted', () => {
        const n = toOperationCommandNode({
            id: 1, operation_id: 'op', parent_id: 9, label: 'CO', node_type: 'command', assigned_user_id: 11,
            assigned_unit_id: 4, assigned_user: secretUserRow(11, 'CO'), assigned_unit: { id: 4, name: 'Alpha', sort_order: 1 },
            fleet_group_id: 3, pos_x: 10, pos_y: 20, color: '#0f0', icon: 'star', sort_order: 2, live_status: 'Engaged', created_at: 'c',
            secret_LEAK: 1,
        } as never);
        expectMiniUser(n.assignedUser, 11, 'CO');
        expect(n).toStrictEqual({
            id: 1, operationId: 'op', parentId: 9, label: 'CO', nodeType: 'command', assignedUserId: 11, assignedUnitId: 4,
            assignedUser: n.assignedUser, assignedUnit: expect.objectContaining({ id: 4, name: 'Alpha' }),
            fleetGroupId: 3, posX: 10, posY: 20, color: '#0f0', icon: 'star', sortOrder: 2, liveStatus: 'Engaged', createdAt: 'c',
        });
        expect(toOperationCommandNode({
            id: 2, operation_id: 'op', parent_id: null, label: 'L', node_type: null, assigned_user_id: null, assigned_unit_id: null,
            fleet_group_id: null, pos_x: null, pos_y: null, color: null, icon: null, sort_order: null, live_status: null, created_at: 'c',
        } as never)).toStrictEqual({
            id: 2, operationId: 'op', parentId: undefined, label: 'L', nodeType: 'position', assignedUserId: undefined,
            assignedUnitId: undefined, assignedUser: undefined, assignedUnit: undefined, fleetGroupId: undefined,
            posX: 0, posY: 0, color: undefined, icon: undefined, sortOrder: 0, liveStatus: undefined, createdAt: 'c',
        });
    });

    it('toOperationSlotAssignment narrows status to the two legal values', () => {
        const base = { id: 1, operation_id: 'op', slot_id: 2, user_id: 11, user_ship_id: 7, created_at: 'c', updated_at: 'LEAK' };
        expect(toOperationSlotAssignment({ ...base, status: 'applied' } as never)).toStrictEqual({
            id: 1, operationId: 'op', slotId: 2, userId: 11, status: 'applied', userShipId: 7, createdAt: 'c',
        });
        expect(toOperationSlotAssignment({ ...base, status: 'assigned' } as never).status).toBe('assigned');
        // A stray value (no CHECK constraint yet, or a hand-edited row) can never surface
        // as 'applied' and grow an approve/deny control.
        expect(toOperationSlotAssignment({ ...base, status: 'approved-by-admin' } as never).status).toBe('assigned');
        expect(toOperationSlotAssignment({ ...base, status: 'applied', user_ship_id: null } as never).userShipId).toBeUndefined();
    });

    it('toOperationShipSlot: full, defaulted, and capacity 0 is preserved (?? not ||)', () => {
        expect(toOperationShipSlot({
            id: 1, operation_id: 'op', parent_slot_id: 9, ship_id: 3, label: 'Lead ship', seat_role: 'Pilot', capacity: 2,
            sort_order: 4, notes: 'n', created_at: 'c', updated_at: 'LEAK',
            ship: { id: 3, name: 'Hammerhead', image_url: 'hh.png', msrp: 'LEAK' },
            assignments: [{ id: 5, operation_id: 'op', slot_id: 1, user_id: 11, status: 'applied', user_ship_id: null, created_at: 'ac' }],
        } as never)).toStrictEqual({
            id: 1, operationId: 'op', parentSlotId: 9, shipId: 3, ship: { id: 3, name: 'Hammerhead', imageUrl: 'hh.png' },
            label: 'Lead ship', seatRole: 'Pilot', capacity: 2, sortOrder: 4, notes: 'n',
            assignments: [{ id: 5, operationId: 'op', slotId: 1, userId: 11, status: 'applied', userShipId: undefined, createdAt: 'ac' }],
            createdAt: 'c',
        });
        const sparse = { id: 2, operation_id: 'op', parent_slot_id: null, ship_id: null, label: 'S', seat_role: null, sort_order: null, notes: null, created_at: 'c' };
        expect(toOperationShipSlot({ ...sparse, capacity: null, ship: null, assignments: null } as never)).toStrictEqual({
            id: 2, operationId: 'op', parentSlotId: undefined, shipId: undefined, ship: undefined, label: 'S',
            seatRole: undefined, capacity: 1, sortOrder: 0, notes: undefined, assignments: [], createdAt: 'c',
        });
        expect(toOperationShipSlot({ ...sparse, capacity: 0 } as never).capacity).toBe(0);
        expect(toOperationShipSlot({ ...sparse, capacity: 1, ship: { id: 4, name: 'Cutter', image_url: null } } as never).ship)
            .toStrictEqual({ id: 4, name: 'Cutter', imageUrl: undefined });
    });

    it('toOperationBoardElement: full and defaulted', () => {
        expect(toOperationBoardElement({
            id: 1, operation_id: 'op', element_type: 'arrow', label: 'Go', pos_x: 1, pos_y: 2, width: 30, height: 40,
            rotation: 90, color: '#00f', data: { to: [3, 4] }, layer: 2, sort_order: 6, created_at: 'c', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, operationId: 'op', elementType: 'arrow', label: 'Go', posX: 1, posY: 2, width: 30, height: 40,
            rotation: 90, color: '#00f', data: { to: [3, 4] }, layer: 2, sortOrder: 6, createdAt: 'c',
        });
        expect(toOperationBoardElement({
            id: 2, operation_id: 'op', element_type: null, label: null, pos_x: null, pos_y: null, width: null, height: null,
            rotation: null, color: null, data: null, layer: null, sort_order: null, created_at: 'c',
        } as never)).toStrictEqual({
            id: 2, operationId: 'op', elementType: 'unit', label: undefined, posX: 0, posY: 0, width: undefined, height: undefined,
            rotation: 0, color: undefined, data: {}, layer: 0, sortOrder: 0, createdAt: 'c',
        });
    });

    it('toOperationLogisticsItem: full and defaulted', () => {
        expect(toOperationLogisticsItem({
            id: 1, operation_id: 'op', item_name: 'Medpen', quantity_needed: 10, quantity_fulfilled: 4,
            fulfilled_by_user_id: 11, category: 'medical', status: 'Partial', notes: 'n', created_at: 'c', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, operationId: 'op', itemName: 'Medpen', quantityNeeded: 10, quantityFulfilled: 4,
            fulfilledByUserId: 11, category: 'medical', status: 'Partial', notes: 'n', createdAt: 'c',
        });
        expect(toOperationLogisticsItem({
            id: 2, operation_id: 'op', item_name: 'Ammo', quantity_needed: null, quantity_fulfilled: null,
            fulfilled_by_user_id: null, category: null, status: null, notes: null, created_at: 'c',
        } as never)).toStrictEqual({
            id: 2, operationId: 'op', itemName: 'Ammo', quantityNeeded: 1, quantityFulfilled: 0,
            fulfilledByUserId: undefined, category: 'general', status: 'Needed', notes: undefined, createdAt: 'c',
        });
    });

    it('toAAREntry: full (author minified) and defaulted', () => {
        const e = toAAREntry({
            id: 1, operation_id: 'op', author_id: 11, author: secretUserRow(11, 'Writer'), category: 'lesson',
            content: 'text', upvotes: 3, created_at: 'c', secret_LEAK: 1,
        } as never);
        expectMiniUser(e.author, 11, 'Writer');
        expect(e).toStrictEqual({ id: 1, operationId: 'op', authorId: 11, author: e.author, category: 'lesson', content: 'text', upvotes: 3, createdAt: 'c' });
        expect(toAAREntry({ id: 2, operation_id: 'op', author_id: null, author: null, category: null, content: 'x', upvotes: null, created_at: 'c' } as never))
            .toStrictEqual({ id: 2, operationId: 'op', authorId: null, author: undefined, category: 'observation', content: 'x', upvotes: 0, createdAt: 'c' });
    });
});

describe('toHydratedOperation', () => {
    const SPARSE_EXPECTED = {
        id: 'op-2', name: 'Bare', ownerId: undefined, status: 'Planning', type: 'Combat', description: undefined,
        tracksUec: undefined, totalUec: undefined, totalCosts: 0, payoutMode: 'equal', createdAt: undefined,
        updatedAt: undefined, activeStartTime: undefined, activeEndTime: undefined, scheduledStart: undefined,
        scheduledEnd: undefined, isSpecial: undefined, joinCode: undefined, clearanceLevel: 0, isTraining: false,
        maxParticipants: undefined, unitId: undefined, discordEventId: undefined, discordStartNotice: false,
        discordAnnouncementChannelId: undefined, discordAnnouncementMessageId: undefined, templateId: undefined,
        limitingMarkers: [], owner: UNKNOWN_USER, unit: undefined, location: undefined, additionalLocations: [],
        locationText: undefined, additionalLocationTexts: undefined, isJoint: false, roe: undefined,
        commanderNotes: undefined, commsPlan: [], liveStatus: undefined, aarSummary: undefined,
        aarLessonsLearned: undefined, aarSubmittedAt: undefined, aarSubmittedBy: undefined, aarAiGeneratedAt: undefined,
        alliedOrgs: [], alliedParticipants: [], phases: [], scheduleEntries: [], tasks: [], commandNodes: [],
        shipSlots: [], boardElements: [], logistics: [], aarEntries: [], participants: [], log: [],
    };

    it('a bare list-path row gets safe defaults and the Unknown Agent owner', () => {
        expect(toHydratedOperation({ id: 'op-2', name: 'Bare', status: 'Planning', type: 'Combat' } as never)).toStrictEqual(SPARSE_EXPECTED);
    });

    // It used to be HARDCODED to null, so nothing downstream could tell who had left — and
    // the read gates silently admitted former participants while the board policy did not.
    it('maps participant time_left through; absent or null normalises to null (never undefined)', () => {
        const op = toHydratedOperation({
            id: 'op-3', name: 'Concluded', status: 'Concluded', type: 'Combat',
            participants: [
                { user_id: 1, joined_at: 'j', time_left: null },
                { user_id: 2, joined_at: 'j', time_left: '2026-04-01T12:00:00Z' },
                { user_id: 3, joined_at: 'j' },
            ],
        } as never);
        const left = (op.participants as unknown as Array<{ userId: number; timeLeft: unknown }>).map((p) => [p.userId, p.timeLeft]);
        // `=== null` is what every client "active participant" filter compares against.
        expect(left).toStrictEqual([[1, null], [2, '2026-04-01T12:00:00Z'], [3, null]]);
    });

    it('an empty additional_location_texts array is reported as absent', () => {
        const op = toHydratedOperation({ id: 'op-2', name: 'Bare', status: 'Planning', type: 'Combat', additional_location_texts: [], total_costs: null } as never);
        expect(op.additionalLocationTexts).toBeUndefined();
        expect(op.totalCosts).toBe(0);
    });

    it('maps a fully-hydrated detail row: embeds minified, sub-resources mapped, log sorted', () => {
        const op = toHydratedOperation({
            id: 'op-1', name: 'Nightfall', owner_id: 11, status: 'Active', type: 'Combat', description: 'desc',
            tracks_uec: true, total_uec: 5000, total_costs: 1200, payout_mode: 'weighted',
            created_at: 'c', updated_at: 'u', active_start_time: 'as', active_end_time: 'ae',
            scheduled_start: 'ss', scheduled_end: 'se', is_special: true, join_code: 'JOIN-1', clearance_level: 3,
            is_training: true, max_participants: 12, unit_id: 4, discord_event_id: 'ev-1', discord_start_notice: true,
            discord_announcement_channel_id: 'ch-1', discord_announcement_message_id: 'msg-1', template_id: 0,
            limiting_markers: [{ marker: 'NOFORN' }, { marker: null }],
            owner: secretUserRow(11, 'Owner'),
            unit: { id: 4, name: 'Alpha', sort_order: 1 },
            location: { id: 1, name: 'Port Olisar' },
            operation_locations: [
                { is_primary: true, location: { id: 1, name: 'Port Olisar' } },
                { is_primary: false, location: { id: 2, name: 'Grim HEX' } },
                { is_primary: false, location: null },
                null,
            ],
            location_text: 'Stanton > Crusader', additional_location_texts: ['Yela'],
            is_joint: true, roe: 'weapons free', commander_notes: 'cn', comms_plan: [{ channel: 'Ops', frequency: '1' }],
            live_status: 'Engaged', aar_summary: 'sum', aar_lessons_learned: 'll', aar_submitted_at: 'sa',
            aar_submitted_by: 11, aar_ai_generated_at: 'ai',
            allied_orgs: [{ id: 1, operation_id: 'op-1', peer_id: 'p', accepted: true, invited_at: 'i', accepted_at: null, peer: null }],
            allied_participants: [{ operation_id: 'op-1', peer_id: 'p', remote_user_handle: 'h', display_name: 'D', avatar_url: null, role: null, ship_text: null, rsvp_status: 'Accepted', is_ready: false, updated_at: 'u' }],
            phases: [{ id: 1, operation_id: 'op-1', name: 'P', created_at: 'c' }],
            schedule_entries: [{ id: 1, operation_id: 'op-1', label: 'L', scheduled_time: 't', created_at: 'c' }],
            tasks: [{ id: 1, operation_id: 'op-1', title: 'T', created_at: 'c' }],
            command_nodes: [{ id: 1, operation_id: 'op-1', label: 'CO', created_at: 'c' }],
            ship_slots: [{ id: 1, operation_id: 'op-1', label: 'S', capacity: 2, created_at: 'c' }],
            board_elements: [{ id: 1, operation_id: 'op-1', created_at: 'c' }],
            logistics: [{ id: 1, operation_id: 'op-1', item_name: 'I', created_at: 'c' }],
            aar_entries: [{ id: 1, operation_id: 'op-1', author_id: 1, content: 'x', created_at: 'c' }],
            participants: [
                {
                    user_id: 11, joined_at: 'j', is_ready: true, role_requested: 'Pilot', ship_utilized: 'Gladius',
                    attendance_status: 'Present', rsvp_status: 'Accepted', rsvp_at: 'ra', ship_id: 3,
                    ship: { id: 3, name: 'Gladius', manufacturer: 'Aegis' }, user_ship_id: 7, live_status: 'Engaged',
                    payout_share_percent: '25.5', payout_paid_at: 'pp', payout_paid_by: 1, user: secretUserRow(11, 'Owner'),
                },
                {
                    // A FORMER participant: still on the roster when the op concluded.
                    user_id: 12, joined_at: 'j2', time_left: '2026-03-01T00:00:00Z', is_ready: false, role_requested: null, ship_utilized: null,
                    attendance_status: null, rsvp_status: null, rsvp_at: null, ship_id: null, ship: null,
                    user_ship_id: null, live_status: null, payout_share_percent: null, payout_paid_at: null,
                    payout_paid_by: null, user: null,
                },
            ],
            log: [
                { id: 2, operation_id: 'op-1', entry_type: 'cost', log_entry: 'fuel', author_id: 11, created_at: '2026-01-02T00:00:00Z', uec_amount: 50, cost_category: 'fuel', cost_description: 'qt', author: secretUserRow(11, 'Owner') },
                { id: 1, operation_id: 'op-1', entry_type: 'note', log_entry: 'start', author_id: null, created_at: '2026-01-01T00:00:00Z', uec_amount: null, cost_category: null, cost_description: null, author: null },
            ],
            join_pin_hash: 'LEAK-pin', secret_LEAK: 1,
        } as never);

        expectMiniUser(op.owner, 11, 'Owner');
        expect(op.unit).toMatchObject({ id: 4, name: 'Alpha' });
        expect(op.limitingMarkers).toEqual(['NOFORN']);
        expect(op.additionalLocations).toEqual([{ id: 2, name: 'Grim HEX' }]);
        expect(op.additionalLocationTexts).toEqual(['Yela']);
        expect(op.templateId).toBe(0);
        expect(op.alliedOrgs).toEqual([expect.objectContaining({ id: 1, peerId: 'p', acceptedAt: undefined })]);
        expect(op.alliedParticipants).toEqual([expect.objectContaining({ remoteUserHandle: 'h', displayName: 'D' })]);
        expect(op.phases).toEqual([expect.objectContaining({ id: 1, phaseType: 'sequential' })]);
        expect(op.scheduleEntries).toEqual([expect.objectContaining({ id: 1, label: 'L' })]);
        expect(op.tasks).toEqual([expect.objectContaining({ id: 1, taskType: 'primary' })]);
        expect(op.commandNodes).toEqual([expect.objectContaining({ id: 1, nodeType: 'position' })]);
        expect(op.shipSlots).toEqual([expect.objectContaining({ id: 1, capacity: 2, assignments: [] })]);
        expect(op.boardElements).toEqual([expect.objectContaining({ id: 1, elementType: 'unit' })]);
        expect(op.logistics).toEqual([expect.objectContaining({ id: 1, itemName: 'I', status: 'Needed' })]);
        expect(op.aarEntries).toEqual([expect.objectContaining({ id: 1, category: 'observation' })]);

        const [p1, p2] = op.participants as unknown as Array<Record<string, unknown>>;
        expectMiniUser(p1.user, 11, 'Owner');
        expect(p1).toStrictEqual({
            userId: 11, timeJoined: 'j', timeLeft: null, isReady: true, roleRequested: 'Pilot', shipUtilized: 'Gladius',
            attendanceStatus: 'Present', rsvpStatus: 'Accepted', rsvpAt: 'ra', shipId: 3,
            ship: expect.objectContaining({ id: 3, name: 'Gladius', manufacturer: 'Aegis' }), userShipId: 7,
            liveStatus: 'Engaged', payoutSharePercent: 25.5, payoutPaidAt: 'pp', payoutPaidBy: 1, user: p1.user,
        });
        expect(p2).toStrictEqual({
            userId: 12, timeJoined: 'j2', timeLeft: '2026-03-01T00:00:00Z', isReady: false, roleRequested: null, shipUtilized: null,
            attendanceStatus: null, rsvpStatus: undefined, rsvpAt: undefined, shipId: undefined, ship: undefined,
            userShipId: undefined, liveStatus: undefined, payoutSharePercent: undefined, payoutPaidAt: undefined,
            payoutPaidBy: undefined, user: UNKNOWN_USER,
        });

        const log = op.log as unknown as Array<Record<string, unknown>>;
        expect(log.map(l => l.id)).toEqual([1, 2]);
        expect(log[0]).toStrictEqual({
            id: 1, operationId: 'op-1', entryType: 'note', logEntry: 'start', authorId: null, createdAt: '2026-01-01T00:00:00Z',
            uecAmount: null, costCategory: undefined, costDescription: undefined, author: UNKNOWN_USER,
        });
        expectMiniUser(log[1].author, 11, 'Owner');
        expect(log[1]).toMatchObject({ costCategory: 'fuel', costDescription: 'qt', uecAmount: 50 });

        expect(op).toStrictEqual({
            ...SPARSE_EXPECTED,
            id: 'op-1', name: 'Nightfall', ownerId: 11, status: 'Active', description: 'desc', tracksUec: true,
            totalUec: 5000, totalCosts: 1200, payoutMode: 'weighted', createdAt: 'c', updatedAt: 'u',
            activeStartTime: 'as', activeEndTime: 'ae', scheduledStart: 'ss', scheduledEnd: 'se', isSpecial: true,
            joinCode: 'JOIN-1', clearanceLevel: 3, isTraining: true, maxParticipants: 12, unitId: 4,
            discordEventId: 'ev-1', discordStartNotice: true, discordAnnouncementChannelId: 'ch-1',
            discordAnnouncementMessageId: 'msg-1', templateId: 0, limitingMarkers: ['NOFORN'], owner: op.owner,
            unit: op.unit, location: { id: 1, name: 'Port Olisar' }, additionalLocations: op.additionalLocations,
            locationText: 'Stanton > Crusader', additionalLocationTexts: ['Yela'], isJoint: true, roe: 'weapons free',
            commanderNotes: 'cn', commsPlan: [{ channel: 'Ops', frequency: '1' }], liveStatus: 'Engaged',
            aarSummary: 'sum', aarLessonsLearned: 'll', aarSubmittedAt: 'sa', aarSubmittedBy: 11, aarAiGeneratedAt: 'ai',
            alliedOrgs: op.alliedOrgs, alliedParticipants: op.alliedParticipants, phases: op.phases,
            scheduleEntries: op.scheduleEntries, tasks: op.tasks, commandNodes: op.commandNodes, shipSlots: op.shipSlots,
            boardElements: op.boardElements, logistics: op.logistics, aarEntries: op.aarEntries,
            participants: op.participants, log: op.log,
        });
        expect(JSON.stringify(op)).not.toContain('LEAK');
    });
});
