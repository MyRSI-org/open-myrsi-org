import { describe, it, expect } from 'vitest';
import { isOpaqueServerError, SecurityDenial } from '../lib/errors';

describe('isOpaqueServerError', () => {
    it('flags Supabase PostgrestError shape (string code)', () => {
        expect(isOpaqueServerError({
            message: 'column "deleted_at_at" does not exist',
            code: 'PGRST204',
            details: null,
            hint: null,
        })).toBe(true);
    });

    it('flags Supabase AuthError by name', () => {
        const err = Object.assign(new Error('Invalid JWT'), { name: 'AuthError' });
        expect(isOpaqueServerError(err)).toBe(true);
    });

    it('flags AuthApiError variant', () => {
        const err = Object.assign(new Error('rate limit'), { name: 'AuthApiError' });
        expect(isOpaqueServerError(err)).toBe(true);
    });

    it('flags Node system errors (ECONNREFUSED)', () => {
        const err = Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
            errno: -111,
            syscall: 'connect',
        });
        expect(isOpaqueServerError(err)).toBe(true);
    });

    it('flags errors with a details string (PostgrestError variant)', () => {
        expect(isOpaqueServerError({
            message: 'duplicate key',
            details: 'Key (email)=(x@y) already exists.',
        })).toBe(true);
    });

    it('does NOT flag plain user-facing Error', () => {
        expect(isOpaqueServerError(new Error('Alliance not found'))).toBe(false);
    });

    it('does NOT flag Error with no structured fields', () => {
        expect(isOpaqueServerError(new Error('Account name is required.'))).toBe(false);
    });

    it('does NOT flag null/undefined/primitives', () => {
        expect(isOpaqueServerError(null)).toBe(false);
        expect(isOpaqueServerError(undefined)).toBe(false);
        expect(isOpaqueServerError('a string')).toBe(false);
        expect(isOpaqueServerError(42)).toBe(false);
    });

    it('does NOT flag a code field that is not a string', () => {
        expect(isOpaqueServerError({ message: 'x', code: 42 })).toBe(false);
    });

    it('does NOT flag a code field that is an empty string', () => {
        expect(isOpaqueServerError({ message: 'x', code: '' })).toBe(false);
    });
});

describe('isOpaqueServerError — native engine errors are opaque', () => {
    // A bare native error carries no code/errno/details/hint, so it used to fall
    // through every arm and the dispatcher forwarded V8's machine-generated text
    // — built out of OUR identifiers — to the caller, unauthenticated included.
    it('flags the exact leak shape (property read on undefined)', () => {
        expect(isOpaqueServerError(
            new TypeError("Cannot read properties of undefined (reading 'tokensValidFrom')")
        )).toBe(true);
    });

    it('flags every native engine constructor', () => {
        const natives = [
            new TypeError('x.map is not a function'),
            new RangeError('Invalid array length'),
            new ReferenceError('supabse is not defined'),
            new SyntaxError('Unexpected token < in JSON at position 0'),
            new EvalError('nope'),
            new URIError('URI malformed'),
            new AggregateError([new Error('a')], 'All promises were rejected'),
        ];
        for (const err of natives) {
            expect(isOpaqueServerError(err), `${err.name} must be opaque`).toBe(true);
        }
    });

    it('flags a cross-realm native error by name (undici TypeError: fetch failed)', () => {
        // instanceof is false across a realm/vm boundary — the name check is what
        // holds there, which is why both checks exist.
        expect(isOpaqueServerError({ name: 'TypeError', message: 'fetch failed' })).toBe(true);
    });

    it('does NOT flag the business-error idiom — plain Error copy still reaches the client', () => {
        const businessCopy = [
            'Only an Admin may perform this action.',
            'Role not found',
            'Cannot delete protected system roles.',
            'The Client role is locked. Its permissions cannot be modified.',
            'Import file too large (max 64 MB).',
            'Unauthorized',
            'Missing authorization code from Discord.',
        ];
        for (const msg of businessCopy) {
            expect(isOpaqueServerError(new Error(msg)), msg).toBe(false);
        }
    });

    it('does NOT flag SecurityDenial — its message IS the client copy', () => {
        expect(isOpaqueServerError(
            new SecurityDenial('Course does not belong to this organisation.', { auditEvent: 'authz.cross_org.denied' })
        )).toBe(false);
    });
});
