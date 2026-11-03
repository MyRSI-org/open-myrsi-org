import { describe, it, expect } from 'vitest';
import { buildUnitTree, type UnitNode } from '../lib/unitTree';
import type { OrganizationalUnit } from '../types';

// lib/unitTree.ts — the shared unit-hierarchy builder behind OrganisationView (org chart)
// and DutyRosterView (hierarchical roster). Both surfaces must agree on parentage and
// ordering, so the contract pinned here is: parent links resolve, unresolvable parents
// surface as roots (never silently dropped), siblings sort by sortOrder then name at
// every depth, and the caller's array is never mutated.

const u = (id: number, name: string, extra: Partial<OrganizationalUnit> = {}): OrganizationalUnit => ({ id, name, ...extra });
const names = (nodes: UnitNode[]) => nodes.map(n => n.name);

describe('buildUnitTree', () => {
    it('returns an empty forest for no units', () => {
        expect(buildUnitTree([])).toEqual([]);
    });

    it('nests children under their parent and keeps parentless units as roots', () => {
        const tree = buildUnitTree([
            u(1, 'Command'),
            u(2, 'Alpha', { parentUnitId: 1 }),
            u(3, 'Alpha-1', { parentUnitId: 2 }),
            u(4, 'Logistics'),
        ]);
        expect(names(tree)).toEqual(['Command', 'Logistics']);
        expect(names(tree[0].children)).toEqual(['Alpha']);
        expect(names(tree[0].children[0].children)).toEqual(['Alpha-1']);
        expect(tree[0].children[0].children[0].children).toEqual([]);
        expect(tree[1].children).toEqual([]);
    });

    it('promotes a unit whose parent is not in the list to a root rather than dropping it', () => {
        const tree = buildUnitTree([u(5, 'Orphan', { parentUnitId: 999 }), u(6, 'Root')]);
        expect(names(tree)).toEqual(['Orphan', 'Root']);
    });

    it('sorts by sortOrder first, treating a missing sortOrder as 0', () => {
        const tree = buildUnitTree([
            u(1, 'Charlie', { sortOrder: 2 }),
            u(2, 'Bravo', { sortOrder: 1 }),
            u(3, 'Zulu'),               // undefined → 0
            u(4, 'Yankee', { sortOrder: -1 }),
        ]);
        expect(names(tree)).toEqual(['Yankee', 'Zulu', 'Bravo', 'Charlie']);
    });

    it('breaks sortOrder ties by name', () => {
        const tree = buildUnitTree([
            u(1, 'Delta', { sortOrder: 1 }),
            u(2, 'Alpha', { sortOrder: 1 }),
            u(3, 'Charlie'),
            u(4, 'Bravo', { sortOrder: 0 }),
        ]);
        expect(names(tree)).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
    });

    it('applies the same ordering recursively at every depth', () => {
        const tree = buildUnitTree([
            u(1, 'HQ'),
            u(10, 'Squad C', { parentUnitId: 1, sortOrder: 3 }),
            u(11, 'Squad A', { parentUnitId: 1, sortOrder: 3 }),
            u(12, 'Squad B', { parentUnitId: 1, sortOrder: 1 }),
            u(20, 'Fireteam 2', { parentUnitId: 11 }),
            u(21, 'Fireteam 1', { parentUnitId: 11 }),
        ]);
        expect(names(tree[0].children)).toEqual(['Squad B', 'Squad A', 'Squad C']);
        expect(names(tree[0].children[1].children)).toEqual(['Fireteam 1', 'Fireteam 2']);
    });

    it('carries every unit field through onto the node', () => {
        const unit = u(7, 'Recon', { leaderId: 42, motto: 'Eyes open', isRestricted: true, linkedChannelId: 'c1', sortOrder: 4 });
        const [node] = buildUnitTree([unit]);
        expect(node).toEqual({ ...unit, children: [] });
    });

    it('never mutates the input array or the unit objects', () => {
        const input = [u(2, 'B', { parentUnitId: 1 }), u(1, 'A')];
        const snapshot = JSON.parse(JSON.stringify(input));
        const tree = buildUnitTree(input);
        expect(input).toEqual(snapshot);
        expect(input[0]).not.toHaveProperty('children');
        expect(tree[0]).not.toBe(input[1]);
    });

    it('terminates on a parent cycle and keeps the rest of the forest intact', () => {
        // No server-side guard stops admin:update_unit from creating a cycle. Today the
        // cycle members resolve each other as parents, so neither is a root and both are
        // absent from the forest (see the open question raised with this test). What must
        // hold regardless: no infinite recursion, and unrelated units are unaffected.
        const tree = buildUnitTree([
            u(1, 'Loop A', { parentUnitId: 2 }),
            u(2, 'Loop B', { parentUnitId: 1 }),
            u(3, 'Self', { parentUnitId: 3 }),
            u(4, 'Stable'),
            u(5, 'Stable child', { parentUnitId: 4 }),
        ]);
        expect(names(tree)).toEqual(['Stable']);
        expect(names(tree[0].children)).toEqual(['Stable child']);
    });
});
