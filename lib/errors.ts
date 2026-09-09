// Server-side error classification for the RPC 500 catch-all.
//
// The dispatcher currently passes `error.message` straight to the client.
// That's safe for the codebase's intentional `throw new Error('User-friendly
// copy')` pattern, but it leaks schema names, query fragments, and Postgres
// constraint names when a raw Supabase error or a Node system error bubbles
// up. This module identifies the unsafe shapes so the dispatcher can replace
// their message with a generic one before responding.

interface MaybeStructuredError {
    code?: unknown;
    details?: unknown;
    hint?: unknown;
    name?: unknown;
    errno?: unknown;
    syscall?: unknown;
}

/**
 * Native engine error constructors. Their `message` is machine-generated V8 text
 * built out of OUR identifiers — "Cannot read properties of undefined (reading
 * 'tokensValidFrom')", "x.map is not a function", "Unexpected token < in JSON at
 * position 0". That is a crash report, never deliberate user-facing copy: nothing
 * in this repo throws one on purpose, so forwarding the message only ever hands a
 * caller a description of an internal failure.
 *
 * Matched by NAME first so it still holds for an error that crossed a realm/vm
 * boundary (undici's `TypeError: fetch failed`, a worker thread) where instanceof
 * is false; instanceof is then checked as a fallback so an engine or transpiler
 * that reports a different `name` still fails CLOSED.
 *
 * Deliberately NOT listed: plain `Error`. `throw new Error('user-facing copy')` is
 * this codebase's business-error idiom ('Only an Admin may perform this action.',
 * 'Role not found', 'Import file too large (max 64 MB).') and must keep reaching
 * the client — that, and SecurityDenial (whose `name` is its own), are why this is
 * a name allowlist rather than "anything that isn't Error.prototype".
 */
const NATIVE_ENGINE_ERROR_NAMES: ReadonlySet<string> = new Set([
    'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError',
]);

/**
 * Return true when `e` looks like a Supabase PostgrestError/AuthError, a Node
 * system error, or a native engine error (TypeError & friends) — anything whose
 * `message` may include schema/SQL/infra detail, or our own identifiers, that we
 * don't want to forward to clients. Heuristic, not exhaustive:
 * matches against the structural shape of the error rather than instanceof,
 * because Supabase errors are plain objects (not Error subclasses) when they
 * bubble through `throw error;`.
 */
export function isOpaqueServerError(e: unknown): boolean {
    if (e == null || typeof e !== 'object') return false;
    const err = e as MaybeStructuredError;

    // Supabase PostgrestError: { message, code: 'PGRST...', details, hint }
    // Supabase AuthError: { name: 'AuthError' | 'AuthApiError', ... }
    // Node system error (DNS/socket/fs): { code: 'ECONNREFUSED' | ..., errno, syscall }
    if (typeof err.code === 'string' && err.code.length > 0) return true;
    if (typeof err.errno === 'number' || typeof err.syscall === 'string') return true;
    if (typeof err.name === 'string' && err.name.startsWith('Auth')) return true;
    if (typeof err.details === 'string' || typeof err.hint === 'string') return true;

    // Native engine errors — a bug in OUR code, not a message for the caller. A
    // bare TypeError carries no code/errno/details, so without this every
    // "Cannot read properties of undefined (reading 'x')" was forwarded verbatim.
    if (typeof err.name === 'string' && NATIVE_ENGINE_ERROR_NAMES.has(err.name)) return true;
    if (
        e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError ||
        e instanceof SyntaxError || e instanceof EvalError || e instanceof URIError ||
        e instanceof AggregateError
    ) return true;

    return false;
}

/**
 * An authorization/BOLA denial raised by the db layer when a caller tries to act
 * on (or read) a resource they don't own or aren't cleared for. Distinct from a
 * plain `throw new Error(...)`: the dispatcher translates a SecurityDenial into a
 * 403 (not a 500) and audit-logs `auditEvent` + `fields` server-side, while only
 * the human-readable `message` crosses the wire.
 *
 * CONTRACT: `message` must be a safe, generic client string (e.g. "Course does
 * not belong to this organisation.") — never a schema name, id, or SQL fragment.
 * Put ids and diagnostic context in `fields` (log-only, never returned). Keep the
 * message OPAQUE across not-found vs not-authorised so it can't be used as an
 * existence oracle (a foreign id and a missing id must read identically).
 */
export interface SecurityDenialOptions {
    /** Audit event slug for the server log (e.g. 'authz.cross_org.denied'). */
    auditEvent?: string;
    /** Diagnostic context for the log ONLY — never returned to the client. */
    fields?: Record<string, unknown>;
    /** HTTP status the dispatcher should return (default 403). */
    status?: number;
}

export class SecurityDenial extends Error {
    readonly auditEvent: string;
    readonly fields: Record<string, unknown>;
    readonly status: number;

    constructor(clientMessage: string, options: SecurityDenialOptions = {}) {
        super(clientMessage);
        this.name = 'SecurityDenial';
        this.auditEvent = options.auditEvent || 'authz.denied';
        this.fields = options.fields || {};
        this.status = options.status ?? 403;
        // Preserve the prototype chain so `instanceof SecurityDenial` holds after
        // transpilation (extending built-ins under some targets otherwise breaks it).
        Object.setPrototypeOf(this, SecurityDenial.prototype);
    }
}

/** Type guard for the dispatcher's catch block (survives cross-module identity). */
export function isSecurityDenial(e: unknown): e is SecurityDenial {
    return e instanceof SecurityDenial || (typeof e === 'object' && e != null && (e as { name?: unknown }).name === 'SecurityDenial');
}
