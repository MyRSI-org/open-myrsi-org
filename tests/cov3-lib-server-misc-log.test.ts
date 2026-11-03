// @vitest-environment node
//
// lib/log.ts is the auto-redaction BACKSTOP behind Security rule 5 ("never log or
// return secrets"). These tests pin, on the exact JSON line written to
// stdout/stderr (and on redactFields, the same walk reused by the security_events
// audit sink):
//   - every key shape SECRET_KEY_RE is meant to catch, top-level / nested / in arrays,
//     plus near-miss keys that must NOT be redacted (over-redaction hides real data);
//   - the depth cap's exact boundary and that it fails closed;
//   - Error serialisation under `err` (only name/message/stack — never own props)
//     with value-scrubbing of the message and stack;
//   - non-plain objects (Map / class instance) coerced to a scrubbed string, while
//     Date and Buffer keep their JSON form;
//   - LOG_LEVEL parsing and child-logger context, including redaction of the child
//     context itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log, refreshLogLevel, redactFields } from '../lib/log';

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let savedLevel: string | undefined;

beforeEach(() => {
    savedLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    refreshLogLevel();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.useRealTimers();
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
    refreshLogLevel();
});

function raw(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
}

function lastRecord(spy: ReturnType<typeof vi.spyOn>): Record<string, any> {
    const calls = spy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return JSON.parse(String(calls[calls.length - 1][0]));
}

// One key per alternative in SECRET_KEY_RE, in the casings / separators real code
// uses (headers are lower-kebab, env-ish config is UPPER_SNAKE, JS is camelCase).
const SECRET_KEYS = [
    'authorization', 'Authorization', 'proxy-authorization',
    'secret', 'webhookSecret', 'JWT_SECRET',
    'password', 'userPassword', 'PASSWORD',
    'cookie', 'set-cookie', 'Cookie',
    'token', 'accessToken', 'refresh_token',
    'apikey', 'api_key', 'api-key', 'apiKey', 'X-API-KEY',
    'client_secret', 'client-secret', 'clientSecret',
    'bot_token', 'bot-token', 'botToken',
    'privateKey', 'private_key', 'private-key', 'PRIVATEKEY',
    'credential', 'credentials', 'awsCredential',
];

// Keys that share a stem with a secret pattern but are not secrets. Redacting these
// would blank ordinary diagnostics, so they must pass through untouched.
const BENIGN_KEYS = ['key', 'author', 'publicKey', 'pass', 'auth', 'tok', 'module', 'userId', 'privacy', 'apiVersion'];

describe('SECRET_KEY_RE key shapes', () => {
    it.each(SECRET_KEYS)('redacts %s at the top level of a log record', (key) => {
        log.info('x', { [key]: 'LEAK-VALUE-1', keep: 'visible' });
        const rec = lastRecord(stdoutSpy);
        expect(rec[key]).toBe('[REDACTED]');
        expect(rec.keep).toBe('visible');
        expect(raw(stdoutSpy)).not.toContain('LEAK-VALUE-1');
    });

    it.each(SECRET_KEYS)('redacts %s nested in an object inside an array', (key) => {
        log.warn('x', { payload: { items: [{ [key]: 'LEAK-VALUE-2', id: 3 }] } });
        const rec = lastRecord(stderrSpy);
        expect(rec.payload.items[0]).toEqual({ [key]: '[REDACTED]', id: 3 });
        expect(raw(stderrSpy)).not.toContain('LEAK-VALUE-2');
    });

    it.each(SECRET_KEYS)('redactFields() redacts %s exactly as the log line does', (key) => {
        expect(redactFields({ [key]: 'v', nested: { [key]: 'v' } })).toEqual({
            [key]: '[REDACTED]',
            nested: { [key]: '[REDACTED]' },
        });
    });

    it.each(BENIGN_KEYS)('keeps the near-miss key %s (no over-redaction)', (key) => {
        log.info('x', { [key]: 'plain-value', nested: { [key]: 'plain-value' } });
        const rec = lastRecord(stdoutSpy);
        expect(rec[key]).toBe('plain-value');
        expect(rec.nested[key]).toBe('plain-value');
    });

    it('replaces the WHOLE subtree under a secret-named key, not just its leaves', () => {
        log.info('x', { credentials: { user: 'svc', region: 'eu', nested: { a: 1 } } });
        const rec = lastRecord(stdoutSpy);
        expect(rec.credentials).toBe('[REDACTED]');
        expect(raw(stdoutSpy)).not.toContain('svc');
    });
});

describe('structure walk', () => {
    it('walks arrays of arrays and keeps primitives and benign siblings', () => {
        log.info('x', { grid: [[{ token: 'g-leak', n: 1 }, 'str', 2, null, true], []] });
        expect(lastRecord(stdoutSpy).grid).toEqual([[{ token: '[REDACTED]', n: 1 }, 'str', 2, null, true], []]);
        expect(raw(stdoutSpy)).not.toContain('g-leak');
    });

    it('walks a null-prototype object (treated as plain, not stringified)', () => {
        const bag = Object.create(null) as Record<string, unknown>;
        bag.password = 'np-leak';
        bag.host = 'db.internal';
        log.info('x', { bag });
        expect(lastRecord(stdoutSpy).bag).toEqual({ password: '[REDACTED]', host: 'db.internal' });
        expect(raw(stdoutSpy)).not.toContain('np-leak');
    });

    it('keeps a Date in its native JSON (ISO) form', () => {
        const when = new Date(Date.UTC(2026, 10, 2, 3, 4, 5));
        log.info('x', { when, nested: { when } });
        const rec = lastRecord(stdoutSpy);
        expect(rec.when).toBe('2026-11-02T03:04:05.000Z');
        expect(rec.nested.when).toBe('2026-11-02T03:04:05.000Z');
    });

    it('keeps a Buffer in its native JSON form', () => {
        log.info('x', { buf: Buffer.from([1, 2, 3]) });
        expect(lastRecord(stdoutSpy).buf).toEqual({ type: 'Buffer', data: [1, 2, 3] });
    });

    it('coerces a Map to its string form so its entries never ride along', () => {
        const m = new Map([['botToken', 'map-leak']]);
        log.info('x', { m });
        expect(lastRecord(stdoutSpy).m).toBe('[object Map]');
        expect(raw(stdoutSpy)).not.toContain('map-leak');
    });

    it('value-scrubs the string form of a class instance (toString carrying a credential)', () => {
        class Conn {
            host = 'voice.example';
            toString() { return 'Conn(host=voice.example token=inst-leak)'; }
        }
        log.info('x', { conn: new Conn() });
        expect(lastRecord(stdoutSpy).conn).toBe('Conn(host=voice.example [REDACTED]');
        expect(raw(stdoutSpy)).not.toContain('inst-leak');
    });

    it('does not mutate the caller-supplied fields object', () => {
        const fields = { apiKey: 'k', nested: { password: 'p' } };
        log.info('x', fields);
        redactFields(fields);
        expect(fields).toEqual({ apiKey: 'k', nested: { password: 'p' } });
    });
});

describe('depth cap (fails closed)', () => {
    // Top-level field values are walked at depth 0, so chain[k] sits at depth k.
    function chain(levels: number): Record<string, any> {
        let node: Record<string, any> = { leaf: 'deep-leaf', apiKey: 'deep-leak' };
        for (let i = 0; i < levels; i++) node = { n: node, d: i };
        return node;
    }

    it('walks objects up to depth 7 and collapses the depth-8 object to a sentinel', () => {
        log.info('x', { root: chain(8) });
        let node = lastRecord(stdoutSpy).root;
        for (let depth = 0; depth < 7; depth++) node = node.n;
        // node is the depth-7 object: still walked, its primitive sibling kept...
        expect(node.d).toBe(0);
        // ...and its child (depth 8) is never emitted raw.
        expect(node.n).toBe('[REDACTED:depth]');
        expect(raw(stdoutSpy)).not.toContain('deep-leak');
        expect(raw(stdoutSpy)).not.toContain('deep-leaf');
    });

    it('emits a structure that bottoms out exactly at depth 7 in full', () => {
        log.info('x', { root: chain(7) });
        let node = lastRecord(stdoutSpy).root;
        for (let depth = 0; depth < 7; depth++) node = node.n;
        expect(node).toEqual({ leaf: 'deep-leaf', apiKey: '[REDACTED]' });
    });

    it('counts array nesting toward the cap too', () => {
        let arr: unknown = [{ token: 'arr-leak' }];
        for (let i = 0; i < 8; i++) arr = [arr];
        log.info('x', { arr });
        expect(raw(stdoutSpy)).toContain('[REDACTED:depth]');
        expect(raw(stdoutSpy)).not.toContain('arr-leak');
    });

    it('terminates on a cyclic structure instead of overflowing the stack', () => {
        const a: Record<string, unknown> = { name: 'a' };
        a.self = a;
        expect(() => log.info('x', { a })).not.toThrow();
        expect(raw(stdoutSpy)).toContain('[REDACTED:depth]');
    });
});

describe('Error serialisation under err', () => {
    it('emits exactly {name, message, stack} — no own properties of the error', () => {
        // axios-style errors carry the request config (and its Authorization header)
        // as an own property; none of it may reach the line.
        const e = Object.assign(new Error('upstream 500'), {
            config: { headers: { Authorization: 'Bearer own-prop-leak' } },
            code: 'ECONNRESET',
        });
        log.error('failed', { err: e });
        const rec = lastRecord(stderrSpy);
        expect(Object.keys(rec.err).sort()).toEqual(['message', 'name', 'stack']);
        expect(rec.err.name).toBe('Error');
        expect(rec.err.message).toBe('upstream 500');
        expect(rec.err.stack).toMatch(/^Error: upstream 500\n/);
        expect(raw(stderrSpy)).not.toContain('own-prop-leak');
    });

    it('keeps the subclass / custom name', () => {
        class UpstreamError extends Error { constructor(m: string) { super(m); this.name = 'UpstreamError'; } }
        log.error('x', { err: new TypeError('bad type'), other: new UpstreamError('nope') });
        const rec = lastRecord(stderrSpy);
        expect(rec.err.name).toBe('TypeError');
        expect(rec.other).toMatchObject({ name: 'UpstreamError', message: 'nope' });
    });

    it('serialises an Error nested anywhere, not only under the err key', () => {
        log.error('x', { ctx: { failures: [new Error('inner')] } });
        expect(lastRecord(stderrSpy).ctx.failures[0]).toMatchObject({ name: 'Error', message: 'inner' });
    });

    it('passes a non-string stack through (an absent stack is simply omitted)', () => {
        const e = new Error('no stack');
        Object.defineProperty(e, 'stack', { value: undefined });
        log.error('x', { err: e });
        expect(lastRecord(stderrSpy).err).toEqual({ name: 'Error', message: 'no stack' });
    });

    it('scrubs the credential out of BOTH message and stack, keeping the benign text', () => {
        log.error('x', { err: new Error('call failed: token=tk-leak (retrying)') });
        const rec = lastRecord(stderrSpy);
        expect(rec.err.message).toBe('call failed: [REDACTED] (retrying)');
        expect(rec.err.stack).toContain('call failed: [REDACTED] (retrying)');
        expect(raw(stderrSpy)).not.toContain('tk-leak');
    });

    // SECRET_VALUE_RE: `Bearer <tok>` or `<keyword><sep><value>` — the value is
    // removed, the value ends at whitespace / comma / semicolon.
    it.each([
        ['Bearer abc.def.ghi', '[REDACTED]'],
        ['BEARER abc', '[REDACTED]'],
        ['Authorization: Bearer abc', '[REDACTED]'],
        ['api_key=AKIA123', '[REDACTED]'],
        ['api-key: AKIA123', '[REDACTED]'],
        ['apikey="AKIA123"', '[REDACTED]'],
        ['client_secret=cs1', '[REDACTED]'],
        ['bot-token MTIz', '[REDACTED]'],
        ["private_key='pk1'", '[REDACTED]'],
        ['secret=s1', '[REDACTED]'],
        ['password: hunter2', '[REDACTED]'],
        ['credential=c1', '[REDACTED]'],
        ['token=a,next=1', '[REDACTED],next=1'],
        ['token=a;rest', '[REDACTED];rest'],
        ['first token=a then password=b', 'first [REDACTED] then [REDACTED]'],
        ['nothing to see here', 'nothing to see here'],
    ])('scrubs %j in an Error message to %j', (input, expected) => {
        log.error('x', { err: new Error(input) });
        expect(lastRecord(stderrSpy).err.message).toBe(expected);
    });

    it('redactFields() serialises and scrubs an Error the same way', () => {
        const out = redactFields({ err: new Error('Bearer rf-leak') }) as { err: { name: string; message: string } };
        expect(out.err.name).toBe('Error');
        expect(out.err.message).toBe('[REDACTED]');
        expect(JSON.stringify(out)).not.toContain('rf-leak');
    });
});

describe('record shape and level routing', () => {
    it('writes one newline-terminated JSON line with ts/level/msg first', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2026, 10, 2, 12, 0, 0)));
        log.info('hello', { a: 1 });
        const line = String(stdoutSpy.mock.calls[0][0]);
        expect(line.endsWith('\n')).toBe(true);
        expect(line.split('\n')).toHaveLength(2);
        expect(JSON.parse(line)).toEqual({ ts: '2026-11-02T12:00:00.000Z', level: 'info', msg: 'hello', a: 1 });
    });

    it('emits no fields key at all when fields are omitted', () => {
        log.debug('bare');
        expect(Object.keys(lastRecord(stdoutSpy)).sort()).toEqual(['level', 'msg', 'ts']);
    });

    it('defaults to info when LOG_LEVEL is unset (debug suppressed, info emitted)', () => {
        delete process.env.LOG_LEVEL;
        refreshLogLevel();
        log.debug('d');
        log.info('i');
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        expect(lastRecord(stdoutSpy).msg).toBe('i');
    });

    it('defaults to info for an unrecognised LOG_LEVEL', () => {
        process.env.LOG_LEVEL = 'verbose';
        refreshLogLevel();
        log.debug('d');
        log.info('i');
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
    });

    it('parses LOG_LEVEL case-insensitively', () => {
        process.env.LOG_LEVEL = 'ERROR';
        refreshLogLevel();
        log.warn('w');
        log.error('e');
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        expect(lastRecord(stderrSpy)).toMatchObject({ level: 'error', msg: 'e' });
    });

    it('redactFields() still redacts when the logger itself is silent', () => {
        process.env.LOG_LEVEL = 'silent';
        refreshLogLevel();
        expect(redactFields({ token: 't', ok: 1 })).toEqual({ token: '[REDACTED]', ok: 1 });
        expect(stdoutSpy).not.toHaveBeenCalled();
        expect(stderrSpy).not.toHaveBeenCalled();
    });
});

describe('child loggers', () => {
    it('stamps the context on every level, routed to the right stream', () => {
        const c = log.child({ module: 'm1' });
        c.debug('d'); c.info('i'); c.warn('w'); c.error('e');
        const out = stdoutSpy.mock.calls.map((x: unknown[]) => JSON.parse(String(x[0])));
        const err = stderrSpy.mock.calls.map((x: unknown[]) => JSON.parse(String(x[0])));
        expect(out.map((r: any) => [r.level, r.module])).toEqual([['debug', 'm1'], ['info', 'm1']]);
        expect(err.map((r: any) => [r.level, r.module])).toEqual([['warn', 'm1'], ['error', 'm1']]);
    });

    it('a grandchild merges its context over the parent, leaving the parent untouched', () => {
        const parent = log.child({ module: 'p', requestId: 'r1' });
        const kid = parent.child({ requestId: 'r2', step: 3 });
        kid.info('k');
        expect(lastRecord(stdoutSpy)).toMatchObject({ module: 'p', requestId: 'r2', step: 3 });
        parent.info('p');
        const rec = lastRecord(stdoutSpy);
        expect(rec.requestId).toBe('r1');
        expect(rec).not.toHaveProperty('step');
        log.info('root');
        expect(lastRecord(stdoutSpy)).not.toHaveProperty('module');
    });

    it('a per-call field overrides a context key of the same name', () => {
        log.child({ module: 'ctx' }).info('x', { module: 'field' });
        expect(lastRecord(stdoutSpy).module).toBe('field');
    });

    it('redacts a secret-named key in the child CONTEXT on every record it stamps', () => {
        const c = log.child({ module: 'm', botToken: 'ctx-leak', auth: { password: 'ctx-pw' } });
        c.info('one');
        c.child({ step: 2 }).error('two');
        expect(lastRecord(stdoutSpy)).toMatchObject({ module: 'm', botToken: '[REDACTED]', auth: { password: '[REDACTED]' } });
        expect(lastRecord(stderrSpy)).toMatchObject({ module: 'm', botToken: '[REDACTED]', step: 2 });
        expect(raw(stdoutSpy) + raw(stderrSpy)).not.toContain('ctx-leak');
        expect(raw(stdoutSpy) + raw(stderrSpy)).not.toContain('ctx-pw');
    });

    it('serialises an Error carried in the child context instead of emitting {}', () => {
        log.child({ cause: new Error('Bearer cause-leak') }).warn('x');
        expect(lastRecord(stderrSpy).cause).toMatchObject({ name: 'Error', message: '[REDACTED]' });
        expect(raw(stderrSpy)).not.toContain('cause-leak');
    });
});
