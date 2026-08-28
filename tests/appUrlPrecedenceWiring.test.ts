import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// tests/appUrlResolver.test.ts pins the PURE resolver. This file pins the WIRING — the
// half that actually ships behaviour.
//
// Why it has to exist separately: lib/db.ts and lib/db/alliances.ts both call
// `resolveAppUrl(process.env.APP_URL, stored)`, and both parameters are strings. Swap
// them and you get `resolveAppUrl(stored, process.env.APP_URL)` — stored wins again,
// which is exactly the reported bug — and it type-checks, lints, and leaves the resolver
// suite entirely green. So does restoring the old `if (appUrl) return appUrl;` body.
// Per CLAUDE.md, security behaviour without a pinning test is considered unshipped, and
// this value decides what origin is embedded in every Discord announcement and
// advertised to every federation peer.
//
// The scenario below is the operator's: a database restored onto a new host still
// carries the OLD deployment's origin in settings.systemConfig.appUrl, while .env on
// the new host is correct.

const h = vi.hoisted(() => ({ storedAppUrl: undefined as string | undefined }));

vi.mock('../lib/db/common', () => {
    const settingsRow = () => ({
        select: () => ({
            eq: () => ({
                maybeSingle: async () => ({
                    data: h.storedAppUrl === undefined ? null : { value: { appUrl: h.storedAppUrl } },
                    error: null,
                }),
            }),
        }),
    });
    return {
        supabase: { from: () => settingsRow() },
        handleSupabaseError: () => {},
        getSystemRoles: async () => ({}),
        broadcastToOrg: () => {},
    };
});

import { getOrgTenantUrl, resolveOrgAppUrl } from '../lib/db';

const ENV_HOST = 'https://new-host.myorg-example-a.com';
const OLD_HOST = 'https://old-host.myorg-example-b.com';

let savedAppUrl: string | undefined;

beforeEach(() => {
    savedAppUrl = process.env.APP_URL;
    h.storedAppUrl = undefined;
});

afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
});

describe('getOrgTenantUrl — env-first wiring (the migration bug)', () => {
    it('returns APP_URL, not the stale origin the restored database carries', async () => {
        process.env.APP_URL = ENV_HOST;
        h.storedAppUrl = OLD_HOST;

        // Before the fix this returned OLD_HOST, and Discord announcements linked to
        // the old deployment no matter what .env said.
        expect(await getOrgTenantUrl()).toBe(ENV_HOST);

        const resolved = await resolveOrgAppUrl();
        expect(resolved.source).toBe('env');
        expect(resolved.drift).toEqual({ env: ENV_HOST, stored: OLD_HOST });
    });

    it('still honours the stored value when APP_URL is unset — no regression for older installs', async () => {
        delete process.env.APP_URL;
        h.storedAppUrl = OLD_HOST;

        expect(await getOrgTenantUrl()).toBe(OLD_HOST);
        expect((await resolveOrgAppUrl()).source).toBe('stored');
    });

    it('ignores an APP_URL left at the .env.example placeholder rather than publishing it', async () => {
        process.env.APP_URL = 'https://yourdomain.com';
        h.storedAppUrl = OLD_HOST;

        expect(await getOrgTenantUrl()).toBe(OLD_HOST);
        const resolved = await resolveOrgAppUrl();
        expect(resolved.source).toBe('stored');
        expect(resolved.rejected).toEqual([{ source: 'env', value: 'https://yourdomain.com', reason: 'placeholder' }]);
    });

    it('reports the localhost fallback as such when neither source is configured', async () => {
        delete process.env.APP_URL;
        h.storedAppUrl = undefined;

        const resolved = await resolveOrgAppUrl();
        expect(resolved.source).toBe('fallback');
        expect(await getOrgTenantUrl()).toBe(resolved.url);
    });

    it('normalises a trailing slash so deep links do not double up separators', async () => {
        process.env.APP_URL = `${ENV_HOST}/`;
        h.storedAppUrl = undefined;

        const base = await getOrgTenantUrl();
        expect(base).toBe(ENV_HOST);
        // The shape api/actions/operations.ts builds for the announcement embed.
        expect(`${base}/operations/abc`).toBe(`${ENV_HOST}/operations/abc`);
    });
});
