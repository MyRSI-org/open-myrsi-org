
import * as db from '../../lib/db.js';
import type { ShipStatus, FleetGroupType } from '../../types.js';

// --- Payload shapes ---
// Numeric ids are treated as numbers by the lib/db layer.

interface AddShipPayload {
    userId: number;
    shipId: number;
    customName: string | null;
    loadoutNotes: string | null;
}

interface AddShipsPayload {
    userId: number;
    shipIds: number[];
}

// Partial UserShip-like fields the db update path reads off `updates`.
interface UserShipUpdates {
    customName?: string | null;
    loadoutNotes?: string | null;
    status?: ShipStatus;
    isPrimary?: boolean;
}

// Actor identity injected by the dispatcher (userId is force-set to the
// authenticated user; user carries role + permissions).
type ActorFields = { userId?: number; user?: { role?: string; permissions?: string[] } };

interface UpdateShipPayload extends ActorFields {
    userShipId: number;
    updates: UserShipUpdates;
}

interface RemoveShipPayload extends ActorFields {
    userShipId: number;
}

interface RemoveShipsPayload extends ActorFields {
    userShipIds: number[];
}

// Members with only fleet:manage_own may mutate ONLY their own ships. fleet:manage
// holders operate org-wide → pass undefined (no scoping). NO ROLE-NAME BYPASS: a
// permissionless custom role called "Commander" escaped own-ship scoping. Admin and
// Dispatcher are both seeded with fleet:manage.
function fleetOwnScope(user?: { permissions?: string[] }, userId?: number): number | undefined {
    const canManageAll = Array.isArray(user?.permissions) && user!.permissions!.includes('fleet:manage');
    return canManageAll ? undefined : userId;
}

// Fields the db create/update path reads off a fleet group payload.
interface FleetGroupData {
    name: string;
    type?: FleetGroupType | string;
    parentId?: number | null;
    commanderId?: number | null;
    description?: string | null;
    icon?: string | null;
    sortOrder?: number;
}

interface CreateGroupPayload {
    groupData: FleetGroupData;
}

interface UpdateGroupPayload {
    groupId: number;
    updates: Partial<FleetGroupData>;
}

interface DeleteGroupPayload {
    groupId: number;
}

interface AssignShipPayload {
    fleetGroupId: number;
    userShipId: number;
}

interface ReorderGroupsPayload {
    orderedIds: number[];
}

interface ReorderGroupShipsPayload {
    fleetGroupId: number;
    orderedAssignmentIds: number[];
}

interface ReparentGroupPayload {
    groupId: number;
    newParentId?: number | null;
    newSortOrder: number;
}

export const fleetActions = {
    'fleet:add_ship': ({ userId, shipId, customName, loadoutNotes }: AddShipPayload) =>
        db.addUserShip(userId, shipId, customName, loadoutNotes),

    'fleet:add_ships': ({ userId, shipIds }: AddShipsPayload) =>
        db.addUserShips(userId, shipIds),

    'fleet:update_ship': ({ userShipId, updates, userId, user }: UpdateShipPayload) =>
        db.updateUserShip(userShipId, updates, fleetOwnScope(user, userId)),

    'fleet:remove_ship': ({ userShipId, userId, user }: RemoveShipPayload) =>
        db.removeUserShip(userShipId, fleetOwnScope(user, userId)),

    'fleet:remove_ships': ({ userShipIds, userId, user }: RemoveShipsPayload) =>
        db.removeUserShips(userShipIds, fleetOwnScope(user, userId)),

    'fleet:create_group': ({ groupData }: CreateGroupPayload) =>
        db.createFleetGroup(groupData),

    'fleet:update_group': ({ groupId, updates }: UpdateGroupPayload) =>
        db.updateFleetGroup(groupId, updates),

    'fleet:delete_group': ({ groupId }: DeleteGroupPayload) =>
        db.deleteFleetGroup(groupId),

    'fleet:assign_ship': ({ fleetGroupId, userShipId }: AssignShipPayload) =>
        db.assignShipToGroup(fleetGroupId, userShipId),

    'fleet:unassign_ship': ({ fleetGroupId, userShipId }: AssignShipPayload) =>
        db.removeShipFromGroup(fleetGroupId, userShipId),

    'fleet:reorder_groups': ({ orderedIds }: ReorderGroupsPayload) =>
        db.reorderFleetGroups(orderedIds),

    'fleet:reorder_group_ships': ({ fleetGroupId, orderedAssignmentIds }: ReorderGroupShipsPayload) =>
        db.reorderGroupShips(fleetGroupId, orderedAssignmentIds),

    'fleet:reparent_group': ({ groupId, newParentId, newSortOrder }: ReparentGroupPayload) =>
        db.reparentFleetGroup(groupId, newParentId ?? null, newSortOrder),

    'fleet:sync_catalog': () =>
        db.syncShipCatalog(),
};
