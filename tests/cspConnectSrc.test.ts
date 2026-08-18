import { describe, it, expect } from 'vitest';
import { buildConnectSrc, originVariants, SUPABASE_WILDCARD, LIVEKIT_WILDCARD } from '../lib/cspConnectSrc';

// connect-src is what stops an injected script from shipping the session token
// off-origin. The list used to carry https://*.supabase.co and
// https://*.livekit.cloud unconditionally — and since anyone can register a free
// project on either platform, `<attacker>.supabase.co` was a valid exfiltration
// target even with the "explicit" allow-list in place. These pin the narrowing:
// the exact configured origin wins, and a wildcard only ever appears as a
// fallback for a host that genuinely is not known at header-build time.

describe('originVariants', () => {
    it('returns the https + wss forms of an https URL', () => {
        expect(originVariants('https://abc123.supabase.co')).toEqual([
            'https://abc123.supabase.co', 'wss://abc123.supabase.co',
        ]);
    });

    it('normalises a wss URL to the same pair', () => {
        expect(originVariants('wss://myorg.livekit.cloud')).toEqual([
            'https://myorg.livekit.cloud', 'wss://myorg.livekit.cloud',
        ]);
    });

    it('keeps a non-default port (a self-hosted Supabase or LiveKit)', () => {
        expect(originVariants('https://supabase.internal:8443')).toEqual([
            'https://supabase.internal:8443', 'wss://supabase.internal:8443',
        ]);
    });

    it('strips any path, query or fragment — only the host reaches the directive', () => {
        expect(originVariants('https://abc.supabase.co/rest/v1?k=1#x')).toEqual([
            'https://abc.supabase.co', 'wss://abc.supabase.co',
        ]);
    });

    it('returns [] for absent or unparseable input rather than emitting a broken token', () => {
        expect(originVariants(undefined)).toEqual([]);
        expect(originVariants(null)).toEqual([]);
        expect(originVariants('')).toEqual([]);
        expect(originVariants('not a url')).toEqual([]);
    });
});

describe('buildConnectSrc', () => {
    const full = { supabaseUrl: 'https://abc123.supabase.co', livekitUrl: 'wss://myorg.livekit.cloud' };

    it('pins the exact origins and emits NO platform wildcard when both are configured', () => {
        const csp = buildConnectSrc(full);
        expect(csp).toContain('https://abc123.supabase.co');
        expect(csp).toContain('wss://myorg.livekit.cloud');
        expect(csp).not.toContain('*');
    });

    it("always allows 'self' and the analytics beacon", () => {
        const csp = buildConnectSrc(full);
        expect(csp.startsWith("'self' ")).toBe(true);
        expect(csp).toContain('https://cloudflareinsights.com');
    });

    it('never emits a bare https: (that would allow every origin on the web)', () => {
        for (const input of [full, {}, { supabaseUrl: full.supabaseUrl }, { livekitUrl: full.livekitUrl }]) {
            expect(buildConnectSrc(input).split(' ')).not.toContain('https:');
        }
    });

    it('falls back to the platform wildcard only for the host it could not resolve', () => {
        // LiveKit unset: its URL may live in the admin-console settings row.
        const noLivekit = buildConnectSrc({ supabaseUrl: full.supabaseUrl });
        expect(noLivekit).toContain(LIVEKIT_WILDCARD[0]);
        expect(noLivekit).not.toContain(SUPABASE_WILDCARD[0]);
        expect(noLivekit).toContain('https://abc123.supabase.co');

        const noSupabase = buildConnectSrc({ livekitUrl: full.livekitUrl });
        expect(noSupabase).toContain(SUPABASE_WILDCARD[0]);
        expect(noSupabase).not.toContain(LIVEKIT_WILDCARD[0]);
    });

    it('an unparseable URL falls back rather than silently dropping the host', () => {
        // Dropping it would break the app; emitting a broken token would too.
        const csp = buildConnectSrc({ supabaseUrl: 'http://[bad', livekitUrl: 'also bad' });
        expect(csp).toContain(SUPABASE_WILDCARD[0]);
        expect(csp).toContain(LIVEKIT_WILDCARD[0]);
    });

    it('a self-hosted Supabase on a custom domain is pinned, not wildcarded', () => {
        const csp = buildConnectSrc({ supabaseUrl: 'https://db.myorg.example', livekitUrl: full.livekitUrl });
        expect(csp).toContain('https://db.myorg.example');
        expect(csp).toContain('wss://db.myorg.example');
        expect(csp).not.toContain('*');
    });
});
