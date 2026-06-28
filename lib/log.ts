// Thin in-house structured logger. Emits one JSON line per log record to
// stdout (debug/info) or stderr (warn/error). No external dependency — the
// repo's hot paths are few enough that a 60-line wrapper around process.std*
// is preferable to pulling in pino/winston for this scope.
//
// Usage:
//   import { log } from './lib/log.js';
//   log.info('hello', { userId: 42 });
//   const reqLog = log.child({ requestId: 'abc123' });
//   reqLog.error('failed', { err: new Error('boom') });
//
// Levels respect LOG_LEVEL (default 'info'). 'silent' disables all output —
// useful for tests. Errors passed under `err` are serialized as
// { name, message, stack } rather than the empty `{}` JSON.stringify
// produces for Error instances.

export type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<Level, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
};

function parseLevel(raw: string | undefined): number {
    if (!raw) return LEVELS.info;
    const norm = raw.toLowerCase() as Level;
    return LEVELS[norm] ?? LEVELS.info;
}

let minLevel = parseLevel(process.env.LOG_LEVEL);

/** Re-read LOG_LEVEL from process.env. Exposed for tests that mutate env. */
export function refreshLogLevel(): void {
    minLevel = parseLevel(process.env.LOG_LEVEL);
}

export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    /** Return a new logger that includes `context` on every record. */
    child(context: Record<string, unknown>): Logger;
}

// Any field whose name looks like a secret (top-level or nested) is replaced with
// '[REDACTED]' before it's written. Callers should still avoid logging secrets;
// this is a backstop so one stray log.error('x', { botToken }) can't dump a
// credential into the logs. The walk is depth-bounded, but the bound fails closed
// (a subtree past the cap is redacted wholesale rather than emitted raw) and
// free-form strings (Error message/stack, stringified instances) are value-scanned.
const SECRET_KEY_RE = /(authorization|secret|password|cookie|token|api[_-]?key|client[_-]?secret|bot[_-]?token|private[_-]?key|credential)/i;
const REDACT_MAX_DEPTH = 8;

// Matches a secret-looking value embedded in a free-form string — e.g. a token
// pasted into an Error message/stack, or a credential carried on a stringified
// instance. Catches `Bearer <tok>` and `<keyword><sep><value>` (optionally a
// bearer token), so the value (not just the label) is removed. Global so every
// occurrence in the string is scrubbed.
const SECRET_VALUE_RE = /\b(?:bearer\s+[^\s]+|(?:authorization|api[_-]?key|client[_-]?secret|bot[_-]?token|private[_-]?key|secret|password|token|credential)[\s:="']+(?:bearer\s+)?[^\s,;]+)/gi;

function scrubSecretValues(s: string): string {
    return s.replace(SECRET_VALUE_RE, '[REDACTED]');
}

function isPlainObject(v: object): boolean {
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function serializeField(v: unknown, depth = 0): unknown {
    if (v instanceof Error) {
        // Error strings can carry a credential (e.g. an upstream "401: Bearer …"
        // body); scrub the value-patterns out of both message and stack.
        return {
            name: v.name,
            message: scrubSecretValues(v.message),
            stack: typeof v.stack === 'string' ? scrubSecretValues(v.stack) : v.stack,
        };
    }
    if (v && typeof v === 'object') {
        // Past the cap, never emit a raw subtree (it could still hold secret-named
        // keys) — collapse it to a sentinel. This also bounds cyclic structures.
        if (depth >= REDACT_MAX_DEPTH) return '[REDACTED:depth]';
        if (Array.isArray(v)) return v.map((item) => serializeField(item, depth + 1));
        if (isPlainObject(v as object)) {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
                out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : serializeField(val, depth + 1);
            }
            return out;
        }
        // Date/Buffer keep their native JSON form. Any other non-plain object
        // (Map/Set/class instance) is coerced to a scrubbed string so an own-property
        // secret can't ride along untouched via JSON.stringify.
        if (v instanceof Date) return v;
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v;
        return scrubSecretValues(String(v));
    }
    return v;
}

function emit(level: Exclude<Level, 'silent'>, context: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < minLevel) return;
    const record: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...context,
    };
    if (fields) {
        for (const k of Object.keys(fields)) {
            record[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : serializeField(fields[k]);
        }
    }
    const line = JSON.stringify(record) + '\n';
    if (level === 'warn' || level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
}

function createLogger(context: Record<string, unknown>): Logger {
    return {
        debug: (msg, fields) => emit('debug', context, msg, fields),
        info: (msg, fields) => emit('info', context, msg, fields),
        warn: (msg, fields) => emit('warn', context, msg, fields),
        error: (msg, fields) => emit('error', context, msg, fields),
        child(more) {
            return createLogger({ ...context, ...more });
        },
    };
}

/** Root logger. Modules should `log.child({ module: 'name' })` rather than mutate this. */
export const log: Logger = createLogger({});
