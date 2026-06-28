// MembersContext owns the Members slices (users, ranks, units, roles,
// clearances, markers, specializations, certifications, commendations, Discord
// role-sync maps) plus their CRUD and user-admin methods.
//
// Mounts OUTSIDE DataProvider so DataContext can call useMembers() inside its
// body and re-expose the Members fields on its own context value, keeping the
// useData() surface unchanged.
//
// `members` is the derived list of staff users (Member, Dispatcher, Admin).
//
// Hydration: registers a slice setter per slice with DataCore, populated when
// applyStateData(data) runs after a 'main'/'discord'/etc subset fetch.
//
// CRUD methods refresh the relevant subset after their RPC. refreshMainState/
// refreshDiscord are defined in DataContext and registered here via register*
// callbacks so CRUD can refresh without depending on useData() (would cycle).

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    User, UserRole, Rank, OrganizationalUnit, Role,
    SecurityClearance, LimitingMarker, SpecializationTag, Certification, Commendation,
    DiscordRole,
} from '../types';

export interface MembersContextValue {
    allUsers: User[];
    ranks: Rank[];
    units: OrganizationalUnit[];
    roles: Role[];
    securityClearances: SecurityClearance[];
    limitingMarkers: LimitingMarker[];
    specializationTags: SpecializationTag[];
    certifications: Certification[];
    commendations: Commendation[];
    syncedDiscordRoles: DiscordRole[];
    rankMappings: Record<string, string>;
    roleMappings: Record<string, string>;

    members: User[];

    // Exposed for DataContext's optimisticUpdate ('ranks', 'organizational_units')
    // branches.
    setAllUsers: React.Dispatch<React.SetStateAction<User[]>>;
    setRanks: React.Dispatch<React.SetStateAction<Rank[]>>;
    setUnits: React.Dispatch<React.SetStateAction<OrganizationalUnit[]>>;
    setRoles: React.Dispatch<React.SetStateAction<Role[]>>;
    setSecurityClearances: React.Dispatch<React.SetStateAction<SecurityClearance[]>>;
    setLimitingMarkers: React.Dispatch<React.SetStateAction<LimitingMarker[]>>;
    setSpecializationTags: React.Dispatch<React.SetStateAction<SpecializationTag[]>>;
    setCertifications: React.Dispatch<React.SetStateAction<Certification[]>>;
    setCommendations: React.Dispatch<React.SetStateAction<Commendation[]>>;
    setSyncedDiscordRoles: React.Dispatch<React.SetStateAction<DiscordRole[]>>;
    setRankMappings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    setRoleMappings: React.Dispatch<React.SetStateAction<Record<string, string>>>;

    addUnit: (data: any) => Promise<void>;
    updateUnit: (data: any) => Promise<void>;
    deleteUnit: (id: number) => Promise<void>;

    addRank: (data: any) => Promise<void>;
    updateRank: (data: any) => Promise<void>;
    deleteRank: (id: number) => Promise<void>;

    addRole: (data: any) => Promise<void>;
    updateRole: (data: any) => Promise<void>;
    deleteRole: (id: number) => Promise<void>;
    getRoleDetails: (id: number) => Promise<any>;
    updateRolePermissions: (id: number, perms: string[]) => Promise<void>;

    addSpecializationTag: (data: any) => Promise<void>;
    updateSpecializationTag: (data: any) => Promise<void>;
    deleteSpecializationTag: (id: number) => Promise<void>;

    addCertification: (data: any) => Promise<void>;
    updateCertification: (data: any) => Promise<void>;
    deleteCertification: (id: number) => Promise<void>;

    addCommendation: (data: any) => Promise<void>;
    updateCommendation: (data: any) => Promise<void>;
    deleteCommendation: (id: number) => Promise<void>;

    syncDiscordRoles: () => Promise<void>;
    updateRankMapping: (discordRoleId: string, rankId: string, roleId?: string) => Promise<void>;
    /** Fetch the (admin-gated) 'discord' subset. The role-sync maps no longer
     *  ride the boot payload — DiscordSettingsTab calls this on mount. */
    refreshDiscord: () => Promise<void>;

    // User admin methods
    updateUserRecord: (id: number, data: any) => Promise<void>;
    adjustUserReputation: (id: number, amount: number, reason: string) => Promise<void>;
    awardCertification: (userId: number, certId: number) => Promise<void>;
    awardCommendation: (userId: number, commendId: number, reason: string) => Promise<void>;
    addConductEntry: (userId: number, type: string, reason: string) => Promise<void>;
    revokeCertification: (userId: number, certId: number) => Promise<void>;
    revokeCommendation: (commendId: number) => Promise<void>;
    updateUserClearance: (userId: number, levelId: number | null, markerIds: number[]) => Promise<void>;
    promoteUserToMember: (id: number) => Promise<void>;

    /** DataContext registers its refreshMainState callback here once defined;
     *  Members's CRUD methods invoke it after their RPC completes. */
    registerRefreshMainState: (fn: () => Promise<void> | void) => () => void;
    /** Same, for the 'discord' subset — used by syncDiscordRoles and updateRankMapping. */
    registerRefreshDiscord: (fn: () => Promise<void> | void) => () => void;
}

const MembersContext = createContext<MembersContextValue | null>(null);

export const MembersProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { rpcAction, registerSliceSetter } = useDataCore();

    const [allUsers, setAllUsers] = useState<User[]>([]);
    const [ranks, setRanks] = useState<Rank[]>([]);
    const [units, setUnits] = useState<OrganizationalUnit[]>([]);
    const [roles, setRoles] = useState<Role[]>([]);
    const [securityClearances, setSecurityClearances] = useState<SecurityClearance[]>([]);
    const [limitingMarkers, setLimitingMarkers] = useState<LimitingMarker[]>([]);
    const [specializationTags, setSpecializationTags] = useState<SpecializationTag[]>([]);
    const [certifications, setCertifications] = useState<Certification[]>([]);
    const [commendations, setCommendations] = useState<Commendation[]>([]);
    const [syncedDiscordRoles, setSyncedDiscordRoles] = useState<DiscordRole[]>([]);
    const [rankMappings, setRankMappings] = useState<Record<string, string>>({});
    const [roleMappings, setRoleMappings] = useState<Record<string, string>>({});

    // Derived list of staff users (Member, Dispatcher, Admin). Used widely as
    // the "internal org members" dropdown / picker source vs the broader
    // allUsers which includes Clients.
    const members = useMemo(
        () => allUsers.filter(u => u.role === UserRole.Member || u.role === UserRole.Dispatcher || u.role === UserRole.Admin),
        [allUsers],
    );

    // DataContext registers refreshMainState/refreshDiscord here on mount; held
    // in refs so CRUD method identities stay stable across refresh-fn changes.
    const refreshMainStateRef = useRef<(() => Promise<void> | void) | null>(null);
    const refreshDiscordRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshMainState = useCallback((fn: () => Promise<void> | void) => {
        refreshMainStateRef.current = fn;
        return () => {
            if (refreshMainStateRef.current === fn) refreshMainStateRef.current = null;
        };
    }, []);
    const registerRefreshDiscord = useCallback((fn: () => Promise<void> | void) => {
        refreshDiscordRef.current = fn;
        return () => {
            if (refreshDiscordRef.current === fn) refreshDiscordRef.current = null;
        };
    }, []);

    const refreshMain = useCallback(async () => {
        const fn = refreshMainStateRef.current;
        if (fn) await fn();
    }, []);
    const refreshDiscord = useCallback(async () => {
        const fn = refreshDiscordRef.current;
        if (fn) await fn();
    }, []);

    // Each setter applies its slice when applyStateData(data) runs after a
    // 'main'/'discord'/etc subset fetch.
    useEffect(() => {
        const cleanups = [
            registerSliceSetter('users', (data: any) => { if (data.users) setAllUsers(data.users); }),
            registerSliceSetter('ranks', (data: any) => { if (data.ranks) setRanks(data.ranks); }),
            registerSliceSetter('units', (data: any) => { if (data.units) setUnits(data.units); }),
            registerSliceSetter('roles', (data: any) => { if (data.roles) setRoles(data.roles); }),
            registerSliceSetter('securityClearances', (data: any) => { if (data.securityClearances) setSecurityClearances(data.securityClearances); }),
            registerSliceSetter('limitingMarkers', (data: any) => { if (data.limitingMarkers) setLimitingMarkers(data.limitingMarkers); }),
            registerSliceSetter('specializationTags', (data: any) => { if (data.specializationTags) setSpecializationTags(data.specializationTags); }),
            registerSliceSetter('certifications', (data: any) => { if (data.certifications) setCertifications(data.certifications); }),
            registerSliceSetter('commendations', (data: any) => { if (data.commendations) setCommendations(data.commendations); }),
            registerSliceSetter('syncedDiscordRoles', (data: any) => { if (data.syncedDiscordRoles) setSyncedDiscordRoles(data.syncedDiscordRoles); }),
            registerSliceSetter('rankMappings', (data: any) => { if (data.rankMappings) setRankMappings(data.rankMappings); }),
            registerSliceSetter('roleMappings', (data: any) => { if (data.roleMappings) setRoleMappings(data.roleMappings); }),
        ];
        return () => cleanups.forEach(unreg => unreg());
    }, [registerSliceSetter]);

    // CRUD methods refresh the 'main' subset after their RPC. The optimistic
    // writes for ranks/units live here in the CRUD body (using the local setters
    // directly); DataContext.optimisticUpdate's rank/unit branches remain a
    // public utility but no longer drive these CRUDs.

    // Units
    const addUnit = useCallback((data: any) =>
        rpcAction('admin:add_unit', data).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateUnit = useCallback((data: any) => {
        // Optimistic write before the RPC.
        setUnits(prev => prev.map(item => item.id === data.id ? { ...item, ...data } : item));
        return rpcAction('admin:update_unit', data).then(() => refreshMain());
    }, [rpcAction, refreshMain]);

    const deleteUnit = useCallback((id: number) => {
        // Optimistic delete; on RPC failure, refreshMain() in catch reverts.
        setUnits(prev => prev.filter(item => item.id !== id));
        return rpcAction('admin:delete_unit', { unitId: id })
            .then(() => refreshMain())
            .catch(err => { void refreshMain(); throw err; });
    }, [rpcAction, refreshMain]);

    // Ranks
    const addRank = useCallback((data: any) =>
        rpcAction('admin:add_rank', data).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateRank = useCallback((data: any) => {
        setRanks(prev => prev.map(item => item.id === data.id ? { ...item, ...data } : item));
        return rpcAction('admin:update_rank', data).then(() => refreshMain());
    }, [rpcAction, refreshMain]);

    const deleteRank = useCallback((id: number) => {
        setRanks(prev => prev.filter(item => item.id !== id));
        return rpcAction('admin:delete_rank', { rankId: id }).then(() => refreshMain());
    }, [rpcAction, refreshMain]);

    // Roles
    const addRole = useCallback((data: any) =>
        rpcAction('admin:add_role', { roleData: data }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateRole = useCallback((data: any) =>
        rpcAction('admin:update_role', { roleData: data }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const deleteRole = useCallback((id: number) =>
        rpcAction('admin:delete_role', { roleId: id }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const getRoleDetails = useCallback((id: number) =>
        rpcAction('admin:get_role_details', { roleId: id }),
    [rpcAction]);

    const updateRolePermissions = useCallback((id: number, perms: string[]) =>
        rpcAction('admin:update_role_permissions', { roleId: id, permissionNames: perms }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // Specialization Tags
    const addSpecializationTag = useCallback((tagData: any) =>
        rpcAction('admin:add_specialization', { tagData }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateSpecializationTag = useCallback((tagData: any) =>
        rpcAction('admin:update_specialization', { tagData }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const deleteSpecializationTag = useCallback((tagId: number) =>
        rpcAction('admin:delete_specialization', { tagId }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // Certifications
    const addCertification = useCallback((certData: any) =>
        rpcAction('admin:add_certification', { certData }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateCertification = useCallback((certData: any) =>
        rpcAction('admin:update_certification', { certData }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const deleteCertification = useCallback((certId: number) =>
        rpcAction('admin:delete_certification', { certId }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // Commendations
    const addCommendation = useCallback((commendData: any) =>
        rpcAction('admin:add_commendation', { commendData }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateCommendation = useCallback((commendData: any) =>
        rpcAction('admin:update_commendation', { commendData }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const deleteCommendation = useCallback((commendId: number) =>
        rpcAction('admin:delete_commendation', { commendId }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // Discord sync
    const syncDiscordRoles = useCallback(async () => {
        await rpcAction('admin:sync_discord_roles', {});
        await refreshDiscord();
    }, [rpcAction, refreshDiscord]);

    // Optimistic local write to rankMappings (and roleMappings if a roleId is
    // given) before the RPC, then refresh on success or failure.
    const updateRankMapping = useCallback(async (discordRoleId: string, rankId: string, roleId?: string) => {
        setRankMappings(prev => ({ ...prev, [discordRoleId]: rankId }));
        if (roleId !== undefined) setRoleMappings(prev => ({ ...prev, [discordRoleId]: roleId }));
        try {
            await rpcAction('admin:update_rank_mapping', { discordRoleId, rankId, roleId });
            await refreshDiscord();
        } catch (e) {
            console.error('Failed to update rank mapping', e);
            void refreshDiscord();
        }
    }, [rpcAction, refreshDiscord]);

    // User admin methods — thin RPC wrappers followed by a 'main' subset refresh.
    const updateUserRecord = useCallback((userId: number, data: any) =>
        rpcAction('admin:update_user', { targetUserId: userId, ...data }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const adjustUserReputation = useCallback((userId: number, amount: number, reason: string) =>
        rpcAction('admin:adjust_rep', { targetUserId: userId, newReputation: amount, reason }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const awardCertification = useCallback((userId: number, certId: number) =>
        rpcAction('admin:award_certification', { targetUserId: userId, certificationId: certId }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const awardCommendation = useCallback((userId: number, commendId: number, reason: string) =>
        rpcAction('admin:award_commendation', { targetUserId: userId, commendationId: commendId, reason }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const addConductEntry = useCallback((userId: number, type: string, reason: string) =>
        rpcAction('admin:add_conduct_entry', { targetUserId: userId, type, reason }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const revokeCertification = useCallback((userId: number, certId: number) =>
        rpcAction('admin:revoke_certification', { targetUserId: userId, certificationId: certId }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const revokeCommendation = useCallback((commendId: number) =>
        rpcAction('admin:revoke_commendation', { awardedCommendationId: commendId }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateUserClearance = useCallback((userId: number, levelId: number | null, markerIds: number[]) =>
        rpcAction('admin:update_user_clearance', { targetUserId: userId, levelId, markerIds }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // Refreshes only the 'main' subset (updated allUsers), not the full session:
    // an admin promotes another user, so the actor's own record is unchanged.
    const promoteUserToMember = useCallback((id: number) =>
        rpcAction('admin:promote_user', { targetUserId: id }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const value = useMemo<MembersContextValue>(() => ({
        allUsers, ranks, units, roles,
        securityClearances, limitingMarkers, specializationTags, certifications, commendations,
        syncedDiscordRoles, rankMappings, roleMappings,
        members,
        setAllUsers, setRanks, setUnits, setRoles,
        setSecurityClearances, setLimitingMarkers, setSpecializationTags, setCertifications, setCommendations,
        setSyncedDiscordRoles, setRankMappings, setRoleMappings,
        addUnit, updateUnit, deleteUnit,
        addRank, updateRank, deleteRank,
        addRole, updateRole, deleteRole, getRoleDetails, updateRolePermissions,
        addSpecializationTag, updateSpecializationTag, deleteSpecializationTag,
        addCertification, updateCertification, deleteCertification,
        addCommendation, updateCommendation, deleteCommendation,
        syncDiscordRoles, updateRankMapping, refreshDiscord,
        updateUserRecord, adjustUserReputation,
        awardCertification, awardCommendation, addConductEntry,
        revokeCertification, revokeCommendation,
        updateUserClearance, promoteUserToMember,
        registerRefreshMainState, registerRefreshDiscord,
    }), [
        allUsers, ranks, units, roles,
        securityClearances, limitingMarkers, specializationTags, certifications, commendations,
        syncedDiscordRoles, rankMappings, roleMappings,
        members,
        addUnit, updateUnit, deleteUnit,
        addRank, updateRank, deleteRank,
        addRole, updateRole, deleteRole, getRoleDetails, updateRolePermissions,
        addSpecializationTag, updateSpecializationTag, deleteSpecializationTag,
        addCertification, updateCertification, deleteCertification,
        addCommendation, updateCommendation, deleteCommendation,
        syncDiscordRoles, updateRankMapping, refreshDiscord,
        updateUserRecord, adjustUserReputation,
        awardCertification, awardCommendation, addConductEntry,
        revokeCertification, revokeCommendation,
        updateUserClearance, promoteUserToMember,
        registerRefreshMainState, registerRefreshDiscord,
    ]);

    return <MembersContext value={value}>{children}</MembersContext>;
};

export const useMembers = (): MembersContextValue => {
    const ctx = use(MembersContext);
    if (!ctx) throw new Error('useMembers must be used within a MembersProvider');
    return ctx;
};
