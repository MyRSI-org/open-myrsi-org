import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/government/templates.ts (via the lib/db/government.ts barrel) — the quick-setup
// templates and applyGovernmentTemplate, which rebuilds the structure wholesale.

vi.mock('../lib/db/common', async () => (await import('./cov-db-government-fake')).commonModule());
vi.mock('../lib/supabaseServer', () => ({ supabase: { storage: { from: () => ({}) } }, handleSupabaseError: () => {} }));

import {
    fake, on, only, queries, calls, writeLog, resetFake, assertNoWildcards, govBroadcasts,
} from './cov-db-government-fake';
import * as government from '../lib/db/government';
import { GOVERNMENT_TEMPLATES } from '../lib/db/government/internal';
import { GovernmentType } from '../types';

type Row = Record<string, unknown>;

beforeEach(() => { resetFake(); });
afterEach(() => { assertNoWildcards(); vi.restoreAllMocks(); });

describe('lib/db/government barrel', () => {
    it('re-exports every government module', () => {
        for (const name of [
            'getGovernmentState', 'getGovernmentStructureState', 'appointPositionHolder', // structure
            'getGovernmentTemplates', 'applyGovernmentTemplate', // templates
            'getElectionsState', 'castElectionVote', 'concludeElection', // elections
            'getLegislationState', 'castMotionVote', // legislation
            'listGovernmentOrders', 'createGovernmentOrder', // orders
        ]) {
            expect(typeof (government as Record<string, unknown>)[name], name).toBe('function');
        }
    });
});

describe('getGovernmentTemplates', () => {
    it('returns the shipped template catalogue', () => {
        expect(government.getGovernmentTemplates()).toBe(GOVERNMENT_TEMPLATES);
    });

    // Both tables carry UNIQUE(name). A template that repeated a name could never be
    // applied in full — the second insert would collide and (now) refuse midway.
    it.each(GOVERNMENT_TEMPLATES.map(t => [t.type, t] as const))('%s uses each branch name and each position name once', (_type, template) => {
        const branchNames = template.branches.map(b => b.name);
        const positionNames = template.branches.flatMap(b => b.positions.map(p => p.name));
        expect(new Set(branchNames).size).toBe(branchNames.length);
        expect(new Set(positionNames).size).toBe(positionNames.length);
    });
});

describe('applyGovernmentTemplate', () => {
    // No orders on record; branch inserts return sequential ids so each position can be
    // traced to its branch.
    function seedApply(orders: number | null = 0) {
        let nextBranchId = 100;
        on('government_orders', 'select', { count: orders });
        on('government_branches', 'insert', () => ({ data: { id: nextBranchId++ } }));
        on('government_configs', 'select', { data: { id: 'c1' } });
        on('government_configs', 'upsert', { data: null });
    }

    it('refuses an unknown template before touching the database', async () => {
        await expect(government.applyGovernmentTemplate('anarchy')).rejects.toThrow('Unknown government template: anarchy');
        expect(fake.queries).toEqual([]);
        expect(govBroadcasts()).toEqual([]);
    });

    // BUG FIX (pinned): the reset deleted only the BRANCHES, unfiltered, with the error
    // ignored. Positions are ON DELETE SET NULL on their branch, so every one survived
    // branch-less and its holders kept their veto / legislative-vote / order-issuing
    // powers. Positions are now deleted explicitly (the cascade takes their holders),
    // before the branches, each delete with an explicit always-true filter.
    it('checks for orders, deletes every position then every branch, sets the config, then builds the template', async () => {
        seedApply();
        await government.applyGovernmentTemplate(GovernmentType.Westminster);

        const orders = only('government_orders', 'select');
        expect(orders.columns).toBe('id');
        expect(orders.selectOpts).toEqual({ count: 'exact', head: true });
        expect(orders.chain).toEqual([]);
        // The order check runs before any write.
        expect(fake.queries.indexOf(orders)).toBe(0);

        const log = writeLog();
        expect(log.slice(0, 3)).toEqual(['government_positions:delete', 'government_branches:delete', 'government_configs:upsert']);
        expect(log.slice(3)).toEqual([
            'government_branches:insert', 'government_positions:insert', 'government_positions:insert',
            'government_branches:insert', 'government_positions:insert', 'government_positions:insert',
            'government_branches:insert', 'government_positions:insert', 'government_positions:insert',
        ]);
        // pg-safeupdate: neither bulk delete is unfiltered.
        for (const table of ['government_positions', 'government_branches']) {
            const del = only(table, 'delete');
            expect(del.chain, table).toEqual([['not', ['id', 'is', null]]]);
        }

        const cfg = queries('government_configs', 'upsert')[0].values as Row;
        expect(cfg).toMatchObject({ id: 'c1', government_type: 'westminster', name: 'Parliament', constitution_content: null });
        expect(cfg.description).toMatch(/^A Westminster-style parliamentary system/);

        const branches = queries('government_branches', 'insert');
        expect(branches.map(q => q.values)).toEqual([
            { name: 'Executive', branch_type: 'Executive', icon: 'fa-solid fa-landmark-dome', sort_order: 0 },
            { name: 'House of Representatives', branch_type: 'Legislative', icon: 'fa-solid fa-landmark', sort_order: 1 },
            { name: 'Senate', branch_type: 'Legislative', icon: 'fa-solid fa-building-columns', sort_order: 2 },
        ]);
        expect(branches.every(q => q.returning === 'id')).toBe(true);

        const positions = queries('government_positions', 'insert').map(q => q.values as Row);
        expect(positions.map(p => [p.branch_id, p.name])).toEqual([
            [100, 'Prime Minister'], [100, 'Deputy Prime Minister'],
            [101, 'Speaker of the House'], [101, 'Representative'],
            [102, 'Senate President'], [102, 'Senator'],
        ]);
        // The apex seat carries its powers; an unflagged seat defaults to powerless.
        expect(positions[0]).toEqual({
            branch_id: 100, name: 'Prime Minister', fill_method: 'Elected', term_length_days: 120, max_holders: 1,
            icon: 'fa-solid fa-star', sort_order: 0, permissions_granted: ['gov:manage', 'gov:elected_official'],
            can_propose_legislation: false, can_vote_legislation: false, can_veto_legislation: false, can_call_elections: true,
        });
        expect(positions[1]).toEqual({
            branch_id: 100, name: 'Deputy Prime Minister', fill_method: 'Appointed', term_length_days: null, max_holders: 1,
            icon: 'fa-solid fa-star-half-stroke', sort_order: 1, permissions_granted: [],
            can_propose_legislation: false, can_vote_legislation: false, can_veto_legislation: false, can_call_elections: false,
        });
    });

    it('broadcasts a wholesale (slice-less) update after the config\'s structure update, and returns the fresh bundle', async () => {
        seedApply();
        on('government_branches', 'select', { data: [{ id: 100, name: 'High Command', branch_type: 'Executive', sort_order: 0, created_at: 't' }] });
        const state = await government.applyGovernmentTemplate(GovernmentType.MilitaryJunta);
        expect(govBroadcasts()).toEqual([{ slices: ['structure'] }, {}]);
        expect(state.governmentBranches.map(b => b.name)).toEqual(['High Command']);
        expect(state).toMatchObject({ governmentsConfig: { enabled: false }, governmentElections: [], governmentLegislation: [], governmentMotions: [] });
        // The bundle is read AFTER the rebuild.
        const firstRead = fake.queries.findIndex(q => q.op === 'select' && q.table === 'government_branches');
        const lastWrite = fake.queries.map(q => q.op).lastIndexOf('insert');
        expect(firstRead).toBeGreaterThan(lastWrite);
    });

    // government_orders.issuer_position_id is ON DELETE RESTRICT: with any order on record
    // the position delete cannot succeed, so the reset is refused up front, saying why.
    describe('refuses while executive orders exist', () => {
        it.each([
            [1, 'Cannot apply a template: 1 executive order is on record.'],
            [3, 'Cannot apply a template: 3 executive orders are on record.'],
        ])('%i order(s): refused before anything is deleted', async (n, lead) => {
            seedApply(n);
            const err = await government.applyGovernmentTemplate(GovernmentType.Westminster).then(
                () => { throw new Error('expected a refusal'); },
                (e: unknown) => e as Error,
            );
            expect(err).toBeInstanceOf(Error);
            expect(err.message.startsWith(lead)).toBe(true);
            expect(err.message).toContain('draft, in force, expired or revoked');
            expect(writeLog()).toEqual([]);
            expect(govBroadcasts()).toEqual([]);
        });

        it('an unreadable order count refuses (fail closed), as does an unknown one', async () => {
            on('government_orders', 'select', { error: { message: 'timeout' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.Westminster)).rejects.toThrow('Failed to check for executive orders');
            expect(writeLog()).toEqual([]);
            resetFake();
            seedApply(null);
            await expect(government.applyGovernmentTemplate(GovernmentType.Westminster)).rejects.toThrow('Could not verify whether any executive orders exist — try again.');
            expect(writeLog()).toEqual([]);
            expect(govBroadcasts()).toEqual([]);
        });

        it('an order issued between the check and the delete (RESTRICT, 23503) is refused with the same reason', async () => {
            seedApply();
            on('government_positions', 'delete', { error: { code: '23503', message: 'violates foreign key constraint "government_orders_issuer_position_id_fkey"' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.Westminster)).rejects.toThrow(/^Cannot apply a template: Executive orders are on record\./);
            expect(writeLog()).toEqual(['government_positions:delete']);
            // Nothing was removed, so nothing to refetch.
            expect(govBroadcasts()).toEqual([]);
        });
    });

    describe('every delete and insert is checked', () => {
        it('a failed position delete refuses before the branches are touched', async () => {
            seedApply();
            on('government_positions', 'delete', { error: { message: 'x' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.Westminster)).rejects.toThrow('Failed to remove the current positions');
            expect(writeLog()).toEqual(['government_positions:delete']);
            expect(govBroadcasts()).toEqual([]);
        });

        it('a failed branch delete refuses before the config is written; clients still refetch', async () => {
            seedApply();
            on('government_branches', 'delete', { error: { message: 'x' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.Westminster)).rejects.toThrow('Failed to remove the current branches');
            expect(writeLog()).toEqual(['government_positions:delete', 'government_branches:delete']);
            // The positions are already gone — the wholesale broadcast still goes out.
            expect(govBroadcasts()).toEqual([{}]);
        });

        // BUG FIX (pinned): UNIQUE(name) collisions used to drop the template's seat
        // silently (insert errors were ignored), so a branch or seat simply never appeared.
        it('a branch name collision refuses, naming the branch, instead of skipping it', async () => {
            seedApply();
            fake.routes.delete('government_branches:insert');
            on('government_branches', 'insert',
                { data: { id: 100 } },
                { error: { code: '23505', message: 'duplicate key value violates unique constraint "government_branches_name_key"' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.DemocraticRepublic))
                .rejects.toThrow('Cannot apply the template: a branch named "Senate" already exists. The template was only partly applied — apply it again.');
            // Executive (2 seats) built; nothing after the collision.
            expect(queries('government_branches', 'insert')).toHaveLength(2);
            expect(queries('government_positions', 'insert').map(q => (q.values as Row).name)).toEqual(['President', 'Vice President']);
            expect(govBroadcasts().at(-1)).toEqual({});
        });

        it('a position name collision refuses, naming the position', async () => {
            seedApply();
            on('government_positions', 'insert', { data: null }, { error: { code: '23505', message: 'dup' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.DemocraticRepublic))
                .rejects.toThrow('Cannot apply the template: a position named "Vice President" already exists.');
            expect(queries('government_positions', 'insert')).toHaveLength(2);
            expect(queries('government_branches', 'insert')).toHaveLength(1);
            expect(govBroadcasts().at(-1)).toEqual({});
        });

        it('any other branch insert failure, or a branch insert that returns no row, refuses', async () => {
            seedApply();
            fake.routes.delete('government_branches:insert');
            on('government_branches', 'insert', { error: { code: 'XX000', message: 'boom' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.MilitaryJunta))
                .rejects.toThrow('Failed to create the "High Command" branch — the template was only partly applied');
            expect(queries('government_positions', 'insert')).toHaveLength(0);
            resetFake();
            seedApply();
            fake.routes.delete('government_branches:insert');
            on('government_branches', 'insert', { data: null });
            await expect(government.applyGovernmentTemplate(GovernmentType.MilitaryJunta))
                .rejects.toThrow('Failed to create the "High Command" branch — the template was only partly applied');
            expect(queries('government_positions', 'insert')).toHaveLength(0);
        });

        it('any other position insert failure refuses, naming the position', async () => {
            seedApply();
            on('government_positions', 'insert', { error: { code: 'XX000', message: 'boom' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.MilitaryJunta))
                .rejects.toThrow('Failed to create the "Commander-in-Chief" position — the template was only partly applied');
            expect(queries('government_positions', 'insert')).toHaveLength(1);
        });

        it('a config write failure refuses after the clear; clients still refetch', async () => {
            seedApply();
            fake.routes.delete('government_configs:upsert');
            on('government_configs', 'upsert', { error: { message: 'x' } });
            await expect(government.applyGovernmentTemplate(GovernmentType.MilitaryJunta)).rejects.toThrow('Failed to upsert government config');
            expect(queries('government_branches', 'insert')).toHaveLength(0);
            expect(govBroadcasts()).toEqual([{}]);
        });
    });

    it.each(GOVERNMENT_TEMPLATES.map(t => [t.type, t] as const))('%s builds exactly its own branches and positions', async (type, template) => {
        seedApply();
        await government.applyGovernmentTemplate(type);
        expect(queries('government_branches', 'insert').map(q => (q.values as Row).name)).toEqual(template.branches.map(b => b.name));
        expect(queries('government_positions', 'insert').map(q => (q.values as Row).name)).toEqual(template.branches.flatMap(b => b.positions.map(p => p.name)));
        expect(queries('government_branches', 'delete')).toHaveLength(1);
        expect(calls(only('government_positions', 'delete'), 'not')).toEqual([['id', 'is', null]]);
    });
});
