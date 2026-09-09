import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { stripComments } from './stripComments';

// USER-EMBED COLUMN RATCHET (security / data-minimisation rule).
//
// A `users` EMBED — `author:users!created_by(...)`, `owner:users(...)` — rides inside
// somebody else's row. It is NOT covered by the roster projection constants, it is NOT
// narrowed by lib/db/mappers.ts blankSensitiveUserFields (a bespoke return shape has no
// minifier at all), and /api/services applies no user-field minimisation to a handler
// result. So the columns an embed names are the columns that reach the browser.
//
// SCOPE — READ THIS BEFORE ASSUMING MORE COVERAGE THAN EXISTS. This ratchet governs
// `users` EMBEDS only. The three top-level `.from('users').select(CONST)` projections
// produce ZERO embed groups here (none of `user_specializations(`,
// `user_certifications!`, `user_commendations!`, `security_clearances(` contains the
// token `users`), so their own column lists are pinned directly by
// tests/rosterSelectProjection.test.ts, not here.
//
// THE ANCHORING REQUIREMENT IS THE WHOLE DESIGN. tests/wildcardSelectRatchet.test.ts
// resolves each `.select(...)` argument to a WHOLE string and tests that string. A naive
// port asks "does this resolved select contain a `users!` embed AND a forbidden column
// anywhere?" — which is TRUE of USER_SELECT_QUERY, because that single template literal
// holds three real `users!` embeds alongside `role_permissions(...)`,
// `clearance_level:security_clearances(...)` and `limiting_markers:...`. A whole-string
// test reports a false positive and fails CI on a correct file. So: find each `users`
// embed head inside the resolved string and test ONLY that head's own balanced
// parenthesis group. Fixture 12 below pins exactly that.
//
// THE BASELINE IS EMPTY, and it is measured, not assumed. Do not add an allow-list.

const ROOT = resolve(__dirname, '..');

/** Columns that must never appear inside a `users` embed body. */
const FORBIDDEN = [
    'discord_id', 'admin_notes', 'personnel_notes', 'clearance_level', 'limiting_markers',
    'role_permissions', 'job_title', 'voice_channel_name', 'timezone', 'date_format',
    'probation_start', 'probation_end', 'tenure_start_date', 'tokens_valid_from',
    'rsi_verified', 'rsi_verification_code', 'rsi_handle_pending', 'auth_user_id',
];

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel, acc);
        else if (entry.name.endsWith('.ts')) acc.push(rel);
    }
    return acc;
}

// Shared helper — the local version here had the same blanking bug that blinded the
// wildcard-select ratchet over 820 lines of lib/db/system.ts.

const STRING_LITERAL = /^(`[^`]*`|'[^']*'|"[^"]*")$/;
const CONST_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
const OBJ_PROP = /([A-Za-z_$][\w$]*)\s*:\s*(`[^`]*`|'[^']*'|"[^"]*")/g;

function extractSelectArgs(src: string): string[] {
    const NEEDLE = '.select(';
    const out: string[] = [];
    let i = 0;
    while ((i = src.indexOf(NEEDLE, i)) !== -1) {
        let j = i + NEEDLE.length;
        const start = j;
        let depth = 0;
        let quote: string | null = null;
        for (; j < src.length; j++) {
            const c = src[j];
            if (quote) {
                if (c === '\\') { j++; continue; }
                if (c === quote) quote = null;
                continue;
            }
            if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
            if (c === '(' || c === '[' || c === '{') { depth++; continue; }
            if (c === ')' && depth === 0) break;
            if (c === ')' || c === ']' || c === '}') { depth--; continue; }
            if (c === ',' && depth === 0) break;
        }
        out.push(src.slice(start, j).trim());
        i = j;
    }
    return out;
}

/**
 * A `users` embed head: `:users(` / `users!<fk>(` / a bare `users(`. The negative
 * lookbehind excludes every look-alike in the tree — user_certifications!,
 * user_commendations!, user_specializations(, user_limiting_markers(, user_presence,
 * user_hr_position_history — none of which contains the token `users` followed by
 * `!` or `(`.
 */
const USERS_EMBED = /(?<![A-Za-z0-9_])users(?:!([A-Za-z0-9_]+))?\(/g;

/** The OWN column list of each `users` embed inside a resolved select string. */
export function usersEmbedBodies(select: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    USERS_EMBED.lastIndex = 0;
    while ((m = USERS_EMBED.exec(select)) !== null) {
        let i = m.index + m[0].length;
        const start = i;
        let depth = 0;
        for (; i < select.length; i++) {
            const c = select[i];
            if (c === '(') depth++;
            else if (c === ')') { if (depth === 0) break; depth--; }
        }
        out.push(select.slice(start, i));
        USERS_EMBED.lastIndex = i;
    }
    return out;
}

const files = [...walk('lib'), ...walk('api')];
const sources: Record<string, string> = {};
for (const rel of files) {
    sources[rel] = stripComments(readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8'));
}

const fileConsts: Record<string, Record<string, string>> = {};
const fileProps: Record<string, Record<string, string[]>> = {};
const globalConsts: Record<string, string> = {};
const globalProps: Record<string, string[]> = {};

for (const rel of files) {
    fileConsts[rel] = {};
    fileProps[rel] = {};
    let m: RegExpExecArray | null;
    CONST_DECL.lastIndex = 0;
    while ((m = CONST_DECL.exec(sources[rel])) !== null) {
        fileConsts[rel][m[1]] = m[2];
        if (!(m[1] in globalConsts)) globalConsts[m[1]] = m[2];
    }
    OBJ_PROP.lastIndex = 0;
    while ((m = OBJ_PROP.exec(sources[rel])) !== null) {
        (fileProps[rel][m[1]] ||= []).push(m[2]);
        (globalProps[m[1]] ||= []).push(m[2]);
    }
}

function resolveSelectArg(rel: string, arg: string): string[] | null {
    if (STRING_LITERAL.test(arg)) return [arg];
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
        const v = fileConsts[rel]?.[arg] ?? globalConsts[arg];
        return v === undefined ? null : [v];
    }
    const qualified = arg.match(/^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$/);
    if (qualified) {
        const prop = qualified[1];
        const vals = fileProps[rel]?.[prop] ?? globalProps[prop];
        if (vals) return vals;
        const v = fileConsts[rel]?.[prop] ?? globalConsts[prop];
        return v === undefined ? null : [v];
    }
    return null;
}

const offenders: string[] = [];
let embedGroupsScanned = 0;

for (const rel of files) {
    for (const arg of extractSelectArgs(sources[rel])) {
        const resolved = resolveSelectArg(rel, arg);
        // Unresolvable select arguments are the wildcard ratchet's problem, not this
        // file's — it already fails CI on any new one.
        if (resolved === null) continue;
        for (const value of resolved) {
            for (const body of usersEmbedBodies(value)) {
                embedGroupsScanned++;
                for (const col of FORBIDDEN) {
                    if (new RegExp(`(?<![A-Za-z0-9_])${col}(?![A-Za-z0-9_])`).test(body)) {
                        offenders.push(`${rel}: users(${body.trim()}) -> ${col}`);
                    }
                }
            }
        }
    }
}

describe('users-embed column ratchet (lib/** + api/**)', () => {
    it('9. no `users` embed selects a privileged column', () => {
        // blankSensitiveUserFields is now an allow-list rebuild, so a widened embed no
        // longer leaks through the minifier — but a bespoke return shape (the HR
        // eligibility RPCs' shape, for instance) has NO minifier at all, and the
        // dispatcher applies none to a handler result.
        expect(offenders, offenders.join('\n')).toEqual([]);
    });

    it('10. TG5 negative fixture — the scanner actually FIRES', () => {
        // An empty-baseline ratchet that matches nothing passes green and protects
        // nothing. This is the proof that it does not.
        const bodies = usersEmbedBodies('author:users!created_by(id, discord_id, name)');
        expect(bodies).toEqual(['id, discord_id, name']);
        expect(bodies.some(b => /(?<![A-Za-z0-9_])discord_id(?![A-Za-z0-9_])/.test(b))).toBe(true);
    });

    it('11. TG5 positive fixtures — the `user…` look-alikes are NOT matched', () => {
        for (const s of [
            'user_certifications!user_id(awarded_at)',
            'user_commendations!user_id(id)',
            'user_specializations(specialization:x(id))',
            'user_limiting_markers(marker:y(id))',
            'user_presence(last_seen)',
            'user_hr_position_history(id)',
        ]) {
            expect(usersEmbedBodies(s), s).toEqual([]);
        }
    });

    it('12. TG5 / A9 anchoring fixture — a USER_SELECT_QUERY shape PASSES', () => {
        // The false positive a whole-resolved-string test would produce, pinned as a
        // fixture so a later "simplification" back to whole-string testing fails here
        // rather than failing CI on a correct source file.
        const shape = `
            id, name,
            role:roles!inner(id, name, role_permissions(permission:permissions(name))),
            clearance_level:security_clearances(id, level, name),
            limiting_markers:user_limiting_markers(marker:m(id)),
            awardedBy:users!awarded_by(id, name, avatar_url)
        `;
        const bodies = usersEmbedBodies(shape);
        expect(bodies).toEqual(['id, name, avatar_url']);
        for (const body of bodies) {
            for (const col of FORBIDDEN) {
                expect(new RegExp(`(?<![A-Za-z0-9_])${col}(?![A-Za-z0-9_])`).test(body), `${col} in ${body}`).toBe(false);
            }
        }
    });

    it('13. scanner liveness — a path or regex change that stops matching must TRIP', () => {
        // Same purpose as the wildcard ratchet's last test: a clean run over zero embeds
        // is indistinguishable from a clean tree unless the scan is proved live.
        expect(files.length).toBeGreaterThan(80);
        expect(embedGroupsScanned).toBeGreaterThan(100);
    });
});
