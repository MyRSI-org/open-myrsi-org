import { describe, it, expect } from 'vitest';
import { safeSearchTerm, clampListOffset, MAX_LIST_OFFSET } from '../lib/pgrest';
import { sanitizeRichHtml } from '../lib/htmlSanitize';
import { isSessionForceLoggedOut, isSessionRevokedByWatermark, type AuthToken } from '../lib/auth';
import { constantTimeEqual } from '../api/actions/auth';

// Pure-helper tests.

describe('safeSearchTerm (L8 — PostgREST .or() injection guard)', () => {
    it('strips the structural metacharacters that break out of .or() grammar', () => {
        // commas/parens/dots are .or() structure; an under-escaped term could
        // inject sibling OR conditions, so the allow-list removes them.
        expect(safeSearchTerm('a,is_internal.eq.false')).toBe('ais_internaleqfalse');
        expect(safeSearchTerm('x),(or(y')).toBe('xory');
        expect(safeSearchTerm('na%me_*')).toBe('name_'); // % and * stripped, _ kept
    });
    it('keeps benign alphanumerics, spaces, underscore, hyphen', () => {
        expect(safeSearchTerm('Star Citizen_2-A')).toBe('Star Citizen_2-A');
    });
    it('caps length and handles non-strings', () => {
        expect(safeSearchTerm('a'.repeat(500)).length).toBe(100);
        expect(safeSearchTerm(null)).toBe('');
        expect(safeSearchTerm(undefined)).toBe('');
        expect(safeSearchTerm(123 as unknown)).toBe('');
    });
});

describe('sanitizeRichHtml (L6 — write-side defense-in-depth strip)', () => {
    it('removes <script>/<style>/<iframe> blocks', () => {
        const out = sanitizeRichHtml('<p>ok</p><script>steal()</script><style>x</style><iframe src=x></iframe>');
        expect(out).toContain('<p>ok</p>');
        expect(out.toLowerCase()).not.toContain('<script');
        expect(out.toLowerCase()).not.toContain('<style');
        expect(out.toLowerCase()).not.toContain('<iframe');
        expect(out).not.toContain('steal()');
    });
    it('strips inline event-handler attributes', () => {
        const out = sanitizeRichHtml('<img src="x" onerror="alert(1)"><div onclick="evil()">hi</div>');
        expect(out.toLowerCase()).not.toContain('onerror');
        expect(out.toLowerCase()).not.toContain('onclick');
    });
    it('neutralises javascript:/vbscript: URLs', () => {
        const out = sanitizeRichHtml('<a href="javascript:alert(1)">x</a><a href="vbscript:msgbox">y</a>');
        expect(out.toLowerCase()).not.toContain('javascript:');
        expect(out.toLowerCase()).not.toContain('vbscript:');
    });
    it('preserves benign formatting + handles non-strings', () => {
        expect(sanitizeRichHtml('<h2>Terms</h2><p><strong>bold</strong> <a href="https://ok.example">link</a></p>'))
            .toContain('<strong>bold</strong>');
        expect(sanitizeRichHtml(null)).toBe('');
        expect(sanitizeRichHtml(42 as unknown)).toBe('');
    });
});

describe('isSessionForceLoggedOut (L13 — shared force-logout predicate)', () => {
    const SEVEN_D = 7 * 24 * 60 * 60 * 1000;
    const tokenIssuedAt = (iso: string): AuthToken => ({ userId: 1, exp: new Date(iso).getTime() + SEVEN_D });

    it('revokes a session issued BEFORE the force-logout timestamp', () => {
        expect(isSessionForceLoggedOut(tokenIssuedAt('2026-01-01T00:00:00.000Z'), '2026-06-01T00:00:00.000Z')).toBe(true);
    });
    it('allows a session issued AFTER the force-logout timestamp', () => {
        expect(isSessionForceLoggedOut(tokenIssuedAt('2026-06-05T00:00:00.000Z'), '2026-06-01T00:00:00.000Z')).toBe(false);
    });
    it('allows when no force-logout is set', () => {
        expect(isSessionForceLoggedOut(tokenIssuedAt('2026-06-05T00:00:00.000Z'), null)).toBe(false);
        expect(isSessionForceLoggedOut(tokenIssuedAt('2026-06-05T00:00:00.000Z'), undefined)).toBe(false);
    });
});

describe('isSessionRevokedByWatermark (shared per-user revocation predicate)', () => {
    const SEVEN_D = 7 * 24 * 60 * 60 * 1000;
    const tokenIssuedAt = (iso: string): AuthToken => ({ userId: 1, exp: new Date(iso).getTime() + SEVEN_D });

    it('revokes a session issued BEFORE the user tokens_valid_from watermark', () => {
        expect(isSessionRevokedByWatermark(tokenIssuedAt('2026-01-01T00:00:00.000Z'), '2026-06-01T00:00:00.000Z')).toBe(true);
    });
    it('allows a session issued AFTER the watermark', () => {
        expect(isSessionRevokedByWatermark(tokenIssuedAt('2026-06-05T00:00:00.000Z'), '2026-06-01T00:00:00.000Z')).toBe(false);
    });
    it('fails OPEN when no watermark is set (signature is the real gate)', () => {
        expect(isSessionRevokedByWatermark(tokenIssuedAt('2026-06-05T00:00:00.000Z'), null)).toBe(false);
        expect(isSessionRevokedByWatermark(tokenIssuedAt('2026-06-05T00:00:00.000Z'), undefined)).toBe(false);
    });
});

describe('clampListOffset (DoS clamp on client-supplied list offset)', () => {
    it('passes through a normal offset unchanged', () => {
        expect(clampListOffset(0)).toBe(0);
        expect(clampListOffset(250)).toBe(250);
    });
    it('caps a pathological deep offset at MAX_LIST_OFFSET', () => {
        expect(clampListOffset(1_000_000_000)).toBe(MAX_LIST_OFFSET);
    });
    it('collapses negative / non-finite / non-numeric to 0 and floors fractions', () => {
        expect(clampListOffset(-5)).toBe(0);
        expect(clampListOffset(Infinity)).toBe(0);
        expect(clampListOffset(NaN)).toBe(0);
        expect(clampListOffset(undefined)).toBe(0);
        expect(clampListOffset('500' as unknown)).toBe(0);
        expect(clampListOffset(12.9)).toBe(12);
    });
});

describe('constantTimeEqual (L4 — setup-code compare)', () => {
    it('matches equal strings and rejects different ones (length-independent)', () => {
        expect(constantTimeEqual('SETUP-abc123', 'SETUP-abc123')).toBe(true);
        expect(constantTimeEqual('SETUP-abc123', 'SETUP-xyz789')).toBe(false);
        expect(constantTimeEqual('short', 'a-much-longer-value')).toBe(false); // no length-leak / no throw
        expect(constantTimeEqual('', '')).toBe(true);
    });
});
