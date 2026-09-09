
import { supabase, handleSupabaseError, safeFetch } from '../common.js';
import { sanitizeTiptapJson } from '../../tiptapValidate.js';
import { normalizeDocMediaForStorage, assertDocImageCap, signDocMediaForClient } from '../../orgMediaDocs.js';
import {
    GovernmentConfig,
    GovernmentBranch,
    GovernmentPosition,
    GovernmentPositionHolder,
} from '../../../types.js';
import {
    log,
    USER_HYDRATE,
    broadcastGovernmentUpdate,
    toGovernmentConfig,
    toGovernmentBranch,
    toGovernmentPosition,
    toGovernmentPositionHolder,
} from './internal.js';
import { getElectionsState } from './elections.js';
import { getLegislationState, getMotionsState } from './legislation.js';

// ---------------------------------------------------------------------------
// State aggregation (query subset)
// ---------------------------------------------------------------------------

/**
 * The structure key-group of the government bundle: config + branches +
 * positions + holders (+ the feature toggle). These four stay co-fetched
 * because of the cross-row hydration below (holders bucket into positions,
 * positions into branches). Backs both getGovernmentState and the realtime
 * `government_structure` slice subset.
 */
export async function getGovernmentStructureState() {
    const [configResult, branchesResult, positionsResult, holdersResult, featureToggleResult] = await Promise.all([
        safeFetch(
            supabase.from('government_configs').select('id, government_type, name, description, constitution_content, created_at, updated_at').maybeSingle(),
            null, 'government_configs'
        ),
        safeFetch(
            supabase.from('government_branches').select('id, name, branch_type, description, sort_order, icon, created_at').order('sort_order'),
            [], 'government_branches'
        ),
        safeFetch(
            supabase.from('government_positions').select('id, branch_id, name, description, fill_method, term_length_days, max_holders, icon, sort_order, permissions_granted, can_propose_legislation, can_vote_legislation, can_veto_legislation, can_call_elections, can_issue_orders, created_at').order('sort_order'),
            [], 'government_positions'
        ),
        safeFetch(
            supabase.from('government_position_holders').select(`
                id, position_id, user_id, appointed_by_id, election_id, started_at, ended_at, end_reason, created_at,
                user:users!government_position_holders_user_id_fkey(${USER_HYDRATE}),
                appointed_by:users!government_position_holders_appointed_by_id_fkey(${USER_HYDRATE})
            `).is('ended_at', null),
            [], 'government_position_holders'
        ),
        safeFetch(
            supabase.from('settings').select('value').eq('key', 'governmentsConfig').maybeSingle(),
            null, 'settings:governmentsConfig'
        ),
    ]);

    const branches = Array.isArray(branchesResult) ? branchesResult.map(toGovernmentBranch) : [];
    const positions = Array.isArray(positionsResult) ? positionsResult.map(toGovernmentPosition) : [];
    const holders = Array.isArray(holdersResult) ? holdersResult.map(r => toGovernmentPositionHolder(r as unknown as Parameters<typeof toGovernmentPositionHolder>[0])) : [];

    // Hydrate positions with their current holders
    const holdersByPosition = new Map<number, GovernmentPositionHolder[]>();
    for (const h of holders) {
        const arr = holdersByPosition.get(h.positionId) || [];
        arr.push(h);
        holdersByPosition.set(h.positionId, arr);
    }
    for (const pos of positions) {
        pos.currentHolders = holdersByPosition.get(pos.id) || [];
    }

    // Hydrate branches with their positions
    const positionsByBranch = new Map<number, GovernmentPosition[]>();
    for (const pos of positions) {
        if (pos.branchId) {
            const arr = positionsByBranch.get(pos.branchId) || [];
            arr.push(pos);
            positionsByBranch.set(pos.branchId, arr);
        }
    }
    for (const branch of branches) {
        branch.positions = positionsByBranch.get(branch.id) || [];
    }

    const featureToggle = featureToggleResult as { value?: unknown } | null;
    const governmentConfig = configResult ? toGovernmentConfig(configResult) : null;
    // Constitution images are stored in the private bucket as object keys; swap them for
    // signed URLs so a permitted reader can display them. This runs behind the gov:view gate.
    if (governmentConfig?.constitutionContent) {
        governmentConfig.constitutionContent = await signDocMediaForClient(governmentConfig.constitutionContent);
    }
    return {
        governmentsConfig: featureToggle?.value || { enabled: false },
        governmentConfig,
        governmentBranches: branches,
        governmentPositions: positions,
        governmentPositionHolders: holders,
    };
}

export async function getGovernmentState() {
    // Structure key-group + the three list key-groups in parallel.
    // Elections/legislation/motions are deliberately called WITHOUT a
    // currentUserId (per-viewer ballot flags stay absent on the subset path —
    // parity preserved by the per-slice subsets too).
    const [structure, elections, legislation, motions] = await Promise.all([
        getGovernmentStructureState(),
        getElectionsState().catch(() => []),
        getLegislationState().catch(() => []),
        getMotionsState().catch(() => []),
    ]);

    return {
        ...structure,
        governmentElections: elections,
        governmentLegislation: legislation,
        governmentMotions: motions,
    };
}

// ---------------------------------------------------------------------------
// Government Config CRUD
// ---------------------------------------------------------------------------

export async function upsertGovernmentConfig(config: Partial<GovernmentConfig>): Promise<GovernmentConfig | null> {
    const payload: Record<string, unknown> = {
        government_type: config.governmentType || 'custom',
        name: config.name || 'Government',
        description: config.description || null,
        // Constitution is edited via the WikiEditor (Tiptap JSON); sanitize on
        // save to drop disallowed nodes/marks and reject unsafe link/image URLs.
        constitution_content: config.constitutionContent
            ? normalizeDocMediaForStorage(sanitizeTiptapJson(config.constitutionContent, 'wiki'))
            : null,
        updated_at: new Date().toISOString(),
    };
    if (payload.constitution_content) assertDocImageCap(payload.constitution_content);

    // Single-org: government_configs holds exactly one row. Upsert on the PK —
    // reuse the existing row's id if present, otherwise insert a fresh one.
    const { data: existing } = await supabase.from('government_configs').select('id').limit(1).maybeSingle();
    if (existing?.id) payload.id = existing.id;
    const { data, error } = await supabase.from('government_configs')
        .upsert(payload, { onConflict: 'id' })
        .select('id, government_type, name, description, constitution_content, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to upsert government config' });
    broadcastGovernmentUpdate('structure');
    return data ? toGovernmentConfig(data) : null;
}

export async function updateConstitution(content: unknown) {
    const safeContent = content ? normalizeDocMediaForStorage(sanitizeTiptapJson(content, 'wiki')) : null;
    if (safeContent) assertDocImageCap(safeContent);
    const { error } = await supabase.from('government_configs')
        .update({ constitution_content: safeContent, updated_at: new Date().toISOString() })
        ;
    handleSupabaseError({ error, message: 'Failed to update constitution' });
    broadcastGovernmentUpdate('structure');
}

// ---------------------------------------------------------------------------
// Government Branches CRUD
// ---------------------------------------------------------------------------

export async function createGovernmentBranch(data: Partial<GovernmentBranch>): Promise<GovernmentBranch | null> {
    const payload = {
        name: data.name,
        branch_type: data.branchType || 'Custom',
        description: data.description || null,
        sort_order: data.sortOrder ?? 0,
        icon: data.icon || null,
    };
    const { data: result, error } = await supabase.from('government_branches')
        .insert(payload).select('id, name, branch_type, description, sort_order, icon, created_at').single();
    handleSupabaseError({ error, message: 'Failed to create government branch' });
    broadcastGovernmentUpdate('structure');
    return result ? toGovernmentBranch(result) : null;
}

export async function updateGovernmentBranch(branchId: number, updates: Partial<GovernmentBranch>) {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.branchType !== undefined) dbUpdates.branch_type = updates.branchType;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon;

    if (Object.keys(dbUpdates).length === 0) return;

    const { error } = await supabase.from('government_branches')
        .update(dbUpdates).eq('id', branchId);
    handleSupabaseError({ error, message: 'Failed to update government branch' });
    broadcastGovernmentUpdate('structure');
}

export async function deleteGovernmentBranch(branchId: number) {
    const { error } = await supabase.from('government_branches')
        .delete().eq('id', branchId);
    handleSupabaseError({ error, message: 'Failed to delete government branch' });
    broadcastGovernmentUpdate('structure');
}

/**
 * Apply a new order to government branches within an org. Caller passes the
 * full ordered id list; we set sort_order = (idx + 1) * 10 so future inserts
 * can slot between two existing rows without a renumber. Mirrors
 * reorderFleetGroups (lib/db/fleet.ts).
 */
export async function reorderGovernmentBranches(orderedIds: number[]) {
    if (orderedIds.length === 0) return;
    const updates = orderedIds.map((id, idx) =>
        supabase.from('government_branches')
            .update({ sort_order: (idx + 1) * 10 })
            .eq('id', id)
            
    );
    const results = await Promise.all(updates);
    for (const r of results) {
        handleSupabaseError({ error: r.error, message: 'Failed to reorder government branches' });
    }
    broadcastGovernmentUpdate('structure');
}

// ---------------------------------------------------------------------------
// Government Positions CRUD
// ---------------------------------------------------------------------------

export async function createGovernmentPosition(data: Partial<GovernmentPosition>): Promise<GovernmentPosition | null> {
    const payload = {
        branch_id: data.branchId || null,
        name: data.name,
        description: data.description || null,
        fill_method: data.fillMethod || 'Appointed',
        term_length_days: data.termLengthDays || null,
        max_holders: data.maxHolders ?? 1,
        icon: data.icon || null,
        sort_order: data.sortOrder ?? 0,
        permissions_granted: data.permissionsGranted || [],
        can_propose_legislation: data.canProposeLegislation ?? false,
        can_vote_legislation: data.canVoteLegislation ?? false,
        can_veto_legislation: data.canVetoLegislation ?? false,
        can_call_elections: data.canCallElections ?? false,
        can_issue_orders: data.canIssueOrders ?? false,
    };
    const { data: result, error } = await supabase.from('government_positions')
        .insert(payload).select('id, branch_id, name, description, fill_method, term_length_days, max_holders, icon, sort_order, permissions_granted, can_propose_legislation, can_vote_legislation, can_veto_legislation, can_call_elections, can_issue_orders, created_at').single();
    handleSupabaseError({ error, message: 'Failed to create government position' });
    broadcastGovernmentUpdate('structure');
    return result ? toGovernmentPosition(result) : null;
}

export async function updateGovernmentPosition(positionId: number, updates: Partial<GovernmentPosition>) {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.branchId !== undefined) dbUpdates.branch_id = updates.branchId;
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.fillMethod !== undefined) dbUpdates.fill_method = updates.fillMethod;
    if (updates.termLengthDays !== undefined) dbUpdates.term_length_days = updates.termLengthDays;
    if (updates.maxHolders !== undefined) dbUpdates.max_holders = updates.maxHolders;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
    if (updates.permissionsGranted !== undefined) dbUpdates.permissions_granted = updates.permissionsGranted;
    if (updates.canProposeLegislation !== undefined) dbUpdates.can_propose_legislation = updates.canProposeLegislation;
    if (updates.canVoteLegislation !== undefined) dbUpdates.can_vote_legislation = updates.canVoteLegislation;
    if (updates.canVetoLegislation !== undefined) dbUpdates.can_veto_legislation = updates.canVetoLegislation;
    if (updates.canCallElections !== undefined) dbUpdates.can_call_elections = updates.canCallElections;
    if (updates.canIssueOrders !== undefined) dbUpdates.can_issue_orders = updates.canIssueOrders;

    if (Object.keys(dbUpdates).length === 0) return;

    const { error } = await supabase.from('government_positions')
        .update(dbUpdates).eq('id', positionId);
    handleSupabaseError({ error, message: 'Failed to update government position' });
    broadcastGovernmentUpdate('structure');
}

export async function deleteGovernmentPosition(positionId: number) {
    const { error } = await supabase.from('government_positions')
        .delete().eq('id', positionId);
    handleSupabaseError({ error, message: 'Failed to delete government position' });
    broadcastGovernmentUpdate('structure');
}

/**
 * Apply a new order to positions within a single branch (or to top-level
 * positions when branchId is null). Validates branch membership when scoped.
 * Mirrors reorderGroupShips (lib/db/fleet.ts).
 */
export async function reorderGovernmentPositions(branchId: number | null, orderedIds: number[]) {
    if (orderedIds.length === 0) return;

    if (branchId !== null) {
        // Defense-in-depth: confirm the branch belongs to the caller's org
        // so a crafted payload can't reorder another tenant's positions.
        const { data: branch } = await supabase.from('government_branches')
            .select('id')
            .eq('id', branchId)
            
            .maybeSingle();
        if (!branch) throw new Error('Government branch not found');
    }

    const updates = orderedIds.map((id, idx) => {
        const q = supabase.from('government_positions')
            .update({ sort_order: (idx + 1) * 10 })
            .eq('id', id)
            ;
        return branchId !== null ? q.eq('branch_id', branchId) : q.is('branch_id', null);
    });
    const results = await Promise.all(updates);
    for (const r of results) {
        handleSupabaseError({ error: r.error, message: 'Failed to reorder government positions' });
    }
    broadcastGovernmentUpdate('structure');
}

// ---------------------------------------------------------------------------
// Position Holders
// ---------------------------------------------------------------------------

const HOLDER_COLUMNS = 'id, position_id, user_id, appointed_by_id, election_id, started_at, ended_at, end_reason, created_at';

// The authenticated actor the dispatcher injects, as far as the government
// authority checks care about it.
export interface GovActor { id?: number; isSystemAdmin?: boolean; permissions?: string[] }

// Apex government seats (veto / call-elections) may only be hand-filled or cleared by a
// real org admin. Gate on role IDENTITY (isSystemAdmin, stamped by getUserById from
// users.role_id) — not the admin:access permission and not the name-inferred tier. The
// seeded Dispatcher carries gov:manage and admin:access, so a permission test would let
// through the exact role this ceiling is meant to stop; and `role` is derived from the
// role row's free-text NAME, so any role called "Commander" cleared it. Unstamped ⇒
// false ⇒ the ceiling holds (fail closed).
function isOrgAdmin(actor?: GovActor): boolean {
    return actor?.isSystemAdmin === true;
}

// Authority ceiling for the manual appointment path (gov:appoint_holder). Two rules, so
// a gov:manage holder such as a Dispatcher cannot grab apex authority:
//   1. Seats filled by election, succession or merit are not hand-appointable; they come
//      through their own process. This blocks self-appointing into an elected
//      presidency, monarchy and so on.
//   2. Putting someone into an apex office (one that can veto legislation or call
//      elections) is above routine gov:manage and needs an org admin.
// The election-conclusion path is exempt and never reaches here (see appointPositionHolder).
async function assertAppointable(positionId: number, actor?: GovActor): Promise<void> {
    const { data: pos } = await supabase.from('government_positions')
        .select('fill_method, can_veto_legislation, can_call_elections')
        .eq('id', positionId).maybeSingle();
    if (!pos) throw new Error('Position not found');
    if (pos.fill_method !== 'Appointed') {
        throw new Error(`This position is filled by ${String(pos.fill_method).toLowerCase()}, not by direct appointment.`);
    }
    if ((pos.can_veto_legislation || pos.can_call_elections) && !isOrgAdmin(actor)) {
        throw new Error('Appointing into an office that can veto legislation or call elections requires an administrator.');
    }
}

export async function appointPositionHolder(data: Partial<GovernmentPositionHolder>, actor?: GovActor): Promise<GovernmentPositionHolder | null> {
    // s4-8b: the appointee is a PERMISSION-GRANTING write on a non-forced client
    // userId — validate it is a real, non-deleted member (+ reject non-finite ids)
    // rather than relying solely on the DB FK. Same for the position id.
    if (typeof data.userId !== 'number' || !Number.isInteger(data.userId)) throw new Error('Invalid appointee id.');
    if (typeof data.positionId !== 'number' || !Number.isInteger(data.positionId)) throw new Error('Invalid position id.');

    // Enforce the authority ceiling only on the manual path. The election conclusion
    // seats winners with an electionId set — the electorate already chose them, so that
    // path skips the ceiling.
    if (data.electionId == null) {
        await assertAppointable(data.positionId, actor);
    }

    const { data: appointee } = await supabase.from('users').select('id').eq('id', data.userId).is('deleted_at', null).maybeSingle();
    if (!appointee) throw new Error('Appointee is not a valid member.');

    // race-2: atomic max_holders check + insert under a row lock on the position.
    const { data: holderId, error: rpcError } = await supabase.rpc('gov_appoint_holder', {
        p_position_id: data.positionId,
        p_user_id: data.userId,
        p_appointed_by_id: data.appointedById || null,
        p_election_id: data.electionId || null,
    });
    if (rpcError) {
        const msg = typeof rpcError.message === 'string' ? rpcError.message : '';
        if (msg.includes('position_not_found')) throw new Error('Position not found');
        if (msg.includes('already_holds')) throw new Error('User already holds this position');
        if (msg.includes('position_full')) throw new Error('Position is full');
        const rpcCode = (rpcError as { code?: string }).code;
        // Soft-fallback if the RPC predates the schema redeploy (function missing):
        // the non-atomic count-then-insert (prior behavior).
        if (rpcCode === 'PGRST202' || rpcCode === '42883') {
            return appointPositionHolderFallback(data);
        }
        handleSupabaseError({ error: rpcError, message: 'Failed to appoint position holder' });
    }
    broadcastGovernmentUpdate('structure');
    if (holderId == null) return null;
    const { data: row } = await supabase.from('government_position_holders')
        .select(HOLDER_COLUMNS).eq('id', holderId).single();
    return row ? toGovernmentPositionHolder(row) : null;
}

// Non-atomic appointment path used only when gov_appoint_holder isn't deployed yet.
async function appointPositionHolderFallback(data: Partial<GovernmentPositionHolder>): Promise<GovernmentPositionHolder | null> {
    const { data: position } = await supabase.from('government_positions')
        .select('max_holders').eq('id', data.positionId).single();
    if (!position) throw new Error('Position not found');

    const { count } = await supabase.from('government_position_holders')
        .select('id', { count: 'exact', head: true })
        .eq('position_id', data.positionId)
        .is('ended_at', null);
    if (count !== null && count >= position.max_holders) {
        throw new Error(`Position is full (${position.max_holders} holder${position.max_holders > 1 ? 's' : ''} max)`);
    }

    const { count: existingCount } = await supabase.from('government_position_holders')
        .select('id', { count: 'exact', head: true })
        .eq('position_id', data.positionId)
        .eq('user_id', data.userId)
        .is('ended_at', null);
    if (existingCount && existingCount > 0) {
        throw new Error('User already holds this position');
    }

    const payload = {
        position_id: data.positionId,
        user_id: data.userId,
        appointed_by_id: data.appointedById || null,
        election_id: data.electionId || null,
    };
    const { data: result, error } = await supabase.from('government_position_holders')
        .insert(payload).select(HOLDER_COLUMNS).single();
    handleSupabaseError({ error, message: 'Failed to appoint position holder' });
    broadcastGovernmentUpdate('structure');
    return result ? toGovernmentPositionHolder(result) : null;
}

export async function removePositionHolder(holderId: number, reason: string, actor?: GovActor) {
    // Evicting the holder of an apex office (veto or call-elections) is admin-only, so a
    // gov:manage holder can't clear opposition out of powerful seats.
    // FAILS CLOSED, in three places that all used to fail open.
    //
    // The error was discarded, so any read fault (a statement timeout, a schema-cache
    // miss) yielded holder = null -> pos = undefined -> the apex-office guard was
    // skipped entirely, and a gov:manage holder could evict the org's veto-holder or
    // election-caller on exactly the blip that made the check unverifiable. A guard
    // that exists to stop opposition being cleared out of powerful seats must not be
    // the thing that switches itself off.
    //
    // A missing holder row and an unreadable POSITION are refused for the same reason:
    // "I could not tell whether this is an apex office" must never read as "it is not".
    const { data: holder, error: holderErr } = await supabase.from('government_position_holders')
        .select('position:government_positions(can_veto_legislation, can_call_elections)')
        .eq('id', holderId).is('ended_at', null).maybeSingle();
    handleSupabaseError({ error: holderErr, message: 'Failed to load position holder' });
    if (!holder) throw new Error('Position holder not found.');
    const pos = (holder as { position?: { can_veto_legislation?: boolean; can_call_elections?: boolean } | null } | null)?.position;
    if (!pos) throw new Error('Cannot verify which office this holder occupies — try again.');
    if ((pos.can_veto_legislation || pos.can_call_elections) && !isOrgAdmin(actor)) {
        throw new Error('Removing the holder of an office that can veto legislation or call elections requires an administrator.');
    }

    const { error } = await supabase.from('government_position_holders')
        .update({ ended_at: new Date().toISOString(), end_reason: reason })
        .eq('id', holderId)

        .is('ended_at', null);
    handleSupabaseError({ error, message: 'Failed to remove position holder' });
    broadcastGovernmentUpdate('structure');
}

/**
 * Called when a user leaves the org — vacates all their government positions.
 */
export async function vacateAllPositions(userId: number) {
    const { error } = await supabase.from('government_position_holders')
        .update({ ended_at: new Date().toISOString(), end_reason: 'org_left' })
        .eq('user_id', userId)

        .is('ended_at', null);
    if (error) log.error('vacate positions for leaving user failed', { userId, err: error });
    else broadcastGovernmentUpdate('structure');
}
