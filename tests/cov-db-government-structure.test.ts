import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/government/structure.ts — the government's shape: config + constitution,
// branches, positions, holders, the bundle aggregation, and the authority ceilings on
// hand-appointing / removing holders of apex (veto / call-elections) offices.

vi.mock('../lib/db/common', async () => (await import('./cov-db-government-fake')).commonModule());
vi.mock('../lib/supabaseServer', () => ({ supabase: { storage: { from: () => ({}) } }, handleSupabaseError: () => {} }));
vi.mock('../lib/orgMediaDocs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/orgMediaDocs')>()),
    signDocMediaForClient: vi.fn(async (doc: unknown) => ({ signedFrom: doc })),
}));

import {
    fake, on, only, queries, eqs, calls, writeLog, resetFake, assertNoWildcards, govBroadcasts, type FakeQuery,
} from './cov-db-government-fake';
import {
    getGovernmentStructureState, getGovernmentState, upsertGovernmentConfig, updateConstitution,
    createGovernmentBranch, updateGovernmentBranch, deleteGovernmentBranch, reorderGovernmentBranches,
    createGovernmentPosition, updateGovernmentPosition, deleteGovernmentPosition, reorderGovernmentPositions,
    appointPositionHolder, removePositionHolder, vacateAllPositions,
} from '../lib/db/government/structure';
import { log, USER_HYDRATE } from '../lib/db/government/internal';
import { signDocMediaForClient, MAX_DOC_IMAGES } from '../lib/orgMediaDocs';
import { GovernmentType, PositionFillMethod, type GovernmentBranch } from '../types';

type Row = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONFIG_COLUMNS = 'id, government_type, name, description, constitution_content, created_at, updated_at';
const BRANCH_COLUMNS = 'id, name, branch_type, description, sort_order, icon, created_at';
const POSITION_COLUMNS = 'id, branch_id, name, description, fill_method, term_length_days, max_holders, icon, sort_order, permissions_granted, can_propose_legislation, can_vote_legislation, can_veto_legislation, can_call_elections, can_issue_orders, created_at';
const HOLDER_COLUMNS = 'id, position_id, user_id, appointed_by_id, election_id, started_at, ended_at, end_reason, created_at';
const ADMIN = { id: 1, isSystemAdmin: true };
const MANAGER = { id: 2, permissions: ['gov:manage', 'admin:access'] };

beforeEach(() => { resetFake(); vi.mocked(signDocMediaForClient).mockClear(); });
afterEach(() => { assertNoWildcards(); vi.restoreAllMocks(); });

const dirtyDoc = () => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We the members' }] }, { type: 'iframe', attrs: { src: 'https://evil' } }] });

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe('getGovernmentStructureState', () => {
    function seedStructure() {
        on('government_configs', 'select', { data: { id: 'c1', government_type: 'westminster', name: 'Parliament', description: null, constitution_content: { type: 'doc' }, created_at: 't', updated_at: 't' } });
        on('government_branches', 'select', { data: [
            { id: 1, name: 'Exec', branch_type: 'Executive', sort_order: 0, created_at: 't' },
            { id: 2, name: 'Empty', branch_type: 'Custom', sort_order: 1, created_at: 't' },
        ] });
        on('government_positions', 'select', { data: [
            { id: 10, branch_id: 1, name: 'PM', fill_method: 'Elected', max_holders: 1, sort_order: 0, permissions_granted: [], created_at: 't' },
            { id: 11, branch_id: 1, name: 'Deputy', fill_method: 'Appointed', max_holders: 1, sort_order: 1, permissions_granted: [], created_at: 't' },
            { id: 12, branch_id: null, name: 'Orphan', fill_method: 'Appointed', max_holders: 2, sort_order: 0, permissions_granted: [], created_at: 't' },
        ] });
        on('government_position_holders', 'select', { data: [
            { id: 100, position_id: 10, user_id: 7, started_at: 's', created_at: 'c' },
            { id: 101, position_id: 12, user_id: 8, started_at: 's', created_at: 'c' },
            { id: 102, position_id: 12, user_id: 9, started_at: 's', created_at: 'c' },
        ] });
        on('settings', 'select', { data: { value: { enabled: true } } });
    }

    it('co-fetches the five reads with explicit columns, only current holders', async () => {
        seedStructure();
        await getGovernmentStructureState();
        expect(only('government_configs', 'select').columns).toBe(CONFIG_COLUMNS);
        expect(only('government_configs', 'select').terminal).toBe('maybeSingle');
        const b = only('government_branches', 'select');
        expect(b.columns).toBe(BRANCH_COLUMNS);
        expect(calls(b, 'order')).toEqual([['sort_order']]);
        const p = only('government_positions', 'select');
        expect(p.columns).toBe(POSITION_COLUMNS);
        expect(calls(p, 'order')).toEqual([['sort_order']]);
        const h = only('government_position_holders', 'select');
        expect(h.columns).toBe(`${HOLDER_COLUMNS}, user:users!government_position_holders_user_id_fkey(${USER_HYDRATE}), appointed_by:users!government_position_holders_appointed_by_id_fkey(${USER_HYDRATE})`);
        expect(calls(h, 'is')).toEqual([['ended_at', null]]);
        const s = only('settings', 'select');
        expect(s.columns).toBe('value');
        expect(eqs(s)).toEqual({ key: 'governmentsConfig' });
    });

    it('buckets holders into positions and positions into branches; a branch-less position stays top-level', async () => {
        seedStructure();
        const s = await getGovernmentStructureState();
        expect(s.governmentsConfig).toEqual({ enabled: true });
        expect(s.governmentBranches.map(b => [b.id, b.positions!.map(p => p.id)])).toEqual([[1, [10, 11]], [2, []]]);
        expect(s.governmentPositions.map(p => [p.id, p.currentHolders!.map(h => h.id)])).toEqual([[10, [100]], [11, []], [12, [101, 102]]]);
        expect(s.governmentPositionHolders).toHaveLength(3);
    });

    it('signs the constitution\'s private images for the permitted reader', async () => {
        seedStructure();
        const s = await getGovernmentStructureState();
        expect(signDocMediaForClient).toHaveBeenCalledWith({ type: 'doc' });
        expect(s.governmentConfig).toMatchObject({ id: 'c1', name: 'Parliament', constitutionContent: { signedFrom: { type: 'doc' } } });
    });

    it('every read failing degrades to an empty, disabled government (nothing signed)', async () => {
        for (const t of ['government_configs', 'government_branches', 'government_positions', 'government_position_holders', 'settings']) {
            on(t, 'select', { error: { message: 'x' } });
        }
        await expect(getGovernmentStructureState()).resolves.toEqual({
            governmentsConfig: { enabled: false }, governmentConfig: null,
            governmentBranches: [], governmentPositions: [], governmentPositionHolders: [],
        });
        expect(fake.safeFetchFallbacks.sort()).toEqual(['government_branches', 'government_configs', 'government_position_holders', 'government_positions', 'settings:governmentsConfig']);
        expect(signDocMediaForClient).not.toHaveBeenCalled();
    });

    it('a config without a constitution is not signed; a non-array list result is empty', async () => {
        on('government_configs', 'select', { data: { id: 'c1', government_type: 'custom', name: 'G', constitution_content: null, created_at: 't', updated_at: 't' } });
        on('government_branches', 'select', { data: null });
        const s = await getGovernmentStructureState();
        expect(s.governmentConfig).toMatchObject({ id: 'c1', constitutionContent: undefined });
        expect(s.governmentBranches).toEqual([]);
        expect(signDocMediaForClient).not.toHaveBeenCalled();
    });
});

describe('getGovernmentState', () => {
    it('merges the structure with the three list key-groups, with no per-viewer ballot read', async () => {
        on('government_elections', 'select', { data: [] });
        on('government_legislation', 'select', { data: [] });
        on('government_motions', 'select', { data: [] });
        const s = await getGovernmentState();
        expect(Object.keys(s).sort()).toEqual([
            'governmentBranches', 'governmentConfig', 'governmentElections', 'governmentLegislation', 'governmentMotions',
            'governmentPositionHolders', 'governmentPositions', 'governmentsConfig',
        ]);
        expect(s).toMatchObject({ governmentElections: [], governmentLegislation: [], governmentMotions: [] });
        expect(queries('government_election_voter_registry')).toHaveLength(0);
        expect(queries('government_motion_votes')).toHaveLength(0);
    });

    it('one list key-group throwing degrades to an empty list without losing the rest', async () => {
        // A null row makes each list mapper throw; the legislation signer rejects.
        on('government_elections', 'select', { data: [null] });
        on('government_motions', 'select', { data: [null] });
        on('government_legislation', 'select', { data: [{ id: 1, title: 'A', body: { type: 'doc' }, status: 'Draft', author_id: 7, created_at: 't', updated_at: 't' }] });
        vi.mocked(signDocMediaForClient).mockRejectedValueOnce(new Error('sign failed'));
        on('government_branches', 'select', { data: [{ id: 1, name: 'Exec', branch_type: 'Executive', sort_order: 0, created_at: 't' }] });
        const s = await getGovernmentState();
        expect(s.governmentElections).toEqual([]);
        expect(s.governmentLegislation).toEqual([]);
        expect(s.governmentMotions).toEqual([]);
        expect(s.governmentBranches.map(b => b.id)).toEqual([1]);
    });
});

// ---------------------------------------------------------------------------
// Config / constitution
// ---------------------------------------------------------------------------

describe('upsertGovernmentConfig', () => {
    it('upserts onto the single existing row with a sanitised constitution', async () => {
        on('government_configs', 'select', { data: { id: 'c1' } });
        on('government_configs', 'upsert', { data: { id: 'c1', government_type: 'westminster', name: 'P', description: 'd', constitution_content: null, created_at: 't', updated_at: 't' } });
        const c = await upsertGovernmentConfig({ governmentType: GovernmentType.Westminster, name: 'P', description: 'd', constitutionContent: dirtyDoc() });

        const probe = only('government_configs', 'select');
        expect(probe.columns).toBe('id');
        expect(calls(probe, 'limit')).toEqual([[1]]);
        const up = only('government_configs', 'upsert');
        const v = up.values as Row;
        expect(v).toMatchObject({ id: 'c1', government_type: 'westminster', name: 'P', description: 'd', updated_at: expect.stringMatching(ISO) });
        expect(JSON.stringify(v.constitution_content)).toContain('We the members');
        expect(JSON.stringify(v.constitution_content)).not.toContain('iframe');
        expect(up.writeOpts).toEqual({ onConflict: 'id' });
        expect(up.returning).toBe(CONFIG_COLUMNS);
        expect(c).toMatchObject({ id: 'c1', governmentType: 'westminster' });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it('with no existing row it inserts a fresh one, defaulting every field', async () => {
        on('government_configs', 'select', { data: null });
        on('government_configs', 'upsert', { data: null });
        await expect(upsertGovernmentConfig({})).resolves.toBeNull();
        expect(only('government_configs', 'upsert').values).toEqual({
            government_type: 'custom', name: 'Government', description: null, constitution_content: null, updated_at: expect.stringMatching(ISO),
        });
    });

    // BUG FIX (pinned): the existing-row probe discarded its error, so a read fault looked
    // like "no row yet" and the upsert INSERTED a second config. From then on the
    // structure read's maybeSingle() errors on two rows and the government config
    // vanishes from every client. It now refuses instead of writing.
    it('an unreadable existing-row probe refuses rather than inserting a duplicate config', async () => {
        on('government_configs', 'select', { error: { message: 'statement timeout' } });
        await expect(upsertGovernmentConfig({ name: 'P' })).rejects.toThrow('Failed to load government config');
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    it('a constitution over the image cap is refused before any read or write', async () => {
        const images = Array.from({ length: MAX_DOC_IMAGES + 1 }, (_, i) => ({ type: 'image', attrs: { src: `https://cdn.example/${i}.png` } }));
        await expect(upsertGovernmentConfig({ constitutionContent: { type: 'doc', content: images } })).rejects.toThrow(`Too many images in this document (max ${MAX_DOC_IMAGES}).`);
        expect(fake.queries).toEqual([]);
    });

    it('a write failure surfaces the caller message', async () => {
        on('government_configs', 'upsert', { error: { message: 'x' } });
        await expect(upsertGovernmentConfig({})).rejects.toThrow('Failed to upsert government config');
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('updateConstitution', () => {
    it('stores the sanitised document on the config row', async () => {
        await updateConstitution(dirtyDoc());
        const u = only('government_configs', 'update');
        const v = u.values as Row;
        expect(v.updated_at).toMatch(ISO);
        expect(JSON.stringify(v.constitution_content)).not.toContain('iframe');
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    // pg-safeupdate refuses an UPDATE with no WHERE clause outright; the single-row
    // update was unfiltered. It now carries an explicit always-true filter.
    it('the single-row update is never unfiltered (pg-safeupdate)', async () => {
        await updateConstitution(dirtyDoc());
        expect(only('government_configs', 'update').chain).toEqual([['not', ['id', 'is', null]]]);
    });

    it('clearing it stores null; a cap breach or write failure refuses', async () => {
        await updateConstitution(null);
        expect((only('government_configs', 'update').values as Row).constitution_content).toBeNull();
        resetFake();
        const images = Array.from({ length: MAX_DOC_IMAGES + 1 }, (_, i) => ({ type: 'image', attrs: { src: `https://cdn.example/${i}.png` } }));
        await expect(updateConstitution({ type: 'doc', content: images })).rejects.toThrow(/Too many images/);
        expect(fake.queries).toEqual([]);
        on('government_configs', 'update', { error: { message: 'x' } });
        await expect(updateConstitution(null)).rejects.toThrow('Failed to update constitution');
    });
});

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

describe('branches', () => {
    it('createGovernmentBranch inserts with defaults and returns the mapped branch', async () => {
        on('government_branches', 'insert', { data: { id: 4, name: 'Senate', branch_type: 'Custom', sort_order: 0, created_at: 't' } });
        const b = await createGovernmentBranch({ name: 'Senate' });
        const ins = only('government_branches', 'insert');
        expect(ins.values).toEqual({ name: 'Senate', branch_type: 'Custom', description: null, sort_order: 0, icon: null });
        expect(ins.returning).toBe(BRANCH_COLUMNS);
        expect(b).toMatchObject({ id: 4, name: 'Senate', branchType: 'Custom' });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it('createGovernmentBranch carries supplied fields; null result → null; failure surfaces', async () => {
        on('government_branches', 'insert', { data: null });
        await expect(createGovernmentBranch({ name: 'S', branchType: 'Legislative' as GovernmentBranch['branchType'], description: 'd', sortOrder: 3, icon: 'i' })).resolves.toBeNull();
        expect(only('government_branches', 'insert').values).toEqual({ name: 'S', branch_type: 'Legislative', description: 'd', sort_order: 3, icon: 'i' });
        resetFake();
        on('government_branches', 'insert', { error: { message: 'x' } });
        await expect(createGovernmentBranch({ name: 'S' })).rejects.toThrow('Failed to create government branch');
    });

    it('updateGovernmentBranch writes only supplied fields; an empty patch writes nothing', async () => {
        await updateGovernmentBranch(4, { name: 'N', branchType: 'Judicial' as GovernmentBranch['branchType'], description: 'd', sortOrder: 2, icon: 'i' });
        const u = only('government_branches', 'update');
        expect(u.values).toEqual({ name: 'N', branch_type: 'Judicial', description: 'd', sort_order: 2, icon: 'i' });
        expect(eqs(u)).toEqual({ id: 4 });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
        resetFake();
        await updateGovernmentBranch(4, {});
        expect(writeLog()).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
        on('government_branches', 'update', { error: { message: 'x' } });
        await expect(updateGovernmentBranch(4, { name: 'x' })).rejects.toThrow('Failed to update government branch');
    });

    it('deleteGovernmentBranch deletes by id; failure surfaces', async () => {
        await deleteGovernmentBranch(4);
        expect(eqs(only('government_branches', 'delete'))).toEqual({ id: 4 });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
        resetFake();
        on('government_branches', 'delete', { error: { message: 'x' } });
        await expect(deleteGovernmentBranch(4)).rejects.toThrow('Failed to delete government branch');
    });

    it('reorderGovernmentBranches spaces sort_order by 10 in the given order, broadcasting once', async () => {
        await reorderGovernmentBranches([7, 3, 5]);
        expect(queries('government_branches', 'update').map(q => [eqs(q).id, (q.values as Row).sort_order])).toEqual([[7, 10], [3, 20], [5, 30]]);
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it('reorderGovernmentBranches: an empty list is a no-op; any failed write refuses', async () => {
        await reorderGovernmentBranches([]);
        expect(fake.queries).toEqual([]);
        on('government_branches', 'update', { error: null }, { error: { message: 'x' } });
        await expect(reorderGovernmentBranches([1, 2])).rejects.toThrow('Failed to reorder government branches');
        expect(govBroadcasts()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

describe('positions', () => {
    it('createGovernmentPosition defaults to a powerless appointed single seat', async () => {
        on('government_positions', 'insert', { data: { id: 9, name: 'Clerk', fill_method: 'Appointed', max_holders: 1, sort_order: 0, permissions_granted: [], created_at: 't' } });
        const p = await createGovernmentPosition({ name: 'Clerk' });
        const ins = only('government_positions', 'insert');
        expect(ins.values).toEqual({
            branch_id: null, name: 'Clerk', description: null, fill_method: 'Appointed', term_length_days: null, max_holders: 1,
            icon: null, sort_order: 0, permissions_granted: [], can_propose_legislation: false, can_vote_legislation: false,
            can_veto_legislation: false, can_call_elections: false, can_issue_orders: false,
        });
        expect(ins.returning).toBe(POSITION_COLUMNS);
        expect(p).toMatchObject({ id: 9, name: 'Clerk' });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it('createGovernmentPosition carries every supplied power; null result → null; failure surfaces', async () => {
        on('government_positions', 'insert', { data: null });
        await expect(createGovernmentPosition({
            branchId: 2, name: 'P', description: 'd', fillMethod: PositionFillMethod.Elected, termLengthDays: 90, maxHolders: 3, icon: 'i',
            sortOrder: 4, permissionsGranted: ['gov:manage'], canProposeLegislation: true, canVoteLegislation: true,
            canVetoLegislation: true, canCallElections: true, canIssueOrders: true,
        })).resolves.toBeNull();
        expect(only('government_positions', 'insert').values).toEqual({
            branch_id: 2, name: 'P', description: 'd', fill_method: 'Elected', term_length_days: 90, max_holders: 3, icon: 'i',
            sort_order: 4, permissions_granted: ['gov:manage'], can_propose_legislation: true, can_vote_legislation: true,
            can_veto_legislation: true, can_call_elections: true, can_issue_orders: true,
        });
        resetFake();
        on('government_positions', 'insert', { error: { message: 'x' } });
        await expect(createGovernmentPosition({ name: 'P' })).rejects.toThrow('Failed to create government position');
    });

    it('updateGovernmentPosition maps every field; an empty patch writes nothing', async () => {
        await updateGovernmentPosition(9, {
            branchId: 2, name: 'P', description: 'd', fillMethod: PositionFillMethod.Merit, termLengthDays: 30, maxHolders: 2, icon: 'i',
            sortOrder: 1, permissionsGranted: [], canProposeLegislation: false, canVoteLegislation: true, canVetoLegislation: false,
            canCallElections: false, canIssueOrders: true,
        });
        const u = only('government_positions', 'update');
        expect(u.values).toEqual({
            branch_id: 2, name: 'P', description: 'd', fill_method: 'Merit', term_length_days: 30, max_holders: 2, icon: 'i',
            sort_order: 1, permissions_granted: [], can_propose_legislation: false, can_vote_legislation: true,
            can_veto_legislation: false, can_call_elections: false, can_issue_orders: true,
        });
        expect(eqs(u)).toEqual({ id: 9 });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
        resetFake();
        await updateGovernmentPosition(9, {});
        expect(writeLog()).toEqual([]);
        on('government_positions', 'update', { error: { message: 'x' } });
        await expect(updateGovernmentPosition(9, { name: 'x' })).rejects.toThrow('Failed to update government position');
    });

    it('deleteGovernmentPosition deletes by id; failure surfaces', async () => {
        await deleteGovernmentPosition(9);
        expect(eqs(only('government_positions', 'delete'))).toEqual({ id: 9 });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
        resetFake();
        on('government_positions', 'delete', { error: { message: 'x' } });
        await expect(deleteGovernmentPosition(9)).rejects.toThrow('Failed to delete government position');
    });

    it('reorderGovernmentPositions within a branch checks the branch and scopes every write to it', async () => {
        on('government_branches', 'select', { data: { id: 2 } });
        await reorderGovernmentPositions(2, [9, 8]);
        const b = only('government_branches', 'select');
        expect(b.columns).toBe('id');
        expect(eqs(b)).toEqual({ id: 2 });
        expect(queries('government_positions', 'update').map(q => [eqs(q), (q.values as Row).sort_order, calls(q, 'is')])).toEqual([
            [{ id: 9, branch_id: 2 }, 10, []],
            [{ id: 8, branch_id: 2 }, 20, []],
        ]);
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it('reorderGovernmentPositions refuses an unknown branch before writing', async () => {
        on('government_branches', 'select', { data: null });
        await expect(reorderGovernmentPositions(2, [9])).rejects.toThrow('Government branch not found');
        expect(writeLog()).toEqual([]);
    });

    it('top-level positions (no branch) are scoped to branch_id IS NULL, with no branch check', async () => {
        await reorderGovernmentPositions(null, [9]);
        expect(queries('government_branches')).toHaveLength(0);
        const u = only('government_positions', 'update');
        expect(eqs(u)).toEqual({ id: 9 });
        expect(calls(u, 'is')).toEqual([['branch_id', null]]);
    });

    it('reorderGovernmentPositions: empty is a no-op; any failed write refuses', async () => {
        await reorderGovernmentPositions(2, []);
        expect(fake.queries).toEqual([]);
        on('government_positions', 'update', { error: { message: 'x' } });
        await expect(reorderGovernmentPositions(null, [1])).rejects.toThrow('Failed to reorder government positions');
        expect(govBroadcasts()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

describe('appointPositionHolder', () => {
    function seedAppoint(position: Row | null = { fill_method: 'Appointed', can_veto_legislation: false, can_call_elections: false }, holder: Row | null = { id: 500, position_id: 3, user_id: 7, appointed_by_id: 1, election_id: null, started_at: 's', ended_at: null, end_reason: null, created_at: 'c' }) {
        on('government_positions', 'select', { data: position });
        on('users', 'select', { data: { id: 7 } });
        on('government_position_holders', 'select', { data: holder });
        fake.rpcResult = { data: 500, error: null };
    }

    it('rejects a non-integer position id before any read', async () => {
        await expect(appointPositionHolder({ userId: 7, positionId: '3' as never })).rejects.toThrow('Invalid position id.');
        await expect(appointPositionHolder({ userId: '7' as never, positionId: 3 })).rejects.toThrow('Invalid appointee id.');
        expect(fake.queries).toEqual([]);
    });

    it('a manual appointment reads the seat, validates the member, then appoints atomically via the RPC', async () => {
        seedAppoint();
        const h = await appointPositionHolder({ userId: 7, positionId: 3, appointedById: 1 }, MANAGER);
        const seat = only('government_positions', 'select');
        expect(seat.columns).toBe('fill_method, can_veto_legislation, can_call_elections');
        expect(eqs(seat)).toEqual({ id: 3 });
        const member = only('users', 'select');
        expect(member.columns).toBe('id');
        expect(eqs(member)).toEqual({ id: 7 });
        expect(calls(member, 'is')).toEqual([['deleted_at', null]]);
        expect(fake.rpcCalls).toEqual([{ fn: 'gov_appoint_holder', args: { p_position_id: 3, p_user_id: 7, p_appointed_by_id: 1, p_election_id: null } }]);
        const read = only('government_position_holders', 'select');
        expect(read.columns).toBe(HOLDER_COLUMNS);
        expect(eqs(read)).toEqual({ id: 500 });
        expect(h).toMatchObject({ id: 500, positionId: 3, userId: 7, appointedById: 1 });
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it('an unknown seat is refused', async () => {
        seedAppoint(null);
        await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Position not found');
        expect(fake.rpcCalls).toEqual([]);
    });

    it.each([['Hereditary', 'hereditary'], ['Merit', 'merit']])('a %s seat is not hand-appointable, even by an admin', async (method, lower) => {
        seedAppoint({ fill_method: method, can_veto_legislation: false, can_call_elections: false });
        await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow(`This position is filled by ${lower}, not by direct appointment.`);
        expect(fake.rpcCalls).toEqual([]);
    });

    it('an apex appointed seat can be filled by a stamped org admin', async () => {
        seedAppoint({ fill_method: 'Appointed', can_veto_legislation: true, can_call_elections: false });
        await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).resolves.toMatchObject({ id: 500 });
        expect(fake.rpcCalls).toHaveLength(1);
    });

    it('an apex seat with no actor at all is refused (unstamped ⇒ not an admin)', async () => {
        seedAppoint({ fill_method: 'Appointed', can_veto_legislation: false, can_call_elections: true });
        await expect(appointPositionHolder({ userId: 7, positionId: 3 })).rejects.toThrow('Appointing into an office that can veto legislation or call elections requires an administrator.');
    });

    it('an election-seated winner skips the manual ceiling entirely', async () => {
        seedAppoint({ fill_method: 'Elected', can_veto_legislation: true, can_call_elections: true });
        await appointPositionHolder({ userId: 7, positionId: 3, electionId: 11 });
        expect(queries('government_positions')).toHaveLength(0);
        expect(fake.rpcCalls[0].args).toEqual({ p_position_id: 3, p_user_id: 7, p_appointed_by_id: null, p_election_id: 11 });
    });

    it.each([
        ['position_not_found', 'Position not found'],
        ['ERROR: already_holds', 'User already holds this position'],
        ['position_full', 'Position is full'],
    ])('maps the RPC refusal %s', async (msg, expected) => {
        seedAppoint();
        fake.rpcResult = { data: null, error: { message: msg } };
        await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow(expected);
        expect(govBroadcasts()).toEqual([]);
    });

    it('any other RPC error surfaces the caller message (never the DB detail)', async () => {
        seedAppoint();
        fake.rpcResult = { data: null, error: { code: '23503', message: 'insert violates fk "secret_constraint"' } };
        await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow(/^Failed to appoint position holder$/);
        fake.rpcResult = { data: null, error: { code: 'XX000' } };
        await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Failed to appoint position holder');
    });

    it('an RPC that returns no id yields null without a holder read', async () => {
        seedAppoint();
        fake.rpcResult = { data: null, error: null };
        await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).resolves.toBeNull();
        expect(queries('government_position_holders')).toHaveLength(0);
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    describe('fallback when gov_appoint_holder is not deployed', () => {
        function seedFallback(maxHolders: number | null, current: number | null, existing: number | null) {
            on('government_positions', 'select',
                { data: { fill_method: 'Appointed', can_veto_legislation: false, can_call_elections: false } },
                { data: maxHolders === null ? null : { max_holders: maxHolders } });
            on('users', 'select', { data: { id: 7 } });
            on('government_position_holders', 'select', { count: current }, { count: existing });
            fake.rpcResult = { data: null, error: { code: '42883', message: 'function does not exist' } };
        }

        it('counts the seat, checks for a duplicate holding, then inserts', async () => {
            seedFallback(2, 1, 0);
            on('government_position_holders', 'insert', { data: { id: 600, position_id: 3, user_id: 7, appointed_by_id: null, election_id: null, started_at: 's', created_at: 'c' } });
            const h = await appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN);
            const cap = queries('government_positions', 'select')[1];
            expect(cap.columns).toBe('max_holders');
            expect(eqs(cap)).toEqual({ id: 3 });
            const [seatCount, dupCount] = queries('government_position_holders', 'select');
            expect(seatCount.selectOpts).toEqual({ count: 'exact', head: true });
            expect(eqs(seatCount)).toEqual({ position_id: 3 });
            expect(calls(seatCount, 'is')).toEqual([['ended_at', null]]);
            expect(eqs(dupCount)).toEqual({ position_id: 3, user_id: 7 });
            const ins = only('government_position_holders', 'insert');
            expect(ins.values).toEqual({ position_id: 3, user_id: 7, appointed_by_id: null, election_id: null });
            expect(ins.returning).toBe(HOLDER_COLUMNS);
            expect(h).toMatchObject({ id: 600, userId: 7 });
            expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
        });

        it('PGRST202 also selects the fallback', async () => {
            seedFallback(1, 0, 0);
            fake.rpcResult = { data: null, error: { code: 'PGRST202', message: 'not found in schema cache' } };
            on('government_position_holders', 'insert', { data: null });
            await expect(appointPositionHolder({ userId: 7, positionId: 3, appointedById: 1, electionId: 4 })).resolves.toBeNull();
            expect(only('government_position_holders', 'insert').values).toEqual({ position_id: 3, user_id: 7, appointed_by_id: 1, election_id: 4 });
        });

        it('refuses an unknown seat, a full seat (singular and plural) and a duplicate holding', async () => {
            seedFallback(null, 0, 0);
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Position not found');
            resetFake();
            seedFallback(1, 1, 0);
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Position is full (1 holder max)');
            resetFake();
            seedFallback(3, 3, 0);
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Position is full (3 holders max)');
            resetFake();
            seedFallback(3, 1, 1);
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('User already holds this position');
            expect(queries('government_position_holders', 'insert')).toHaveLength(0);
        });

        // BUG FIX (pinned): `count !== null && count >= max` skipped the cap whenever the
        // count came back null, so an unreadable count seated the appointee into a full
        // office. Both counts now refuse when unknown or unreadable.
        it('an unknown or unreadable seat count refuses instead of skipping the cap', async () => {
            seedFallback(1, null, 0);
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Could not verify how many members hold this position — try again.');
            expect(queries('government_position_holders', 'insert')).toHaveLength(0);
            resetFake();
            seedFallback(1, 0, 0);
            fake.routes.delete('government_position_holders:select');
            on('government_position_holders', 'select', { error: { message: 'timeout' } });
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Failed to count the position\'s holders');
            expect(queries('government_position_holders', 'insert')).toHaveLength(0);
            expect(govBroadcasts()).toEqual([]);
        });

        it('an unknown or unreadable existing-holding count refuses too', async () => {
            seedFallback(3, 0, null);
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Could not verify whether this member already holds the position — try again.');
            expect(queries('government_position_holders', 'insert')).toHaveLength(0);
            resetFake();
            seedFallback(3, 0, 0);
            fake.routes.delete('government_position_holders:select');
            on('government_position_holders', 'select', { count: 0 }, { error: { message: 'timeout' } });
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Failed to check for an existing holding');
            expect(queries('government_position_holders', 'insert')).toHaveLength(0);
        });

        it('an insert failure surfaces the caller message', async () => {
            seedFallback(2, 0, 0);
            on('government_position_holders', 'insert', { error: { message: 'x' } });
            await expect(appointPositionHolder({ userId: 7, positionId: 3 }, ADMIN)).rejects.toThrow('Failed to appoint position holder');
            expect(govBroadcasts()).toEqual([]);
        });
    });
});

describe('removePositionHolder', () => {
    const holderWith = (position: Row | null) => on('government_position_holders', 'select', { data: { position } });

    it('reads the current holding with its office powers', async () => {
        holderWith({ can_veto_legislation: false, can_call_elections: false });
        await removePositionHolder(50, 'Resigned', MANAGER);
        const read = only('government_position_holders', 'select');
        expect(read.columns).toBe('position:government_positions(can_veto_legislation, can_call_elections)');
        expect(eqs(read)).toEqual({ id: 50 });
        expect(calls(read, 'is')).toEqual([['ended_at', null]]);
        const u = only('government_position_holders', 'update');
        expect(u.values).toEqual({ ended_at: expect.stringMatching(ISO), end_reason: 'Resigned' });
        expect(eqs(u)).toEqual({ id: 50 });
        expect(calls(u, 'is')).toEqual([['ended_at', null]]);
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it.each([
        ['an unreadable holding', () => on('government_position_holders', 'select', { error: { message: 'x' } }), 'Failed to load position holder'],
        ['a missing holding', () => on('government_position_holders', 'select', { data: null }), 'Position holder not found.'],
        ['an unreadable office', () => holderWith(null), 'Cannot verify which office this holder occupies — try again.'],
    ])('fails closed on %s', async (_label, seed, message) => {
        seed();
        await expect(removePositionHolder(50, 'r', ADMIN)).rejects.toThrow(message);
        expect(writeLog()).toEqual([]);
    });

    it('an apex office holder can be removed only by an org admin', async () => {
        holderWith({ can_veto_legislation: true, can_call_elections: false });
        await expect(removePositionHolder(50, 'r', MANAGER)).rejects.toThrow('Removing the holder of an office that can veto legislation or call elections requires an administrator.');
        expect(writeLog()).toEqual([]);
        resetFake();
        holderWith({ can_veto_legislation: false, can_call_elections: true });
        await removePositionHolder(50, 'r', ADMIN);
        expect(writeLog()).toEqual(['government_position_holders:update']);
    });

    it('a write failure surfaces', async () => {
        holderWith({ can_veto_legislation: false, can_call_elections: false });
        on('government_position_holders', 'update', { error: { message: 'x' } });
        await expect(removePositionHolder(50, 'r')).rejects.toThrow('Failed to remove position holder');
        expect(govBroadcasts()).toEqual([]);
    });
});

describe('vacateAllPositions', () => {
    it('ends every current holding of a departing member', async () => {
        await vacateAllPositions(7);
        const u = only('government_position_holders', 'update');
        expect(u.values).toEqual({ ended_at: expect.stringMatching(ISO), end_reason: 'org_left' });
        expect(eqs(u)).toEqual({ user_id: 7 });
        expect(calls(u, 'is')).toEqual([['ended_at', null]]);
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }]);
    });

    it('a failure is logged (ids only) and not broadcast; the departure is not blocked', async () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        on('government_position_holders', 'update', (q: FakeQuery) => ({ error: { message: `fail ${q.table}` } }));
        await expect(vacateAllPositions(7)).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith('vacate positions for leaving user failed', { userId: 7, err: { message: 'fail government_position_holders' } });
        expect(govBroadcasts()).toEqual([]);
    });
});
