import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The GET /api/query `subset=settings` branch was a dead, ungated round-trip. It
// reduced EVERY settings row into one blob, had NO SUBSET_REQUIRED_PERMISSION
// entry (so any authenticated member — down to the lowest Client tier — could
// fetch it) and relied solely on stripSecrets. No client consumes it (config
// keys refresh via the 'main' subset). The branch is removed so an
// ?subset=settings probe falls through to the unknown-subset reject (mirroring
// the already-removed 'alliances' subset).
//
// These assert at the handler level:
//   1. An authenticated member probing ?subset=settings → 400 'Unknown subset',
//      and getAllSettings is NEVER called (proving the reduce-all-rows branch is
//      gone).
//   2. A low-privilege Client is equally rejected (no escalation surface).
//   3. A known subset ('main') still resolves — only the dead branch is gone.
//   4. stripSecrets — the backstop the live 'main' settings path still depends
//      on — strips admin_setup_code / geminiKey / active_eam / *_token.

const h = vi.hoisted(() => ({
    decoded: null as any,
    user: null as any,
    calls: { getAllSettings: 0, getMainState: 0 },
}));

// Chainable, awaitable Supabase stub (unused by the state path here, included to
// match the query-handler test precedent so any incidental access resolves).
function sbBuilder() {
    const b: any = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) {
        b[m] = () => b;
    }
    b.then = (resolve: any) => resolve({ count: 1, data: { id: 4 }, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    signRealtimeToken: () => 'rt',
}));
vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => { h.calls.getAllSettings++; return { discordConfig: {} }; },
    getMainState: async () => { h.calls.getMainState++; return { users: [] }; },
}));

import handler from '../api/query';
import { stripSecrets } from '../api/query';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function mockReq(query: any, token?: string) {
    return { method: 'GET', query, headers: token ? { authorization: `Bearer ${token}` } : {} } as any;
}

const clientUser = { id: 5, role: 'Client', permissions: [], auth_user_id: 'u5' };
const memberUser = { id: 6, role: 'Member', permissions: ['warrant:view', 'intel:view', 'hr:view'], auth_user_id: 'u6' };

beforeEach(() => {
    h.decoded = null; h.user = null;
    h.calls = { getAllSettings: 0, getMainState: 0 };
});

describe('GET /api/query?subset=settings — dead, ungated branch removed', () => {
    it('an authenticated Member probing ?subset=settings → 400 Unknown subset, settings never read', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'settings' }, 'tok'), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Unknown subset');
        // The reduce-EVERY-settings-row producer must not have run at all.
        expect(h.calls.getAllSettings).toBe(0);
        // No settings keys leaked onto the wire.
        expect(res.body.discordConfig).toBeUndefined();
        expect(res.body.platformSettings).toBeUndefined();
    });

    it('a low-privilege Client probing ?subset=settings is equally rejected (no escalation surface)', async () => {
        h.decoded = { userId: 5 }; h.user = clientUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'settings' }, 'tok'), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Unknown subset');
        expect(h.calls.getAllSettings).toBe(0);
    });

    it('an unauthenticated ?subset=settings probe is rejected before any DB read', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'settings' }), res);
        // No token → auth-required 403 (never reaches the switch / getAllSettings).
        expect(res.statusCode).toBe(403);
        expect(h.calls.getAllSettings).toBe(0);
    });

    it('a known subset (main) still resolves — only the dead branch is gone', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }, 'tok'), res);
        expect(res.statusCode).toBe(200);
        expect(h.calls.getMainState).toBe(1);
    });
});

// callerHasSubsetPermission carried a ctx parameter and a ctx-owner short-circuit left over
// from the multi-tenant build. Every call site passed null, so it was unreachable — but a
// future caller handing it a ctx would have reopened an owner bypass on every subset gate.
describe('callerHasSubsetPermission — the multi-tenant owner bypass is gone', () => {
    it('takes (currentUser, requiredPerm) only, and its body consults no ctx / owner field', () => {
        // Normalised: the tree is CRLF locally and LF in CI.
        const src = readFileSync(resolve(__dirname, '..', 'api', 'query.ts'), 'utf8').replace(/\r\n/g, '\n');
        const at = src.indexOf('function callerHasSubsetPermission(');
        expect(at, 'callerHasSubsetPermission was renamed').toBeGreaterThan(-1);
        const end = src.indexOf('\n}\n', at);
        expect(end).toBeGreaterThan(at);
        const fn = src.slice(at, end);
        expect(fn).toMatch(/^function callerHasSubsetPermission\(currentUser: any, requiredPerm: string\): boolean \{/);
        expect(fn).not.toMatch(/ownerId|auth_user_id|ctx/);
        // Every call site uses the two-argument form (no leftover null ctx).
        const calls = [...src.matchAll(/callerHasSubsetPermission\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => !/:\s/.test(a));
        expect(calls.length).toBeGreaterThanOrEqual(4);
        for (const args of calls) expect(args.split(',').length, args).toBe(2);
    });

    it('a member without the subset permission is refused even though their row carries an auth_user_id', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser; // holds warrant/intel/hr view, NOT operations:view
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'operations' }, 'tok'), res);
        expect(res.statusCode).toBe(403);
    });
});

describe('stripSecrets — backstop the live settings path (subset=main) still relies on', () => {
    it('drops admin_setup_code / geminiKey / active_eam / *_token; preserves non-secret fields', () => {
        const out = stripSecrets({
            admin_setup_code: 'SETUP-DEADBEEF',
            geminiKey: 'AIza-secret',
            active_eam: 'classified EAM body',
            bot_token: 'discord-bot-token',
            some_api_key: 'k',
            discordConfig: { clientId: 'cid', botToken: 'bt', newRequestChannelId: 'ch' },
            brandingName: 'Acme',
        });
        expect(out.admin_setup_code).toBeUndefined();
        expect(out.geminiKey).toBeUndefined();
        expect(out.active_eam).toBeUndefined();
        expect(out.bot_token).toBeUndefined();
        expect(out.some_api_key).toBeUndefined();
        // discordConfig is rebuilt from an allowlist → secret botToken dropped,
        // public clientId kept.
        expect(out.discordConfig.botToken).toBeUndefined();
        expect(out.discordConfig.clientId).toBe('cid');
        // Non-secret fields are preserved.
        expect(out.brandingName).toBe('Acme');
    });
});
