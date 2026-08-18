import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// HANDOFF s5-2 / s5-3: the security-header middleware + slowloris timeouts.
// server.ts builds an Express app at module scope (and binds a real socket on
// main-module import), so this pins the configuration at the source rather than
// booting the server. A revert that drops any of these would re-fail here.
const src = readFileSync(join(resolve(__dirname, '..'), 'server.ts'), 'utf8');

describe('security headers (s5-2)', () => {
    it('disables the legacy XSS auditor (X-XSS-Protection: 0)', () => {
        expect(src).toMatch(/setHeader\('X-XSS-Protection',\s*'0'\)/);
        expect(src).not.toMatch(/X-XSS-Protection',\s*'1; mode=block'/);
    });
    it('sets Cross-Origin-Opener-Policy: same-origin', () => {
        expect(src).toMatch(/setHeader\('Cross-Origin-Opener-Policy',\s*'same-origin'\)/);
    });
    it('sets a Permissions-Policy that denies camera/geo/payment/usb and allows microphone=(self)', () => {
        expect(src).toMatch(/setHeader\('Permissions-Policy',/);
        expect(src).toMatch(/camera=\(\)/);
        expect(src).toMatch(/microphone=\(self\)/);
    });
    it("CSP carries object-src 'none' and frame-ancestors 'none'", () => {
        expect(src).toMatch(/object-src 'none'/);
        expect(src).toMatch(/frame-ancestors 'none'/);
    });
    // These four were set in server.ts but not pinned, so a refactor dropping any of
    // them would still pass. Pin them at the source.
    it('sets X-Content-Type-Options: nosniff', () => {
        expect(src).toMatch(/setHeader\('X-Content-Type-Options',\s*'nosniff'\)/);
    });
    it('sets X-Frame-Options: DENY', () => {
        expect(src).toMatch(/setHeader\('X-Frame-Options',\s*'DENY'\)/);
    });
    it('sets Referrer-Policy: strict-origin-when-cross-origin', () => {
        expect(src).toMatch(/setHeader\('Referrer-Policy',\s*'strict-origin-when-cross-origin'\)/);
    });
    it('sets HSTS (Strict-Transport-Security) in production', () => {
        expect(src).toMatch(/setHeader\('Strict-Transport-Security',\s*'max-age=\d+; includeSubDomains'\)/);
    });
    // connect-src must not use a bare `https:` (that would allow sending to any
    // origin). It is built from an explicit allow-list constant, itself produced
    // by the pure builder in lib/cspConnectSrc.ts. The builder's contract (exact
    // origins pinned, platform wildcard only as a fallback) is covered in
    // tests/cspConnectSrc.test.ts; this pins the wiring.
    it('CSP connect-src is an explicit allow-list, not bare https:', () => {
        expect(src).toMatch(/connect-src \$\{CSP_CONNECT_SRC\}/);
        expect(src).not.toMatch(/connect-src 'self' https:/);
    });

    it('connect-src is built by the pure builder, from the environment', () => {
        expect(src).toMatch(/import \{ buildConnectSrc \} from '\.\/lib\/cspConnectSrc\.js'/);
        expect(src).toMatch(/const CSP_CONNECT_SRC = buildConnectSrc\(/);
        expect(src).toMatch(/supabaseUrl: process\.env\.SUPABASE_URL/);
        expect(src).toMatch(/livekitUrl: process\.env\.LIVEKIT_URL/);
        // The platform wildcards must not be hardcoded into the header any more:
        // they belong in the builder's fallback arm, reached only when the exact
        // origin is unknown.
        expect(src).not.toMatch(/'https:\/\/\*\.supabase\.co'/);
        expect(src).not.toMatch(/'https:\/\/\*\.livekit\.cloud'/);
    });
});

describe('slowloris timeouts (s5-3)', () => {
    it('sets requestTimeout and headersTimeout on the inbound server', () => {
        expect(src).toMatch(/server\.requestTimeout\s*=/);
        expect(src).toMatch(/server\.headersTimeout\s*=/);
    });
});

describe('terminal recovery handler (s5-10a) + AI-limiter prune (s5-5b)', () => {
    it('has a terminal app.all that 303-redirects to a hardcoded "/"', () => {
        expect(src).toMatch(/app\.all\(/);
        expect(src).toMatch(/res\.redirect\(303,\s*'\/'\)/);
    });
    it('wires the AI rate-limit prune into the periodic sweep', () => {
        expect(src).toMatch(/pruneAiRateLimitBuckets\(/);
    });
});

describe('client-IP trust is secure by default', () => {
    it("TRUST_PROXY_HOPS defaults to 0 (uses the unspoofable socket peer)", () => {
        expect(src).toMatch(/TRUST_PROXY_HOPS \?\? '0'/);
        expect(src).not.toMatch(/TRUST_PROXY_HOPS \?\? '1'/);
    });
    it('the abuse blackhole exempts loopback (no self-DoS behind a same-host proxy)', () => {
        expect(src).toMatch(/isLoopbackIp\(ip\)/);
    });
});
