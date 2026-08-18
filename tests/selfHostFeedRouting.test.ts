import { describe, it, expect } from 'vitest';
import { isSelfHostedUrl } from '../lib/selfHost';

// Guards the trust boundary in the intel feed sync (lib/db/intel.ts). Taking the
// "local" branch skips ssrfSafeFetch and substitutes a PRIVILEGED LOCAL READ
// (verifyApiKey + getPublicFeedData against this instance's own DB) whose result
// is then ingested as though the remote peer had served it — which can relink
// existing rows to a foreign feed and silently drop them from outbound
// federation.
//
// The old check was `url.toLowerCase().includes('.myrsi.org') ||
// ...includes('localhost')` over the WHOLE constructed URL, so the marker could
// sit in the path, query, fragment or userinfo, or be a suffix of an unrelated
// registrable domain.

const SELF = 'https://myorg.myrsi.org';

describe('isSelfHostedUrl — attacker-controlled URLs must not read as local', () => {
    const notLocal: Array<[string, string]> = [
        ['marker in the query string', 'https://evil.example/collect?ref=.myrsi.org/api/intel/feed'],
        ['marker in the path', 'https://evil.example/.myrsi.org/api/intel/feed'],
        ['marker in the fragment', 'https://evil.example/feed#localhost'],
        ['marker as a domain suffix', 'https://notmyrsi.org.evil.com/api/intel/feed'],
        ['marker in userinfo', 'https://.myrsi.org@evil.example/api/intel/feed'],
        ['localhost as a subdomain label', 'https://localhost.evil.example/api/intel/feed'],
        ['a different registrable domain entirely', 'https://evil.example/api/intel/feed'],
    ];

    for (const [name, url] of notLocal) {
        it(`rejects: ${name}`, () => {
            expect(isSelfHostedUrl(url, SELF), url).toBe(false);
        });
    }

    it('rejects a SIBLING deployment on the same platform — a different database', () => {
        // The substring check classified this as local and returned OUR data.
        expect(isSelfHostedUrl('https://allyorg.myrsi.org/api/intel/feed', SELF)).toBe(false);
    });
});

describe('isSelfHostedUrl — genuine local URLs still take the shortcut', () => {
    it('accepts our own host', () => {
        expect(isSelfHostedUrl('https://myorg.myrsi.org/api/intel/feed', SELF)).toBe(true);
        expect(isSelfHostedUrl('https://myorg.myrsi.org/api/intel/feed?since=2026-01-01', SELF)).toBe(true);
    });

    it('is case-insensitive on the hostname', () => {
        expect(isSelfHostedUrl('https://MyOrg.MyRSI.org/api/intel/feed', SELF)).toBe(true);
    });

    it('ignores port and scheme differences on our own host', () => {
        expect(isSelfHostedUrl('http://myorg.myrsi.org:8080/api/intel/feed', SELF)).toBe(true);
    });

    it('accepts loopback regardless of the configured self URL', () => {
        for (const u of ['http://localhost:3000/api/intel/feed', 'http://127.0.0.1:3000/api/intel/feed', 'http://[::1]:3000/api/intel/feed']) {
            expect(isSelfHostedUrl(u, SELF), u).toBe(true);
            expect(isSelfHostedUrl(u, undefined), u).toBe(true);
        }
    });

    it('accepts a self-hosted custom domain', () => {
        expect(isSelfHostedUrl('https://ops.myorg.example/api/intel/feed', 'https://ops.myorg.example')).toBe(true);
    });
});

describe('isSelfHostedUrl — fails closed', () => {
    it('an unparseable feed URL is not local', () => {
        for (const u of ['', 'not a url', '//evil.example', 'javascript:alert(1)']) {
            expect(isSelfHostedUrl(u, SELF), u).toBe(false);
        }
        expect(isSelfHostedUrl(null, SELF)).toBe(false);
        expect(isSelfHostedUrl(undefined, SELF)).toBe(false);
    });

    it('with no self URL configured, only loopback is local', () => {
        expect(isSelfHostedUrl('https://myorg.myrsi.org/api/intel/feed', undefined)).toBe(false);
        expect(isSelfHostedUrl('https://myorg.myrsi.org/api/intel/feed', '')).toBe(false);
        expect(isSelfHostedUrl('https://myorg.myrsi.org/api/intel/feed', 'not a url')).toBe(false);
        expect(isSelfHostedUrl('http://localhost/api/intel/feed', undefined)).toBe(true);
    });
});
