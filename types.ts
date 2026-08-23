import React, { ReactNode } from 'react';

export enum UserRole {
    Client = 'Client',
    Member = 'Member',
    Dispatcher = 'Dispatcher',
    Admin = 'Admin'
}

export enum ServiceRequestStatus {
    Submitted = 'Submitted',
    Triaged = 'Triaged',
    Accepted = 'Accepted',
    InProgress = 'In-Progress',
    Success = 'Success',
    Failed = 'Failed',
    Cancelled = 'Cancelled',
    Refused = 'Refused',
    Aborted = 'Aborted',
    GameError = 'GameError'
}

export enum UrgencyLevel {
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
    Critical = 'Critical'
}

export enum ThreatLevel {
    None = 'None',
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
    Critical = 'Critical',
    PVP = 'PVP'
}

export enum OperationStatus {
    Planning = 'Planning',
    Scheduled = 'Scheduled',
    Active = 'Active',
    Concluded = 'Concluded'
}

export enum OperationLiveStatus {
    Holding = 'Holding',
    Engaged = 'Engaged',
    Regrouping = 'Regrouping',
    Disengaging = 'Disengaging',
    RTB = 'RTB',
    Standby = 'Standby'
}

/** Three modes for splitting an operation's net aUEC pool among participants. */
export type OperationPayoutMode = 'equal' | 'weighted' | 'custom';

/** Hard-coded cost categories. Rarely changes; admin-configurable categories
 *  add tenant-config surface that's out of scope. */
export type OperationCostCategory = 'fuel' | 'repairs' | 'supplies' | 'consumables' | 'crew' | 'other';

/** Shape of a row in `HydratedOperation.log`. */
export interface OperationLogEntry {
    id: number;
    entryType: string;
    logEntry: string;
    createdAt: string;
    uecAmount?: number;
    /** Set when entryType === 'UEC_COST'. */
    costCategory?: OperationCostCategory;
    costDescription?: string;
    author?: { id: number; name: string; avatarUrl?: string };
}

export enum PhaseStatus {
    Pending = 'Pending',
    Active = 'Active',
    Completed = 'Completed',
    Skipped = 'Skipped'
}

export enum TaskStatus {
    Pending = 'Pending',
    Active = 'Active',
    Completed = 'Completed',
    Failed = 'Failed'
}

export enum TaskPriority {
    Low = 'Low',
    Normal = 'Normal',
    High = 'High',
    Critical = 'Critical'
}

export enum AARCategory {
    Observation = 'observation',
    Sustain = 'sustain',
    Improve = 'improve',
    ActionItem = 'action_item'
}

export enum LogisticsCategory {
    Ammo = 'ammo',
    Medical = 'medical',
    Transport = 'transport',
    Fuel = 'fuel',
    General = 'general'
}

export enum LogisticsStatus {
    Needed = 'Needed',
    Partial = 'Partial',
    Fulfilled = 'Fulfilled'
}

export enum OperationType {
    PvP = 'PvP',
    PvE = 'PvE',
    Mixed = 'Mixed',
    NonCombat = 'Non-Combat',
    Training = 'Training',
    Social = 'Social'
}

export enum WarrantAction {
    Caution = 'Caution',
    HighCaution = 'High Caution',
    ExtremeCaution = 'Extreme Caution'
}

export enum WarrantStatus {
    Active = 'Active',
    Claimed = 'Claimed',
    Cancelled = 'Cancelled',
    Standing = 'Standing'
}

export enum IntelSubjectType {
    Person = 'Person',
    Organization = 'Organization'
}

export enum IntelThreatLevel {
    None = 'None',
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
    Critical = 'Critical'
}

export enum ApplicationStatus {
    Applied = 'Applied',
    Screening = 'Screening',
    Interviewing = 'Interviewing',
    OnHold = 'On Hold',
    Offered = 'Offered',
    Rejected = 'Rejected',
    Accepted = 'Accepted',
    Hired = 'Hired',
    Withdrawn = 'Withdrawn'
}

export enum JobPostingStatus {
    Draft = 'Draft',
    Open = 'Open',
    Closed = 'Closed',
    Filled = 'Filled'
}

export enum TransferRequestStatus {
    Pending = 'Pending',
    Approved = 'Approved',
    Denied = 'Denied',
    Cancelled = 'Cancelled'
}

export enum ConductRecordType {
    Commendation = 'Commendation',
    Observation = 'Observation',
    Counseling = 'Counseling',
    Warning = 'Warning',
    Infraction = 'Infraction'
}

export enum LocationType {
    System = 'System',
    Planet = 'Planet',
    Moon = 'Moon',
    Station = 'Station',
    Facility = 'Facility'
}

// Fleet Manager
export enum ShipStatus { Active = 'Active', Stored = 'Stored', Damaged = 'Damaged', Lent = 'Lent', Sold = 'Sold' }
export enum FleetGroupType { Division = 'Division', Squadron = 'Squadron', Wing = 'Wing', Taskforce = 'Taskforce', Custom = 'Custom' }

// Operations RSVP
export enum RSVPStatus { Pending = 'Pending', Accepted = 'Accepted', Declined = 'Declined', Tentative = 'Tentative' }

// Alliance System — secure server-to-server federation between self-hosted
// instances. See lib/db/alliances.ts and migrations/add-alliances.sql.
export enum AllianceStatus { Pending = 'Pending', Active = 'Active', Dissolved = 'Dissolved' }
export enum AllianceType { Alliance = 'Alliance', Rivalry = 'Rivalry', Neutral = 'Neutral' }

// Per-channel sharing toggles on an alliance peer.
export interface AllianceChannels {
    reports?: boolean;
    warrants?: boolean;
    bulletins?: boolean;
    // Opt-in to cross-instance joint operations with this peer.
    operations?: boolean;
    // Opt-in to share a minimal member roster / fleet summary with this peer.
    roster?: boolean;
    fleet?: boolean;
}

// Minimal, deny-by-default roster projection shared with an ally. NO PII
// (no discord id, email, notes, clearance, permissions).
export interface AllyRosterMember {
    id: number;
    rsiHandle: string;
    name: string;
    avatarUrl?: string | null;
    rankName?: string | null;
    rankIcon?: string | null;
    unitName?: string | null;
    roleName?: string | null;
    isDuty: boolean;
    specializations?: { name: string; icon?: string | null }[];
}
export interface AllyRosterData {
    memberCount: number;
    members: AllyRosterMember[];
    fetchedAt: string;
}

// Aggregate fleet summary (no per-member ship ownership).
export interface AllyFleetGroup {
    name: string;
    type: string;
    totalShips: number;
}
export interface AllyFleetSummary {
    groupCount: number;
    totalShips: number;
    shipsByCategory: { category: string; count: number }[];
    groups: AllyFleetGroup[];
    fetchedAt: string;
}

// Admin-facing peer view. Key material, code hashes, and the entered peer code
// are NEVER included — see listAlliancePeers() in lib/db/alliances.ts.
export interface AlliancePeer {
    id: string;
    label: string;
    baseUrl: string;
    peerOrgName?: string | null;
    peerOrgTag?: string | null;
    peerIconUrl?: string | null;
    peerBlurb?: string | null;
    status: AllianceStatus;
    type: AllianceType;
    inboundMaxClearance: number;
    outboundMaxClearance: number;
    channels: AllianceChannels;
    pairingState: string;
    hasOutboundKey: boolean;
    lastContactAt?: string | null;
    createdAt?: string;
    // Live-sync health (admin UI badge + diagnostics).
    syncHealth?: 'unknown' | 'healthy' | 'degraded' | 'down';
    syncFailures?: number;
    syncLastOkAt?: string | null;
    syncNextAttemptAt?: string | null;
    syncAlert?: string | null;
}

// Member-facing directory card — the safe projection sent to the browser.
export interface AllianceDirectoryEntry {
    id: string;
    peerOrgName?: string | null;
    peerOrgTag?: string | null;
    peerIconUrl?: string | null;
    peerBlurb?: string | null;
    status: AllianceStatus;
    type: AllianceType;
    lastContactAt?: string | null;
}

// The org's own advertised directory card, stored as the settings key
// 'allianceSelfProfile' and served to verified peers via /api/alliance/profile.
export interface AllianceSelfProfile {
    orgName: string;
    orgTag?: string;
    iconUrl?: string;
    blurb?: string;
    contactDiscord?: string;
    directoryVisible: boolean;
}

// Result of generating a one-time pairing code (returned to the admin once).
export interface AlliancePairingCode {
    code: string;
    expiresAt: string;
}

// Government System
export enum GovernmentType {
    MilitaryJunta = 'military_junta',
    CorporateBoard = 'corporate_board',
    DemocraticRepublic = 'democratic_republic',
    ConstitutionalMonarchy = 'constitutional_monarchy',
    Westminster = 'westminster',
    Technocracy = 'technocracy',
    PirateCode = 'pirate_code',
    Custom = 'custom'
}

export enum GovernmentBranchType {
    Executive = 'Executive',
    Legislative = 'Legislative',
    Judicial = 'Judicial',
    Custom = 'Custom'
}

export enum PositionFillMethod {
    Appointed = 'Appointed',
    Elected = 'Elected',
    Hereditary = 'Hereditary',
    Merit = 'Merit'
}

export enum ElectionType {
    SimpleMajority = 'SimpleMajority',
    Preferential = 'Preferential',
    ProportionalRepresentation = 'ProportionalRepresentation',
    Approval = 'Approval',
    Plurality = 'Plurality'
}

export enum ElectionStatus {
    Draft = 'Draft',
    Candidacy = 'Candidacy',
    Voting = 'Voting',
    Concluded = 'Concluded',
    Cancelled = 'Cancelled',
    Runoff = 'Runoff'
}

export enum LegislationStatus {
    Draft = 'Draft',
    Proposed = 'Proposed',
    Debate = 'Debate',
    Voting = 'Voting',
    Passed = 'Passed',
    Failed = 'Failed',
    Vetoed = 'Vetoed',
    Repealed = 'Repealed',
    Amended = 'Amended'
}

export enum MotionStatus {
    Open = 'Open',
    Voting = 'Voting',
    Passed = 'Passed',
    Failed = 'Failed',
    Cancelled = 'Cancelled'
}

export type ServiceType = string;

export interface Rank {
    id: number;
    name: string;
    iconUrl: string;
    sortOrder: number;
}

export interface OrganizationalUnit {
    id: number;
    name: string;
    parentUnitId?: number;
    sortOrder?: number;
    leaderId?: number;
    logoUrl?: string;
    bannerUrl?: string;
    motto?: string;
    description?: string;
    hasRadioChannel?: boolean;
    linkedChannelId?: string;
    leader?: User;
    // When true, the unit's detail page (roster, feed, operations) is gated
    // to its members + users with the units:view_all permission. The card
    // itself remains visible in the Org Chart with a lock badge so the org
    // structure stays legible. Defaults to false (open) for new and existing
    // units; pre-migration rows return undefined which is treated the same.
    isRestricted?: boolean;
}

export interface Role {
    id: number;
    name: string;
    description?: string;
    permissions?: string[];
    memberCount?: number;
    is_system?: boolean;
}

export interface PersonnelPosition {
    id: number;
    name: string;
    description?: string;
    icon?: string;
    department?: string;
}

export interface SecurityClearance {
    id: number;
    level: number;
    name: string;
    description?: string;
}

export interface LimitingMarker {
    id: number;
    name: string;
    code: string;
    description?: string;
    syncRestricted?: boolean;
}

export interface SpecializationTag {
    id: number;
    name: string;
    description?: string;
    icon?: string;
    imageUrl?: string;
}

export interface Certification {
    id: number;
    name: string;
    description?: string;
    icon?: string;
    imageUrl?: string;
    awardedAt?: string;
    awardedBy?: User;
}

export interface Commendation {
    id: number;
    name: string;
    description?: string;
    icon?: string;
    imageUrl?: string;
    awardedAt?: string;
    awardedBy?: User;
    reason?: string;
}

export interface ConductRecord {
    id: number;
    type: ConductRecordType;
    reason: string;
    enteredBy: User;
    createdAt: string;
}

export interface User {
    id: number;
    discordId: string;
    /** Effective display name — `displayName` if the user has set one, otherwise the Discord-sourced name. Use this everywhere. */
    name: string;
    /** User-set override. `null` or `undefined` = no override (app falls back to Discord name). Exposed so admin/profile UIs can tell whether a custom name is active. */
    displayName?: string | null;
    /** Raw Discord-sourced name (global_name or guild nick). Surfaced so admin views / the Profile page can show "what Discord says" when a custom name is set. */
    discordName?: string;
    avatarUrl: string;
    rsiHandle: string;
    role: UserRole;
    roleId: number;
    rank?: Rank;
    unit?: OrganizationalUnit;
    position?: PersonnelPosition;
    secondaryPosition?: PersonnelPosition;
    reputation: number;
    isDuty: boolean;
    /** Admin-toggled visual flag — only meaningful when role === Client. */
    isAffiliate?: boolean;
    /** Admin-toggled visual flag — only meaningful when role === Client. */
    isVip?: boolean;
    permissions: string[];
    createdAt: string;
    adminNotes?: string;
    personnelNotes?: string;
    clearanceLevel?: SecurityClearance;
    limitingMarkers?: LimitingMarker[];
    specializations?: SpecializationTag[];
    certifications?: Certification[];
    commendations?: Commendation[];
    conductRecord?: ConductRecord[];
    rsiHandlePending?: string;
    rsiVerificationCode?: string;
    /** false only when an admin used the first-run "verify later (offline)" bypass. */
    rsiVerified?: boolean;
    jobTitle?: string;
    voiceChannelName?: string;
    /** IANA timezone, e.g. "Europe/London". `null`/`undefined` = use the browser's detected zone. */
    timezone?: string | null;
    /** Date format preset key. `null`/`undefined` = `compact_12h` ("01 Apr 26 10:00 AM"). */
    dateFormat?: 'compact_12h' | 'iso_24h' | 'us_12h' | null;
    averageRating?: number;
    auth_user_id?: string;
    probationStart?: string;
    probationEnd?: string;
    /** Admin override for tenure start. When set, replaces createdAt for "member since" / tenure displays. Null = use createdAt. */
    tenureStartDate?: string | null;
    /** Per-user session-revocation watermark. HMAC tokens issued before this are
     *  rejected (force_logout) by the dispatcher. Set by an admin revoke or by a
     *  soft-delete/ban. Null = no per-user revocation in effect. */
    tokensValidFrom?: string | null;
}

/** A single HR or Government position assignment in a user's career timeline. Source: user_position_history_unified view. */
export interface PositionHistoryEntry {
    kind: 'hr' | 'government';
    id: number;
    userId: number;
    positionId: number;
    positionName: string;
    positionDescription?: string;
    positionIcon?: string;
    startedAt: string;
    endedAt?: string | null;
    endReason?: string | null;
}

export interface Announcement {
    id: string;
    title: string;
    body: string;
    author: string;
    type: AnnouncementType;
    audience: string[];
    publishDate: string;
    expiryDate?: string;
}

export enum AnnouncementType {
    Information = 'Information',
    Warning = 'Warning',
    Danger = 'Danger'
}

export interface ServiceRequest {
    id: string;
    clientId?: number;
    client?: User;
    unregisteredClientRsiHandle?: string;
    serviceType: string;
    location: string;
    description: string;
    status: ServiceRequestStatus;
    urgency: UrgencyLevel;
    threatLevel: ThreatLevel;
    leadResponderId?: number;
    leadResponder?: User;
    createdAt: string;
    updatedAt: string;
    uecEarned?: number;
    medigelConsumed?: number;
    clientRating?: number;
    clientFeedback?: string;
    rated: boolean;
    partyInfo?: string;
    secondaryClientHandles?: string[];
    assignedMembers: User[];
    assignedMemberIds: number[];
}

export interface HydratedServiceRequest extends ServiceRequest {
    statusHistory: any[];
    hydratedStatusHistory: any[];
}

export interface HydratedOperation {
    id: string;
    name: string;
    ownerId: number;
    owner: User;
    status: OperationStatus;
    type: OperationType;
    description: string;
    tracksUec: boolean;
    totalUec: number;
    /** Running sum of UEC_COST entries — gross cost, not signed. */
    totalCosts: number;
    /** How payouts are split among participants when calculating estimates. */
    payoutMode: OperationPayoutMode;
    createdAt: string;
    updatedAt: string;
    activeStartTime?: string;
    activeEndTime?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    isSpecial: boolean;
    joinCode?: string;
    clearanceLevel: number;
    isTraining: boolean;
    maxParticipants?: number;
    unitId?: number;
    unit?: OrganizationalUnit;
    locationId?: number;
    location?: Location;
    // Secondary locations attached via operation_locations. The primary still
    // travels through `location`; this list excludes it.
    additionalLocations?: Location[];
    // Free-text location strings sourced from the platform_locations search
    // (LocationInput component). Preferred over `location` / `additionalLocations`
    // for new ops; legacy ops fall back to the joined org-locations rows.
    locationText?: string;
    additionalLocationTexts?: string[];
    discordEventId?: string;
    // Channel + message IDs for the optional embed announcement (separate from
    // the Guild Scheduled Event above). Channel ID is set on create when the
    // wizard's "Post Announcement Embed" toggle is on; message ID is back-filled
    // by the server after the embed posts and is used to edit the embed in
    // place when the operation is updated (preserving Discord-side reactions).
    discordAnnouncementChannelId?: string;
    discordAnnouncementMessageId?: string;
    // ID of the operation_template this op was instantiated from, if any.
    templateId?: number;
    limitingMarkers: LimitingMarker[];
    participants: {
        userId: number;
        user: User;
        timeJoined: string;
        timeLeft?: string;
        isReady: boolean;
        roleRequested?: string;
        shipUtilized?: string;
        attendanceStatus?: string;
        rsvpStatus?: string;
        rsvpAt?: string;
        shipId?: number;
        ship?: PlatformShip;
        userShipId?: number;
        liveStatus?: OperationLiveStatus;
        /** Custom payout share — used only when operation.payoutMode === 'custom'. */
        payoutSharePercent?: number;
        /** Set when this participant has been settled. Read-only once op concluded. */
        payoutPaidAt?: string;
        payoutPaidBy?: number;
    }[];
    log: OperationLogEntry[];
    // Joint operations
    isJoint: boolean;
    alliedOrgs?: OperationAlliedOrg[];
    // Members of allied peer instances participating in this (host-owned) joint op.
    alliedParticipants?: AlliedParticipant[];
    // SMEAC planning fields
    roe?: string;
    commanderNotes?: string;
    commsPlan: CommsPlanEntry[];
    liveStatus?: OperationLiveStatus;
    // AAR
    aarSummary?: string;
    aarLessonsLearned?: string;
    aarSubmittedAt?: string;
    aarSubmittedBy?: number;
    aarAiGeneratedAt?: string;
    // Sub-resources (populated on detail fetch)
    phases?: OperationPhase[];
    scheduleEntries?: OperationScheduleEntry[];
    tasks?: OperationTask[];
    commandNodes?: OperationCommandNode[];
    boardElements?: OperationBoardElement[];
    logistics?: OperationLogisticsItem[];
    aarEntries?: AAREntry[];
}

export type CommsProvider =
    | 'discord_voice'
    | 'discord_text'
    | 'op_radio'
    | 'teamspeak'
    | 'mumble'
    | 'simple_radio'
    | 'dcs_srs'
    | 'external'
    | 'other';

export interface CommsPlanEntry {
    // Optional for backward-compat with legacy rows that only have
    // `channel/frequency/callsign/notes` populated.
    id?: string;
    purpose?: string;
    provider?: CommsProvider;
    label?: string;
    discordChannelId?: string;
    address?: string;
    port?: number;
    url?: string;

    // Legacy + provider-conditional fields. `channel` survives as a legacy
    // free-text fallback; `frequency` and `callsign` are still meaningful
    // for SimpleRadio / DCS-SRS / in-game radio rows.
    channel?: string;
    frequency?: string;
    callsign?: string;
    notes?: string;
}

// An allied PEER invited to a locally-owned joint operation.
export interface OperationAlliedOrg {
    id: number;
    operationId: string;
    peerId: string;
    accepted: boolean;
    invitedAt: string;
    acceptedAt?: string;
    // Cached directory fields from the alliance_peers row.
    label?: string | null;
    peerOrgName?: string | null;
    peerOrgTag?: string | null;
    peerIconUrl?: string | null;
}

// A member of an allied PEER participating in a locally-owned joint op. No local
// user — identity is a snapshot synced from the peer.
export interface AlliedParticipant {
    operationId: string;
    peerId: string;
    remoteUserHandle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    role?: string | null;
    shipText?: string | null;
    rsvpStatus: string;
    isReady: boolean;
    updatedAt: string;
}

// GUEST side: a read-only mirror of an operation hosted by an allied peer.
export interface MirroredOperation {
    id: string;               // the HOST operation id
    hostPeerId: string;
    hostPeerName?: string | null;
    hostPeerIconUrl?: string | null;
    snapshot: HydratedOperation | null;
    version: number;
    snapshotUpdatedAt?: string | null;
    accepted: boolean;
    invitedAt: string;
    acceptedAt?: string | null;
    lastPolledAt?: string | null;
    // This instance's own members' participation, overlaid on the host snapshot.
    myParticipation?: MirroredParticipation[];
}

export interface MirroredParticipation {
    mirrorOpId: string;
    userId: number;
    user?: User;
    rsvpStatus: string;
    shipText?: string | null;
    isReady: boolean;
    updatedAt: string;
}

export interface OperationPhase {
    id: number;
    operationId: string;
    name: string;
    description?: string;
    phaseType: 'sequential' | 'contingency';
    sortOrder: number;
    status: PhaseStatus;
    color?: string;
    createdAt: string;
}

export interface OperationScheduleEntry {
    id: number;
    operationId: string;
    label: string;
    scheduledTime: string;
    phaseId?: number;
    notes?: string;
    status?: string;
    sortOrder: number;
    createdAt: string;
}

export interface OperationTask {
    id: number;
    operationId: string;
    title: string;
    description?: string;
    taskType: 'primary' | 'secondary' | 'assignment';
    assignedUnitId?: number;
    assignedUserId?: number;
    assignedUser?: User;
    assignedUnit?: OrganizationalUnit;
    phaseId?: number;
    status: TaskStatus;
    priority: TaskPriority;
    sortOrder: number;
    createdAt: string;
}

// Operation Templates capture only the structural plan (phases + their child
// milestones and tasks) so users can spin up similar ops quickly. Participants,
// command nodes, board elements, logistics, allies, and logs are intentionally
// excluded — those are op-specific runtime state.
export interface OperationTemplateMilestone {
    label: string;
    notes?: string;
    // Minutes from the new operation's scheduled start. Optional — milestones
    // may be left unscheduled and timed later.
    offsetMinutes?: number;
}

export interface OperationTemplateTask {
    title: string;
    description?: string;
    taskType?: 'primary' | 'secondary' | 'assignment';
    priority?: TaskPriority;
}

export interface OperationTemplatePhase {
    name: string;
    description?: string;
    phaseType?: 'sequential' | 'contingency';
    color?: string;
    milestones?: OperationTemplateMilestone[];
    tasks?: OperationTemplateTask[];
}

export interface OperationTemplatePayload {
    phases: OperationTemplatePhase[];
}

export interface OperationTemplate {
    id: number;
    name: string;
    description?: string;
    createdBy?: number;
    createdByName?: string;
    createdAt: string;
    updatedAt: string;
    payload: OperationTemplatePayload;
}

export interface OperationCommandNode {
    id: number;
    operationId: string;
    parentId?: number;
    label: string;
    nodeType: 'command' | 'unit' | 'position';
    assignedUserId?: number;
    assignedUnitId?: number;
    assignedUser?: User;
    assignedUnit?: OrganizationalUnit;
    fleetGroupId?: number;
    fleetGroup?: FleetGroup;
    posX: number;
    posY: number;
    color?: string;
    icon?: string;
    sortOrder: number;
    liveStatus?: string;
    createdAt: string;
    children?: OperationCommandNode[];
}

export interface OperationBoardElement {
    id: number;
    operationId: string;
    elementType: 'unit' | 'waypoint' | 'line' | 'zone' | 'text' | 'icon' | 'ship';
    label?: string;
    posX: number;
    posY: number;
    width?: number;
    height?: number;
    rotation: number;
    color?: string;
    data: Record<string, any>;
    layer: number;
    sortOrder: number;
    createdAt: string;
}

export interface OperationLogisticsItem {
    id: number;
    operationId: string;
    itemName: string;
    quantityNeeded: number;
    quantityFulfilled: number;
    fulfilledByUserId?: number;
    category: LogisticsCategory;
    status: LogisticsStatus;
    notes?: string;
    createdAt: string;
}

export interface AAREntry {
    id: number;
    operationId: string;
    authorId: number;
    author?: User;
    category: AARCategory;
    content: string;
    upvotes: number;
    createdAt: string;
}

export interface HydratedOperationTeam {
    id: string;
    name: string;
}

export interface HydratedOperationPosition {
    id: string;
    name: string;
}

export interface HydratedWarrant {
    id: string;
    targetRsiHandle: string;
    reason: string;
    action: WarrantAction;
    uecReward: number;
    status: WarrantStatus;
    // null for federated warrants ingested from an allied feed — render
    // "via {sourceFeedLabel}" provenance instead of a local issuer.
    issuedBy: number | null;
    issuedByUser: User;
    claimedBy?: number;
    claimedByUser?: User;
    issuedAt: string;
    claimedAt?: string;
    // Cached "latest note" for list-view rendering. Canonical history lives
    // in the warrant_notes table. Loaded lazily on detail-modal open.
    notes?: string;
    sourceFeedId?: string;
    sourceFeedLabel?: string;
    externalId?: string;
}

// Append-only note row attached to a warrant. Each post is a separate row
// with author + timestamp; the legacy warrants.notes column is updated to
// the latest note's content for list-view callers.
export interface WarrantNote {
    id: number;
    warrantId: string;
    authorId: number | null;
    content: string;
    createdAt: string;
    author?: User;
}

export interface HydratedIntelligenceReport {
    id: string;
    targetId: string;
    subjectType: IntelSubjectType;
    threatLevel: IntelThreatLevel;
    tags: string[];
    summary: string;
    evidenceUrls: string[];
    createdBy?: User;
    externalAuthor?: string;
    affiliatedOrg?: string;
    sourceFeedLabel?: string;
    createdAt: string;
    classificationLevel: number;
    limitingMarkers: LimitingMarker[];
}

export interface IntelTargetIndexEntry {
    targetId: string;
    threatLevel: IntelThreatLevel;
}

export interface IntelHubStats {
    totalReports: number;
    criticalCount: number;
    recentCount7d: number;
}

export interface PaginatedIntelReports {
    items: HydratedIntelligenceReport[];
    nextCursor: string | null;
    hasMore: boolean;
}

export interface ExternalTool {
    id: number;
    title: string;
    description: string;
    url: string;
    icon: string;
    audience: string[];
    // Optional grouping label. Tools without a category fall into a synthetic
    // "General" bucket in the user-facing tools view.
    category?: string;
    // Lower numbers display first within a category. Defaults to 0 server-side
    // so existing rows keep their current order until an admin reorders.
    sortOrder?: number;
}

export interface RadioChannel {
    id: string;
    name: string;
    color: string;
    type?: string;
    sortOrder?: number;
    isPreset?: boolean;
    description?: string;
}

export interface ActiveRoom {
    roomName: string;
    participantCount: number;
    participants: string[];
    participantNames: string[];
}

export interface Location {
    id: number;
    name: string;
    type: LocationType;
    parent_id?: number;
}

/** Custom theme (v1: accent-only). When disabled/absent, the default theme applies. */
export interface ThemeConfig {
    enabled: boolean;
    /** Base brand accent as a canonical #rrggbb hex; the server derives the full shade ramp. */
    accent?: string;
}

export interface BrandingConfig {
    name: string;
    iconUrl: string;
    notificationSoundUrl?: string;
    themeColor?: string;
    loginTitle?: string;
    loginSubtitle?: string;
    dutyTimeoutMinutes?: number;
    bootSoundUrl?: string;
    newRequestSoundUrl?: string;
    assignmentSoundUrl?: string;
    eamSoundUrl?: string;
    radioMicCueUrl?: string;
    radioSquelchUrl?: string;
    termsOfService?: string;
}

export interface PublicPageExternalLink {
    id: string;
    label: string;
    url: string;
    icon?: string;
}

export interface PublicPageConfig {
    enabled: boolean;
    motto?: string;
    blurb?: string;
    heroImageUrl?: string;
    profileImageUrl?: string;
    modules: {
        stats: boolean;
        testimonials: boolean;
        services: boolean;
        links: boolean;
    };
    links: PublicPageExternalLink[];
    featuredTestimonialIds: string[];
}

export interface PublicTestimonial {
    id: string;
    rating: number;
    quote: string;
    serviceType: string;
    ratedAt: string;
}

export interface PublicPageStats {
    totalCompleted: number;
    avgRatingTimes10: number;
    avgResponseMinutes: number;
    last30Completed: number;
}

export interface TestimonialCandidate {
    id: string;
    rating: number;
    quote: string;
    serviceType: string;
    ratedAt: string;
}

export interface DiscordConfig {
    clientId?: string;
    newRequestChannelId?: string;
    intelChannelId?: string;
    eamChannelId?: string;
    /** Org-wide default channel ID for the optional Operation Announcement
     *  Embed posted from the operation create wizard. Per-op overrides live
     *  on operations.discord_announcement_channel_id. */
    defaultOperationAnnounceChannelId?: string;
}

export interface HeroCardConfig {
    backgroundImageUrl: string;
    discordUrl: string;
    organizationUrl: string;
    title: string;
    subtitle: string;
}

export interface WikiHomeConfig {
    welcomeContent?: any;
    featuredPageIds?: string[];
    // When true, the "Recently Updated" panel on the wiki home page is hidden.
    // Defaults to false (panel visible) so existing tenants see no change.
    hideRecentlyUpdated?: boolean;
}

export interface OpenGraphConfig {
    title: string;
    description: string;
    imageUrl: string;
    themeColor?: string;
    faviconUrl?: string;
    pwaIconUrl?: string;
    keywords?: string;
    twitterCard?: string;
}

export interface RadioConfig {
    channelName: string;
    configured?: boolean;
}

export interface AIConfig {
    enabled: boolean;
    model?: string;
    /** Gemini key: decrypted string server-side, masked to { configured, hint } by the portal, stripped before reaching the dashboard client. */
    apiKey?: unknown;
}

export interface HRConfig {
    probationDays?: number;
}

export interface GovernmentsFeatureConfig {
    enabled: boolean;
}

export interface SystemConfig {
    appUrl: string;
    [key: string]: unknown;
}

export interface IntelSharingConfig {
    maxShareableClearance?: number;
}

export interface GovernmentConfig {
    id: string;
    governmentType: GovernmentType;
    name: string;
    description?: string;
    constitutionContent?: any;
    createdAt: string;
    updatedAt: string;
}

export interface GovernmentBranch {
    id: number;
    name: string;
    branchType: GovernmentBranchType;
    description?: string;
    sortOrder: number;
    icon?: string;
    createdAt: string;
    positions?: GovernmentPosition[];
}

export interface GovernmentPosition {
    id: number;
    branchId?: number;
    branch?: GovernmentBranch;
    name: string;
    description?: string;
    fillMethod: PositionFillMethod;
    termLengthDays?: number;
    maxHolders: number;
    icon?: string;
    sortOrder: number;
    permissionsGranted: string[];
    canProposeLegislation: boolean;
    canVoteLegislation: boolean;
    canVetoLegislation: boolean;
    canCallElections: boolean;
    canIssueOrders?: boolean;
    createdAt: string;
    currentHolders?: GovernmentPositionHolder[];
}

export interface GovernmentPositionHolder {
    id: number;
    positionId: number;
    position?: GovernmentPosition;
    userId: number;
    user?: User;
    appointedById?: number;
    appointedBy?: User;
    electionId?: number;
    startedAt: string;
    endedAt?: string;
    endReason?: string;
    createdAt: string;
}

export interface GovernmentElection {
    id: number;
    positionId: number;
    position?: GovernmentPosition;
    title: string;
    description?: string;
    electionType: ElectionType;
    status: ElectionStatus;
    candidacyStart?: string;
    candidacyEnd?: string;
    votingStart?: string;
    votingEnd?: string;
    minCandidates: number;
    maxWinners: number;
    minVoterTurnoutPct?: number;
    minVoteThresholdPct?: number;
    allowRunoff: boolean;
    runoffTopN: number;
    parentElectionId?: number;
    isByElection: boolean;
    remainingTermDays?: number;
    createdById: number;
    createdBy?: User;
    concludedAt?: string;
    conclusionReason?: string;
    certifiedById?: number;
    certifiedAt?: string;
    eligibleVoterCount?: number;
    totalVotesCast?: number;
    candidates?: GovernmentElectionCandidate[];
    hasVoted?: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface GovernmentElectionCandidate {
    id: number;
    electionId: number;
    userId: number;
    user?: User;
    platformStatement?: string;
    declaredAt: string;
    withdrawnAt?: string;
    isWinner: boolean;
    voteCount?: number;
    votePercentage?: number;
}

export interface GovernmentLegislation {
    id: number;
    title: string;
    body: any;
    summary?: string;
    status: LegislationStatus;
    authorId: number;
    author?: User;
    sponsorPositionId?: number;
    sponsorPosition?: GovernmentPosition;
    parentLegislationId?: number;
    isConstitutionalAmendment: boolean;
    votingStart?: string;
    votingEnd?: string;
    votesFor: number;
    votesAgainst: number;
    votesAbstain: number;
    passedAt?: string;
    vetoedAt?: string;
    vetoedById?: number;
    vetoedBy?: User;
    vetoReason?: string;
    repealedAt?: string;
    repealedByLegislationId?: number;
    comments?: GovernmentLegislationComment[];
    votes?: GovernmentLegislationVote[];
    myVote?: string;
    createdAt: string;
    updatedAt: string;
}

export interface GovernmentLegislationComment {
    id: number;
    legislationId: number;
    userId: number;
    user?: User;
    content: string;
    createdAt: string;
}

export interface GovernmentLegislationVote {
    id: number;
    legislationId: number;
    userId: number;
    user?: User;
    positionId: number;
    position?: GovernmentPosition;
    vote: 'for' | 'against' | 'abstain';
    castAt: string;
}

export interface GovernmentMotion {
    id: number;
    title: string;
    description?: any;
    status: MotionStatus;
    createdById: number;
    createdBy?: User;
    restrictedToPositionIds?: number[];
    votingStart?: string;
    votingEnd?: string;
    votesFor: number;
    votesAgainst: number;
    votesAbstain: number;
    isSecretBallot: boolean;
    concludedAt?: string;
    hasVoted?: boolean;
    myVote?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ServiceTypeConfig {
    id: number;
    name: string;
    icon: string;
    color: string;
    description?: string;
    isActive: boolean;
    /** Per-type Discord channel override (17–19 digit snowflake). When unset,
     *  notifications fall back to discordConfig.newRequestChannelId. */
    discordChannelId?: string;
}

export interface HydratedHRApplication {
    id: string;
    applicantName: string;
    applicantDiscordId: string;
    rsiHandle: string;
    status: ApplicationStatus;
    referralSource?: string;
    notes?: string;
    assignedRecruiterId?: number;
    assignedRecruiter?: User;
    linkedUserId?: number;
    createdAt: string;
    vettingData?: any;
    interviews: HydratedHRInterview[];
    logs: any[];
}

export interface HydratedHRInterview {
    id: string;
    applicationId: string;
    templateId: number;
    template: HRInterviewTemplate;
    interviewerId: number;
    interviewer: User;
    panelMembers: User[];
    scheduledAt: string;
    completedAt?: string;
    overallNotes?: string;
    finalScore?: number;
    status: string;
    isRecommended?: boolean;
    responses: { questionId: number; responseBody: string; score: number }[];
    applicantName?: string;
}

export interface HRInterviewTemplate {
    id: number;
    name: string;
    description: string;
    questions: HRInterviewQuestion[];
}

export interface HRInterviewQuestion {
    id: number;
    templateId: number;
    questionText: string;
    orderIndex: number;
}

export interface JobPosting {
    id: string;
    title: string;
    department: string;
    description: string;
    requirements: string[];
    status: JobPostingStatus;
    createdAt: string;
    positionId?: number;
    position?: PersonnelPosition;
}

export interface TransferRequest {
    id: string;
    userId: number;
    currentUnitId?: number;
    targetUnitId: number;
    targetUnit?: OrganizationalUnit;
    reason: string;
    status: TransferRequestStatus;
    adminNotes?: string;
    createdAt: string;
    updatedAt: string;
    user?: User;
}

export interface WikiPage {
    id: string;
    parentPageId: string | null;
    title: string;
    slug: string;
    content: any;
    classificationLevel: number;
    sortOrder: number;
    limitingMarkers: LimitingMarker[];
    createdById: number | null;
    updatedById: number | null;
    createdBy?: User;
    updatedBy?: User;
    createdAt: string;
    updatedAt: string;
    // When true, the page cannot be re-parented (moved to a different parent
    // in the wiki tree). Sibling reordering is still permitted. Defaults to
    // false; pre-migration DBs return undefined which is treated the same.
    menuStructureLocked?: boolean;
}

export interface WikiExportPage {
    id: string;
    parentPageId: string | null;
    title: string;
    slug: string;
    content: any;
    classificationLevel: number;
    sortOrder: number;
    markerNames: string[];
}

export interface WikiExportBundle {
    version: 1;
    exportedAt: string;
    sourceOrg: { id: string; name: string };
    wikiHomeConfig: WikiHomeConfig | null;
    pages: WikiExportPage[];
}

export type WikiImportMode = 'skip' | 'overwrite' | 'new';

export interface WikiImportResult {
    inserted: number;
    updated: number;
    skipped: number;
}

// --- Full-organization data export (hosted customer portal → self-hosted import) ---
// Streamable NDJSON: one header line then one `{ kind:'row', t, r }` line per row.
// Mirrors the hosted producer shapes (my-rsi-rg/types.ts + lib/db/exporter.ts);
// consumed by this fork's importer (lib/db/importer.ts).
export interface OrgExportHeader {
    kind: 'header';
    version: number;
    exportedAt: string;
    sourceApp: string;
    /** `features` is the source org's optional-module on/off state, carried on the
     *  header because the hosted `organizations` table (where it lives) is never
     *  exported. Plain booleans on the wire; the importer allowlists the keys this
     *  fork gates on and rebuilds them into the local `{ enabled }` shape. Optional —
     *  an export produced before this field existed still imports. */
    sourceOrg: { name: string; slug: string; features?: Record<string, boolean> };
    /** FK-dependency order the importer must follow (parents before children). */
    tableOrder: string[];
    /** Per-table row counts — completeness check + progress denominator. */
    manifest: Record<string, number>;
}

/** One NDJSON row line: a single source row `r` tagged with its table `t`. */
export interface OrgExportRow {
    kind: 'row';
    /** Source table name. */
    t: string;
    /** The exported row (organization_id stripped, secrets excluded, catalog
     *  external keys embedded under the catalog-table alias). */
    r: Record<string, unknown>;
}

export interface DiscordRole {
    id: string;
    name: string;
    color: string;
}

/**
 * Slim payload returned by `?subset=users_presence`. Used for realtime
 * duty-flip refreshes — patched into existing `allUsers` rather than
 * replacing the full user objects.
 */
export interface UserPresenceRow {
    userId: number;
    isDuty: boolean;
    lastActiveAt: string | null;
}

/** Toast severity — picks the visual treatment (accent stripe + icon tint) and the auto-dismiss duration. */
export type ToastVariant = 'success' | 'error' | 'warning' | 'info' | 'neutral';

export interface HydratedReputationHistoryEntry {
    id: number;
    userId: number;
    adminUserId: number;
    adminUser: User;
    changeDate: string;
    oldReputation: number;
    newReputation: number;
    reason: string;
}

export interface RatingHistoryEntry {
    requestId: string;
    serviceType: string;
    clientRating: number;
    date: string;
    clientRsiHandle: string;
    rating: number;
    feedback?: string;
}

export interface ApiKey {
    id: string;
    label: string;
    keyPrefix: string;
    createdAt: string;
    lastUsedAt?: string;
}

export interface TrustedIntelFeed {
    id: string;
    label: string;
    url: string;
    apiKey: string;
    lastSyncedAt?: string;
    syncReports: boolean;
    syncWarrants: boolean;
    syncBulletins: boolean;
    inboundMaxClearance: number;
}

export interface UnitPost {
    id: string;
    unitId: number;
    authorId: number;
    author?: User;
    content: string;
    createdAt: string;
    pinned: boolean;
}

export interface ClearanceHistoryEntry {
    id: number;
    userId: number;
    adminId: number;
    adminName: string;
    oldLevelId?: number;
    newLevelId?: number;
    oldLevelName?: string;
    newLevelName?: string;
    changesDescription: string;
    createdAt: string;
}

export interface VettingChecklist {
    rsiProfile: 'pending' | 'clear' | 'flagged';
    orgHistory: 'pending' | 'clear' | 'flagged';
    internalRecord: 'pending' | 'clear' | 'flagged';
    interview: 'pending' | 'clear' | 'flagged';
}

export interface VettingData {
    stage: string;
    checks: VettingChecklist;
    comments: Record<string, string>;
}

export type BulletinDuration = 0 | 15 | 30 | 60 | 120 | 240;

export interface IntelBulletin {
    id: string;
    title: string;
    body: string;
    threatLevel: IntelThreatLevel;
    location: string | null;
    durationMinutes: BulletinDuration;
    expiresAt: string;
    classificationLevel: number;
    limitingMarkers: LimitingMarker[];
    createdById: number;
    createdByUser?: User;
    createdAt: string;
    sharedWithAllies?: boolean;
    sourceOrganizationId?: string | null;
    sourceBulletinId?: string | null;
    sourceOrganizationName?: string | null;
}

export interface DossierData {
    targetId: string;
    reports: HydratedIntelligenceReport[];
    warrants: HydratedWarrant[];
    requests: any[];
    operations: any[];
    affiliates?: { targetId: string; threatLevel: IntelThreatLevel; lastReportedAt: string }[];
    cachedSummary?: string;
    cachedSummaryDate?: string;
}

export interface WindowConfig {
    id: string;
    title: string;
    component: ReactNode;
    width: number;
    height: number;
    x: number;
    y: number;
    zIndex: number;
}

export interface MinimizedWindow {
    id: string;
    title: string;
    icon: string;
    color: string;
    type: string; // 'intel-report' | 'intel-create' | 'bulletin' | etc.
    restoreData?: any;
}

export interface EAMData {
    message: string;
    timestamp: string;
}

export interface OrgMeta {
    memberCount: number;
    // Optional-module toggles (government / finances / quartermaster / warehouse /
    // leaderboard / external tools) configured by the org admin.
    features?: Record<string, any>;
}

// ============================================================================
// FINANCES (ORG TREASURY / BANK LEDGER)
// ============================================================================

export interface FinancesFeatureConfig {
    enabled?: boolean;
}

export type TreasuryAccountType = 'general' | 'reserve' | 'project' | 'ops';

export interface TreasuryAccount {
    id: number;
    name: string;
    type: TreasuryAccountType;
    description: string | null;
    balanceCached: number;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

export type LedgerEntryType = 'deposit' | 'withdrawal' | 'transfer' | 'payout' | 'adjustment';
export type LedgerEntryStatus = 'pending' | 'confirmed' | 'rejected' | 'reversed';

/** Minimal counterparty projection joined in ledger queries. */
export interface LedgerCounterparty {
    id: number;
    name: string;
    avatarUrl: string;
    rsiHandle: string;
}

export interface LedgerEntry {
    id: string;
    accountId: number;
    entryType: LedgerEntryType;
    amount: number;          // signed aUEC integer
    status: LedgerEntryStatus;
    memo: string | null;
    counterpartyUserId: number | null;
    counterparty?: LedgerCounterparty;
    counterpartyText: string | null;
    operationId: number | null;
    relatedInventoryId: number | null;
    relatedEntryId: string | null;
    transferGroupId: string | null;
    createdByUserId: number;
    createdBy?: LedgerCounterparty;
    approvedByUserId: number | null;
    approvedBy?: LedgerCounterparty;
    approvedAt: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface FinancesOverview {
    accounts: TreasuryAccount[];
    totalBalance: number;
    pendingDepositsCount: number;
    pendingDepositsAmount: number;
    pendingWithdrawalsCount: number;
    pendingWithdrawalsAmount: number;
    thirtyDayNet: number;
    recentEntries: LedgerEntry[];
}

// ============================================================================
// QUARTERMASTER (ORG INVENTORY / ARMOURY)
// ============================================================================

export interface QuartermasterFeatureConfig {
    enabled?: boolean;
}

export type QmCatalogCategory = 'weapon' | 'armor' | 'component' | 'consumable' | 'misc';
export type QmCatalogSource = 'platform' | 'custom';

export interface QmCatalogItem {
    id: number;
    slug: string;
    name: string;
    category: QmCatalogCategory;
    subcategory: string | null;
    attributes: Record<string, any>;
    source: QmCatalogSource;
    thumbnailUrl: string | null;
    wikiUrl: string | null;
    createdAt: string;
    updatedAt: string;
}

export type QmLocationType = 'hangar' | 'ship' | 'station' | 'custom';

export interface QmLocation {
    id: number;
    name: string;
    type: QmLocationType;
    parentId: number | null;
    description: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
}

export type QmCondition = 'pristine' | 'used' | 'damaged' | 'broken';

export interface QmInventoryItem {
    id: number;
    catalogId: number | null;
    catalog?: Pick<QmCatalogItem, 'id' | 'slug' | 'name' | 'category' | 'subcategory' | 'thumbnailUrl'>;
    customName: string | null;
    locationId: number | null;
    location?: Pick<QmLocation, 'id' | 'name' | 'type'>;
    condition: QmCondition;
    acquiredAt: string;
    notes: string | null;
    isArchived: boolean;
    // Computed from movements — server-side aggregate
    quantityOnHand: number;
    quantityOnIssue: number;
    createdAt: string;
    updatedAt: string;
}

export type QmMovementReason = 'initial' | 'issue' | 'return' | 'adjust' | 'loss' | 'destruction';

export interface QmInventoryMovement {
    id: string;
    inventoryId: number;
    delta: number;
    reason: QmMovementReason;
    actorUserId: number;
    relatedIssuanceId: number | null;
    notes: string | null;
    createdAt: string;
}

export type QmIssuanceStatus = 'requested' | 'active' | 'returned' | 'written_off';
export type QmOutcome = 'returned_on_time' | 'returned_late' | 'returned_damaged' | 'lost' | 'destroyed_in_action';

/** Minimal user projection for issuance queries. */
export interface QmUserRef {
    id: number;
    name: string;
    avatarUrl: string;
    rsiHandle: string;
}

/** Per-member rollup of open (requested + active) issuances, server-computed. */
export interface QmMemberRecord {
    user: QmUserRef;
    active: QmIssuance[];
    requested: QmIssuance[];
    overdueCount: number;
    totalQuantity: number;
}

export interface QmIssuance {
    id: number;
    inventoryId: number;
    inventory?: Pick<QmInventoryItem, 'id' | 'customName'> & { catalog?: Pick<QmCatalogItem, 'name' | 'category'> };
    issuedToUserId: number;
    issuedTo?: QmUserRef;
    quantity: number;
    status: QmIssuanceStatus;
    requestedAt: string | null;
    issuedAt: string | null;
    dueBackAt: string | null;
    returnedAt: string | null;
    returnedQuantity: number | null;
    outcome: QmOutcome | null;
    requestedByUserId: number | null;
    requestedBy?: QmUserRef;
    issuedByUserId: number | null;
    issuedBy?: QmUserRef;
    closedByUserId: number | null;
    closedBy?: QmUserRef;
    notes: string | null;
    operationId: number | null;
    isOverdue: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface QmOverview {
    totalItems: number;
    distinctSkus: number;
    itemsOnIssue: number;
    overdueCount: number;
    pendingRequests: number;
    recentIssuances: QmIssuance[];
}

/** Low-stock summary row served by qm:list_low_stock for the overview card. */
export interface QmLowStockRow {
    inventoryId: number;
    name: string;
    quantityOnHand: number;
    quantityOnIssue: number;
    locationName: string | null;
    catalogId: number | null;
    thumbnailUrl: string | null;
}

// --- Warehouse (Bulk Commodity) Types ---

export type WarehouseCatalogCategory = 'ore' | 'refined' | 'fuel' | 'rmc' | 'munition' | 'consumable' | 'misc';

export interface WarehouseCatalogItem {
    id: number;
    name: string;
    category: WarehouseCatalogCategory;
    qualityLabel: string | null;
    unit: string;
    description: string | null;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface WarehouseLocationRef {
    id: number;
    name: string;
    type: string;
}

export interface WarehouseStock {
    id: number;
    catalogId: number;
    catalog?: WarehouseCatalogItem;
    locationId: number;
    location?: WarehouseLocationRef;
    notes: string | null;
    quantityOnHand: number;
    quantityReserved: number;
    createdAt: string;
    updatedAt: string;
}

export type WarehouseMovementReason =
    | 'initial' | 'adjust' | 'restock'
    | 'withdraw_sale' | 'withdraw_craft' | 'withdraw_transport' | 'withdraw_other'
    | 'transfer_in' | 'transfer_out'
    | 'loss' | 'destruction';

export interface WarehouseUserRef {
    id: number;
    name: string;
    avatarUrl: string | null;
}

/**
 * Embedded stock summary attached to movements / withdrawal requests so
 * consumers don't need the full warehouseStock context array to look up
 * commodity name, quality, unit, location.
 */
export interface WarehouseStockEmbed {
    id: number;
    catalogId: number;
    catalog?: Pick<WarehouseCatalogItem, 'id' | 'name' | 'category' | 'qualityLabel' | 'unit'>;
    location?: WarehouseLocationRef;
    /** Present on withdrawal-request joins (via v_warehouse_stock_with_qty); omitted on movement joins. */
    quantityOnHand?: number;
}

export interface WarehouseMovement {
    id: string;
    stockId: number;
    delta: number;
    reason: WarehouseMovementReason;
    actorUserId: number;
    actor?: WarehouseUserRef;
    stock?: WarehouseStockEmbed;
    relatedRequestId: string | null;
    relatedMovementId: string | null;
    notes: string | null;
    createdAt: string;
}

export type WarehouseRequestStatus = 'pending' | 'approved' | 'denied' | 'fulfilled' | 'cancelled';
export type WarehouseReasonCategory = 'sale' | 'craft' | 'transport' | 'other';

export interface WarehouseRequest {
    id: string;
    stockId: number;
    stock?: WarehouseStockEmbed;
    requestedByUserId: number;
    requestedBy?: WarehouseUserRef;
    requestedQuantity: number;
    reasonCategory: WarehouseReasonCategory;
    reasonNotes: string | null;
    status: WarehouseRequestStatus;
    approvedByUserId: number | null;
    approvedAt: string | null;
    fulfilledMovementId: string | null;
    fulfilledAt: string | null;
    denialReason: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface WarehouseOverview {
    totalStocks: number;
    totalOnHand: number;
    totalReserved: number;
    lowStockCount: number;
    openRequestCount: number;
}

// =============================================================================
// MARKETPLACE (single-org internal trading)
// =============================================================================
export type MarketplaceListingKind = 'item' | 'service';
export type MarketplaceListingType = 'sell' | 'buy' | 'offer' | 'request';
export type MarketplacePriceType = 'fixed' | 'negotiable' | 'per_unit' | 'hourly';
export type MarketplaceListingStatus = 'draft' | 'active' | 'paused' | 'closed' | 'expired';
export type MarketplaceContractStatus = 'proposed' | 'accepted' | 'in_progress' | 'delivered' | 'completed' | 'cancelled';

export interface MarketplaceCategory {
    id: number;
    slug: string;
    name: string;
    parentId: number | null;
    listingKind: 'item' | 'service' | 'both';
    icon: string | null;
    sortOrder: number;
    active: boolean;
}

// Public, minimal member projection for trader display — NO PII (no discord id,
// email, clearance, notes, permissions). The server's listing/contract embeds
// only ever populate these fields.
export interface MarketplaceTrader {
    id: number;
    name: string;
    rsiHandle: string | null;
    avatarUrl: string | null;
}

export interface MarketplaceListing {
    id: string;
    sellerId: number;
    seller?: MarketplaceTrader;
    kind: MarketplaceListingKind;
    listingType: MarketplaceListingType;
    categoryId: number | null;
    categoryName?: string | null;
    categoryIcon?: string | null;
    title: string;
    description: string | null;
    quantity: number | null;
    quantityClaimed: number;
    priceUec: number | null;
    priceType: MarketplacePriceType;
    location: string | null;
    tags: string[];
    status: MarketplaceListingStatus;
    expiresAt: string | null;
    warehouseStockId: number | null;
    createdAt: string;
    updatedAt: string;
}

export interface MarketplaceMilestone {
    id: number;
    contractId: string;
    title: string;
    description: string | null;
    sortOrder: number;
    completedAt: string | null;
    completedById: number | null;
}

export interface MarketplaceContract {
    id: string;
    listingId: string | null;
    sellerId: number;
    seller?: MarketplaceTrader;
    buyerId: number;
    buyer?: MarketplaceTrader;
    kind: MarketplaceListingKind;
    title: string;
    quantity: number | null;
    agreedPriceUec: number | null;
    termsNote: string | null;
    status: MarketplaceContractStatus;
    proposedById: number | null;
    cancelReason: string | null;
    warehouseStockId: number | null;
    proposedAt: string;
    acceptedAt: string | null;
    deliveredAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    createdAt: string;
    updatedAt: string;
    milestones?: MarketplaceMilestone[];
}

export interface MarketplaceRating {
    id: number;
    contractId: string;
    raterId: number;
    rater?: MarketplaceTrader;
    rateeId: number;
    raterRole: 'buyer' | 'seller';
    stars: number;
    feedback: string | null;
    createdAt: string;
}

export interface MarketplaceReputation {
    userId: number;
    averageStars: number;
    ratingCount: number;
    tier: 'New' | 'Reputable' | 'Trusted' | 'Elite';
}

export interface MarketplaceTraderProfile {
    trader: MarketplaceTrader;
    reputation: MarketplaceReputation;
    activeListings: MarketplaceListing[];
    // No recentRatings — per-rating feedback + rater identities are
    // party-confidential (see getContractRatings). Aggregate reputation only.
}

export type MarketplaceReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed';

// Admin moderation view of a report. Surfaces only what the moderation queue
// renders — reporter name/avatar + a target summary (title/status/owner) — never
// the full listing/contract body or any reporter PII beyond display name.
export interface MarketplaceReport {
    id: number;
    listingId: string | null;
    contractId: string | null;
    reporterId: number;
    reporterName: string | null;
    reporterAvatarUrl: string | null;
    reasonCategory: string;
    details: string | null;
    status: MarketplaceReportStatus;
    reviewedAt: string | null;
    reviewedById: number | null;
    reviewerName: string | null;
    createdAt: string;
    targetType: 'listing' | 'contract';
    targetId: string | null;
    targetTitle: string | null;
    targetStatus: string | null;
    targetSellerId: number | null;
}

// --- UEX Platform Catalog Types ---
// Editable lookup of UEX item categories. Synced from /2.0/categories at sync
// time; admin can rename via display_name without redeploys.
export interface QmPlatformCategory {
    id: number;
    uexCategoryId: number;
    uexCategoryName: string;
    uexSection: string | null;
    displayName: string;
    sortOrder: number;
    isHidden: boolean;
    createdAt: string;
    updatedAt: string;
}

// QmCatalogItem extended with UEX-sourced fields. Only platform rows
// (source='platform') populate these; custom rows leave them null.
export interface QmPlatformItem {
    id: number;
    slug: string;
    name: string;
    category: QmCatalogCategory;
    subcategory: string | null;
    attributes: Record<string, any>;
    source: 'platform';
    thumbnailUrl: string | null;
    wikiUrl: string | null;
    externalUuid: string | null;
    externalId: number | null;
    isVehicleItem: boolean;
    isCommodity: boolean;
    isHarvestable: boolean;
    screenshotUrl: string | null;
    storeUrl: string | null;
    companyName: string | null;
    vehicleName: string | null;
    quality: number | null;
    sizeLabel: string | null;
    color: string | null;
    color2: string | null;
    gameVersion: string | null;
    platformCategoryId: number | null;
    lastSyncedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface QmPlatformItemWithUsage extends QmPlatformItem {
    usageCount: number;
}

export interface WarehousePlatformCategory {
    id: number;
    slug: string;
    uexKind: string;
    displayName: string;
    sortOrder: number;
    isHidden: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface WarehousePlatformCommodity {
    id: number;
    externalId: number;
    externalUuid: string | null;
    slug: string;
    name: string;
    code: string | null;
    kind: string | null;
    weightScu: number | null;  // numeric — UEX returns fractional SCU (e.g. 1.2)
    priceBuy: number | null;
    priceSell: number | null;
    isAvailable: boolean | null;
    isAvailableLive: boolean | null;
    isVisible: boolean | null;
    isExtractable: boolean | null;
    isMineral: boolean | null;
    isRaw: boolean | null;
    isPure: boolean | null;
    isRefined: boolean | null;
    isRefinable: boolean | null;
    isHarvestable: boolean | null;
    isBuyable: boolean | null;
    isSellable: boolean | null;
    isTemporary: boolean | null;
    isIllegal: boolean | null;
    isVolatileQt: boolean | null;
    isVolatileTime: boolean | null;
    isInert: boolean | null;
    isExplosive: boolean | null;
    isBuggy: boolean | null;
    isFuel: boolean | null;
    wikiUrl: string | null;
    platformCategoryId: number | null;
    uexDateAdded: number | null;
    uexDateModified: number | null;
    lastSyncedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface WarehousePlatformCommodityWithUsage extends WarehousePlatformCommodity {
    usageCount: number;
}

// --- UEX Platform Location Catalog ---
export type PlatformLocationKind =
    | 'star_system' | 'orbit' | 'planet' | 'moon'
    | 'space_station' | 'city' | 'outpost' | 'poi';

export interface PlatformLocationAmenities {
    quantum_marker?: boolean;
    trade_terminal?: boolean;
    habitation?: boolean;
    refinery?: boolean;
    cargo_center?: boolean;
    clinic?: boolean;
    food?: boolean;
    shops?: boolean;
    refuel?: boolean;
    repair?: boolean;
    gravity?: boolean;
    loading_dock?: boolean;
    docking_port?: boolean;
    freight_elevator?: boolean;
}

export interface PlatformLocation {
    id: number;
    kind: PlatformLocationKind;
    externalId: number;
    parentId: number | null;
    starSystemId: number | null;
    name: string;
    nickname: string | null;
    code: string | null;
    path: string | null;
    isAvailableLive: boolean | null;
    isVisible: boolean | null;
    isLandable: boolean | null;
    isArmistice: boolean | null;
    isDecommissioned: boolean | null;
    isInternal: boolean;
    isHidden: boolean;
    padTypes: string | null;
    amenities: PlatformLocationAmenities;
    factionName: string | null;
    jurisdictionName: string | null;
    wikiUrl: string | null;
    uexDateAdded: number | null;
    uexDateModified: number | null;
    lastSyncedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

// Unified shape returned by warehouse:search_catalog — covers both tenant
// warehouse_catalog rows and platform warehouse_platform_commodities rows.
// `id` is the row id within its own table; `source` disambiguates which
// table to insert against when the user picks one.
export interface WarehouseCatalogSearchResult {
    id: number;
    source: 'custom' | 'platform';
    name: string;
    category: string | null;          // 'ore' | 'refined' | ... for custom; UEX kind for platform
    qualityLabel: string | null;       // custom only
    unit: string | null;               // custom only
    archived: boolean;                 // custom only
}

// --- Fleet Manager Types ---
export interface PlatformShip {
    id: number; externalUuid?: string; externalApiId?: number; name: string; manufacturer: string; manufacturerCode?: string;
    role?: string; career?: string; size?: string; crewMin: number; crewMax: number;
    cargoCapacity: number; length?: number; beam?: number; height?: number; mass?: number;
    scmSpeed?: number; maxSpeed?: number; health?: number; shieldHp?: number;
    imageUrl?: string; wikiUrl?: string; pledgeUrl?: string; msrp?: number;
    description?: string; productionStatus?: string;
}

export interface UserShip {
    id: number; userId: number; user?: User; shipId: number; ship?: PlatformShip;
    customName?: string; loadoutNotes?: string; status: ShipStatus; isPrimary: boolean; createdAt: string;
    // Set only when this UserShip was loaded as part of a FleetGroup.assignedShips
    // list — it's the fleet_group_ships junction row id, used for reorder RPCs.
    assignmentId?: number;
}

export interface FleetGroup {
    id: number; name: string; type: FleetGroupType | string; parentId?: number;
    commanderId?: number; commander?: User; description?: string; icon?: string;
    sortOrder: number; children: FleetGroup[]; assignedShips: UserShip[];
}

// --- Alliance System Types ---
// (removed: OrgDirectoryProfile — the dropped multi-org public directory /
// diplomacy type; the alliance layer is rebuilt around alliance_peers.)

export interface DataContextType {
    allUsers: User[];
    users: User[]; // Legacy alias for allUsers
    members: User[];
    ranks: Rank[];
    units: OrganizationalUnit[];
    roles: Role[];
    announcements: Announcement[];
    hydratedServiceRequests: HydratedServiceRequest[];
    intelTargetIndex: Map<string, IntelThreatLevel>;
    intelHubStats: IntelHubStats;
    intelDataVersion: number;
    activeBulletins: IntelBulletin[];
    operations: HydratedOperation[];
    operationTemplates: OperationTemplate[];
    warrants: HydratedWarrant[];
    externalTools: ExternalTool[];
    radioChannels: RadioChannel[];
    locations: Location[];
    orgMeta: OrgMeta | null;
    platformSettings: any;

    // Fleet Manager
    shipCatalog: PlatformShip[];
    userShips: UserShip[];
    fleetGroups: FleetGroup[];

    // Government System
    governmentConfig: GovernmentConfig | null;
    governmentBranches: GovernmentBranch[];
    governmentPositions: GovernmentPosition[];
    governmentPositionHolders: GovernmentPositionHolder[];
    governmentElections: GovernmentElection[];
    governmentLegislation: GovernmentLegislation[];
    governmentMotions: GovernmentMotion[];
    governmentsFeatureConfig: GovernmentsFeatureConfig;
    refreshGovernment: () => Promise<void>;

    securityClearances: SecurityClearance[];
    limitingMarkers: LimitingMarker[];
    specializationTags: SpecializationTag[];
    certifications: Certification[];
    commendations: Commendation[];

    brandingConfig: BrandingConfig;
    discordConfig: DiscordConfig;
    heroCardConfig: HeroCardConfig;
    openGraphConfig: OpenGraphConfig;
    radioConfig: RadioConfig;
    aiConfig: AIConfig;
    wikiHomeConfig: WikiHomeConfig;
    hrConfig: HRConfig;
    publicPageConfig: PublicPageConfig;
    serviceTypes: ServiceTypeConfig[];

    hrApplicants: HydratedHRApplication[];
    hrInterviews: HydratedHRInterview[];
    hrJobs: JobPosting[];
    hrTemplates: HRInterviewTemplate[];
    hrTransfers: TransferRequest[];
    wikiPages: WikiPage[];
    warehouseCatalog: WarehouseCatalogItem[];
    warehouseStock: WarehouseStock[];
    warehouseRequests: WarehouseRequest[];
    hrPositions: PersonnelPosition[];
    setHrJobs: React.Dispatch<React.SetStateAction<JobPosting[]>>;

    syncedDiscordRoles: DiscordRole[];
    rankMappings: Record<string, string>;
    roleMappings: Record<string, string>;

    rpcAction: (action: string, payload: any) => Promise<any>;
    notifyDbConnected: () => Promise<void>;
    setStateFromData: (data: any) => void;
    /** Generation-guarded getInitialState fetch+apply — the only sanctioned
     *  full-state hydrate outside boot (a raw setStateFromData(getInitialState())
     *  would bypass the slice-patch guards). Returns the raw payload. */
    hydrateFullState: () => Promise<any>;
    refreshRequests: () => Promise<void>;
    refreshHR: () => Promise<void>;
    refreshMainState: () => Promise<void>;
    refreshWarrants: () => Promise<void>;
    refreshOperations: () => Promise<void>;
    refreshIntel: () => Promise<void>;
    refreshAnnouncements: () => Promise<void>;
    refreshWiki: () => Promise<void>;
    refreshWarehouse: () => Promise<void>;
    refreshFleet: () => Promise<void>;
    ensureFleetLoaded: () => Promise<void>;

    createOperationTemplate: (data: { name: string; description?: string; payload: OperationTemplatePayload }) => Promise<OperationTemplate>;
    updateOperationTemplate: (id: number, updates: { name?: string; description?: string; payload?: OperationTemplatePayload }) => Promise<OperationTemplate>;
    deleteOperationTemplate: (id: number) => Promise<void>;
    extractTemplateFromOperation: (operationId: string) => Promise<OperationTemplatePayload>;
    importOperationTemplate: (data: { name: string; description?: string; payload: OperationTemplatePayload }) => Promise<OperationTemplate>;

    createBulletin: (data: any) => Promise<void>;
    deleteBulletin: (id: string) => Promise<void>;

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

    addLocation: (data: any) => Promise<void>;
    updateLocation: (data: any) => Promise<void>;
    deleteLocation: (id: number) => Promise<void>;
    seedDefaultLocations: () => Promise<any>;

    addServiceType: (data: any) => Promise<void>;
    updateServiceType: (data: any) => Promise<void>;
    deleteServiceType: (id: number) => Promise<void>;

    addExternalTool: (data: any) => Promise<void>;
    updateExternalTool: (data: any) => Promise<void>;
    deleteExternalTool: (id: number) => Promise<void>;
    reorderExternalTool: (id: number, sortOrder: number) => Promise<void>;

    addSpecializationTag: (data: any) => Promise<void>;
    updateSpecializationTag: (data: any) => Promise<void>;
    deleteSpecializationTag: (id: number) => Promise<void>;

    addCertification: (data: any) => Promise<void>;
    updateCertification: (data: any) => Promise<void>;
    deleteCertification: (id: number) => Promise<void>;

    addCommendation: (data: any) => Promise<void>;
    updateCommendation: (data: any) => Promise<void>;
    deleteCommendation: (id: number) => Promise<void>;

    deleteRadioChannel: (id: string) => Promise<void>;

    updateDiscordConfig: (config: any) => Promise<void>;
    updateHeroCardConfig: (config: any) => Promise<void>;
    updateBrandingConfig: (config: any) => Promise<void>;
    updateOpenGraphConfig: (config: any) => Promise<void>;
    updateRadioConfig: (config: any) => Promise<void>;
    updateAIConfig: (config: any) => Promise<void>;
    updateWikiHomeConfig: (config: WikiHomeConfig) => Promise<void>;
    reorderWikiPages: (pages: { id: string; sortOrder: number }[]) => Promise<void>;
    updateSystemConfig: (url: string) => Promise<void>;
    updatePublicPageConfig: (config: PublicPageConfig) => Promise<void>;
    listTestimonialCandidates: (params: { search?: string; limit?: number; offset?: number }) => Promise<{ items: TestimonialCandidate[]; total: number }>;
    updateOrgFeatures: (patch: Record<string, any>) => Promise<void>;

    syncDiscordRoles: () => Promise<void>;
    updateRankMapping: (discordRoleId: string, rankId: string, roleId?: string) => Promise<void>;

    broadcastEAM: (msg: string) => Promise<void>;

    fetchUserDetail: (userId: number) => Promise<User | null>;
    getReputationHistory: (userId: number) => Promise<any>;
    getRatingHistory: (userId: number) => Promise<any>;
    getClearanceHistory: (userId: number) => Promise<any>;
    getPositionHistory: (targetUserId: number) => Promise<PositionHistoryEntry[]>;

    isFetching: Record<string, boolean>;
    optimisticUpdate: (table: string, id: string | number, data: any, action: 'create' | 'update' | 'delete') => void;
}

// --- Referral Source Display Names ---
const REFERRAL_SOURCE_LABELS: Record<string, string> = {
    'WEBSITE_APPLICATION': 'Application to Join',
    'INTERNAL_CASE': 'Internal Case',
    'INTERNAL_TRANSFER': 'Unit Transfer',
    'INTERNAL_JOB': 'Job Application',
    'SECURITY_VETTING': 'Security Clearance Request',
    'Ad-hoc Interview': 'Ad-hoc Interview',
};

export function formatReferralSource(source: string | undefined | null): string {
    if (!source) return 'General Application';
    if (REFERRAL_SOURCE_LABELS[source]) return REFERRAL_SOURCE_LABELS[source];
    if (source.startsWith('Internal Application:')) return source.replace('Internal Application:', 'Job:').trim();
    return source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// =============================================================================
// NOTIFICATION CENTER (persistent per-user inbox)
// =============================================================================
// A durable, per-recipient record of meaningful org events (request lifecycle,
// QM issuance, HR assignment, academy enrolment/completion, …) — distinct from
// the ephemeral toast/"attention required" feed. The row stores only a
// NON-SENSITIVE summary + an in-app deep-link; clicking re-fetches the
// permission-gated view. organizationId/userId are never surfaced to the client.
export interface PersistentNotification {
    id: number;
    /** Category for icon/grouping, e.g. 'request' | 'qm_issuance' | 'hr_assignment' | 'academy_enrolled'. Free text. */
    type: string;
    title: string;
    body: string;
    /** In-app view target (e.g. 'requests', 'academy') for coarse section nav. */
    link: string | null;
    /** Minimal non-sensitive entity ids for rendering/grouping — never gated content. */
    metadata: Record<string, unknown>;
    /** ISO timestamp when read, or null while unread. */
    readAt: string | null;
    createdAt: string;
}

// =============================================================================
// ACADEMY (LMS) — courses → modules → lessons → outcomes, sessions, enrolments
// =============================================================================
// Optional feature (default OFF). Single-org: no organizationId on any academy
// type (the tenant dimension the hosted build carried is gone). See lib/db/academy.ts.
export type AcademyCourseStatus = 'draft' | 'pending_approval' | 'published' | 'archived';
export type AcademyCourseAccess = 'open' | 'gated';
/** How a course is run: scheduled cohort sessions, or evergreen self-paced (enrol anytime). */
export type AcademyCourseDelivery = 'cohort' | 'self_paced';
export type AcademySessionStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export type AcademyEnrollmentStatus = 'enrolled' | 'in_progress' | 'completed' | 'withdrawn';
export type AcademyEnrollmentSource = 'self' | 'assigned';
export type AcademyOutcomeVerdict = 'competent' | 'not_yet_competent';

/** Minimal user projection joined into academy rows (instructor / student / assessor). */
export interface AcademyUserRef {
    id: number;
    name: string;
    avatarUrl: string;
    rsiHandle: string;
}

/** Certification a course awards on certified completion (minimal projection). */
export interface AcademyCertRef {
    id: number;
    name: string;
    icon: string | null;
    imageUrl: string | null;
}

export interface AcademyLesson {
    id: number;
    moduleId: number;
    title: string;
    content: string | null;
    videoUrl: string | null;
    sortOrder: number;
    estimatedMinutes: number | null;
}

export interface AcademyModule {
    id: number;
    courseId: string;
    title: string;
    description: string | null;
    sortOrder: number;
    lessons: AcademyLesson[];
}

export interface AcademyOutcome {
    id: number;
    courseId: string;
    title: string;
    description: string | null;
    sortOrder: number;
    required: boolean;
}

export interface AcademyCourse {
    id: string;
    title: string;
    description: string | null;
    icon: string | null;
    imageUrl: string | null;
    status: AcademyCourseStatus;
    access: AcademyCourseAccess;
    /** Cohort (scheduled sessions) or self-paced (evergreen, one implicit session). */
    delivery: AcademyCourseDelivery;
    certificationId: number | null;
    certification: AcademyCertRef | null;
    createdBy: number;
    approvedBy: number | null;
    publishedAt: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
    /** Assigned curriculum authors (hydrated on detail reads). */
    instructors: AcademyUserRef[];
    /** Nested curriculum (hydrated on detail reads). */
    modules: AcademyModule[];
    outcomes: AcademyOutcome[];
    /** Count of scheduled/active sessions (hydrated on list reads). */
    sessionCount?: number;
}

export interface AcademySession {
    id: string;
    courseId: string;
    /** Course title projection for list rendering. */
    courseTitle: string | null;
    title: string;
    status: AcademySessionStatus;
    startsAt: string | null;
    endsAt: string | null;
    location: string | null;
    capacity: number | null;
    enrollmentOpen: boolean;
    /** True for the hidden auto-managed session that backs a self-paced course. */
    isImplicit: boolean;
    createdBy: number;
    createdAt: string;
    updatedAt: string;
    /** Assigned session instructors (hydrated on detail reads). */
    instructors: AcademyUserRef[];
    /** Current enrolment count (hydrated for capacity display). */
    enrollmentCount: number;
}

export interface AcademyLessonProgress {
    id: number;
    enrollmentId: string;
    lessonId: number;
    completedBy: number;
    completedAt: string;
}

export interface AcademyOutcomeResult {
    id: number;
    enrollmentId: string;
    outcomeId: number;
    verdict: AcademyOutcomeVerdict;
    assessedBy: number;
    assessedAt: string;
}

export interface AcademyEnrollment {
    id: string;
    sessionId: string;
    studentId: number;
    student: AcademyUserRef | null;
    source: AcademyEnrollmentSource;
    status: AcademyEnrollmentStatus;
    assignedBy: number | null;
    recommendedBy: number | null;
    recommendedAt: string | null;
    certifiedBy: number | null;
    completedAt: string | null;
    enrolledAt: string;
    /** Curriculum + competency detail (hydrated on the student/instructor detail view). */
    lessonProgress: AcademyLessonProgress[];
    outcomeResults: AcademyOutcomeResult[];
    /** Session/course context projection for "My Sessions" rows. */
    sessionTitle?: string | null;
    courseTitle?: string | null;
    /** Curriculum progress projection (hydrated in the my-academy bundle only). */
    lessonsTotal?: number;
    lessonsCompleted?: number;
}