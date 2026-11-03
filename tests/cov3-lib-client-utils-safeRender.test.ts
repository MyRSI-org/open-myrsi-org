import { describe, it, expect } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { safe, safeString } from '../lib/safeRender';

// lib/safeRender.ts — the containment helpers the intel bulletin views
// (components/modals/BulletinDetailModal.tsx, components/views/intel/BulletinCard.tsx) wrap
// around externally-sourced fields. A bulletin field that arrives as an object (federated
// payload drift, a JSON column) would otherwise crash the whole view with React error #300
// ("Objects are not valid as a React child"). The contract: objects never reach React,
// legitimate primitives (including falsy ones like 0 and '') pass through untouched.

describe('safe — React child containment', () => {
    it('contains an object field that would otherwise crash the render', () => {
        const hostile = { $$typeof: 'nope', title: 'x' } as unknown as ReactNode;
        expect(() => renderToStaticMarkup(createElement('span', null, hostile))).toThrow(/Objects are not valid as a React child/);
        expect(renderToStaticMarkup(createElement('span', null, safe(hostile, '—')))).toBe('<span>—</span>');
    });

    it('returns the fallback for objects and arrays, never "[object Object]"', () => {
        expect(safe({ a: 1 })).toBe('');
        expect(safe({ a: 1 }, 'n/a')).toBe('n/a');
        expect(safe(['a', 'b'], 'n/a')).toBe('n/a');
        expect(safe(new Date(0), 'n/a')).toBe('n/a');
    });

    it('returns the fallback for null and undefined (default empty string)', () => {
        expect(safe(null)).toBe('');
        expect(safe(undefined)).toBe('');
        expect(safe(null, 'Unknown')).toBe('Unknown');
        expect(safe(undefined, 'Unknown')).toBe('Unknown');
    });

    it('passes legitimate primitives through unchanged, including falsy ones', () => {
        expect(safe('High')).toBe('High');
        expect(safe(42)).toBe(42);
        expect(safe(0, 'fallback')).toBe(0);
        expect(safe('', 'fallback')).toBe('');
    });

    it('renders a plain string field as escaped text', () => {
        expect(renderToStaticMarkup(createElement('h3', null, safe('<b>Hostile</b>')))).toBe('<h3>&lt;b&gt;Hostile&lt;/b&gt;</h3>');
    });
});

describe('safeString — state initialisation from external data', () => {
    it('keeps strings and stringifies numbers', () => {
        expect(safeString('Port Olisar')).toBe('Port Olisar');
        expect(safeString('')).toBe('');
        expect(safeString('  padded value \n')).toBe('  padded value \n'); // returned verbatim, not normalised
        expect(safeString(0)).toBe('0');
        expect(safeString(12.5)).toBe('12.5');
    });

    it('returns the fallback for every non-string, non-number value', () => {
        for (const v of [null, undefined, true, false, { a: 1 }, ['x'], () => 'x']) {
            expect(safeString(v)).toBe('');
            expect(safeString(v, 'fb')).toBe('fb');
        }
    });
});
