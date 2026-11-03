// @vitest-environment node
//
// lib/pgrest.ts — the input guards that stand between caller-supplied values and
// the PostgREST filter grammar (.or()/.filter() strings, like/ilike operands,
// offsets, ids, bulk id arrays). Every helper must fail closed: strip or reject,
// never pass an injectable fragment through.
import { describe, it, expect } from 'vitest';
import {
    safeSearchTerm,
    escapeLikePattern,
    clampListOffset,
    MAX_LIST_OFFSET,
    requireUuid,
    requireIntId,
    assertIdArray,
} from '../lib/pgrest';

describe('safeSearchTerm', () => {
    it.each([undefined, null, 42, {}, ['a']])('returns "" for the non-string %j', (v) => {
        expect(safeSearchTerm(v)).toBe('');
    });

    it('strips every PostgREST grammar character so no sibling OR term can be injected', () => {
        expect(safeSearchTerm('a,id.eq.1),or(role.eq.admin')).toBe('aideq1orroleeqadmin');
        expect(safeSearchTerm(`x%*\\'"():;!`)).toBe('x');
    });

    it('keeps alphanumerics, space, underscore and hyphen, then trims', () => {
        expect(safeSearchTerm('  Jean-Luc_Picard 1701  ')).toBe('Jean-Luc_Picard 1701');
    });

    it('strips non-ASCII letters (allow-list, not deny-list)', () => {
        expect(safeSearchTerm('Zoë Ünïcode')).toBe('Zo ncode');
    });

    it('caps at 100 characters by default and at a caller-supplied max', () => {
        expect(safeSearchTerm('a'.repeat(150))).toBe('a'.repeat(100));
        expect(safeSearchTerm('abcdefgh', 3)).toBe('abc');
    });

    it('trims BEFORE capping, so leading space does not eat the budget', () => {
        expect(safeSearchTerm('     abc', 3)).toBe('abc');
    });
});

describe('escapeLikePattern', () => {
    it('escapes each LIKE metacharacter, including PostgREST\'s * wildcard alias', () => {
        expect(escapeLikePattern('%')).toBe('\\%');
        expect(escapeLikePattern('_')).toBe('\\_');
        expect(escapeLikePattern('\\')).toBe('\\\\');
        expect(escapeLikePattern('*')).toBe('\\*');
    });

    it('escapes every occurrence in a mixed handle, leaving other characters alone', () => {
        expect(escapeLikePattern('a_b%c*d\\e')).toBe('a\\_b\\%c\\*d\\\\e');
        expect(escapeLikePattern('Plain-Handle.01')).toBe('Plain-Handle.01');
    });

    it.each([undefined, null, 5, {}, ['%']])('returns "" (matches nothing) for the non-string %j', (v) => {
        expect(escapeLikePattern(v)).toBe('');
    });
});

describe('clampListOffset', () => {
    it('passes a normal non-negative integer through', () => {
        expect(clampListOffset(0)).toBe(0);
        expect(clampListOffset(250)).toBe(250);
    });

    it('floors a fractional offset', () => {
        expect(clampListOffset(12.9)).toBe(12);
    });

    it('clamps a negative offset to 0 and a huge one to MAX_LIST_OFFSET', () => {
        expect(clampListOffset(-5)).toBe(0);
        expect(MAX_LIST_OFFSET).toBe(100_000);
        expect(clampListOffset(MAX_LIST_OFFSET + 1)).toBe(MAX_LIST_OFFSET);
        expect(clampListOffset(MAX_LIST_OFFSET)).toBe(MAX_LIST_OFFSET);
    });

    it('honours a caller-supplied max', () => {
        expect(clampListOffset(500, 100)).toBe(100);
    });

    it.each([NaN, Infinity, -Infinity, '10', null, undefined, {}])('falls back to 0 for %j', (v) => {
        expect(clampListOffset(v)).toBe(0);
    });
});

describe('requireUuid', () => {
    it('returns a canonical UUID unchanged (either case)', () => {
        expect(requireUuid('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000');
        expect(requireUuid('123E4567-E89B-12D3-A456-426614174000')).toBe('123E4567-E89B-12D3-A456-426614174000');
    });

    it.each([
        '123e4567-e89b-12d3-a456-42661417400',     // one short
        '123e4567-e89b-12d3-a456-4266141740000',   // one long
        '123e4567e89b12d3a456426614174000',        // no hyphens
        '123e4567-e89b-12d3-a456-42661417400g',    // non-hex
        '123e4567-e89b-12d3-a456-426614174000,id', // grammar smuggled after a valid id
        ' 123e4567-e89b-12d3-a456-426614174000',
        '',
    ])('rejects %j with the default field name', (v) => {
        expect(() => requireUuid(v)).toThrow('Invalid id: not a UUID');
    });

    it('rejects a non-string and names the caller-supplied field', () => {
        expect(() => requireUuid(42, 'operationId')).toThrow('Invalid operationId: not a UUID');
        expect(() => requireUuid(null, 'operationId')).toThrow('Invalid operationId: not a UUID');
    });
});

describe('requireIntId', () => {
    it('stringifies a non-negative safe integer (0 included)', () => {
        expect(requireIntId(0)).toBe('0');
        expect(requireIntId(42)).toBe('42');
        expect(requireIntId(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
    });

    it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2])('rejects the number %j as not a non-negative safe integer', (v) => {
        expect(() => requireIntId(v)).toThrow('Invalid id: not a non-negative safe integer');
    });

    it('returns an all-digit string unchanged', () => {
        expect(requireIntId('0042')).toBe('0042');
    });

    it.each(['', '-1', '1.5', '12a', '1,2', '1)', ' 1', null, undefined, {}, true])('rejects %j as not an integer', (v) => {
        expect(() => requireIntId(v)).toThrow('Invalid id: not an integer');
    });

    it('names the caller-supplied field in both error shapes', () => {
        expect(() => requireIntId(-1, 'userId')).toThrow('Invalid userId: not a non-negative safe integer');
        expect(() => requireIntId('x', 'userId')).toThrow('Invalid userId: not an integer');
    });
});

describe('assertIdArray', () => {
    it('returns the same array when every element is a string or number within the cap', () => {
        const ids = [1, 'two', 3];
        expect(assertIdArray(ids, 3)).toBe(ids);
    });

    it('rejects a non-array', () => {
        expect(() => assertIdArray('1,2', 10)).toThrow('Invalid ids: not an array');
        expect(() => assertIdArray({ 0: 1, length: 1 }, 10)).toThrow('Invalid ids: not an array');
        expect(() => assertIdArray(undefined, 10)).toThrow('Invalid ids: not an array');
    });

    it('rejects an empty array', () => {
        expect(() => assertIdArray([], 10)).toThrow('Invalid ids: empty array');
    });

    it('rejects one element over the cap and names the cap', () => {
        expect(() => assertIdArray([1, 2, 3, 4], 3)).toThrow('Invalid ids: array too large (max 3)');
    });

    it.each([[[1, null]], [[1, { id: 2 }]], [[true]], [[['nested']]], [[undefined]]])('rejects a non-primitive element in %j', (arr) => {
        expect(() => assertIdArray(arr, 10)).toThrow('Invalid ids: elements must be string or number');
    });

    it('uses the caller-supplied field name in every message', () => {
        expect(() => assertIdArray(null, 5, 'userIds')).toThrow('Invalid userIds: not an array');
        expect(() => assertIdArray([], 5, 'userIds')).toThrow('Invalid userIds: empty array');
        expect(() => assertIdArray([1, 2], 1, 'userIds')).toThrow('Invalid userIds: array too large (max 1)');
        expect(() => assertIdArray([null], 5, 'userIds')).toThrow('Invalid userIds: elements must be string or number');
    });
});
