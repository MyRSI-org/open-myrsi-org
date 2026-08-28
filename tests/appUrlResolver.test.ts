import { describe, it, expect } from 'vitest';
import { resolveAppUrl, APP_URL_FALLBACK } from '../lib/appUrl';

// Pins the precedence for THIS deployment's own public origin — the value that goes
// into Discord announcement deep links (api/actions/operations.ts buildAnnouncementEmbedInput),
// into a Discord scheduled event's location, and onto the wire as `fromBaseUrl` in the
// alliance pairing handshake (lib/db/alliances.ts getOurOrigin).
//
// The bug this replaces: the stored `settings.systemConfig.appUrl` row WON over
// process.env.APP_URL. That row is org data and survives a pg_dump/restore, so an org
// migrated to a new host kept publishing links to the OLD deployment no matter what the
// operator put in .env — only hand-written SQL against the settings table fixed it.
//
// Env-first matches the rest of the project (lib/secrets.ts getOrgSecret is
// `process.env[key] || storedValue`, pinned by tests/envPrecedenceOverDb.test.ts).
// The resolver is pure, so this file needs no mocking and no process.env juggling.

const ENV = 'https://new-host.example-org.com';
const STORED = 'https://old-host.example-org.com';

describe('resolveAppUrl — precedence', () => {
    it('ENV wins over a conflicting stored value (the migration case)', () => {
        const r = resolveAppUrl(ENV, STORED);
        expect(r.url).toBe(ENV);
        expect(r.source).toBe('env');
    });

    it('reports the drift so a stale stored value is diagnosable from the boot log', () => {
        expect(resolveAppUrl(ENV, STORED).drift).toEqual({ env: ENV, stored: STORED });
    });

    it('reports no drift when the two agree, or when only one is set', () => {
        expect(resolveAppUrl(ENV, ENV).drift).toBeUndefined();
        expect(resolveAppUrl(ENV, undefined).drift).toBeUndefined();
        expect(resolveAppUrl(undefined, STORED).drift).toBeUndefined();
    });

    it('falls back to the stored value when env is unset/blank — installs that predate APP_URL keep working', () => {
        for (const empty of [undefined, null, '', '   ']) {
            const r = resolveAppUrl(empty, STORED);
            expect(r.url).toBe(STORED);
            expect(r.source).toBe('stored');
            expect(r.rejected).toEqual([]);
        }
    });

    it('falls back to localhost, flagged as such, when neither is set', () => {
        const r = resolveAppUrl(undefined, undefined);
        expect(r.url).toBe(APP_URL_FALLBACK);
        expect(r.source).toBe('fallback');
    });
});

describe('resolveAppUrl — normalisation', () => {
    it('strips trailing slashes so call sites need no ad-hoc .replace(/\\/$/)', () => {
        expect(resolveAppUrl('https://host.test-org.com/', undefined).url).toBe('https://host.test-org.com');
        expect(resolveAppUrl('https://host.test-org.com///', undefined).url).toBe('https://host.test-org.com');
    });

    it('treats a value differing only by trailing slash as agreeing, not drifting', () => {
        expect(resolveAppUrl('https://host.test-org.com/', 'https://host.test-org.com').drift).toBeUndefined();
    });

    it('preserves a path prefix (deployments served under a sub-path)', () => {
        expect(resolveAppUrl('https://host.test-org.com/myrsi', undefined).url).toBe('https://host.test-org.com/myrsi');
    });

    it('trims surrounding whitespace from a hand-edited .env line', () => {
        expect(resolveAppUrl('  https://host.test-org.com  ', undefined).url).toBe('https://host.test-org.com');
    });

    // The result is built from the PARSE, not the operator's raw text. `new URL()`
    // accepts far more than string concatenation does, so returning the input verbatim
    // shipped broken links: `https:/host` became `https:/host/operations/42` in a
    // Discord embed — not a link to the host at all.
    it.each([
        ['single-slash typo', 'https:/host.test-org.com'],
        ['backslash typo', 'https:\\\\host.test-org.com'],
        ['uppercase scheme and host', 'HTTPS://Host.Test-Org.Com'],
        ['explicit default port', 'https://host.test-org.com:443'],
    ])('normalises a %s to the real origin', (_label, value) => {
        expect(resolveAppUrl(value, undefined).url).toBe('https://host.test-org.com');
    });

    it('does not report drift between values that are the same origin written differently', () => {
        expect(resolveAppUrl('HTTPS://Host.Test-Org.Com:443/', 'https://host.test-org.com').drift).toBeUndefined();
    });
});

describe('resolveAppUrl — a bad candidate is SKIPPED, never returned', () => {
    // Skipping rather than returning is the point: a malformed APP_URL must fall
    // through to the stored value instead of poisoning every published link.
    const bad: Array<[string, unknown, string]> = [
        ['unparseable', 'not a url', 'unparseable'],
        ['scheme-relative', '//host.test-org.com', 'unparseable'],
        ['bare host, no scheme', 'host.test-org.com', 'unparseable'],
        ['non-http scheme', 'ftp://host.test-org.com', 'not-http'],
        ['javascript:', 'javascript:alert(1)', 'not-http'],
        // A query/fragment can never be a base: `${url}/operations/42` would append
        // the path INTO the query string.
        ['query string', 'https://host.test-org.com?x=1', 'not-a-base'],
        ['fragment', 'https://host.test-org.com#frag', 'not-a-base'],
    ];

    it.each(bad)('%s falls through to the stored value and is reported', (_label, value, reason) => {
        const r = resolveAppUrl(value, STORED);
        expect(r.url).toBe(STORED);
        expect(r.source).toBe('stored');
        expect(r.rejected).toEqual([{ source: 'env', value: String(value).trim(), reason }]);
    });

    // Rule 5. The `userinfo` rejection fires precisely BECAUSE the string holds a
    // password, and server.ts writes rejected[].value into the boot log — which goes to
    // stderr and on to whatever aggregator the host ships to. lib/log.ts does not save
    // us: it redacts by field KEY, and value-scans only Errors and stringified objects,
    // never a plain string field.
    it('REDACTS credentials out of the reported value instead of logging them', () => {
        const r = resolveAppUrl('https://svc:S3cretPw@host.test-org.com/base', STORED);
        expect(r.url).toBe(STORED);
        expect(r.rejected).toEqual([
            { source: 'env', value: 'https://[redacted]@host.test-org.com/base', reason: 'userinfo' },
        ]);
        expect(JSON.stringify(r)).not.toContain('S3cretPw');
        expect(JSON.stringify(r)).not.toContain('svc:');
    });

    it('rejects a bad STORED value too, falling back to localhost', () => {
        const r = resolveAppUrl(undefined, 'not a url');
        expect(r.url).toBe(APP_URL_FALLBACK);
        expect(r.source).toBe('fallback');
        expect(r.rejected).toEqual([{ source: 'stored', value: 'not a url', reason: 'unparseable' }]);
    });

    it('does not report a merely-absent candidate as rejected (that is the normal case)', () => {
        expect(resolveAppUrl(undefined, STORED).rejected).toEqual([]);
        expect(resolveAppUrl('', '').rejected).toEqual([]);
    });

    it('ignores a non-string stored value rather than throwing', () => {
        for (const junk of [42, {}, [], true]) {
            expect(resolveAppUrl(undefined, junk).source).toBe('fallback');
        }
    });
});

describe('resolveAppUrl — placeholder hostnames are ignored', () => {
    // .env.example used to ship APP_URL=https://yourdomain.com POPULATED, so
    // "copied the example, never edited line 14" is a real population. Under env-first
    // an unedited placeholder would otherwise beat a correct stored value and publish
    // links to a domain the operator does not control. Matched on HOSTNAME, so the
    // half-edited near-misses are caught too.
    const placeholders = [
        'https://yourdomain.com',
        'https://yourdomain.com/',
        'http://yourdomain.com',
        'https://www.yourdomain.com',
        'https://app.yourdomain.com',
        'https://YourDomain.com',
        'https://example.com',
        'https://example.org',
        'https://myorg.example.net',
        'https://myrsi.invalid',
        'https://myrsi.test',
    ];

    it.each(placeholders)('%s is skipped in favour of the real stored value', (value) => {
        const r = resolveAppUrl(value, STORED);
        expect(r.url).toBe(STORED);
        expect(r.source).toBe('stored');
        expect(r.rejected).toEqual([{ source: 'env', value: value.trim(), reason: 'placeholder' }]);
    });

    // The population the placeholder check actually exists for: a fresh install that
    // copied .env.example and never edited the APP_URL line. lib/db/seeder.ts seeds
    // appUrl: '', so there is NO stored value to fall back to — without this case the
    // suite would stay green even if isPlaceholderHost were gutted, because every other
    // placeholder row is rescued by STORED.
    it.each(['', undefined])('falls all the way to localhost when the placeholder is all there is (stored=%p)', (stored) => {
        const r = resolveAppUrl('https://yourdomain.com', stored);
        expect(r.url).toBe(APP_URL_FALLBACK);
        expect(r.source).toBe('fallback');
        expect(r.rejected).toEqual([{ source: 'env', value: 'https://yourdomain.com', reason: 'placeholder' }]);
    });

    it('rejects a placeholder on the STORED side too', () => {
        const r = resolveAppUrl(undefined, 'https://yourdomain.com');
        expect(r.source).toBe('fallback');
        expect(r.rejected).toEqual([{ source: 'stored', value: 'https://yourdomain.com', reason: 'placeholder' }]);
    });

    it('is not fooled by the fully-qualified trailing-dot form', () => {
        expect(resolveAppUrl('https://yourdomain.com.', STORED).source).toBe('stored');
    });

    it('does not mistake a real domain that merely contains the placeholder for one', () => {
        for (const real of ['https://yourdomain.com.au', 'https://notyourdomain.com', 'https://example.company']) {
            expect(resolveAppUrl(real, STORED).source).toBe('env');
        }
    });

    it('still allows localhost — it is the documented dev origin, not a placeholder', () => {
        expect(resolveAppUrl('http://localhost:3000', STORED).source).toBe('env');
    });
});
