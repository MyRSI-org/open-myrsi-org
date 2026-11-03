import { describe, it, expect } from 'vitest';
import {
    canViewAllClassifications,
    passesClearance,
    filterByClearance,
    assertCanClassify,
    type ClearanceUser,
} from '../lib/clearance';

// =============================================================================
// lib/clearance.ts — the deny-by-default clearance + limiting-marker predicates
// behind every classified read (intel, wiki, operations) and the write-side
// classification-integrity guard.
//
// Rule: item level <= viewer clearance AND the viewer holds EVERY item marker;
// the system Admin (role IDENTITY, never the role name) and holders of a
// caller-named bypass permission see everything.
// =============================================================================

const markerRow = (id: number, code = `M${id}`, name = `Marker ${id}`) => ({ id, code, name });
const viewer = (level: number | null | undefined, markers: unknown[] = [], extra: Partial<ClearanceUser> = {}): ClearanceUser => ({
    clearanceLevel: level === null ? null : level === undefined ? undefined : { level },
    limitingMarkers: markers,
    ...extra,
});

// ---------------------------------------------------------------------------
describe('canViewAllClassifications (the bypass)', () => {
    it('is false for a missing viewer (fail closed)', () => {
        expect(canViewAllClassifications(null)).toBe(false);
        expect(canViewAllClassifications(undefined, ['intel:manage'])).toBe(false);
    });

    it('is true only for the STAMPED system-Admin identity', () => {
        expect(canViewAllClassifications({ isSystemAdmin: true })).toBe(true);
    });

    it('a truthy-but-not-true stamp, or a role NAME of Admin, is not the identity', () => {
        expect(canViewAllClassifications({ isSystemAdmin: 'true' as unknown as boolean })).toBe(false);
        expect(canViewAllClassifications({ isSystemAdmin: 1 as unknown as boolean })).toBe(false);
        expect(canViewAllClassifications({ role: 'Admin', permissions: [] } as ClearanceUser)).toBe(false);
    });

    it('a caller holding one of the NAMED bypass permissions sees all; other permissions do not count', () => {
        expect(canViewAllClassifications({ permissions: ['intel:view', 'intel:manage'] }, ['intel:manage'])).toBe(true);
        expect(canViewAllClassifications({ permissions: ['intel:view'] }, ['intel:manage'])).toBe(false);
    });

    it('an empty bypass list grants nothing, whatever the caller holds', () => {
        expect(canViewAllClassifications({ permissions: ['intel:manage', 'admin:access'] })).toBe(false);
        expect(canViewAllClassifications({ permissions: ['intel:manage'] }, [])).toBe(false);
    });

    it('a non-array permissions field cannot satisfy a bypass (no substring match on a string)', () => {
        expect(canViewAllClassifications({ permissions: 'intel:manage' as unknown as string[] }, ['intel:manage'])).toBe(false);
        expect(canViewAllClassifications({}, ['intel:manage'])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('passesClearance — classification level', () => {
    it('admits at and below the viewer clearance, denies above it', () => {
        expect(passesClearance(viewer(3), 2)).toBe(true);
        expect(passesClearance(viewer(3), 3)).toBe(true);
        expect(passesClearance(viewer(3), 4)).toBe(false);
    });

    it('a null/undefined item level is unclassified (0)', () => {
        expect(passesClearance(viewer(0), null)).toBe(true);
        expect(passesClearance(viewer(0), undefined)).toBe(true);
        expect(passesClearance(viewer(0))).toBe(true);
    });

    it.each([
        ['no viewer', null],
        ['an undefined viewer', undefined],
        ['a null clearanceLevel', viewer(null)],
        ['an absent clearanceLevel', viewer(undefined)],
        ['a clearanceLevel with no level', { clearanceLevel: {} } as ClearanceUser],
    ])('%s is treated as clearance 0: sees unclassified, nothing above', (_l, who) => {
        expect(passesClearance(who, 0)).toBe(true);
        expect(passesClearance(who, null)).toBe(true);
        expect(passesClearance(who, 1)).toBe(false);
    });

    it('the stamped Admin passes any level and any marker, even at clearance 0 with no markers', () => {
        const admin = viewer(0, [], { isSystemAdmin: true });
        expect(passesClearance(admin, 99, [markerRow(1), markerRow(2)])).toBe(true);
    });

    it('a bypass-permission holder passes regardless of level and markers', () => {
        const mgr = viewer(0, [], { permissions: ['intel:manage'] });
        expect(passesClearance(mgr, 5, [markerRow(9)], ['intel:manage'])).toBe(true);
        // …but only when the caller names that permission as the bypass.
        expect(passesClearance(mgr, 5, [markerRow(9)])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('passesClearance — limiting markers', () => {
    it('no markers (absent or empty) adds no requirement', () => {
        expect(passesClearance(viewer(1), 1, undefined)).toBe(true);
        expect(passesClearance(viewer(1), 1, [])).toBe(true);
    });

    it('the viewer must hold EVERY marker: a superset passes, a strict subset is denied', () => {
        const item = [markerRow(1), markerRow(2)];
        expect(passesClearance(viewer(1, [markerRow(1), markerRow(2), markerRow(3)]), 1, item)).toBe(true);
        expect(passesClearance(viewer(1, [markerRow(1)]), 1, item)).toBe(false);
        expect(passesClearance(viewer(1, []), 1, item)).toBe(false);
    });

    it('a viewer with no markers array at all is denied any marked item', () => {
        expect(passesClearance({ clearanceLevel: { level: 5 } }, 0, [markerRow(1)])).toBe(false);
        expect(passesClearance(null, 0, ['NOFORN'])).toBe(false);
    });

    it('level is checked before markers: holding the marker does not lift a level shortfall', () => {
        expect(passesClearance(viewer(1, [markerRow(1)]), 2, [markerRow(1)])).toBe(false);
    });

    it('row objects compare by id, so two DIFFERENT markers never collapse to one key', () => {
        // The historical defect: String(obj) made every marker "[object Object]".
        expect(passesClearance(viewer(1, [markerRow(1)]), 1, [markerRow(2)])).toBe(false);
        expect(passesClearance(viewer(1, [{ id: 7 }]), 1, [{ id: 7, code: 'X', name: 'Y' }])).toBe(true);
    });

    it('id wins over code: same code but a different id is a different marker', () => {
        expect(passesClearance(viewer(1, [{ id: 1, code: 'NF' }]), 1, [{ id: 2, code: 'NF' }])).toBe(false);
    });

    it('falls back to code when there is no id, then to name', () => {
        expect(passesClearance(viewer(1, [{ code: 'NF' }]), 1, [{ code: 'NF', name: 'other' }])).toBe(true);
        expect(passesClearance(viewer(1, [{ code: 'NF' }]), 1, [{ code: 'REL' }])).toBe(false);
        expect(passesClearance(viewer(1, [{ id: null, code: 'NF' }]), 1, [{ code: 'NF' }])).toBe(true);
        expect(passesClearance(viewer(1, [{ name: 'Eyes Only' }]), 1, [{ name: 'Eyes Only' }])).toBe(true);
        expect(passesClearance(viewer(1, [{ name: 'Eyes Only' }]), 1, [{ name: 'Other' }])).toBe(false);
        expect(passesClearance(viewer(1, [{ id: undefined, code: null, name: 'Eyes Only' }]), 1, [{ name: 'Eyes Only' }])).toBe(true);
    });

    it('keys are namespaced by kind: an id never matches an equal-looking code or name', () => {
        expect(passesClearance(viewer(1, [{ code: '5' }]), 1, [{ id: 5 }])).toBe(false);
        expect(passesClearance(viewer(1, [{ name: '5' }]), 1, [{ code: '5' }])).toBe(false);
        expect(passesClearance(viewer(1, ['5']), 1, [{ id: 5 }])).toBe(false);
    });

    it('scalar markers (strings/numbers) compare by value', () => {
        expect(passesClearance(viewer(1, ['NOFORN', 'REL']), 1, ['NOFORN'])).toBe(true);
        expect(passesClearance(viewer(1, ['REL']), 1, ['NOFORN'])).toBe(false);
        expect(passesClearance(viewer(1, [5]), 1, ['5'])).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// An unidentifiable marker — an object with no id/code/name, or null/undefined —
// used to key as 'v:[object Object]' / 'v:null', so a malformed marker on the item
// and another on the viewer matched each other and the item was shown.
describe('passesClearance — unidentifiable markers fail closed', () => {
    const UNIDENTIFIABLE: Array<[string, unknown]> = [
        ['an empty object', {}],
        ['an object with no id/code/name', { foo: 'bar' }],
        ['an object whose id/code/name are all null', { id: null, code: null, name: null }],
        ['an object whose id/code/name are all undefined', { id: undefined, code: undefined, name: undefined }],
        ['null', null],
        ['undefined', undefined],
    ];

    it.each(UNIDENTIFIABLE)('an item marker that is %s denies, even when the viewer holds the same malformed marker', (_l, bad) => {
        expect(passesClearance(viewer(5, [bad]), 0, [bad])).toBe(false);
        expect(passesClearance(viewer(5, [{}, { foo: 'bar' }, null, undefined]), 0, [bad])).toBe(false);
    });

    it.each(UNIDENTIFIABLE)('an item marker that is %s denies a viewer holding every well-formed marker', (_l, bad) => {
        const holdsAll = viewer(5, [markerRow(1), markerRow(2), 'NOFORN']);
        expect(passesClearance(holdsAll, 0, [bad])).toBe(false);
        expect(passesClearance(holdsAll, 0, [markerRow(1), bad])).toBe(false);
        expect(passesClearance(holdsAll, 0, [bad, markerRow(1)])).toBe(false);
    });

    it('two DIFFERENT malformed objects no longer collapse to one key', () => {
        expect(passesClearance(viewer(1, [{ foo: 'viewer' }]), 1, [{ bar: 'item' }])).toBe(false);
    });

    it('an unidentifiable VIEWER marker satisfies nothing — not even its old stringified key', () => {
        const junk = viewer(5, [{}, { foo: 'bar' }, null, undefined]);
        expect(passesClearance(junk, 0, ['[object Object]'])).toBe(false);
        expect(passesClearance(junk, 0, ['null'])).toBe(false);
        expect(passesClearance(junk, 0, ['undefined'])).toBe(false);
        expect(passesClearance(viewer(5, [null]), 0, ['null'])).toBe(false);
        expect(passesClearance(viewer(5, [undefined]), 0, ['undefined'])).toBe(false);
        expect(passesClearance(viewer(5, [{}]), 0, ['[object Object]'])).toBe(false);
    });

    it('a viewer\'s unidentifiable entries do not spoil the well-formed markers it also holds', () => {
        const mixed = viewer(2, [{}, null, markerRow(1), undefined, 'NOFORN', { foo: 'bar' }]);
        expect(passesClearance(mixed, 1, [markerRow(1)])).toBe(true);
        expect(passesClearance(mixed, 1, [markerRow(1), 'NOFORN'])).toBe(true);
        expect(passesClearance(mixed, 1, [markerRow(2)])).toBe(false);
    });

    it('falsy-but-real identities still count: id 0, code "0", scalar 0', () => {
        expect(passesClearance(viewer(1, [{ id: 0 }]), 1, [{ id: 0, code: 'Z' }])).toBe(true);
        expect(passesClearance(viewer(1, [{ code: '0' }]), 1, [{ code: '0' }])).toBe(true);
        expect(passesClearance(viewer(1, [0]), 1, [0])).toBe(true);
        expect(passesClearance(viewer(1, [{ id: 0 }]), 1, [{ id: 1 }])).toBe(false);
    });

    it('the stamped Admin and a bypass holder still see an item with unidentifiable markers', () => {
        expect(passesClearance(viewer(0, [], { isSystemAdmin: true }), 3, [{}, null])).toBe(true);
        expect(passesClearance(viewer(0, [], { permissions: ['intel:manage'] }), 3, [{}, null], ['intel:manage'])).toBe(true);
    });

    it('filterByClearance drops an item carrying an unidentifiable marker for an ordinary viewer only', () => {
        const items = [
            { id: 'ok', classificationLevel: 0, limitingMarkers: [markerRow(1)] as unknown[] },
            { id: 'malformed', classificationLevel: 0, limitingMarkers: [{}] as unknown[] },
            { id: 'half', classificationLevel: 0, limitingMarkers: [markerRow(1), null] as unknown[] },
        ];
        const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
        expect(ids(filterByClearance(items, viewer(5, [markerRow(1), {}, null])))).toEqual(['ok']);
        expect(filterByClearance(items, { isSystemAdmin: true })).toBe(items);
        expect(filterByClearance(items, { permissions: ['wiki:x'] }, ['wiki:x'])).toBe(items);
    });
});

// ---------------------------------------------------------------------------
// One level down: a marker whose id/code/name is itself an object still keyed as
// 'id:[object Object]', so two such markers matched; an array or a custom
// toString() could even spell a REAL marker's key. A key part now counts only
// when it is a string or a finite number.
describe('passesClearance — a key part must be a string or a finite number', () => {
    const BAD_PARTS: Array<[string, unknown]> = [
        ['an empty object', {}],
        ['a non-empty object', { a: 1 }],
        ['an empty array', []],
        ['a one-element array', [5]],
        ['an object whose toString() spells 5', { toString: () => '5' }],
        ['a boxed string', new String('5')],
        ['true', true],
        ['false', false],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['a bigint', BigInt(5)],
        ['a symbol', Symbol('5')],
        ['a function', () => 5],
    ];

    for (const field of ['id', 'code', 'name'] as const) {
        it.each(BAD_PARTS)(`an item marker whose only ${field} is %s denies, even when the viewer holds the same value`, (_l, bad) => {
            const marker = { [field]: bad };
            expect(passesClearance(viewer(5, [marker]), 0, [marker])).toBe(false);
            expect(passesClearance(viewer(5, [{ [field]: bad }]), 0, [{ [field]: bad }])).toBe(false);
        });

        it.each(BAD_PARTS)(`a viewer marker whose only ${field} is %s satisfies nothing`, (_l, bad) => {
            const junk = viewer(5, [{ [field]: bad }]);
            expect(passesClearance(junk, 0, [{ [field]: '5' }])).toBe(false);
            expect(passesClearance(junk, 0, [{ [field]: 5 }])).toBe(false);
            expect(passesClearance(junk, 0, [{ [field]: '[object Object]' }])).toBe(false);
            expect(passesClearance(junk, 0, [{ [field]: String(bad as string) }])).toBe(false);
        });
    }

    it('the reported case: two { id: {} } markers no longer match', () => {
        expect(passesClearance(viewer(5, [{ id: {} }]), 0, [{ id: {} }])).toBe(false);
        expect(passesClearance(viewer(5, [{ id: { a: 1 } }]), 0, [{ id: { b: 2 } }])).toBe(false);
        expect(passesClearance(viewer(5, [{ id: {} }]), 0, [{ id: '[object Object]' }])).toBe(false);
    });

    it('an array or toString() id cannot spell a REAL marker\'s key, on either side', () => {
        // Both used to key as 'id:5' and match the well-formed { id: 5 }.
        expect(passesClearance(viewer(5, [{ id: [5] }]), 0, [{ id: 5 }])).toBe(false);
        expect(passesClearance(viewer(5, [{ id: { toString: () => '5' } }]), 0, [{ id: 5 }])).toBe(false);
        expect(passesClearance(viewer(5, [{ id: 5 }]), 0, [{ id: [5] }])).toBe(false);
        expect(passesClearance(viewer(5, [{ id: 5 }]), 0, [{ id: { toString: () => '5' } }])).toBe(false);
    });

    it('an unusable id falls through to code, then name — like an absent one', () => {
        expect(passesClearance(viewer(1, [{ id: {}, code: 'NF' }]), 1, [{ code: 'NF' }])).toBe(true);
        expect(passesClearance(viewer(1, [{ code: 'NF' }]), 1, [{ id: NaN, code: 'NF' }])).toBe(true);
        expect(passesClearance(viewer(1, [{ id: [], code: true, name: 'Eyes Only' }]), 1, [{ name: 'Eyes Only' }])).toBe(true);
        // …and is then namespaced by the part it fell to: a code key never meets an id key.
        expect(passesClearance(viewer(1, [{ id: {}, code: 'NF' }]), 1, [{ id: 1, code: 'NF' }])).toBe(false);
        expect(passesClearance(viewer(1, [{ id: 1, code: 'NF' }]), 1, [{ id: {}, code: 'NF' }])).toBe(false);
    });

    it.each(BAD_PARTS)('a bare marker value that is %s is unidentifiable on either side', (_l, bad) => {
        expect(passesClearance(viewer(5, [bad]), 0, [bad])).toBe(false);
        expect(passesClearance(viewer(5, [bad]), 0, [String(bad as string)])).toBe(false);
        expect(passesClearance(viewer(5, ['NOFORN']), 0, ['NOFORN', bad])).toBe(false);
    });

    it('strings and finite numbers still identify: negative, fractional, zero and the empty string', () => {
        expect(passesClearance(viewer(1, [{ id: -3 }]), 1, [{ id: '-3' }])).toBe(true);
        expect(passesClearance(viewer(1, [{ id: 1.5 }]), 1, [{ id: 1.5 }])).toBe(true);
        expect(passesClearance(viewer(1, [{ id: 0 }]), 1, [{ id: -0 }])).toBe(true);
        expect(passesClearance(viewer(1, [7]), 1, [7])).toBe(true);
        expect(passesClearance(viewer(1, [{ code: '' }]), 1, [{ code: '' }])).toBe(true);
    });

    it('a viewer\'s malformed entries do not spoil the well-formed markers it also holds', () => {
        const mixed = viewer(2, [{ id: {} }, { id: NaN }, true, markerRow(1), { code: [1] }]);
        expect(passesClearance(mixed, 1, [markerRow(1)])).toBe(true);
        expect(passesClearance(mixed, 1, [markerRow(1), { id: {} }])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('filterByClearance', () => {
    const items = [
        { id: 'open', classificationLevel: 0, limitingMarkers: [] as unknown[] },
        { id: 'unset', classificationLevel: null, limitingMarkers: undefined },
        { id: 'secret', classificationLevel: 2, limitingMarkers: [] as unknown[] },
        { id: 'marked', classificationLevel: 1, limitingMarkers: [markerRow(1)] },
        { id: 'top', classificationLevel: 4, limitingMarkers: [markerRow(1), markerRow(2)] },
    ];
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

    it('the Admin gets the very same array back (no copy, nothing dropped)', () => {
        expect(filterByClearance(items, { isSystemAdmin: true })).toBe(items);
    });

    it('a bypass holder gets everything', () => {
        expect(filterByClearance(items, { permissions: ['wiki:x'] }, ['wiki:x'])).toBe(items);
    });

    it('an anonymous/absent viewer sees only unclassified, unmarked items', () => {
        expect(ids(filterByClearance(items, null))).toEqual(['open', 'unset']);
        expect(ids(filterByClearance(items))).toEqual(['open', 'unset']);
    });

    it('applies level and markers per item, preserving order', () => {
        expect(ids(filterByClearance(items, viewer(2)))).toEqual(['open', 'unset', 'secret']);
        expect(ids(filterByClearance(items, viewer(2, [markerRow(1)])))).toEqual(['open', 'unset', 'secret', 'marked']);
        expect(ids(filterByClearance(items, viewer(4, [markerRow(1), markerRow(2)])))).toEqual(['open', 'unset', 'secret', 'marked', 'top']);
        expect(ids(filterByClearance(items, viewer(4, [markerRow(2)])))).toEqual(['open', 'unset', 'secret']);
    });

    it('returns a new array (never mutates the input) when filtering', () => {
        const out = filterByClearance(items, viewer(0));
        expect(out).not.toBe(items);
        expect(items).toHaveLength(5);
    });
});

// ---------------------------------------------------------------------------
describe('assertCanClassify (write-side integrity)', () => {
    const ABOVE = 'You cannot classify content above your own clearance level.';
    const MARKER = 'You cannot apply a limiting marker you do not hold.';

    it('the Admin and a bypass holder may classify at any level with any marker', () => {
        expect(() => assertCanClassify({ isSystemAdmin: true }, 99, [1, 2, 3])).not.toThrow();
        expect(() => assertCanClassify({ permissions: ['intel:manage'] }, 99, ['X'], ['intel:manage'])).not.toThrow();
    });

    it('an author may label at or below their own level, never above', () => {
        expect(() => assertCanClassify(viewer(2), 2)).not.toThrow();
        expect(() => assertCanClassify(viewer(2), 1)).not.toThrow();
        expect(() => assertCanClassify(viewer(2), 3)).toThrow(ABOVE);
    });

    it('a missing viewer is clearance 0 with no markers (fail closed)', () => {
        expect(() => assertCanClassify(null, 0)).not.toThrow();
        expect(() => assertCanClassify(undefined, null)).not.toThrow();
        expect(() => assertCanClassify(null, 1)).toThrow(ABOVE);
        expect(() => assertCanClassify(null, 0, [1])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(null), 1)).toThrow(ABOVE);
    });

    it('null/empty marker lists add no requirement', () => {
        expect(() => assertCanClassify(viewer(0), 0, null)).not.toThrow();
        expect(() => assertCanClassify(viewer(0), 0, [])).not.toThrow();
        expect(() => assertCanClassify(viewer(0), 0, undefined)).not.toThrow();
    });

    it('every applied marker must be held; numeric ids match the held row id by string form', () => {
        const author = viewer(3, [markerRow(5), markerRow(6)]);
        expect(() => assertCanClassify(author, 1, [5, '6'])).not.toThrow();
        expect(() => assertCanClassify(author, 1, [5, 7])).toThrow(MARKER);
    });

    it('held markers without an id are matched by code, then by name', () => {
        expect(() => assertCanClassify(viewer(1, [{ code: 'NF' }]), 0, ['NF'])).not.toThrow();
        expect(() => assertCanClassify(viewer(1, [{ id: null, code: 'NF' }]), 0, ['NF'])).not.toThrow();
        expect(() => assertCanClassify(viewer(1, [{ name: 'Eyes Only' }]), 0, ['Eyes Only'])).not.toThrow();
        expect(() => assertCanClassify(viewer(1, [{ name: 'Eyes Only' }]), 0, ['NF'])).toThrow(MARKER);
    });

    it('held scalar markers count; null/undefined and unidentifiable held entries are ignored', () => {
        expect(() => assertCanClassify(viewer(1, ['NF', 7]), 0, ['NF', 7])).not.toThrow();
        // A null/undefined/empty-object "held" entry must not become a wildcard key.
        expect(() => assertCanClassify(viewer(1, [null, undefined, {}]), 0, ['null'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [null, undefined, {}]), 0, ['undefined'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [null, undefined, {}]), 0, ['[object Object]'])).toThrow(MARKER);
    });

    it('a held marker whose id/code/name is not a string or finite number grants nothing', () => {
        // These used to add '[object Object]', '5', 'NaN' or 'true' to the held set.
        expect(() => assertCanClassify(viewer(1, [{ id: {} }]), 0, ['[object Object]'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [{ id: [5] }]), 0, [5])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [{ id: { toString: () => '5' } }]), 0, ['5'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [{ code: NaN }]), 0, ['NaN'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [{ name: Infinity }]), 0, ['Infinity'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [{ id: true }]), 0, ['true'])).toThrow(MARKER);
    });

    it('a held bare marker value that is not a string or finite number grants nothing', () => {
        expect(() => assertCanClassify(viewer(1, [true]), 0, ['true'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [false]), 0, ['false'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [NaN]), 0, ['NaN'])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [BigInt(5)]), 0, [5])).toThrow(MARKER);
        expect(() => assertCanClassify(viewer(1, [0, '']), 0, [0, ''])).not.toThrow();
    });

    it('a held marker with an unusable id is matched by its code, then its name', () => {
        expect(() => assertCanClassify(viewer(1, [{ id: {}, code: 'NF' }]), 0, ['NF'])).not.toThrow();
        expect(() => assertCanClassify(viewer(1, [{ id: NaN, code: [1], name: 'Eyes Only' }]), 0, ['Eyes Only'])).not.toThrow();
        expect(() => assertCanClassify(viewer(1, [{ id: {}, code: 'NF' }]), 0, ['[object Object]'])).toThrow(MARKER);
    });

    it('null/undefined entries in the APPLIED list are skipped rather than demanded', () => {
        expect(() => assertCanClassify(viewer(1, [markerRow(5)]), 0, [5, null as unknown as number, undefined as unknown as number])).not.toThrow();
        expect(() => assertCanClassify(viewer(1, []), 0, [null as unknown as number])).not.toThrow();
    });

    it('the level check fires before the marker check', () => {
        expect(() => assertCanClassify(viewer(1, []), 2, [99])).toThrow(ABOVE);
    });
});
