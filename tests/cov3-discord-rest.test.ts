import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/discord.ts — the identity / guild-membership half: OAuth code exchange, the
// user + member lookups, guild role listing and the synced-roles table, the
// per-guild role-change queue, and the platform -> Discord role push.
//
// Every request this module makes either carries the OAuth client secret (in the
// form body) or `Authorization: Bot <token>`. So beyond the exact URL / method /
// headers / body of each call, three properties are pinned across the whole file:
//   1. a missing credential FAILS CLOSED — no request is issued at all;
//   2. neither credential ever appears in a thrown message, a return value, or a
//      log line (an afterEach sweeps every log entry this file produced);
//   3. an id interpolated into a bot-authenticated path must be a snowflake, or
//      it chooses the endpoint (see the ROUTE-ID GUARD block below).

const BOT_TOKEN = 'MTIz.bot-SECRET-token.value-xyz';
const CLIENT_SECRET = 'oauth-CLIENT-SECRET-value-987';
const CLIENT_ID = '112233445566778899';
const GUILD_ID = '998877665544332211';
const USER_ID = '123456789012345678';
const ROLE_A = '223344556677889900';
const ROLE_B = '334455667788990011';
const ROLE_C = '445566778899001122';
const VICTIM = '111122223333444455';
const API = 'https://discord.com/api/v10';

type LogEntry = { level: string; msg: string; fields?: Record<string, unknown> };
type Query = { table: string; op: 'select' | 'delete' | 'insert'; columns?: string; eqs: Array<[string, unknown]>; rows?: unknown; single?: boolean };
type DbResult = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
    secrets: {} as Record<string, string | null>,
    secretReads: [] as string[],
    logs: [] as Array<{ level: string; msg: string; fields?: Record<string, unknown> }>,
    childArgs: [] as unknown[],
    queries: [] as Array<{ table: string; op: 'select' | 'delete' | 'insert'; columns?: string; eqs: Array<[string, unknown]>; rows?: unknown; single?: boolean }>,
    results: {} as Record<string, { data: unknown; error: unknown }>,
    fromThrows: null as Error | null,
    handled: [] as Array<{ error: unknown; message: string }>,
}));

vi.mock('../lib/secrets', () => ({
    getOrgSecret: async (key: string) => {
        h.secretReads.push(key);
        return h.secrets[key] ?? null;
    },
}));

vi.mock('../lib/log', () => {
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const child = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
    return { log: { ...child, child: (args: unknown) => { h.childArgs.push(args); return child; } } };
});

vi.mock('../lib/db/common', () => {
    const resultFor = (q: { table: string; op: string }) => h.results[`${q.table}.${q.op}`] ?? { data: null, error: null };
    return {
        supabase: {
            from: (table: string) => {
                if (h.fromThrows) throw h.fromThrows;
                const q: { table: string; op: 'select' | 'delete' | 'insert'; columns?: string; eqs: Array<[string, unknown]>; rows?: unknown; single?: boolean } = { table, op: 'select', eqs: [] };
                h.queries.push(q);
                const b: Record<string, unknown> = {};
                b.select = (cols: string) => { q.columns = cols; return b; };
                b.delete = () => { q.op = 'delete'; return b; };
                b.insert = (rows: unknown) => { q.op = 'insert'; q.rows = rows; return b; };
                b.eq = (c: string, v: unknown) => { q.eqs.push([c, v]); return b; };
                b.single = () => { q.single = true; return Promise.resolve(resultFor(q)); };
                b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(resultFor(q)).then(res, rej);
                return b;
            },
        },
        // Same contract as lib/supabaseServer.ts: throw the caller's message on error.
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
            h.handled.push({ error, message });
            if (error) throw new Error(message);
        },
    };
});

type FakeRes = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
function res(status: number, body?: unknown, opts: { invalidJson?: boolean; text?: string; textRejects?: boolean; ok?: boolean } = {}): FakeRes {
    return {
        ok: opts.ok ?? (status >= 200 && status < 300),
        status,
        json: async () => {
            if (opts.invalidJson || body === undefined) throw new SyntaxError('Unexpected token < in JSON at position 0');
            return body;
        },
        text: async () => {
            if (opts.textRejects) throw new Error('body stream already read');
            return opts.text ?? (body === undefined ? '' : JSON.stringify(body));
        },
    };
}

const fetchMock = vi.fn<(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FakeRes>>();
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body }));

// Serialises Errors by message/stack/cause so a secret inside an err cannot hide
// behind JSON.stringify(new Error()) === '{}'.
function serialise(v: unknown): string {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { message: val.message, stack: val.stack, cause: val.cause } : val));
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
    try { await p; } catch (e) { return e as Error; }
    throw new Error('expected the promise to reject');
}

let d: typeof import('../lib/discord');

beforeEach(async () => {
    h.secrets = { DISCORD_BOT_TOKEN: BOT_TOKEN, DISCORD_GUILD_ID: GUILD_ID, DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_CLIENT_SECRET: CLIENT_SECRET };
    h.secretReads = []; h.logs = []; h.childArgs = []; h.queries = []; h.results = {}; h.fromThrows = null; h.handled = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => res(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    // Fresh module per test: the role-change queue map is module state.
    vi.resetModules();
    d = await import('../lib/discord');
    vi.useFakeTimers();
});

afterEach(() => {
    // SECRET HYGIENE, swept over every log line every test produced.
    const logged = serialise(h.logs);
    expect(logged, 'the bot token reached a log line').not.toContain(BOT_TOKEN);
    expect(logged, 'the OAuth client secret reached a log line').not.toContain(CLIENT_SECRET);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('module logger', () => {
    it('logs through a child of the structured logger tagged lib.discord (the redaction backstop)', () => {
        expect(h.childArgs).toEqual([{ module: 'lib.discord' }]);
    });
});

describe('buildGlobalAvatarUrl', () => {
    it('uses the global avatar hash as a png for a static avatar', () => {
        expect(d.buildGlobalAvatarUrl({ id: USER_ID, avatar: 'abc123' })).toBe(`https://cdn.discordapp.com/avatars/${USER_ID}/abc123.png`);
    });

    it('uses gif for an animated (a_) avatar hash', () => {
        expect(d.buildGlobalAvatarUrl({ id: USER_ID, avatar: 'a_abc123' })).toBe(`https://cdn.discordapp.com/avatars/${USER_ID}/a_abc123.gif`);
    });

    it('derives the post-migration default from (snowflake >> 22) % 6 when discriminator is 0 or absent', () => {
        expect(d.buildGlobalAvatarUrl({ id: '80351110224678912', avatar: null, discriminator: '0' })).toBe('https://cdn.discordapp.com/embed/avatars/5.png');
        expect(d.buildGlobalAvatarUrl({ id: '80351110224678912' })).toBe('https://cdn.discordapp.com/embed/avatars/5.png');
        expect(d.buildGlobalAvatarUrl({ id: USER_ID, discriminator: null })).toBe('https://cdn.discordapp.com/embed/avatars/0.png');
    });

    it('derives the legacy default from discriminator % 5', () => {
        expect(d.buildGlobalAvatarUrl({ id: USER_ID, discriminator: '1337' })).toBe('https://cdn.discordapp.com/embed/avatars/2.png');
    });

    it('falls back to the index-0 default when the id is not a parseable snowflake', () => {
        expect(d.buildGlobalAvatarUrl({ id: 'not-a-snowflake', discriminator: '0' })).toBe('https://cdn.discordapp.com/embed/avatars/0.png');
    });
});

describe('exchangeCodeForToken', () => {
    const REDIRECT = 'https://org.example/auth/callback';

    it('POSTs the form-encoded grant with trimmed credentials and returns the token payload', async () => {
        h.secrets.DISCORD_CLIENT_ID = `  ${CLIENT_ID}\n`;
        h.secrets.DISCORD_CLIENT_SECRET = ` ${CLIENT_SECRET} \n`;
        fetchMock.mockResolvedValueOnce(res(200, { access_token: 'at', token_type: 'Bearer', expires_in: 604800 }));

        const out = await d.exchangeCodeForToken('the-code', REDIRECT);

        expect(out).toEqual({ access_token: 'at', token_type: 'Bearer', expires_in: 604800 });
        expect(calls()).toHaveLength(1);
        const c = calls()[0];
        expect(c.url).toBe(`${API}/oauth2/token`);
        expect(c.method).toBe('POST');
        expect(c.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
        expect(Object.fromEntries(new URLSearchParams(String(c.body)))).toEqual({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: 'the-code',
            redirect_uri: REDIRECT,
        });
        expect(h.secretReads).toEqual(['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']);
    });

    it.each([
        ['client id', 'DISCORD_CLIENT_ID', { hasClientId: false, hasClientSecret: true }],
        ['client secret', 'DISCORD_CLIENT_SECRET', { hasClientId: true, hasClientSecret: false }],
    ])('FAILS CLOSED with a generic message when the %s is unset — no request, presence-only log', async (_label, key, presence) => {
        h.secrets[key] = null;
        const err = await errorOf(d.exchangeCodeForToken('code', REDIRECT));
        expect(err.message).toBe('Server configuration error for Discord authentication.');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([{ level: 'error', msg: 'oauth credentials missing', fields: presence }]);
    });

    it('maps a rejected grant to its error_description and logs only a client-id prefix', async () => {
        fetchMock.mockResolvedValueOnce(res(400, { error: 'invalid_grant', error_description: 'Invalid "code" in request.' }));
        const err = await errorOf(d.exchangeCodeForToken('stale', REDIRECT));
        expect(err.message).toBe('Discord OAuth failed: Invalid "code" in request.');
        expect(err.message).not.toContain(CLIENT_SECRET);
        expect(h.logs).toEqual([{
            level: 'error',
            msg: 'token exchange failed',
            fields: { clientIdPrefix: '112233...', error: 'invalid_grant', errorDescription: 'Invalid "code" in request.', redirectUri: REDIRECT },
        }]);
        expect(serialise(h.logs)).not.toContain(CLIENT_ID);
    });

    it('falls back to the error code, then to a fixed phrase, when Discord gives less detail', async () => {
        fetchMock.mockResolvedValueOnce(res(401, { error: 'invalid_client' }));
        expect((await errorOf(d.exchangeCodeForToken('c', REDIRECT))).message).toBe('Discord OAuth failed: invalid_client');
        expect(h.logs[0].fields).toMatchObject({ error: 'invalid_client', errorDescription: 'No description' });

        fetchMock.mockResolvedValueOnce(res(500, {}));
        expect((await errorOf(d.exchangeCodeForToken('c', REDIRECT))).message).toBe('Discord OAuth failed: Unknown Discord error');
    });

    it('a non-JSON error page rejects without the client secret in the error', async () => {
        fetchMock.mockResolvedValueOnce(res(502, undefined, { invalidJson: true }));
        const err = await errorOf(d.exchangeCodeForToken('c', REDIRECT));
        expect(serialise(err)).not.toContain(CLIENT_SECRET);
    });
});

describe('getDiscordUser', () => {
    it('GETs /users/@me with the user Bearer token and returns the profile', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { id: USER_ID, username: 'pilot' }));
        expect(await d.getDiscordUser('user-access-token')).toEqual({ id: USER_ID, username: 'pilot' });
        expect(calls()).toEqual([{ url: `${API}/users/@me`, method: 'GET', headers: { Authorization: 'Bearer user-access-token' }, body: undefined }]);
    });

    it('throws a fixed message on a non-2xx', async () => {
        fetchMock.mockResolvedValueOnce(res(401, { message: '401: Unauthorized' }));
        expect((await errorOf(d.getDiscordUser('bad'))).message).toBe('Failed to fetch Discord user');
    });
});

describe('getDiscordMember', () => {
    it('GETs the guild member with the bot token', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { user: { id: USER_ID }, roles: [ROLE_A] }));
        expect(await d.getDiscordMember(USER_ID)).toEqual({ user: { id: USER_ID }, roles: [ROLE_A] });
        expect(calls()).toEqual([{ url: `${API}/guilds/${GUILD_ID}/members/${USER_ID}`, method: 'GET', headers: { Authorization: `Bot ${BOT_TOKEN}` }, body: undefined }]);
    });

    it.each(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'])('FAILS CLOSED when %s is unset', async (key) => {
        h.secrets[key] = null;
        const err = await errorOf(d.getDiscordMember(USER_ID));
        expect(err.message).toBe('Discord Bot Token or Guild ID not configured for member lookup.');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a 404 (not in the guild) is a null, not an error', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Unknown Member', code: 10007 }));
        expect(await d.getDiscordMember(USER_ID)).toBeNull();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'discord user not found in guild', fields: { discordUserId: USER_ID, guildId: GUILD_ID } }]);
    });

    it('any other failure logs the Discord body and throws a fixed message', async () => {
        fetchMock.mockResolvedValueOnce(res(403, { message: 'Missing Access', code: 50001 }));
        const err = await errorOf(d.getDiscordMember(USER_ID));
        expect(err.message).toBe('Failed to fetch Discord member');
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to fetch discord member', fields: { error: { message: 'Missing Access', code: 50001 } } }]);
    });
});

describe('getDiscordUserById', () => {
    it('GETs /users/{id} with the bot token', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { id: USER_ID, avatar: 'h' }));
        expect(await d.getDiscordUserById(USER_ID)).toEqual({ id: USER_ID, avatar: 'h' });
        expect(calls()).toEqual([{ url: `${API}/users/${USER_ID}`, method: 'GET', headers: { Authorization: `Bot ${BOT_TOKEN}` }, body: undefined }]);
        expect(h.secretReads).toEqual(['DISCORD_BOT_TOKEN']);
    });

    it('FAILS CLOSED without a bot token', async () => {
        h.secrets.DISCORD_BOT_TOKEN = null;
        expect((await errorOf(d.getDiscordUserById(USER_ID))).message).toBe('Discord Bot Token not configured for user lookup.');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('logs and throws a fixed message on a non-2xx', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Unknown User' }));
        expect((await errorOf(d.getDiscordUserById(USER_ID))).message).toBe('Failed to fetch Discord user by ID');
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to fetch discord user', fields: { discordUserId: USER_ID, error: { message: 'Unknown User' } } }]);
    });
});

describe('getDiscordRoles', () => {
    it('GETs the guild roles and projects exactly {id, name, color}, dropping managed roles and @everyone', async () => {
        fetchMock.mockResolvedValueOnce(res(200, [
            { id: GUILD_ID, name: '@everyone', color: 0, managed: false, permissions: '0' },
            { id: ROLE_A, name: 'Officer', color: 0x1abc9c, managed: false, permissions: '8', position: 3, hoist: true, tags: {} },
            { id: ROLE_B, name: 'Bot Role', color: 0xff0000, managed: true },
            { id: ROLE_C, name: 'Blue', color: 255, managed: false },
            { id: '556677889900112233', name: 'Plain', color: 0, managed: false },
        ]));
        expect(await d.getDiscordRoles()).toEqual([
            { id: ROLE_A, name: 'Officer', color: '#1abc9c' },
            { id: ROLE_C, name: 'Blue', color: '#0000ff' },
            { id: '556677889900112233', name: 'Plain', color: '#000000' },
        ]);
        expect(calls()).toEqual([{ url: `${API}/guilds/${GUILD_ID}/roles`, method: 'GET', headers: { Authorization: `Bot ${BOT_TOKEN}` }, body: undefined }]);
    });

    it('names exactly which credential is missing, and issues no request', async () => {
        h.secrets.DISCORD_BOT_TOKEN = null; h.secrets.DISCORD_GUILD_ID = null;
        expect((await errorOf(d.getDiscordRoles())).message).toMatch(/^Discord is not configured\. Add a Bot Token and Guild ID/);
        h.secrets.DISCORD_GUILD_ID = GUILD_ID;
        expect((await errorOf(d.getDiscordRoles())).message).toMatch(/^Discord Bot Token is missing\./);
        h.secrets.DISCORD_BOT_TOKEN = BOT_TOKEN; h.secrets.DISCORD_GUILD_ID = null;
        expect((await errorOf(d.getDiscordRoles())).message).toMatch(/^Discord Guild ID is missing\./);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('wraps a network failure, keeping the cause', async () => {
        const boom = new Error('getaddrinfo ENOTFOUND discord.com');
        fetchMock.mockRejectedValueOnce(boom);
        const err = await errorOf(d.getDiscordRoles());
        expect(err.message).toBe('Could not reach Discord (getaddrinfo ENOTFOUND discord.com). Try again shortly.');
        expect(err.cause).toBe(boom);

        fetchMock.mockRejectedValueOnce({});
        expect((await errorOf(d.getDiscordRoles())).message).toBe('Could not reach Discord (network error). Try again shortly.');
    });

    it.each([
        [401, { message: '401: Unauthorized' }, /^Discord rejected the Bot Token \(401 Unauthorized\)\./],
        [403, { message: 'Missing Access' }, /^Discord rejected the request \(403 Forbidden\)\. Make sure the bot has been added/],
        [404, { message: 'Unknown Guild' }, new RegExp(`^Discord could not find guild ${GUILD_ID} \\(404 Unknown Guild\\)\\.`)],
        [429, { message: 'You are being rate limited.', retry_after: 1.5 }, /^Discord rate-limited the request \(429\)\. Try again in a moment\.$/],
        [503, { message: 'upstream overloaded' }, /^Discord is having issues \(503: upstream overloaded\)\. Try again shortly\.$/],
        [400, { message: 'Bad Request' }, /^Failed to fetch Discord roles \(400: Bad Request\)\.$/],
    ])('maps HTTP %i to an operator-actionable message', async (status, body, expected) => {
        fetchMock.mockResolvedValueOnce(res(status, body));
        const err = await errorOf(d.getDiscordRoles());
        expect(err.message).toMatch(expected);
        expect(err.message).not.toContain(BOT_TOKEN);
        expect(h.logs).toEqual([{ level: 'error', msg: 'get guild roles failed', fields: { guildId: GUILD_ID, status, body: JSON.stringify(body) } }]);
    });

    it('omits the Discord message when the body is not JSON (e.g. an edge HTML page), and caps the logged body', async () => {
        const html = `<html>${'x'.repeat(800)}</html>`;
        fetchMock.mockResolvedValueOnce(res(502, undefined, { text: html }));
        expect((await errorOf(d.getDiscordRoles())).message).toBe('Discord is having issues (502). Try again shortly.');
        expect(h.logs[0].fields?.body).toBe(html.slice(0, 500));

        fetchMock.mockResolvedValueOnce(res(418, undefined, { text: 'teapot' }));
        expect((await errorOf(d.getDiscordRoles())).message).toBe('Failed to fetch Discord roles (418).');
    });

    it('omits the Discord message when the JSON body carries none (or is null)', async () => {
        fetchMock.mockResolvedValueOnce(res(400, undefined, { text: '{"code":0}' }));
        expect((await errorOf(d.getDiscordRoles())).message).toBe('Failed to fetch Discord roles (400).');
        fetchMock.mockResolvedValueOnce(res(500, undefined, { text: 'null' }));
        expect((await errorOf(d.getDiscordRoles())).message).toBe('Discord is having issues (500). Try again shortly.');
    });

    it('survives an unreadable error body', async () => {
        fetchMock.mockResolvedValueOnce(res(500, undefined, { textRejects: true }));
        expect((await errorOf(d.getDiscordRoles())).message).toBe('Discord is having issues (500). Try again shortly.');
        expect(h.logs[0].fields?.body).toBe('');
    });

    it('reports an unparseable 2xx body as an edge error, keeping the cause', async () => {
        fetchMock.mockResolvedValueOnce(res(200, undefined, { invalidJson: true }));
        const err = await errorOf(d.getDiscordRoles());
        expect(err.message).toBe('Discord returned an unexpected response (Unexpected token < in JSON at position 0). This often indicates a Cloudflare/edge error — try again shortly.');
        expect(err.cause).toBeInstanceOf(SyntaxError);

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw {}; }, text: async () => '' });
        expect((await errorOf(d.getDiscordRoles())).message).toMatch(/^Discord returned an unexpected response \(invalid JSON\)\./);
    });
});

describe('syncDiscordRoles', () => {
    it('clears then re-inserts the guild roles, sanitising external names', async () => {
        const longName = 'L'.repeat(150);
        fetchMock.mockResolvedValueOnce(res(200, [
            { id: ROLE_A, name: '<b>Officer</b>\n  Corps', color: 0xff0000, managed: false },
            { id: ROLE_B, name: '<img src=x onerror=alert(1)>', color: 0, managed: false },
            { id: ROLE_C, name: longName, color: 16, managed: false },
            { id: '556677889900112233', name: 'Integration', color: 0, managed: true },
        ]));

        await d.syncDiscordRoles();

        expect(h.queries).toEqual([
            { table: 'synced_discord_roles', op: 'delete', eqs: [] },
            {
                table: 'synced_discord_roles', op: 'insert', eqs: [], rows: [
                    { id: ROLE_A, name: 'Officer Corps', color: '#ff0000' },
                    // Markup-only name strips to empty -> falls back to the id.
                    { id: ROLE_B, name: ROLE_B, color: '#000000' },
                    { id: ROLE_C, name: 'L'.repeat(100), color: '#000010' },
                ],
            },
        ]);
        expect(h.handled).toEqual([
            { error: null, message: 'Failed to clear old discord roles' },
            { error: null, message: 'Failed to insert new discord roles' },
        ]);
    });

    it('DATA INTEGRITY: a Discord failure aborts before the table is cleared', async () => {
        fetchMock.mockResolvedValueOnce(res(503, { message: 'down' }));
        await expect(d.syncDiscordRoles()).rejects.toThrow(/Discord is having issues/);
        expect(h.queries).toEqual([]);
    });

    it('does not insert when the guild has no syncable roles', async () => {
        fetchMock.mockResolvedValueOnce(res(200, [{ id: GUILD_ID, name: '@everyone', color: 0, managed: false }]));
        await d.syncDiscordRoles();
        expect(h.queries.map(q => q.op)).toEqual(['delete']);
    });

    it('stops at a failed clear without inserting', async () => {
        fetchMock.mockResolvedValueOnce(res(200, [{ id: ROLE_A, name: 'A', color: 1, managed: false }]));
        h.results['synced_discord_roles.delete'] = { data: null, error: { message: 'permission denied' } };
        await expect(d.syncDiscordRoles()).rejects.toThrow('Failed to clear old discord roles');
        expect(h.queries.map(q => q.op)).toEqual(['delete']);
    });

    it('surfaces a failed insert', async () => {
        fetchMock.mockResolvedValueOnce(res(200, [{ id: ROLE_A, name: 'A', color: 1, managed: false }]));
        h.results['synced_discord_roles.insert'] = { data: null, error: { message: 'duplicate key' } };
        await expect(d.syncDiscordRoles()).rejects.toThrow('Failed to insert new discord roles');
    });
});

describe('addMemberRole / removeMemberRole', () => {
    it('addMemberRole PUTs the member role with the bot token and reports success', async () => {
        fetchMock.mockResolvedValueOnce(res(204));
        const p = d.addMemberRole(USER_ID, ROLE_A);
        await vi.runAllTimersAsync();
        expect(await p).toBe(true);
        expect(calls()).toEqual([{
            url: `${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_A}`,
            method: 'PUT',
            headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: undefined,
        }]);
    });

    it('removeMemberRole DELETEs the member role with the bot token and reports success', async () => {
        fetchMock.mockResolvedValueOnce(res(204));
        const p = d.removeMemberRole(USER_ID, ROLE_A);
        await vi.runAllTimersAsync();
        expect(await p).toBe(true);
        expect(calls()).toEqual([{
            url: `${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_A}`,
            method: 'DELETE',
            headers: { Authorization: `Bot ${BOT_TOKEN}` },
            body: undefined,
        }]);
    });

    it.each(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'])('both return false and issue nothing when %s is unset', async (key) => {
        h.secrets[key] = null;
        expect(await d.addMemberRole(USER_ID, ROLE_A)).toBe(false);
        expect(await d.removeMemberRole(USER_ID, ROLE_A)).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a rejected add logs the Discord body and reports failure', async () => {
        fetchMock.mockResolvedValueOnce(res(403, { message: 'Missing Permissions', code: 50013 }));
        const p = d.addMemberRole(USER_ID, ROLE_A);
        await vi.runAllTimersAsync();
        expect(await p).toBe(false);
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to add role to user', fields: { discordRoleId: ROLE_A, discordUserId: USER_ID, error: { message: 'Missing Permissions', code: 50013 } } }]);
    });

    it('a rejected remove with an unreadable body logs {} and reports failure', async () => {
        fetchMock.mockResolvedValueOnce(res(500, undefined, { invalidJson: true }));
        const p = d.removeMemberRole(USER_ID, ROLE_A);
        await vi.runAllTimersAsync();
        expect(await p).toBe(false);
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to remove role from user', fields: { discordRoleId: ROLE_A, discordUserId: USER_ID, error: {} } }]);
    });

    it('a rejected add with an unreadable body logs {} and reports failure', async () => {
        fetchMock.mockResolvedValueOnce(res(502, undefined, { invalidJson: true }));
        const p = d.addMemberRole(USER_ID, ROLE_B);
        await vi.runAllTimersAsync();
        expect(await p).toBe(false);
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to add role to user', fields: { discordRoleId: ROLE_B, discordUserId: USER_ID, error: {} } }]);
    });

    it('treats a 204 as success even when the ok flag is false', async () => {
        fetchMock.mockResolvedValueOnce(res(204, undefined, { ok: false }));
        fetchMock.mockResolvedValueOnce(res(204, undefined, { ok: false }));
        const p = Promise.all([d.addMemberRole(USER_ID, ROLE_A), d.removeMemberRole(USER_ID, ROLE_B)]);
        await vi.runAllTimersAsync();
        expect(await p).toEqual([true, true]);
        expect(h.logs).toEqual([]);
    });

    it('RATE LIMIT: role changes on one guild are serialised ~1.1s apart', async () => {
        fetchMock.mockImplementation(async () => res(204));
        const first = d.addMemberRole(USER_ID, ROLE_A);
        const second = d.removeMemberRole(USER_ID, ROLE_B);
        await vi.advanceTimersByTimeAsync(0);
        expect(calls().map(c => c.method)).toEqual(['PUT']);
        await vi.advanceTimersByTimeAsync(1099);
        expect(calls()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls().map(c => c.method)).toEqual(['PUT', 'DELETE']);
        await vi.advanceTimersByTimeAsync(1100);
        expect(await first).toBe(true);
        expect(await second).toBe(true);
    });

    it('a thrown change is logged and reported as failure without wedging the guild queue', async () => {
        const boom = new Error('socket hang up');
        fetchMock.mockRejectedValueOnce(boom);
        fetchMock.mockResolvedValueOnce(res(204));
        const p1 = d.addMemberRole(USER_ID, ROLE_A);
        const p2 = d.addMemberRole(USER_ID, ROLE_B);
        await vi.runAllTimersAsync();
        expect(await p1).toBe(false);
        expect(await p2).toBe(true);
        expect(h.logs).toEqual([{ level: 'error', msg: 'queued role change failed', fields: { guildId: GUILD_ID, err: boom } }]);
        expect(calls().map(c => c.url)).toEqual([
            `${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_A}`,
            `${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_B}`,
        ]);
    });
});

// ROUTE-ID GUARD for the member / role / user paths. The message paths already
// refuse a non-snowflake (tests/discordRouteIdGuard.test.ts); these interpolate
// ids from columns that are NOT shape-checked at their write sites —
// rank_mappings.discord_role_id is written verbatim by admin:update_rank_mapping
// and carried verbatim by an org import, users.discord_id likewise arrives with an
// import — into the same bot-authenticated paths.
describe('ROUTE-ID GUARD: member/role/user ids must be snowflakes', () => {
    it('the traversals are real: a role or user id can turn a role PUT into a ban, and a role DELETE into a channel delete', () => {
        expect(new URL(`${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/../../../bans/${VICTIM}?x=`).href)
            .toBe(`${API}/guilds/${GUILD_ID}/bans/${VICTIM}?x=`);
        expect(new URL(`${API}/guilds/${GUILD_ID}/members/../bans/${VICTIM}?x=/roles/${ROLE_A}`).pathname)
            .toBe(`/api/v10/guilds/${GUILD_ID}/bans/${VICTIM}`);
        expect(new URL(`${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/../../../../../channels/${ROLE_C}?x=`).pathname)
            .toBe(`/api/v10/channels/${ROLE_C}`);
    });

    it('addMemberRole refuses a traversal in either id and issues no request', async () => {
        expect(await d.addMemberRole(USER_ID, `../../../bans/${VICTIM}?x=`)).toBe(false);
        expect(await d.addMemberRole(`../bans/${VICTIM}?x=`, ROLE_A)).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs.map(l => [l.level, l.msg])).toEqual([
            ['warn', 'refusing role change: user or role id is not a snowflake'],
            ['warn', 'refusing role change: user or role id is not a snowflake'],
        ]);
    });

    it('removeMemberRole refuses a traversal in either id and issues no request', async () => {
        expect(await d.removeMemberRole(USER_ID, `../../../../../channels/${ROLE_C}?x=`)).toBe(false);
        expect(await d.removeMemberRole(`${USER_ID}/../../${VICTIM}`, ROLE_A)).toBe(false);
        expect(await d.removeMemberRole(USER_ID, '')).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getDiscordMember treats a non-snowflake as not-a-member (null) without a request', async () => {
        expect(await d.getDiscordMember(`../bans/${VICTIM}`)).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'refusing member lookup: user id is not a snowflake', fields: { discordUserId: `../bans/${VICTIM}` } }]);
    });

    it('getDiscordUserById refuses a non-snowflake without a request', async () => {
        expect((await errorOf(d.getDiscordUserById('../users/@me'))).message).toBe('Invalid Discord user ID.');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a real snowflake still reaches the intended route', async () => {
        fetchMock.mockResolvedValueOnce(res(204));
        const p = d.addMemberRole(USER_ID, ROLE_A);
        await vi.runAllTimersAsync();
        expect(await p).toBe(true);
        expect(calls()[0].url).toBe(`${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_A}`);
    });
});

describe('pushDiscordRolesForUser', () => {
    const run = async (changes: Parameters<typeof d.pushDiscordRolesForUser>[1]) => {
        const p = d.pushDiscordRolesForUser(42, changes);
        await vi.runAllTimersAsync();
        await p;
    };
    const roleCalls = () => calls().map(c => `${c.method} ${c.url.slice(c.url.lastIndexOf('/') + 1)}`);
    const mappings = (rows: Array<{ discord_role_id: string; rank_id?: number | null; role_id?: number | null }>) => {
        h.results['rank_mappings.select'] = { data: rows.map(r => ({ rank_id: null, role_id: null, ...r })), error: null };
    };

    beforeEach(() => {
        h.results['users.select'] = { data: { discord_id: USER_ID }, error: null };
        fetchMock.mockImplementation(async () => res(204));
    });

    it('reads the user discord id and the mappings with explicit columns', async () => {
        mappings([{ discord_role_id: ROLE_A, rank_id: 2 }]);
        await run({ oldRankId: 1, newRankId: 2 });
        expect(h.queries).toEqual([
            { table: 'users', op: 'select', columns: 'discord_id', eqs: [['id', 42]], single: true },
            { table: 'rank_mappings', op: 'select', columns: 'discord_role_id, rank_id, role_id', eqs: [] },
        ]);
    });

    it('rank change: removes the old rank role then adds the new one, leaving unrelated mappings alone', async () => {
        mappings([
            { discord_role_id: ROLE_A, rank_id: 2 },
            { discord_role_id: ROLE_B, rank_id: 1 },
            { discord_role_id: ROLE_C, rank_id: 3 },
        ]);
        await run({ oldRankId: 1, newRankId: 2 });
        expect(roleCalls()).toEqual([`DELETE ${ROLE_B}`, `PUT ${ROLE_A}`]);
        expect(calls().every(c => c.url.startsWith(`${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/`))).toBe(true);
        expect(h.logs).toEqual([{ level: 'info', msg: 'pushed role changes for user', fields: { userId: 42, added: [ROLE_A], removed: [ROLE_B] } }]);
    });

    it('ignores rank mappings entirely when no new rank is supplied', async () => {
        mappings([{ discord_role_id: ROLE_B, rank_id: 1 }]);
        await run({ oldRankId: 1 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([]);
    });

    it('platform role change: removes the old role mapping and adds the new one', async () => {
        mappings([
            { discord_role_id: ROLE_A, role_id: 6 },
            { discord_role_id: ROLE_B, role_id: 5 },
        ]);
        await run({ oldRoleId: 5, newRoleId: 6 });
        expect(roleCalls()).toEqual([`DELETE ${ROLE_B}`, `PUT ${ROLE_A}`]);
    });

    it('CONFLICT: a Discord role leaving via the old rank but arriving via the new role is added, never removed', async () => {
        mappings([
            { discord_role_id: ROLE_A, rank_id: 1 },
            { discord_role_id: ROLE_A, role_id: 6 },
        ]);
        await run({ oldRankId: 1, newRankId: 2, oldRoleId: 5, newRoleId: 6 });
        expect(roleCalls()).toEqual([`PUT ${ROLE_A}`]);
        expect(h.logs[0].fields).toEqual({ userId: 42, added: [ROLE_A], removed: [] });
    });

    it('a role-mapping removal is skipped when the same Discord role is being added by rank', async () => {
        mappings([
            { discord_role_id: ROLE_A, rank_id: 2 },
            { discord_role_id: ROLE_A, role_id: 5 },
        ]);
        await run({ oldRankId: 1, newRankId: 2, oldRoleId: 5, newRoleId: 7 });
        expect(roleCalls()).toEqual([`PUT ${ROLE_A}`]);
    });

    it('a Discord role mapped by both the new rank and the new role is added once', async () => {
        mappings([
            { discord_role_id: ROLE_A, rank_id: 2 },
            { discord_role_id: ROLE_A, role_id: 6 },
        ]);
        await run({ oldRankId: 1, newRankId: 2, oldRoleId: 5, newRoleId: 6 });
        expect(roleCalls()).toEqual([`PUT ${ROLE_A}`]);
    });

    it('a Discord role mapped by both the old rank and the old role is removed once', async () => {
        mappings([
            { discord_role_id: ROLE_A, rank_id: 1 },
            { discord_role_id: ROLE_A, role_id: 5 },
        ]);
        await run({ oldRankId: 1, newRankId: 2, oldRoleId: 5, newRoleId: 6 });
        expect(roleCalls()).toEqual([`DELETE ${ROLE_A}`]);
    });

    it('an unchanged rank/role is a no-op with no log', async () => {
        mappings([{ discord_role_id: ROLE_A, rank_id: 2 }, { discord_role_id: ROLE_B, role_id: 6 }]);
        await run({ oldRankId: 2, newRankId: 2, oldRoleId: 6, newRoleId: 6 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([]);
    });

    it('stops before reading mappings when the user has no Discord id', async () => {
        h.results['users.select'] = { data: { discord_id: null }, error: null };
        await run({ oldRankId: 1, newRankId: 2 });
        expect(h.queries.map(q => q.table)).toEqual(['users']);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('FAIL-SAFE: an unreadable user or mapping table pushes nothing', async () => {
        h.results['users.select'] = { data: null, error: { message: 'timeout' } };
        await run({ oldRankId: 1, newRankId: 2 });
        h.results['users.select'] = { data: { discord_id: USER_ID }, error: null };
        h.results['rank_mappings.select'] = { data: null, error: { message: 'timeout' } };
        await run({ oldRankId: 1, newRankId: 2 });
        mappings([]);
        await run({ oldRankId: 1, newRankId: 2 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a thrown failure is logged, never propagated (background push)', async () => {
        const boom = new Error('client exploded');
        h.fromThrows = boom;
        await expect(run({ oldRankId: 1, newRankId: 2 })).resolves.toBeUndefined();
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to push roles for user', fields: { userId: 42, err: boom } }]);
    });

    it('ROUTE-ID GUARD: a traversal mapping (as an import can carry) issues no request; valid mappings still apply', async () => {
        mappings([
            { discord_role_id: `../../../bans/${VICTIM}?x=`, rank_id: 2 },
            { discord_role_id: ROLE_A, rank_id: 2 },
        ]);
        await run({ oldRankId: 1, newRankId: 2 });
        expect(calls().map(c => c.url)).toEqual([`${API}/guilds/${GUILD_ID}/members/${USER_ID}/roles/${ROLE_A}`]);
    });
});
