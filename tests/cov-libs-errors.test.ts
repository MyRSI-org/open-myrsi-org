import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { isOpaqueServerError, SecurityDenial, isSecurityDenial } from '../lib/errors';
import { stripHtml, stripHtmlSingleLine } from '../lib/textSanitize';

// lib/errors.ts decides which error messages may cross the wire (business copy) and
// which must be replaced by a generic one (DB / system / engine detail), and carries
// the SecurityDenial type the dispatcher turns into a 403. lib/textSanitize.ts is the
// plain-text write-boundary scrubber.

describe('isOpaqueServerError — shapes that must NOT be forwarded', () => {
    it('Supabase PostgrestError (plain object with a code)', () => {
        expect(isOpaqueServerError({ message: 'relation "public.users" does not exist', code: '42P01', details: null, hint: null })).toBe(true);
    });

    it('Node system errors (errno number or syscall string, with or without code)', () => {
        expect(isOpaqueServerError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe(true);
        expect(isOpaqueServerError({ message: 'x', errno: -111 })).toBe(true);
        expect(isOpaqueServerError({ message: 'x', syscall: 'getaddrinfo' })).toBe(true);
    });

    it('Supabase Auth errors by name prefix', () => {
        expect(isOpaqueServerError({ name: 'AuthApiError', message: 'invalid JWT' })).toBe(true);
        expect(isOpaqueServerError({ name: 'AuthError', message: 'x' })).toBe(true);
    });

    it('objects carrying details or hint strings', () => {
        expect(isOpaqueServerError({ message: 'x', details: 'Key (id)=(5) is not present in table "ops".' })).toBe(true);
        expect(isOpaqueServerError({ message: 'x', hint: 'Perhaps you meant to reference the column "users.id".' })).toBe(true);
    });

    it.each([
        ['TypeError', () => new TypeError("Cannot read properties of undefined (reading 'tokensValidFrom')")],
        ['RangeError', () => new RangeError('Invalid array length')],
        ['ReferenceError', () => new ReferenceError('foo is not defined')],
        ['SyntaxError', () => new SyntaxError('Unexpected token < in JSON at position 0')],
        ['EvalError', () => new EvalError('x')],
        ['URIError', () => new URIError('URI malformed')],
        ['AggregateError', () => new AggregateError([new Error('a')], 'All promises were rejected')],
    ])('native engine error %s', (_n, make) => {
        expect(isOpaqueServerError(make())).toBe(true);
    });

    it('a native error that crossed a realm (instanceof false) is caught by NAME', () => {
        const foreign = runInNewContext('new TypeError("fetch failed")') as Error;
        expect(foreign instanceof TypeError).toBe(false);
        expect(isOpaqueServerError(foreign)).toBe(true);
    });

    it('a native error whose NAME was changed is still caught by instanceof (fails closed)', () => {
        const renamed = new TypeError('x.map is not a function');
        Object.defineProperty(renamed, 'name', { value: 'Renamed' });
        expect(isOpaqueServerError(renamed)).toBe(true);
        const agg = new AggregateError([], 'none');
        Object.defineProperty(agg, 'name', { value: 'Custom' });
        expect(isOpaqueServerError(agg)).toBe(true);
    });
});

describe('isOpaqueServerError — business errors that SHOULD reach the client', () => {
    it('a plain Error is forwardable copy', () => {
        expect(isOpaqueServerError(new Error('Only an Admin may perform this action.'))).toBe(false);
    });

    it('a SecurityDenial is forwardable (its message is a contract-safe string)', () => {
        expect(isOpaqueServerError(new SecurityDenial('Not found.'))).toBe(false);
    });

    it('an empty code, non-string details and non-numeric errno do not trigger', () => {
        expect(isOpaqueServerError({ message: 'x', code: '' })).toBe(false);
        expect(isOpaqueServerError({ message: 'x', code: 42, details: null, hint: 0, errno: '5', syscall: 1 })).toBe(false);
        expect(isOpaqueServerError({ name: 'BusinessError', message: 'x' })).toBe(false);
    });

    it('null, undefined and primitives are not "opaque errors"', () => {
        expect(isOpaqueServerError(null)).toBe(false);
        expect(isOpaqueServerError(undefined)).toBe(false);
        expect(isOpaqueServerError('string thrown')).toBe(false);
        expect(isOpaqueServerError(500)).toBe(false);
    });
});

describe('SecurityDenial', () => {
    it('defaults to a 403 with the generic audit slug and empty fields', () => {
        const d = new SecurityDenial('Course does not belong to this organisation.');
        expect(d).toBeInstanceOf(SecurityDenial);
        expect(d).toBeInstanceOf(Error);
        expect(d.name).toBe('SecurityDenial');
        expect(d.message).toBe('Course does not belong to this organisation.');
        expect(d.status).toBe(403);
        expect(d.auditEvent).toBe('authz.denied');
        expect(d.fields).toEqual({});
    });

    it('carries the audit slug, log-only fields and a custom status (including 0 via ??)', () => {
        const d = new SecurityDenial('Not found.', { auditEvent: 'authz.bola.denied', fields: { opId: 'x', userId: 5 }, status: 404 });
        expect(d.auditEvent).toBe('authz.bola.denied');
        expect(d.fields).toEqual({ opId: 'x', userId: 5 });
        expect(d.status).toBe(404);
        expect(d.message).not.toContain('opId');
        expect(new SecurityDenial('x', { status: 0 }).status).toBe(0);
        expect(new SecurityDenial('x', { auditEvent: '' }).auditEvent).toBe('authz.denied');
    });
});

describe('isSecurityDenial', () => {
    it('recognises an instance, and a structural look-alike from another module copy', () => {
        expect(isSecurityDenial(new SecurityDenial('x'))).toBe(true);
        expect(isSecurityDenial({ name: 'SecurityDenial', message: 'x' })).toBe(true);
    });

    it('rejects other errors, null and primitives', () => {
        expect(isSecurityDenial(new Error('SecurityDenial'))).toBe(false);
        expect(isSecurityDenial({ name: 'Denial' })).toBe(false);
        expect(isSecurityDenial(null)).toBe(false);
        expect(isSecurityDenial(undefined)).toBe(false);
        expect(isSecurityDenial('SecurityDenial')).toBe(false);
    });
});

describe('textSanitize', () => {
    it('stripHtml removes tags and C0/DEL controls, keeps tabs/newlines, trims and caps', () => {
        expect(stripHtml('  <b>bold</b>\tx\ny\u0000\u0007\u007f<img src=x onerror=alert(1)>  ', 100)).toBe('bold\tx\ny');
        expect(stripHtml('abcdef', 3)).toBe('abc');
        expect(stripHtml('héllo — ✓', 50)).toBe('héllo — ✓');
    });

    it('stripHtmlSingleLine also collapses newlines/tabs/whitespace runs to one space', () => {
        expect(stripHtmlSingleLine(' <i>Title</i>\r\n\tline   two\u0001 ', 100)).toBe('Title line two');
        expect(stripHtmlSingleLine('abcdef', 4)).toBe('abcd');
    });

    it('both return "" for non-strings', () => {
        expect(stripHtml(null, 10)).toBe('');
        expect(stripHtml({ toString: () => '<b>' }, 10)).toBe('');
        expect(stripHtmlSingleLine(undefined, 10)).toBe('');
        expect(stripHtmlSingleLine(42, 10)).toBe('');
    });
});
