
import {
    User, Rank, OrganizationalUnit, Announcement,
    HydratedOperation, HydratedWarrant, HydratedIntelligenceReport, IntelBulletin,
    OperationAlliedOrg, AlliedParticipant, MirroredOperation,
    HydratedHRApplication, JobPosting, TransferRequest, PersonnelPosition,
    WikiPage, HRInterviewTemplate, HydratedHRInterview,
    HydratedReputationHistoryEntry, RatingHistoryEntry,
    UserRole,
    UnitPost,
    ServiceTypeConfig,
    HydratedServiceRequest,
    PlatformShip, UserShip, FleetGroup, ShipStatus, FleetGroupType,
    TreasuryAccount, LedgerEntry, LedgerCounterparty,
    QmCatalogItem, QmLocation, QmInventoryItem, QmIssuance, QmUserRef,
    QmPlatformItem, QmPlatformCategory,
    WarehousePlatformCommodity, WarehousePlatformCategory,
    PlatformLocation, PlatformLocationKind,
    SpecializationTag, Certification, Commendation,
    AnnouncementType, WarrantAction, WarrantStatus, IntelSubjectType, IntelThreatLevel,
    OperationStatus, OperationType, ApplicationStatus, JobPostingStatus, TransferRequestStatus,
    UrgencyLevel, ThreatLevel, ServiceRequestStatus,
    TreasuryAccountType, LedgerEntryType, LedgerEntryStatus,
    QmCatalogCategory, QmCatalogSource, QmLocationType, QmCondition, QmIssuanceStatus, QmOutcome,
    PlatformLocationAmenities, CommsPlanEntry, ConductRecordType,
    AcademyUserRef, AcademyLesson, AcademyModule, AcademyOutcome, AcademyCourse,
    AcademySession, AcademyLessonProgress, AcademyOutcomeResult, AcademyEnrollment,
    AcademyCourseStatus, AcademyCourseAccess, AcademyCourseDelivery,
    AcademySessionStatus, AcademyEnrollmentSource, AcademyEnrollmentStatus, AcademyOutcomeVerdict,
    Blueprint, CraftableItem, BlueprintRequest, BlueprintRequestStatus, MarketplaceTrader,
} from '../../types.js';
import type { Tables, NullToUndefined } from './rows.js';
// One-way edge into the strip's allow-list so the embed minifier and the roster
// boundary share ONE definition of "safe to show another member". userFilters.ts
// imports only ../../types.js, so this creates no cycle — keep it that way.
import { buildRosterSafeUser } from './userFilters.js';

// ---------------------------------------------------------------------------
// Shared embed helpers
// ---------------------------------------------------------------------------

/**
 * A user row as it arrives from a hydrating PostgREST query: the flat users
 * Row plus the (optional) joined relations the toUser body reads. Joins may be
 * absent, so every embed field is optional. The shape mirrors exactly what the
 * mapper dereferences — nothing more.
 */
type UserRowWithEmbeds = NullToUndefined<Tables<'users'>> & {
    role?: (Tables<'roles'> & {
        role_permissions?: Array<Tables<'role_permissions'> & {
            permission?: Pick<Tables<'permissions'>, 'name'> | null;
        }> | null;
    }) | null;
    rank?: RankRow | null;
    // PostgREST may return the FK relation un-aliased as `units` or aliased as `unit`.
    unit?: UnitRowWithEmbeds | null;
    units?: UnitRowWithEmbeds | null;
    position?: NullToUndefined<Tables<'personnel_positions'>> | null;
    secondaryPosition?: NullToUndefined<Tables<'personnel_positions'>> | null;
    clearance_level?: User['clearanceLevel'];
    limiting_markers?: Array<{ marker?: string | null }> | null;
    specializations?: Array<{ specialization?: Tables<'specialization_tags'> | null }> | null;
    certifications?: Array<{
        certification?: Tables<'certifications'> | null;
        awarded_at?: string | null;
        awardedBy?: { id?: number; name?: string } | null;
    }> | null;
    commendations?: Array<{
        commendation?: Tables<'commendations'> | null;
        reason?: string | null;
        awarded_at?: string | null;
        awardedBy?: { id?: number; name?: string } | null;
    }> | null;
    conductRecord?: Array<{
        id?: number;
        type?: ConductRecordType;
        reason?: string;
        enteredBy?: { id: number; name: string } | null;
        created_at?: string;
    }> | null;
};

// Rank rows can arrive either as a real ranks Row or the fallback {} the caller
// passes; keep the flat Row and let the body's `|| default` guards cover gaps.
type RankRow = NullToUndefined<Tables<'ranks'>>;

type UnitRowWithEmbeds = NullToUndefined<Tables<'units'>> & {
    leader?: UserRowWithEmbeds | null;
};

// ---------------------------------------------------------------------------

export const toSpecializationTag = (db: Tables<'specialization_tags'>): SpecializationTag => ({
    id: db?.id || 0,
    name: db?.name || 'Unknown',
    description: db?.description || undefined,
    icon: db?.icon || undefined,
    imageUrl: db?.image_url || undefined,
});

export const toCertification = (db: Tables<'certifications'>): Certification => ({
    id: db?.id || 0,
    name: db?.name || 'Unknown',
    description: db?.description || undefined,
    icon: db?.icon || undefined,
    imageUrl: db?.image_url || undefined,
});

export const toCommendation = (db: Tables<'commendations'>): Commendation => ({
    id: db?.id || 0,
    name: db?.name || 'Unknown',
    description: db?.description || undefined,
    icon: db?.icon || undefined,
    imageUrl: db?.image_url || undefined,
});

// Fallback user object for missing relations
const unknownUser: User = {
    id: 0,
    discordId: '',
    name: 'Unknown Agent',
    avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
    rsiHandle: 'Unknown',
    role: UserRole.Client,
    roleId: 1,
    reputation: 0,
    isDuty: false,
    permissions: [],
    createdAt: new Date().toISOString()
};

/**
 * DISPLAY / AUDIENCE tier (Client/Member/Dispatcher/Admin) for a role name +
 * permission set. announcements.audience and external_tools.audience store these four
 * literal strings (lib/db.ts), and contexts/SessionContext hands the same string to
 * registerRealtimeAuth, so this ladder must keep producing them.
 *
 * IT IS NOT A PRIVILEGE FACT. Nothing in lib/** or api/** gates on it: authorization
 * reads `permissions`, and "is this the org Admin" reads `isSystemAdmin` — role
 * IDENTITY, lib/db/adminIdentity.ts. Pinned by tests/roleNameBoundary.test.ts.
 *
 * Names match BYTE-EXACTLY (after trimming) against the four seeded names. The aliases
 * 'administrator' / 'commander' / 'director' / 'officer' / 'recruit' are gone — they
 * were never seeded role names, roles.name is operator-supplied free text, and
 * 'Recruit'/'Officer' are seeded RANK names an operator could reasonably reuse for a
 * role. Case-insensitive matching went with them: roles_name_key is byte-exact, so
 * 'admin' could coexist with 'Admin' and inherit its audience. The reserved-name guard
 * in lib/db/system.ts (addRole/updateRole) blocks a SUPERSET of what this accepts, so
 * the name branch is unforgeable for any new role.
 *
 * The permission fallback covers unrecognized names (renamed system roles, custom
 * roles). It uses admin:access specifically — NOT any admin:* prefix, since
 * permissions like admin:config:notices are granted to Dispatchers. Retained
 * deliberately, which is why the userFilters.ts admin:access defusal must stay.
 */
export function inferUserRoleTier(roleName: string | null | undefined, permissions: string[]): UserRole {
    const name = (roleName || '').trim();
    if (name === 'Admin') return UserRole.Admin;
    if (name === 'Dispatcher') return UserRole.Dispatcher;
    if (name === 'Member') return UserRole.Member;
    if (!name || name === 'Client') return UserRole.Client;
    if (permissions.includes('admin:access')) return UserRole.Admin;
    if (permissions.includes('request:dispatch') || permissions.includes('request:triage')) return UserRole.Dispatcher;
    if (permissions.includes('request:accept') || permissions.includes('user:toggle_duty')) return UserRole.Member;
    return UserRole.Client;
}

export const toUser = (dbUser: UserRowWithEmbeds | null | undefined): User | undefined => {
    if (!dbUser || typeof dbUser !== 'object') return undefined;

    // Compute permissions early so we can use them for role inference
    const permissions: string[] = dbUser.role?.role_permissions?.map((rp) => rp.permission?.name).filter(Boolean) as string[] || [];

    const role: UserRole = inferUserRoleTier(dbUser.role?.name, permissions);

    // Handle both aliased 'unit' and unaliased 'units' returned by PostgREST
    const unitData = dbUser.unit || dbUser.units;

    // Effective name = user's custom display_name override if set, else the
    // Discord-sourced name. Centralizing here means the ~200 consumers that
    // read `user.name` pick up the override automatically.
    const discordName = dbUser.name || 'Unknown';
    const effectiveName = (dbUser.display_name && String(dbUser.display_name).trim())
        ? String(dbUser.display_name).trim()
        : discordName;

    return {
        id: dbUser.id || 0,
        discordId: dbUser.discord_id || '',
        name: effectiveName,
        displayName: dbUser.display_name ?? null,
        discordName,
        avatarUrl: dbUser.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
        rsiHandle: dbUser.rsi_handle || '',
        roleId: dbUser.role_id || 0,
        role: role,
        rank: dbUser.rank ? toRank(dbUser.rank) : undefined,
        unit: unitData ? toUnit(unitData) : undefined,
        position: dbUser.position ? toPersonnelPosition(dbUser.position) : undefined,
        secondaryPosition: dbUser.secondaryPosition ? toPersonnelPosition(dbUser.secondaryPosition) : undefined,
        reputation: dbUser.reputation || 0,
        isDuty: dbUser.is_duty || false,
        isAffiliate: dbUser.is_affiliate || false,
        isVip: dbUser.is_vip || false,
        permissions: permissions,
        createdAt: dbUser.created_at || new Date().toISOString(),
        adminNotes: dbUser.admin_notes,
        personnelNotes: dbUser.personnel_notes,
        clearanceLevel: dbUser.clearance_level,
        limitingMarkers: dbUser.limiting_markers?.map((m) => m.marker).filter(Boolean) as unknown as User['limitingMarkers'] || [],
        specializations: dbUser.specializations?.map((s) => s.specialization ? toSpecializationTag(s.specialization) : null).filter(Boolean) as SpecializationTag[] || [],
        certifications: dbUser.certifications?.map((c) => ({
            ...toCertification(c.certification as Tables<'certifications'>),
            awardedAt: c.awarded_at,
            awardedBy: c.awardedBy ? (c.awardedBy.id ? c.awardedBy : { id: 0, name: 'Unknown' }) : { id: 0, name: 'Unknown' }
        })) as Certification[] || [],
        commendations: dbUser.commendations?.map((c) => ({
            ...toCommendation(c.commendation as Tables<'commendations'>),
            reason: c.reason,
            awardedAt: c.awarded_at,
            awardedBy: c.awardedBy ? (c.awardedBy.id ? c.awardedBy : { id: 0, name: 'Unknown' }) : { id: 0, name: 'Unknown' }
        })) as Commendation[] || [],
        conductRecord: dbUser.conductRecord?.map((r) => ({
            id: r.id,
            type: r.type,
            reason: r.reason,
            enteredBy: r.enteredBy || { id: 0, name: 'Unknown' },
            createdAt: r.created_at
        })) as User['conductRecord'] || [],
        rsiHandlePending: dbUser.rsi_handle_pending,
        rsiVerificationCode: dbUser.rsi_verification_code,
        rsiVerified: (dbUser as { rsi_verified?: boolean | null }).rsi_verified ?? true,
        jobTitle: dbUser.job_title,
        voiceChannelName: dbUser.voice_channel_name,
        timezone: dbUser.timezone ?? null,
        dateFormat: (dbUser.date_format as User['dateFormat']) ?? null,
        probationStart: dbUser.probation_start || undefined,
        probationEnd: dbUser.probation_end || undefined,
        tenureStartDate: dbUser.tenure_start_date ?? null,
        // tokens_valid_from ships via add-user-session-revocation (idempotent in
        // schema.sql); pre-migration rows read undefined → no per-user revocation.
        tokensValidFrom: (dbUser as { tokens_valid_from?: string | null }).tokens_valid_from ?? null,
    };
};

// Project an already-mapped User down to the SAME allow-list the roster strip gives a
// non-self viewer, with none of its permission-gated restores. Operates on a mapped
// User (e.g. a getUserById result) where toMiniUser cannot.
//
// This was a DENYLIST of ten keys spread over `...full`, which blanked adminNotes /
// personnelNotes / conductRecord / clearance / limitingMarkers / permissions /
// discordId / isSystemAdmin / the RSI verification pair — but left rsiVerified,
// jobTitle, voiceChannelName, timezone, dateFormat, probationStart, probationEnd,
// tenureStartDate and tokensValidFrom untouched. That was safe only incidentally: no
// `users!` embed selects those columns today, and the one non-embed input
// (lib/db/ops.ts minifyUser(owner)) is always the caller's OWN record because
// `userId` is an ACTOR_ID_FIELD the dispatcher force-overwrites. Sharing
// buildRosterSafeUser with lib/db/userFilters.ts makes the omission structural: the
// embed boundary and the roster boundary can no longer drift apart, and a column a
// future SELECT adds is absent by default rather than one denylist entry away.
//
// isSystemAdmin (a SERVER-INTERNAL fact stamped on the session actor by
// lib/db/adminIdentity.ts) is not on the allow-list, so it is now ABSENT rather than
// present-and-undefined — JSON-equivalent, and the browser must never gate on it.
export const blankSensitiveUserFields = (full: User): User => buildRosterSafeUser(full);

// minifyUser blanks a mapped User (or passes through nullish), for callers that
// already hold a hydrated User and need a safe-to-embed projection.
export const minifyUser = (full: User | null | undefined): User | undefined =>
    full ? blankSensitiveUserFields(full) : undefined;

// Minimal user projection for embedding a user INSIDE another row (warrant
// issuer/claimer, intel/bulletin/wiki author, request client, op participant,
// etc.). Reuses toUser for public identity + professional fields, then blanks
// private/security fields via the shared helper.
export const toMiniUser = (dbUser: UserRowWithEmbeds | null | undefined): User | undefined => {
    const full = toUser(dbUser);
    if (!full) return undefined;
    return blankSensitiveUserFields(full);
};

export const toRank = (dbRank: RankRow | null | undefined): Rank => {
    if (!dbRank) return { id: 0, name: 'Unknown', iconUrl: '', sortOrder: 999 };
    return {
        id: dbRank.id || 0,
        name: dbRank.name || 'Unknown',
        iconUrl: dbRank.icon_url || '',
        sortOrder: dbRank.sort_order || 0
    };
};

export const toUnit = (dbUnit: UnitRowWithEmbeds | null | undefined): OrganizationalUnit => {
    if (!dbUnit) return { id: 0, name: 'Unknown', sortOrder: 999 };
    return {
        id: dbUnit.id || 0,
        name: dbUnit.name || 'Unknown',
        parentUnitId: dbUnit.parent_unit_id,
        sortOrder: dbUnit.sort_order || 0,
        leaderId: dbUnit.leader_id,
        logoUrl: dbUnit.logo_url,
        bannerUrl: dbUnit.banner_url,
        motto: dbUnit.motto,
        description: dbUnit.description,
        hasRadioChannel: dbUnit.has_radio_channel ?? true,
        linkedChannelId: dbUnit.linked_channel_id || undefined,
        leader: dbUnit.leader ? toMiniUser(dbUnit.leader) : undefined,
        // is_restricted ships via add-unit-visibility.sql; pre-migration rows
        // return undefined which the UI treats as "not restricted".
        isRestricted: dbUnit.is_restricted || undefined,
    };
};

type UnitPostRowWithEmbeds = Tables<'unit_posts'> & {
    author?: UserRowWithEmbeds | null;
};

export const toUnitPost = (dbPost: UnitPostRowWithEmbeds): UnitPost => ({
    id: dbPost.id,
    unitId: dbPost.unit_id,
    authorId: dbPost.author_id as number,
    content: dbPost.content,
    createdAt: dbPost.created_at,
    pinned: dbPost.pinned as boolean,
    author: dbPost.author ? toMiniUser(dbPost.author) : undefined
});

export const toPersonnelPosition = (dbPos: NullToUndefined<Tables<'personnel_positions'>> | null | undefined): PersonnelPosition => {
    if (!dbPos) return { id: 0, name: 'Unknown' };
    return {
        id: dbPos.id || 0,
        name: dbPos.name || 'Unknown',
        description: dbPos.description,
        icon: dbPos.icon,
        department: dbPos.department
    };
};

export const toAnnouncement = (dbAnn: NullToUndefined<Tables<'announcements'>>): Announcement => ({
    id: dbAnn.id,
    title: dbAnn.title,
    body: dbAnn.body,
    author: dbAnn.author,
    type: dbAnn.type as unknown as AnnouncementType,
    audience: dbAnn.audience || [],
    publishDate: dbAnn.publish_date,
    expiryDate: dbAnn.expiry_date
});

type StatusHistoryEmbed = Tables<'status_history'> & {
    updated_by?: UserRowWithEmbeds | null;
};

type RequestResponderEmbed = {
    user_id?: number;
    user?: UserRowWithEmbeds | null;
};

type ServiceRequestRowWithEmbeds = NullToUndefined<Tables<'service_requests'>> & {
    statusHistory?: StatusHistoryEmbed[] | null;
    status_history?: StatusHistoryEmbed[] | null;
    request_responders?: RequestResponderEmbed[] | null;
    client?: UserRowWithEmbeds | null;
};

export const toServiceRequest = (dbReq: ServiceRequestRowWithEmbeds): HydratedServiceRequest => {
    // Handle both aliased 'statusHistory' and raw 'status_history'
    const rawHistory = dbReq.statusHistory || dbReq.status_history || [];

    const mappedHistory = rawHistory.map((h) => ({
        status: h.status,
        updatedAt: h.updated_at,
        updatedBy: h.updated_by ? toMiniUser(h.updated_by) : undefined,
        note: h.note
    })).sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

    let leadResponder: User | undefined;
    if (dbReq.lead_responder_id && dbReq.request_responders) {
        const leadEntry = dbReq.request_responders.find((rr) => (rr.user?.id || rr.user_id) === dbReq.lead_responder_id);
        if (leadEntry && leadEntry.user) {
            leadResponder = toMiniUser(leadEntry.user);
        }
    }

    return {
        id: dbReq.id,
        clientId: dbReq.client_id,
        unregisteredClientRsiHandle: dbReq.unregistered_client_rsi_handle,
        serviceType: dbReq.service_type,
        location: dbReq.location,
        description: dbReq.description,
        status: dbReq.status as unknown as ServiceRequestStatus,
        urgency: dbReq.urgency as unknown as UrgencyLevel,
        threatLevel: dbReq.threat_level as unknown as ThreatLevel,
        leadResponderId: dbReq.lead_responder_id,
        createdAt: dbReq.created_at,
        updatedAt: dbReq.updated_at,
        uecEarned: dbReq.uec_earned,
        medigelConsumed: dbReq.medigel_consumed,
        clientRating: dbReq.client_rating,
        clientFeedback: dbReq.client_feedback,
        rated: dbReq.rated as boolean,
        partyInfo: dbReq.party_info,
        secondaryClientHandles: dbReq.secondary_client_handles,

        // Hydrated Fields
        client: dbReq.client ? toMiniUser(dbReq.client) : undefined,
        assignedMemberIds: dbReq.request_responders?.map((rr) => (rr.user?.id || rr.user_id) as number) || [],
        assignedMembers: dbReq.request_responders?.map((rr) => rr.user ? toMiniUser(rr.user) : null).filter(Boolean) as User[] || [],
        leadResponder: leadResponder,

        // Status History
        statusHistory: mappedHistory,
        hydratedStatusHistory: mappedHistory
    };
};

// Sub-resource rows attached to an operation by getFullOperationDetails. Several
// columns are stored as plain text / json in Postgres but carry domain literal
// unions here, and the FK-joined user/unit/location relations the body reads are
// not on the flat Row — both are reflected below.
type OperationParticipantEmbed = Omit<Tables<'operation_participants'>, 'attendance_status' | 'rsvp_status' | 'live_status'> & {
    attendance_status?: string | null;
    rsvp_status?: string | null;
    live_status?: HydratedOperation['participants'][number]['liveStatus'] | null;
    ship?: PlatformShipRow | null;
    user?: UserRowWithEmbeds | null;
};

type OperationLogEmbed = Tables<'operation_log_entries'> & {
    author?: UserRowWithEmbeds | null;
};

type OperationLocationEmbed = Omit<Tables<'operation_locations'>, 'location_id'> & {
    is_primary?: boolean | null;
    location?: HydratedOperation['location'] | null;
};

type OperationRowWithEmbeds = NullToUndefined<Omit<Tables<'operations'>, 'status' | 'type' | 'payout_mode' | 'comms_plan'>> & {
    status: OperationStatus;
    type: OperationType;
    payout_mode?: string | null;
    comms_plan?: CommsPlanEntry[] | null;
    // Not real columns on the operations Row — read defensively by the body
    // (always undefined unless a query aliases them in).
    discord_event_id?: string | null;
    discord_start_notice?: boolean | null;
    template_id?: number | null;
    limiting_markers?: Array<{ marker?: string | null }> | null;
    owner?: UserRowWithEmbeds | null;
    unit?: UnitRowWithEmbeds | null;
    location?: HydratedOperation['location'];
    location_text?: string | null;
    operation_locations?: OperationLocationEmbed[] | null;
    allied_orgs?: AlliedOrgRow[] | null;
    allied_participants?: AlliedParticipantRow[] | null;
    phases?: OperationPhaseRow[] | null;
    schedule_entries?: OperationScheduleEntryRow[] | null;
    tasks?: OperationTaskRow[] | null;
    command_nodes?: OperationCommandNodeRow[] | null;
    ship_slots?: OperationShipSlotRow[] | null;
    board_elements?: OperationBoardElementRow[] | null;
    logistics?: Tables<'operation_logistics'>[] | null;
    aar_entries?: OperationAAREntryRow[] | null;
    participants?: OperationParticipantEmbed[] | null;
    log?: OperationLogEmbed[] | null;
};

export const toHydratedOperation = (dbOp: OperationRowWithEmbeds): HydratedOperation => ({
    id: dbOp.id,
    name: dbOp.name,
    ownerId: dbOp.owner_id as number,
    status: dbOp.status,
    type: dbOp.type,
    description: dbOp.description as string,
    tracksUec: dbOp.tracks_uec as boolean,
    totalUec: dbOp.total_uec as number,
    totalCosts: dbOp.total_costs ?? 0,
    payoutMode: (dbOp.payout_mode as 'equal' | 'weighted' | 'custom') || 'equal',
    createdAt: dbOp.created_at,
    updatedAt: dbOp.updated_at,
    activeStartTime: dbOp.active_start_time,
    activeEndTime: dbOp.active_end_time,
    scheduledStart: dbOp.scheduled_start || undefined,
    scheduledEnd: dbOp.scheduled_end || undefined,
    isSpecial: dbOp.is_special as boolean,
    joinCode: dbOp.join_code,
    clearanceLevel: dbOp.clearance_level || 0,
    isTraining: dbOp.is_training || false,
    maxParticipants: dbOp.max_participants,
    unitId: dbOp.unit_id,
    discordEventId: dbOp.discord_event_id || undefined,
    discordStartNotice: !!dbOp.discord_start_notice,
    discordAnnouncementChannelId: dbOp.discord_announcement_channel_id || undefined,
    discordAnnouncementMessageId: dbOp.discord_announcement_message_id || undefined,
    // Template-of-origin link. NULL when no template was used or the op
    // pre-dates the template_id column migration.
    templateId: dbOp.template_id ?? undefined,
    limitingMarkers: (dbOp.limiting_markers || []).map((m) => m.marker).filter(Boolean) as unknown as HydratedOperation['limitingMarkers'],
    owner: toMiniUser(dbOp.owner) || unknownUser,
    unit: dbOp.unit ? toUnit(dbOp.unit) : undefined,
    location: dbOp.location,
    // operation_locations join: secondary locations attached to the op. The
    // primary still travels through `location` (fed by operations.location_id)
    // — read sites that just need "where is this happening" stay unchanged.
    additionalLocations: (dbOp.operation_locations || [])
        .filter((row) => row && !row.is_primary && row.location)
        .map((row) => row.location) as HydratedOperation['additionalLocations'],
    // Free-text platform-location strings (preferred over the joined org-table
    // rows above for new ops; legacy ops have null/empty here).
    locationText: dbOp.location_text || undefined,
    additionalLocationTexts: Array.isArray(dbOp.additional_location_texts) && dbOp.additional_location_texts.length > 0
        ? dbOp.additional_location_texts
        : undefined,
    // Joint operations fields
    isJoint: dbOp.is_joint || false,
    roe: dbOp.roe || undefined,
    commanderNotes: dbOp.commander_notes || undefined,
    commsPlan: dbOp.comms_plan || [],
    liveStatus: (dbOp.live_status as HydratedOperation['liveStatus']) || undefined,
    aarSummary: dbOp.aar_summary || undefined,
    aarLessonsLearned: dbOp.aar_lessons_learned || undefined,
    aarSubmittedAt: dbOp.aar_submitted_at || undefined,
    aarSubmittedBy: dbOp.aar_submitted_by || undefined,
    aarAiGeneratedAt: dbOp.aar_ai_generated_at || undefined,
    // Sub-resources (populated by getFullOperationDetails)
    alliedOrgs: (dbOp.allied_orgs || []).map(toOperationAlliedOrg) as HydratedOperation['alliedOrgs'],
    alliedParticipants: (dbOp.allied_participants || []).map(toAlliedParticipant) as HydratedOperation['alliedParticipants'],
    phases: (dbOp.phases || []).map(toOperationPhase) as HydratedOperation['phases'],
    scheduleEntries: (dbOp.schedule_entries || []).map(toOperationScheduleEntry) as HydratedOperation['scheduleEntries'],
    tasks: (dbOp.tasks || []).map(toOperationTask) as HydratedOperation['tasks'],
    commandNodes: (dbOp.command_nodes || []).map(toOperationCommandNode) as HydratedOperation['commandNodes'],
    shipSlots: (dbOp.ship_slots || []).map(toOperationShipSlot) as HydratedOperation['shipSlots'],
    boardElements: (dbOp.board_elements || []).map(toOperationBoardElement) as HydratedOperation['boardElements'],
    logistics: (dbOp.logistics || []).map(toOperationLogisticsItem) as HydratedOperation['logistics'],
    aarEntries: (dbOp.aar_entries || []).map(toAAREntry) as HydratedOperation['aarEntries'],
    participants: (dbOp.participants || []).map((p) => ({
        userId: p.user_id,
        timeJoined: p.joined_at,
        timeLeft: null,
        isReady: p.is_ready,
        roleRequested: p.role_requested,
        shipUtilized: p.ship_utilized,
        attendanceStatus: p.attendance_status,
        rsvpStatus: p.rsvp_status || undefined,
        rsvpAt: p.rsvp_at || undefined,
        shipId: p.ship_id || undefined,
        ship: p.ship ? toPlatformShip(p.ship) : undefined,
        userShipId: p.user_ship_id || undefined,
        liveStatus: p.live_status || undefined,
        payoutSharePercent: p.payout_share_percent != null ? Number(p.payout_share_percent) : undefined,
        payoutPaidAt: p.payout_paid_at || undefined,
        payoutPaidBy: p.payout_paid_by || undefined,
        user: toMiniUser(p.user) || unknownUser
    })) as unknown as HydratedOperation['participants'],
    log: (dbOp.log || []).map((l) => ({
        id: l.id,
        operationId: l.operation_id,
        entryType: l.entry_type,
        logEntry: l.log_entry,
        authorId: l.author_id,
        createdAt: l.created_at,
        uecAmount: l.uec_amount,
        costCategory: l.cost_category || undefined,
        costDescription: l.cost_description || undefined,
        author: toMiniUser(l.author) || unknownUser
    })).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) as HydratedOperation['log']
});


// alliance P3: an allied peer invited to a joint op. peer:alliance_peers may be
// embedded for cached directory fields (label/org name/tag/icon).
interface AlliedOrgRow {
    id: number;
    operation_id: string;
    peer_id: string;
    accepted: boolean;
    invited_at: string;
    accepted_at: string | null;
    peer?: { label?: string | null; peer_org_name?: string | null; peer_org_tag?: string | null; peer_icon_url?: string | null } | null;
}

export const toOperationAlliedOrg = (row: AlliedOrgRow): OperationAlliedOrg => ({
    id: row.id,
    operationId: row.operation_id,
    peerId: row.peer_id,
    accepted: row.accepted,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at || undefined,
    label: row.peer?.label ?? null,
    peerOrgName: row.peer?.peer_org_name ?? null,
    peerOrgTag: row.peer?.peer_org_tag ?? null,
    peerIconUrl: row.peer?.peer_icon_url ?? null,
});

interface AlliedParticipantRow {
    operation_id: string;
    peer_id: string;
    remote_user_handle: string;
    display_name: string | null;
    avatar_url: string | null;
    role: string | null;
    ship_text: string | null;
    rsvp_status: string;
    is_ready: boolean;
    updated_at: string;
}

export const toAlliedParticipant = (row: AlliedParticipantRow): AlliedParticipant => ({
    operationId: row.operation_id,
    peerId: row.peer_id,
    remoteUserHandle: row.remote_user_handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    shipText: row.ship_text,
    rsvpStatus: row.rsvp_status,
    isReady: row.is_ready,
    updatedAt: row.updated_at,
});

interface MirroredOperationRow {
    id: string;
    host_peer_id: string;
    snapshot: unknown;
    version: number;
    snapshot_updated_at: string | null;
    accepted: boolean;
    invited_at: string;
    accepted_at: string | null;
    last_polled_at: string | null;
    peer?: { peer_org_name?: string | null; peer_icon_url?: string | null; label?: string | null } | null;
}

export const toMirroredOperation = (row: MirroredOperationRow): MirroredOperation => ({
    id: row.id,
    hostPeerId: row.host_peer_id,
    hostPeerName: row.peer?.peer_org_name ?? row.peer?.label ?? null,
    hostPeerIconUrl: row.peer?.peer_icon_url ?? null,
    snapshot: (row.snapshot as MirroredOperation['snapshot']) ?? null,
    version: row.version,
    snapshotUpdatedAt: row.snapshot_updated_at,
    accepted: row.accepted,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at,
    lastPolledAt: row.last_polled_at,
});

type OperationPhaseRow = Tables<'operation_phases'>;

export const toOperationPhase = (row: OperationPhaseRow) => ({
    id: row.id,
    operationId: row.operation_id,
    name: row.name,
    description: row.description || undefined,
    phaseType: row.phase_type || 'sequential',
    sortOrder: row.sort_order || 0,
    status: row.status || 'Pending',
    color: row.color || undefined,
    createdAt: row.created_at,
});

type OperationScheduleEntryRow = Tables<'operation_schedule_entries'>;

export const toOperationScheduleEntry = (row: OperationScheduleEntryRow) => ({
    id: row.id,
    operationId: row.operation_id,
    label: row.label,
    scheduledTime: row.scheduled_time,
    phaseId: row.phase_id || undefined,
    notes: row.notes || undefined,
    status: row.status || undefined,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
});

type OperationTaskRow = Tables<'operation_tasks'> & {
    assigned_user?: UserRowWithEmbeds | null;
    assigned_unit?: UnitRowWithEmbeds | null;
};

export const toOperationTask = (row: OperationTaskRow) => ({
    id: row.id,
    operationId: row.operation_id,
    title: row.title,
    description: row.description || undefined,
    taskType: row.task_type || 'primary',
    assignedUnitId: row.assigned_unit_id || undefined,
    assignedUserId: row.assigned_user_id || undefined,
    assignedUser: row.assigned_user ? toMiniUser(row.assigned_user) : undefined,
    assignedUnit: row.assigned_unit ? toUnit(row.assigned_unit) : undefined,
    phaseId: row.phase_id || undefined,
    status: row.status || 'Pending',
    priority: row.priority || 'Normal',
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
});

type OperationCommandNodeRow = Tables<'operation_command_nodes'> & {
    assigned_user?: UserRowWithEmbeds | null;
    assigned_unit?: UnitRowWithEmbeds | null;
};

export const toOperationCommandNode = (row: OperationCommandNodeRow) => ({
    id: row.id,
    operationId: row.operation_id,
    parentId: row.parent_id || undefined,
    label: row.label,
    nodeType: row.node_type || 'position',
    assignedUserId: row.assigned_user_id || undefined,
    assignedUnitId: row.assigned_unit_id || undefined,
    assignedUser: row.assigned_user ? toMiniUser(row.assigned_user) : undefined,
    assignedUnit: row.assigned_unit ? toUnit(row.assigned_unit) : undefined,
    fleetGroupId: row.fleet_group_id || undefined,
    posX: row.pos_x || 0,
    posY: row.pos_y || 0,
    color: row.color || undefined,
    icon: row.icon || undefined,
    sortOrder: row.sort_order || 0,
    liveStatus: row.live_status || undefined,
    createdAt: row.created_at,
});

// Ship slots + seat assignments. Hand-written row types: the tables are new, so
// `Tables<'operation_ship_slots'>` is not in the generated database.types until the
// next gen:types run against a database that has already had the schema applied —
// a chicken-and-egg the operator should not have to solve. The service-role client
// is untyped, so the queries work either way.
interface OperationSlotAssignmentRow {
    id: number;
    operation_id: string;
    slot_id: number;
    user_id: number;
    status: string;
    user_ship_id: number | null;
    created_at: string;
    updated_at?: string | null;
}

interface OperationShipSlotRow {
    id: number;
    operation_id: string;
    parent_slot_id: number | null;
    ship_id: number | null;
    label: string;
    seat_role: string | null;
    capacity: number;
    sort_order: number;
    notes: string | null;
    created_at: string;
    updated_at?: string | null;
    ship?: { id: number; name: string; image_url: string | null } | null;
    assignments?: OperationSlotAssignmentRow[] | null;
}

export const toOperationSlotAssignment = (row: OperationSlotAssignmentRow) => ({
    id: row.id,
    operationId: row.operation_id,
    slotId: row.slot_id,
    userId: row.user_id,
    // Narrowed to the two legal values rather than passed through: status drives
    // whether the panel shows an approve/deny control, and the CHECK constraint is
    // the only other thing standing between a stray value and that branch.
    status: (row.status === 'applied' ? 'applied' : 'assigned') as 'applied' | 'assigned',
    userShipId: row.user_ship_id || undefined,
    createdAt: row.created_at,
});

export const toOperationShipSlot = (row: OperationShipSlotRow) => ({
    id: row.id,
    operationId: row.operation_id,
    parentSlotId: row.parent_slot_id || undefined,
    shipId: row.ship_id || undefined,
    ship: row.ship ? { id: row.ship.id, name: row.ship.name, imageUrl: row.ship.image_url || undefined } : undefined,
    label: row.label,
    seatRole: row.seat_role || undefined,
    capacity: row.capacity ?? 1,
    sortOrder: row.sort_order || 0,
    notes: row.notes || undefined,
    // `|| []` is load-bearing, not defensive noise: the slots and assignments reads
    // are separate safeFetch calls that soft-fail INDEPENDENTLY to [], and this
    // mapper also runs on list-path rows that carry no ship_slots at all. Every
    // consumer may therefore assume `assignments` is an array.
    assignments: (row.assignments || []).map(toOperationSlotAssignment),
    createdAt: row.created_at,
});

type OperationBoardElementRow = Tables<'operation_board_elements'>;

export const toOperationBoardElement = (row: OperationBoardElementRow) => ({
    id: row.id,
    operationId: row.operation_id,
    elementType: row.element_type || 'unit',
    label: row.label || undefined,
    posX: row.pos_x || 0,
    posY: row.pos_y || 0,
    width: row.width || undefined,
    height: row.height || undefined,
    rotation: row.rotation || 0,
    color: row.color || undefined,
    data: row.data || {},
    layer: row.layer || 0,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
});

export const toOperationLogisticsItem = (row: Tables<'operation_logistics'>) => ({
    id: row.id,
    operationId: row.operation_id,
    itemName: row.item_name,
    quantityNeeded: row.quantity_needed || 1,
    quantityFulfilled: row.quantity_fulfilled || 0,
    fulfilledByUserId: row.fulfilled_by_user_id || undefined,
    category: row.category || 'general',
    status: row.status || 'Needed',
    notes: row.notes || undefined,
    createdAt: row.created_at,
});

type OperationAAREntryRow = Tables<'operation_aar_entries'> & {
    author?: UserRowWithEmbeds | null;
};

export const toAAREntry = (row: OperationAAREntryRow) => ({
    id: row.id,
    operationId: row.operation_id,
    authorId: row.author_id,
    author: row.author ? toMiniUser(row.author) : undefined,
    category: row.category || 'observation',
    content: row.content,
    upvotes: row.upvotes || 0,
    createdAt: row.created_at,
});

type WarrantRowWithEmbeds = NullToUndefined<Tables<'warrants'>> & {
    issuedBy?: UserRowWithEmbeds | null;
    claimedBy?: UserRowWithEmbeds | null;
    feed?: { label?: string } | null;
};

export const toHydratedWarrant = (dbWarrant: WarrantRowWithEmbeds): HydratedWarrant => ({
    id: dbWarrant.id,
    targetRsiHandle: dbWarrant.target_rsi_handle,
    reason: dbWarrant.reason,
    action: dbWarrant.action as unknown as WarrantAction,
    uecReward: dbWarrant.uec_reward,
    status: dbWarrant.status as unknown as WarrantStatus,
    issuedBy: dbWarrant.issued_by ?? null,
    claimedBy: dbWarrant.claimed_by,
    sourceFeedId: dbWarrant.source_feed_id,
    externalId: dbWarrant.external_id,
    notes: dbWarrant.notes,
    issuedAt: dbWarrant.created_at,
    issuedByUser: toMiniUser(dbWarrant.issuedBy) || unknownUser,
    claimedByUser: dbWarrant.claimedBy ? toMiniUser(dbWarrant.claimedBy) : undefined,
    sourceFeedLabel: dbWarrant.feed?.label
});

type IntelReportRowWithEmbeds = NullToUndefined<Tables<'intel_reports'>> & {
    createdBy?: UserRowWithEmbeds | null;
    feed?: { label?: string } | null;
    intel_report_limiting_markers?: Array<{ marker?: string | null }> | null;
};

export const toHydratedIntelReport = (dbReport: IntelReportRowWithEmbeds): HydratedIntelligenceReport => ({
    id: dbReport.id,
    targetId: dbReport.target_id,
    subjectType: dbReport.subject_type as unknown as IntelSubjectType,
    threatLevel: dbReport.threat_level as unknown as IntelThreatLevel,
    tags: dbReport.tags || [],
    summary: dbReport.summary,
    evidenceUrls: dbReport.evidence_urls || [],
    createdBy: dbReport.createdBy ? toMiniUser(dbReport.createdBy) : undefined,
    externalAuthor: dbReport.external_author,
    affiliatedOrg: dbReport.affiliated_org,
    sourceFeedLabel: dbReport.feed?.label,
    createdAt: dbReport.created_at,
    classificationLevel: dbReport.classification_level || 0,
    limitingMarkers: (dbReport.intel_report_limiting_markers || []).map((m) => m.marker).filter(Boolean) as unknown as HydratedIntelligenceReport['limitingMarkers']
});

type IntelBulletinRowWithEmbeds = Tables<'intel_bulletins'> & {
    createdBy?: UserRowWithEmbeds | null;
    intel_bulletin_limiting_markers?: Array<{ marker?: string | null }> | null;
};

export const toIntelBulletin = (dbBulletin: IntelBulletinRowWithEmbeds): IntelBulletin => ({
    id: dbBulletin.id,
    title: dbBulletin.title,
    body: dbBulletin.body,
    threatLevel: dbBulletin.threat_level as unknown as IntelBulletin['threatLevel'],
    location: dbBulletin.location || null,
    durationMinutes: dbBulletin.duration_minutes as IntelBulletin['durationMinutes'],
    expiresAt: dbBulletin.expires_at,
    classificationLevel: dbBulletin.classification_level || 0,
    limitingMarkers: (dbBulletin.intel_bulletin_limiting_markers || []).map((m) => m.marker).filter(Boolean) as unknown as IntelBulletin['limitingMarkers'],
    createdById: dbBulletin.created_by_id as number,
    createdByUser: dbBulletin.createdBy ? toMiniUser(dbBulletin.createdBy) : undefined,
    createdAt: dbBulletin.created_at,
    sharedWithAllies: dbBulletin.shared_with_allies || false,
    sourceOrganizationId: dbBulletin.source_organization_id || null,
    sourceBulletinId: dbBulletin.source_bulletin_id || null,
    sourceOrganizationName: dbBulletin.source_organization_name || null,
});

type HRApplicationRowWithEmbeds = NullToUndefined<Tables<'hr_applications'>> & {
    assignedRecruiter?: UserRowWithEmbeds | null;
    interviews?: HRInterviewRowWithEmbeds[] | null;
};

export const toHydratedApplication = (dbApp: HRApplicationRowWithEmbeds): HydratedHRApplication => ({
    id: dbApp.id,
    applicantName: dbApp.applicant_name,
    applicantDiscordId: dbApp.applicant_discord_id,
    rsiHandle: dbApp.rsi_handle,
    status: dbApp.status as unknown as ApplicationStatus,
    referralSource: dbApp.referral_source,
    notes: dbApp.notes,
    assignedRecruiterId: dbApp.assigned_recruiter_id,
    assignedRecruiter: dbApp.assignedRecruiter ? toMiniUser(dbApp.assignedRecruiter) : undefined,
    linkedUserId: dbApp.linked_user_id,
    createdAt: dbApp.created_at,
    // Provide empty array if interviews not joined (optimization)
    interviews: (dbApp.interviews || []).map((i) => toHydratedInterview(i)),
    vettingData: dbApp.vetting_data,
    logs: []
});

type HRInterviewTemplateRowWithEmbeds = NullToUndefined<Tables<'hr_interview_templates'>> & {
    questions?: NullToUndefined<Tables<'hr_interview_questions'>>[] | null;
};

export const toHRInterviewTemplate = (dbTpl: HRInterviewTemplateRowWithEmbeds): HRInterviewTemplate => ({
    id: dbTpl.id,
    name: dbTpl.name,
    description: dbTpl.description as string,
    questions: (dbTpl.questions || []).map((q) => ({
        id: q.id,
        templateId: q.template_id as number,
        questionText: q.question_text,
        orderIndex: q.order_index
    }))
});

type JobPostingRowWithEmbeds = NullToUndefined<Tables<'hr_job_postings'>> & {
    position?: NullToUndefined<Tables<'personnel_positions'>> | null;
};

export const toJobPosting = (dbJob: JobPostingRowWithEmbeds): JobPosting => ({
    id: dbJob.id,
    title: dbJob.title,
    department: dbJob.department,
    description: dbJob.description,
    requirements: dbJob.requirements,
    status: dbJob.status as unknown as JobPostingStatus,
    createdAt: dbJob.created_at,
    positionId: dbJob.position_id,
    position: dbJob.position ? toPersonnelPosition(dbJob.position) : undefined
});

type HRInterviewResponseEmbed = Pick<Tables<'hr_interview_responses'>, 'question_id' | 'response_body' | 'score'>;

type HRInterviewRowWithEmbeds = NullToUndefined<Tables<'hr_interviews'>> & {
    template?: HRInterviewTemplateRowWithEmbeds | null;
    interviewer?: UserRowWithEmbeds | null;
    panel?: Array<{ user?: UserRowWithEmbeds | null }> | null;
    responses?: HRInterviewResponseEmbed[] | null;
};

export const toHydratedInterview = (dbInt: HRInterviewRowWithEmbeds | null | undefined): HydratedHRInterview => {
    if (!dbInt || typeof dbInt !== 'object') return {
        id: '0',
        applicationId: '0',
        templateId: 0,
        template: { id: 0, name: 'Unknown', description: '', questions: [] },
        interviewerId: 0,
        interviewer: unknownUser,
        panelMembers: [],
        scheduledAt: new Date().toISOString(),
        status: 'Scheduled',
        responses: []
    };

    // Hydrate panel members from the junction table join
    // PostgREST returns: panel: [{ user: { id, name, ... } }, ...]
    const panelMembers = (dbInt.panel || [])
        .map((p) => p.user ? toMiniUser(p.user) : null)
        .filter(Boolean) as User[];

    return {
        id: dbInt.id,
        applicationId: dbInt.application_id as string,
        templateId: dbInt.template_id as number,
        // Robust handling if template not joined
        template: dbInt.template ? toHRInterviewTemplate(dbInt.template) : { id: 0, name: 'Unknown', description: '', questions: [] },
        interviewerId: dbInt.interviewer_id as number,
        interviewer: toMiniUser(dbInt.interviewer) || unknownUser,
        panelMembers,
        scheduledAt: dbInt.scheduled_at as string,
        completedAt: dbInt.completed_at,
        overallNotes: dbInt.overall_notes,
        finalScore: dbInt.final_score,
        status: dbInt.status as string,
        isRecommended: dbInt.is_recommended,
        responses: (dbInt.responses || []).map((r) => ({
            questionId: r.question_id as number,
            responseBody: r.response_body as string,
            score: r.score as number
        }))
    };
};

type TransferRequestRowWithEmbeds = NullToUndefined<Tables<'hr_transfer_requests'>> & {
    user?: UserRowWithEmbeds | null;
    targetUnit?: UnitRowWithEmbeds | null;
};

export const toTransferRequest = (dbTr: TransferRequestRowWithEmbeds): TransferRequest => ({
    id: dbTr.id,
    userId: dbTr.user_id as number,
    currentUnitId: dbTr.current_unit_id,
    targetUnitId: dbTr.target_unit_id as number,
    reason: dbTr.reason,
    status: dbTr.status as unknown as TransferRequestStatus,
    adminNotes: dbTr.admin_notes,
    createdAt: dbTr.created_at,
    updatedAt: dbTr.updated_at as string,
    user: dbTr.user ? toMiniUser(dbTr.user) : undefined,
    targetUnit: dbTr.targetUnit ? toUnit(dbTr.targetUnit) : undefined
});

type WikiPageRowWithEmbeds = Tables<'wiki_pages'> & {
    wiki_page_limiting_markers?: Array<{ marker?: string | null }> | null;
    createdBy?: UserRowWithEmbeds | null;
    updatedBy?: UserRowWithEmbeds | null;
};

export const toWikiPage = (dbPage: WikiPageRowWithEmbeds): WikiPage => ({
    id: dbPage.id,
    parentPageId: dbPage.parent_page_id || null,
    title: dbPage.title,
    slug: dbPage.slug,
    content: dbPage.content || {},
    classificationLevel: dbPage.classification_level || 0,
    sortOrder: dbPage.sort_order || 0,
    limitingMarkers: (dbPage.wiki_page_limiting_markers || []).map((m) => m.marker).filter(Boolean) as unknown as WikiPage['limitingMarkers'],
    createdById: dbPage.created_by_id || null,
    updatedById: dbPage.updated_by_id || null,
    createdBy: dbPage.createdBy ? toMiniUser(dbPage.createdBy) : undefined,
    updatedBy: dbPage.updatedBy ? toMiniUser(dbPage.updatedBy) : undefined,
    createdAt: dbPage.created_at,
    updatedAt: dbPage.updated_at,
    // menu_structure_locked is added by migrations/add-wiki-page-menu-lock.sql.
    // Pre-migration rows return undefined here which the UI treats as unlocked.
    menuStructureLocked: dbPage.menu_structure_locked || undefined,
});

type ReputationHistoryRowWithEmbeds = Tables<'reputation_history'> & {
    adminUser?: UserRowWithEmbeds | null;
};

export const toReputationHistoryEntry = (dbEntry: ReputationHistoryRowWithEmbeds): HydratedReputationHistoryEntry => ({
    id: dbEntry.id,
    userId: dbEntry.user_id as number,
    adminUserId: dbEntry.admin_user_id,
    adminUser: toMiniUser(dbEntry.adminUser) || unknownUser,
    changeDate: dbEntry.change_date,
    oldReputation: dbEntry.old_reputation,
    newReputation: dbEntry.new_reputation,
    reason: dbEntry.reason
});

type RatingHistoryRow = Tables<'service_requests'> & {
    client?: { rsi_handle?: string | null } | null;
};

export const toRatingHistoryEntry = (dbEntry: RatingHistoryRow): RatingHistoryEntry => ({
    requestId: dbEntry.id,
    serviceType: dbEntry.service_type,
    clientRating: dbEntry.client_rating as number,
    date: dbEntry.updated_at,
    clientRsiHandle: dbEntry.client?.rsi_handle || 'Unknown',
    rating: dbEntry.client_rating as number
});

export const toServiceTypeConfig = (dbType: NullToUndefined<Tables<'service_types'>>): ServiceTypeConfig => ({
    id: dbType.id,
    name: dbType.name,
    icon: dbType.icon as string,
    color: dbType.color as string,
    description: dbType.description,
    isActive: dbType.is_active as boolean,
    discordChannelId: dbType.discord_channel_id || undefined,
});

// --- Fleet Manager Mappers ---

type PlatformShipRow = Tables<'platform_ships'> & {
    length?: number | string | null;
    beam?: number | string | null;
    height?: number | string | null;
    msrp?: number | string | null;
};

export const toPlatformShip = (db: PlatformShipRow): PlatformShip => ({
    id: db.id,
    externalUuid: db.external_uuid || undefined,
    externalApiId: db.external_api_id || undefined,
    name: db.name,
    manufacturer: db.manufacturer,
    manufacturerCode: db.manufacturer_code || undefined,
    role: db.role || undefined,
    career: db.career || undefined,
    size: db.size || undefined,
    crewMin: db.crew_min || 1,
    crewMax: db.crew_max || 1,
    cargoCapacity: db.cargo_capacity || 0,
    length: db.length ? parseFloat(String(db.length)) : undefined,
    beam: db.beam ? parseFloat(String(db.beam)) : undefined,
    height: db.height ? parseFloat(String(db.height)) : undefined,
    mass: db.mass || undefined,
    scmSpeed: db.scm_speed || undefined,
    maxSpeed: db.max_speed || undefined,
    health: db.health || undefined,
    shieldHp: db.shield_hp || undefined,
    imageUrl: db.image_url || undefined,
    wikiUrl: db.wiki_url || undefined,
    pledgeUrl: db.pledge_url || undefined,
    msrp: db.msrp ? parseFloat(String(db.msrp)) : undefined,
    description: db.description || undefined,
    productionStatus: db.production_status || undefined
});

type UserShipRowWithEmbeds = Tables<'user_ships'> & {
    user?: UserRowWithEmbeds | null;
    ship?: PlatformShipRow | null;
    __assignment_id?: number;
};

export const toUserShip = (db: UserShipRowWithEmbeds): UserShip => ({
    id: db.id,
    userId: db.user_id,
    user: db.user ? toMiniUser(db.user) : undefined,
    shipId: db.ship_id,
    ship: db.ship ? toPlatformShip(db.ship) : undefined,
    customName: db.custom_name || undefined,
    loadoutNotes: db.loadout_notes || undefined,
    status: db.status as unknown as ShipStatus || ShipStatus.Active,
    isPrimary: db.is_primary || false,
    createdAt: db.created_at as string,
    // Populated by getFleetGroups when hydrating from the junction join.
    assignmentId: db.__assignment_id,
});

type FleetGroupRowWithEmbeds = Tables<'fleet_groups'> & {
    commander?: UserRowWithEmbeds | null;
};

export const toFleetGroup = (db: FleetGroupRowWithEmbeds): FleetGroup => ({
    id: db.id,
    name: db.name,
    type: db.type as FleetGroupType || FleetGroupType.Custom,
    parentId: db.parent_id || undefined,
    commanderId: db.commander_id || undefined,
    commander: db.commander ? toMiniUser(db.commander) : undefined,
    description: db.description || undefined,
    icon: db.icon || undefined,
    sortOrder: db.sort_order || 0,
    // Both default to [] so consumers never have to null-check. getFleetGroups
    // overwrites assignedShips with the hydrated junction-row data; children
    // stays empty here (the chart walks the flat list via parentId rather than
    // a nested .children tree).
    children: [],
    assignedShips: []
});

// ---------------------------------------------------------------------------
// Finances — treasury accounts + ledger entries
// ---------------------------------------------------------------------------

type LedgerCounterpartyEmbed = {
    id: number;
    name?: string | null;
    avatar_url?: string | null;
    rsi_handle?: string | null;
};

const toLedgerCounterparty = (db: LedgerCounterpartyEmbed | null | undefined): LedgerCounterparty | undefined => (
    db ? {
        id: db.id,
        name: db.name || 'Unknown',
        avatarUrl: db.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
        rsiHandle: db.rsi_handle || '',
    } : undefined
);

export const toTreasuryAccount = (db: Tables<'treasury_accounts'>): TreasuryAccount => ({
    id: db.id,
    name: db.name,
    type: (db.type as TreasuryAccountType) || 'general',
    description: db.description ?? null,
    balanceCached: Number(db.balance_cached ?? 0),
    isActive: db.is_active !== false,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

// ---------------------------------------------------------------------------
// Quartermaster — catalog, locations, inventory, issuances
// ---------------------------------------------------------------------------

type QmUserRefEmbed = {
    id: number;
    name?: string | null;
    avatar_url?: string | null;
    rsi_handle?: string | null;
};

const toQmUserRef = (db: QmUserRefEmbed | null | undefined): QmUserRef | undefined => (
    db ? {
        id: db.id,
        name: db.name || 'Unknown',
        avatarUrl: db.avatar_url || 'https://cdn.discordapp.com/embed/avatars/0.png',
        rsiHandle: db.rsi_handle || '',
    } : undefined
);

export const toQmCatalogItem = (db: Tables<'quartermaster_catalog'>): QmCatalogItem => ({
    id: db.id,
    slug: db.slug,
    name: db.name,
    category: db.category as QmCatalogCategory,
    subcategory: db.subcategory ?? null,
    attributes: (db.attributes as QmCatalogItem['attributes']) || {},
    source: (db.source as QmCatalogSource) || 'custom',
    thumbnailUrl: db.thumbnail_url ?? null,
    wikiUrl: db.wiki_url ?? null,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

export const toQmPlatformItem = (db: Tables<'quartermaster_catalog'>): QmPlatformItem => ({
    id: db.id,
    slug: db.slug,
    name: db.name,
    category: db.category as QmCatalogCategory,
    subcategory: db.subcategory ?? null,
    attributes: (db.attributes as QmPlatformItem['attributes']) || {},
    source: 'platform',
    thumbnailUrl: db.thumbnail_url ?? null,
    wikiUrl: db.wiki_url ?? null,
    externalUuid: db.external_uuid ?? null,
    externalId: db.external_id ?? null,
    isVehicleItem: !!db.is_vehicle_item,
    isCommodity: !!db.is_commodity,
    isHarvestable: !!db.is_harvestable,
    screenshotUrl: db.screenshot_url ?? null,
    storeUrl: db.store_url ?? null,
    companyName: db.company_name ?? null,
    vehicleName: db.vehicle_name ?? null,
    quality: typeof db.quality === 'number' ? db.quality : null,
    sizeLabel: db.size_label ?? null,
    color: db.color ?? null,
    color2: db.color2 ?? null,
    gameVersion: db.game_version ?? null,
    platformCategoryId: db.platform_category_id ?? null,
    lastSyncedAt: db.last_synced_at ?? null,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

export const toQmPlatformCategory = (db: Tables<'quartermaster_platform_categories'>): QmPlatformCategory => ({
    id: db.id,
    uexCategoryId: db.uex_category_id,
    uexCategoryName: db.uex_category_name,
    uexSection: db.uex_section ?? null,
    displayName: db.display_name,
    sortOrder: db.sort_order || 0,
    isHidden: !!db.is_hidden,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

export const toWarehousePlatformCommodity = (db: Tables<'warehouse_platform_commodities'>): WarehousePlatformCommodity => {
    const b = (v: boolean | null | undefined): boolean | null => (v === null || v === undefined ? null : !!v);
    const n = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : v === null || v === undefined ? null : Number(v));
    return {
        id: db.id,
        externalId: db.external_id,
        externalUuid: db.external_uuid ?? null,
        slug: db.slug,
        name: db.name,
        code: db.code ?? null,
        kind: db.kind ?? null,
        weightScu: n(db.weight_scu),
        priceBuy: n(db.price_buy),
        priceSell: n(db.price_sell),
        isAvailable: b(db.is_available),
        isAvailableLive: b(db.is_available_live),
        isVisible: b(db.is_visible),
        isExtractable: b(db.is_extractable),
        isMineral: b(db.is_mineral),
        isRaw: b(db.is_raw),
        isPure: b(db.is_pure),
        isRefined: b(db.is_refined),
        isRefinable: b(db.is_refinable),
        isHarvestable: b(db.is_harvestable),
        isBuyable: b(db.is_buyable),
        isSellable: b(db.is_sellable),
        isTemporary: b(db.is_temporary),
        isIllegal: b(db.is_illegal),
        isVolatileQt: b(db.is_volatile_qt),
        isVolatileTime: b(db.is_volatile_time),
        isInert: b(db.is_inert),
        isExplosive: b(db.is_explosive),
        isBuggy: b(db.is_buggy),
        isFuel: b(db.is_fuel),
        wikiUrl: db.wiki_url ?? null,
        platformCategoryId: db.platform_category_id ?? null,
        uexDateAdded: typeof db.uex_date_added === 'number' ? db.uex_date_added : null,
        uexDateModified: typeof db.uex_date_modified === 'number' ? db.uex_date_modified : null,
        lastSyncedAt: db.last_synced_at ?? null,
        createdAt: db.created_at,
        updatedAt: db.updated_at,
    };
};

export const toWarehousePlatformCategory = (db: Tables<'warehouse_platform_categories'>): WarehousePlatformCategory => ({
    id: db.id,
    slug: db.slug,
    uexKind: db.uex_kind,
    displayName: db.display_name,
    sortOrder: db.sort_order || 0,
    isHidden: !!db.is_hidden,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

export const toPlatformLocation = (db: Tables<'platform_locations'>): PlatformLocation => {
    const b = (v: boolean | null | undefined): boolean | null => (v === null || v === undefined ? null : !!v);
    return {
        id: db.id,
        kind: db.kind as PlatformLocationKind,
        externalId: db.external_id,
        parentId: db.parent_id ?? null,
        starSystemId: db.star_system_id ?? null,
        name: db.name,
        nickname: db.nickname ?? null,
        code: db.code ?? null,
        path: db.path ?? null,
        isAvailableLive: b(db.is_available_live),
        isVisible: b(db.is_visible),
        isLandable: b(db.is_landable),
        isArmistice: b(db.is_armistice),
        isDecommissioned: b(db.is_decommissioned),
        isInternal: !!db.is_internal,
        isHidden: !!db.is_hidden,
        padTypes: db.pad_types ?? null,
        amenities: (db.amenities && typeof db.amenities === 'object' ? db.amenities : {}) as PlatformLocationAmenities,
        factionName: db.faction_name ?? null,
        jurisdictionName: db.jurisdiction_name ?? null,
        wikiUrl: db.wiki_url ?? null,
        uexDateAdded: typeof db.uex_date_added === 'number' ? db.uex_date_added : null,
        uexDateModified: typeof db.uex_date_modified === 'number' ? db.uex_date_modified : null,
        lastSyncedAt: db.last_synced_at ?? null,
        createdAt: db.created_at,
        updatedAt: db.updated_at,
    };
};

export const toQmLocation = (db: Tables<'quartermaster_locations'>): QmLocation => ({
    id: db.id,
    name: db.name,
    type: (db.type as QmLocationType) || 'custom',
    parentId: db.parent_id ?? null,
    description: db.description ?? null,
    sortOrder: db.sort_order || 0,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

// Inventory rows arrive with computed quantity columns (server-side aggregate)
// plus the joined catalog/location relations the body reads.
type QmInventoryRowWithEmbeds = Tables<'quartermaster_inventory'> & {
    quantity_on_hand?: number | null;
    quantity_on_issue?: number | null;
    catalog?: Pick<Tables<'quartermaster_catalog'>, 'id' | 'slug' | 'name' | 'category' | 'subcategory' | 'thumbnail_url'> | null;
    location?: Pick<Tables<'quartermaster_locations'>, 'id' | 'name' | 'type'> | null;
};

export const toQmInventoryItem = (db: QmInventoryRowWithEmbeds): QmInventoryItem => ({
    id: db.id,
    catalogId: db.catalog_id ?? null,
    catalog: db.catalog ? {
        id: db.catalog.id,
        slug: db.catalog.slug,
        name: db.catalog.name,
        category: db.catalog.category as QmCatalogCategory,
        subcategory: db.catalog.subcategory,
        thumbnailUrl: db.catalog.thumbnail_url ?? null,
    } : undefined,
    customName: db.custom_name ?? null,
    locationId: db.location_id ?? null,
    location: db.location ? {
        id: db.location.id,
        name: db.location.name,
        type: db.location.type as QmLocationType,
    } : undefined,
    condition: (db.condition as QmCondition) || 'pristine',
    acquiredAt: db.acquired_at,
    notes: db.notes ?? null,
    isArchived: db.is_archived === true,
    quantityOnHand: Number(db.quantity_on_hand ?? 0),
    quantityOnIssue: Number(db.quantity_on_issue ?? 0),
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

type QmIssuanceRowWithEmbeds = Tables<'quartermaster_issuances'> & {
    inventory?: (Pick<Tables<'quartermaster_inventory'>, 'id' | 'custom_name'> & {
        catalog?: Pick<Tables<'quartermaster_catalog'>, 'name' | 'category'> | null;
    }) | null;
    issued_to?: QmUserRefEmbed | null;
    requested_by?: QmUserRefEmbed | null;
    issued_by?: QmUserRefEmbed | null;
    closed_by?: QmUserRefEmbed | null;
};

export const toQmIssuance = (db: QmIssuanceRowWithEmbeds): QmIssuance => {
    const dueBack = db.due_back_at ?? null;
    const isOverdue = db.status === 'active' && dueBack !== null && new Date(dueBack).getTime() < Date.now();
    return {
        id: db.id,
        inventoryId: db.inventory_id,
        inventory: db.inventory ? {
            id: db.inventory.id,
            customName: db.inventory.custom_name ?? null,
            catalog: db.inventory.catalog ? {
                name: db.inventory.catalog.name,
                category: db.inventory.catalog.category as QmCatalogCategory,
            } : undefined,
        } : undefined,
        issuedToUserId: db.issued_to_user_id,
        issuedTo: toQmUserRef(db.issued_to),
        quantity: db.quantity,
        status: db.status as QmIssuanceStatus,
        requestedAt: db.requested_at ?? null,
        issuedAt: db.issued_at ?? null,
        dueBackAt: dueBack,
        returnedAt: db.returned_at ?? null,
        returnedQuantity: db.returned_quantity ?? null,
        outcome: (db.outcome as QmOutcome) ?? null,
        requestedByUserId: db.requested_by_user_id ?? null,
        requestedBy: toQmUserRef(db.requested_by),
        issuedByUserId: db.issued_by_user_id ?? null,
        issuedBy: toQmUserRef(db.issued_by),
        closedByUserId: db.closed_by_user_id ?? null,
        closedBy: toQmUserRef(db.closed_by),
        notes: db.notes ?? null,
        operationId: db.operation_id ?? null,
        isOverdue,
        createdAt: db.created_at,
        updatedAt: db.updated_at,
    };
};

type LedgerEntryRowWithEmbeds = Tables<'treasury_ledger_entries'> & {
    counterparty?: LedgerCounterpartyEmbed | null;
    created_by?: LedgerCounterpartyEmbed | null;
    approved_by?: LedgerCounterpartyEmbed | null;
};

export const toLedgerEntry = (db: LedgerEntryRowWithEmbeds): LedgerEntry => ({
    id: db.id,
    accountId: db.account_id,
    entryType: db.entry_type as LedgerEntryType,
    amount: Number(db.amount),
    status: db.status as LedgerEntryStatus,
    memo: db.memo ?? null,
    counterpartyUserId: db.counterparty_user_id ?? null,
    counterparty: toLedgerCounterparty(db.counterparty),
    counterpartyText: db.counterparty_text ?? null,
    operationId: db.operation_id ?? null,
    relatedInventoryId: db.related_inventory_id ?? null,
    relatedEntryId: db.related_entry_id ?? null,
    transferGroupId: db.transfer_group_id ?? null,
    createdByUserId: db.created_by_user_id,
    createdBy: toLedgerCounterparty(db.created_by),
    approvedByUserId: db.approved_by_user_id ?? null,
    approvedBy: toLedgerCounterparty(db.approved_by),
    approvedAt: db.approved_at ?? null,
    notes: db.notes ?? null,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
});

// ---------------------------------------------------------------------------
// Academy (LMS) — base row mappers. Nested collections (modules/lessons/
// outcomes/instructors) start empty and are assembled by lib/db/academy.ts.
// Single-org: no organization_id column, so no organizationId field.
// ---------------------------------------------------------------------------
type AcademyUserRefEmbed = { id: number; name: string | null; avatar_url: string | null; rsi_handle: string | null } | null;

export const toAcademyUserRef = (db: AcademyUserRefEmbed): AcademyUserRef | null =>
    db ? { id: db.id, name: db.name ?? '', avatarUrl: db.avatar_url ?? '', rsiHandle: db.rsi_handle ?? '' } : null;

export const toAcademyLesson = (db: Tables<'academy_lessons'>): AcademyLesson => ({
    id: db.id,
    moduleId: db.module_id,
    title: db.title,
    content: db.content ?? null,
    videoUrl: db.video_url ?? null,
    sortOrder: db.sort_order,
    estimatedMinutes: db.estimated_minutes ?? null,
});

export const toAcademyModule = (db: Tables<'academy_modules'>): AcademyModule => ({
    id: db.id,
    courseId: db.course_id,
    title: db.title,
    description: db.description ?? null,
    sortOrder: db.sort_order,
    lessons: [],
});

export const toAcademyOutcome = (db: Tables<'academy_outcomes'>): AcademyOutcome => ({
    id: db.id,
    courseId: db.course_id,
    title: db.title,
    description: db.description ?? null,
    sortOrder: db.sort_order,
    required: db.required !== false,
});

export const toAcademyCourse = (db: Tables<'academy_courses'>): AcademyCourse => ({
    id: db.id,
    title: db.title,
    description: db.description ?? null,
    icon: db.icon ?? null,
    imageUrl: db.image_url ?? null,
    status: db.status as AcademyCourseStatus,
    access: db.access as AcademyCourseAccess,
    delivery: (db.delivery as AcademyCourseDelivery) || 'cohort',
    certificationId: db.certification_id ?? null,
    certification: null,
    createdBy: db.created_by,
    approvedBy: db.approved_by ?? null,
    publishedAt: db.published_at ?? null,
    sortOrder: db.sort_order,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
    instructors: [],
    modules: [],
    outcomes: [],
});

export const toAcademySession = (db: Tables<'academy_sessions'>): AcademySession => ({
    id: db.id,
    courseId: db.course_id,
    courseTitle: null,
    title: db.title,
    status: db.status as AcademySessionStatus,
    startsAt: db.starts_at ?? null,
    endsAt: db.ends_at ?? null,
    location: db.location ?? null,
    capacity: db.capacity ?? null,
    enrollmentOpen: db.enrollment_open !== false,
    isImplicit: db.is_implicit === true,
    createdBy: db.created_by,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
    instructors: [],
    enrollmentCount: 0,
});

export const toAcademyLessonProgress = (db: Tables<'academy_lesson_progress'>): AcademyLessonProgress => ({
    id: db.id,
    enrollmentId: db.enrollment_id,
    lessonId: db.lesson_id,
    completedBy: db.completed_by,
    completedAt: db.completed_at,
});

export const toAcademyOutcomeResult = (db: Tables<'academy_outcome_results'>): AcademyOutcomeResult => ({
    id: db.id,
    enrollmentId: db.enrollment_id,
    outcomeId: db.outcome_id,
    verdict: db.verdict as AcademyOutcomeVerdict,
    assessedBy: db.assessed_by,
    assessedAt: db.assessed_at,
});

export const toAcademyEnrollment = (db: Tables<'academy_enrollments'>): AcademyEnrollment => ({
    id: db.id,
    sessionId: db.session_id,
    studentId: db.student_id,
    student: null,
    source: db.source as AcademyEnrollmentSource,
    status: db.status as AcademyEnrollmentStatus,
    assignedBy: db.assigned_by ?? null,
    recommendedBy: db.recommended_by ?? null,
    recommendedAt: db.recommended_at ?? null,
    certifiedBy: db.certified_by ?? null,
    completedAt: db.completed_at ?? null,
    enrolledAt: db.enrolled_at,
    lessonProgress: [],
    outcomeResults: [],
});

// ── Blueprints ───────────────────────────────────────────────────────────────

/**
 * The party embed carries `deleted_at` for ONE reason: to withhold the name.
 *
 * Member removal is a SOFT delete and the registry rows survive by design — a
 * blueprint is org history. A departed member being named and avatared on the
 * board indefinitely is not history, it is a stale identity, and this build's
 * convention everywhere else (getMarketplaceTrader, getCraftNotifyIds) filters
 * `deleted_at`. Nulling the party here keeps the row and drops the person.
 */
interface BlueprintPartyEmbed {
    id: number;
    name: string;
    avatar_url: string | null;
    rsi_handle: string | null;
    deleted_at: string | null;
}

interface BlueprintRow {
    id: number;
    owner_id: number;
    qm_catalog_id: number | null;
    item_name: string;
    category: string | null;
    notes: string | null;
    offers_crafting: boolean;
    created_at: string;
    updated_at: string;
    owner?: BlueprintPartyEmbed | null;
}

interface BlueprintRequestRow {
    id: number;
    requester_id: number;
    crafter_id: number | null;
    blueprint_id: number | null;
    qm_catalog_id: number | null;
    item_name: string;
    quantity: number;
    materials_note: string | null;
    offer_price_uec: number | string | null;
    status: string;
    claimed_at: string | null;
    ready_at: string | null;
    delivered_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    created_at: string;
    updated_at: string;
    requester?: BlueprintPartyEmbed | null;
    crafter?: BlueprintPartyEmbed | null;
}

const toBlueprintParty = (p: BlueprintPartyEmbed | null | undefined): MarketplaceTrader | undefined =>
    (p && !p.deleted_at) ? {
        id: p.id,
        name: p.name,
        avatarUrl: p.avatar_url ?? null,
        rsiHandle: p.rsi_handle ?? null,
    } : undefined;

export const toBlueprint = (row: BlueprintRow): Blueprint => ({
    id: row.id,
    ownerId: row.owner_id,
    qmCatalogId: row.qm_catalog_id ?? null,
    itemName: row.item_name,
    category: row.category ?? null,
    notes: row.notes ?? null,
    offersCrafting: row.offers_crafting === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: toBlueprintParty(row.owner),
});

/**
 * Takes ONLY the three item-identity columns, so a row that somehow arrived
 * carrying owner_id cannot leak it through this mapper.
 */
export const toCraftableItem = (row: { qm_catalog_id: number | null; item_name: string; category: string | null }): CraftableItem => ({
    qmCatalogId: row.qm_catalog_id ?? null,
    itemName: row.item_name,
    category: row.category ?? null,
});

export const toBlueprintRequest = (row: BlueprintRequestRow): BlueprintRequest => ({
    id: row.id,
    requesterId: row.requester_id,
    crafterId: row.crafter_id ?? null,
    blueprintId: row.blueprint_id ?? null,
    qmCatalogId: row.qm_catalog_id ?? null,
    itemName: row.item_name,
    quantity: row.quantity ?? 1,
    materialsNote: row.materials_note ?? null,
    // bigint arrives as a string over PostgREST once it exceeds the JS-safe range.
    offerPriceUec: row.offer_price_uec == null ? null : Number(row.offer_price_uec),
    status: row.status as BlueprintRequestStatus,
    claimedAt: row.claimed_at ?? null,
    readyAt: row.ready_at ?? null,
    deliveredAt: row.delivered_at ?? null,
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requester: toBlueprintParty(row.requester),
    crafter: toBlueprintParty(row.crafter),
});
