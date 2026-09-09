
import express from 'express';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { getClientIp } from './lib/clientIp.js';
import { getBuildId } from './lib/buildId.js';
import { SESSION_COOKIE_IS_SECURE, credentialFromRequest, clearSessionCookie } from './lib/sessionCookie.js';
import { checkRequestOrigin, allowedOriginsFor } from './lib/csrfOrigin.js';
import { pruneUserRateLimitBuckets } from './lib/userRateLimit.js';
import { buildConnectSrc } from './lib/cspConnectSrc.js';
import { pruneAuthRateLimitBuckets } from './lib/authRateLimit.js';
import orgUploadHandler, { pruneOrgUploadBuckets } from './api/orgUpload.js';
import { MAX_UPLOAD_BYTES } from './lib/storage.js';
import { runOrgMediaGc } from './lib/orgMediaGc.js';
import { pruneAiRateLimitBuckets } from './lib/aiRateLimit.js';
import { pruneSubmissionRateLimitBuckets } from './lib/submissionRateLimit.js';
import { pruneRadioRateLimitBuckets } from './lib/radio.js';
import { log as baseLog } from './lib/log.js';

const log = baseLog.child({ module: 'server' });

// Scanner-path early 404 + per-IP abuse blackhole. Lives at the top of the
// middleware stack so probes never reach body parsing, static, or any
// downstream handler. Client IP extraction is in lib/clientIp.ts.

/**
 * Paths matched here are returned 404 immediately with deduped logging. They
 * are scanner/probe paths with no legitimate use on this site. Update
 * sparingly — a path that overlaps a real route would 404 real users.
 */
const SCANNER_PATH_RE = /^\/(wp-|wordpress|xmlrpc\.php|\.git\b|\.env\b|\.aws\b|\.svn\b|cgi-bin|phpmyadmin|phpMyAdmin|admin\.php|setup\.php|server-status|server-info|wp\d*\/|blog\/wp-|web\/wp-|website\/wp-|news\/wp-|shop\/wp-|cms\/wp-|sito\/wp-|test\/wp-|site\/wp-|wp\/wp-|\d{4}\/wp-)/i;

interface AbuseTracker {
    count: number;        // total bad requests in the current sliding window
    firstSeen: number;    // window start
    blockedUntil: number; // epoch ms; 0 if not blocked
}
const ipAbuseTracker = new Map<string, AbuseTracker>();
const ABUSE_WINDOW_MS = 60_000;       // sliding window for counting
const ABUSE_THRESHOLD = 20;           // bad requests to trip blackhole
const BLOCK_DURATION_MS = 5 * 60_000; // 5 minutes
const MAX_TRACKER_ENTRIES = 5_000;    // hard cap; sheds new entries when full to prevent memory blowup from spray attacks

const lastScannerLog = new Map<string, number>();
const SCANNER_LOG_DEDUPE_MS = 60_000;

// Periodic cleanup of expired trackers. .unref() so this timer doesn't keep
// the process alive on shutdown.
setInterval(() => {
    const now = Date.now();
    for (const [ip, t] of ipAbuseTracker) {
        if (t.blockedUntil < now && (now - t.firstSeen) > ABUSE_WINDOW_MS * 5) {
            ipAbuseTracker.delete(ip);
        }
    }
    for (const [ip, ts] of lastScannerLog) {
        if (now - ts > SCANNER_LOG_DEDUPE_MS * 5) lastScannerLog.delete(ip);
    }
    pruneAuthRateLimitBuckets(now);
    pruneOrgUploadBuckets(now);
    pruneAiRateLimitBuckets(now);
    // These two were exported and tested but NEVER called in production, so their maps only
    // grew; once full, their shed-on-full branch permits every untracked key and the throttle
    // quietly stops working until a restart. Wired here with the new per-user one.
    pruneSubmissionRateLimitBuckets(now);
    pruneRadioRateLimitBuckets(now);
    pruneUserRateLimitBuckets(now);
}, 60_000).unref?.();

function bumpAbuseCounter(ip: string): void {
    // Never blackhole an unidentified caller or our own loopback (a same-host reverse
    // proxy appears as loopback under the secure default) — that would 404 everyone.
    if (ip === 'unknown' || isLoopbackIp(ip)) return;
    const now = Date.now();
    let t = ipAbuseTracker.get(ip);
    if (!t) {
        // Evict to make room when the cap is hit rather than stop tracking new
        // IPs (which a spray attack could exploit to pin out everyone's
        // protection). Prefer evicting an already-expired block; otherwise drop
        // the oldest entry (Map iteration is insertion order).
        if (ipAbuseTracker.size >= MAX_TRACKER_ENTRIES) {
            let evicted = false;
            for (const [oldIp, oldT] of ipAbuseTracker) {
                if (oldT.blockedUntil < now) {
                    ipAbuseTracker.delete(oldIp);
                    evicted = true;
                    break;
                }
            }
            if (!evicted) {
                const oldest = ipAbuseTracker.keys().next().value;
                if (oldest) ipAbuseTracker.delete(oldest);
            }
        }
        t = { count: 0, firstSeen: now, blockedUntil: 0 };
        ipAbuseTracker.set(ip, t);
    }
    if (now - t.firstSeen > ABUSE_WINDOW_MS) {
        t.count = 0;
        t.firstSeen = now;
    }
    t.count += 1;
    if (t.count >= ABUSE_THRESHOLD && t.blockedUntil < now) {
        t.blockedUntil = now + BLOCK_DURATION_MS;
        log.info('ip blackholed', { ip, blockSeconds: BLOCK_DURATION_MS / 1000, badRequests: t.count, windowSeconds: ABUSE_WINDOW_MS / 1000 });
    }
}

function isBlocked(ip: string): boolean {
    const t = ipAbuseTracker.get(ip);
    return !!t && t.blockedUntil > Date.now();
}

// Handler imports use .js extensions: we compile to dist-server/, so these
// relative imports resolve against the compiled output (Node16 resolution).
import handlerFn from './api/index.js';
import servicesFn, { validatePermissionMap } from './api/services.js';
import queryFn, { handleManifest } from './api/query.js';
import swFn from './api/sw.js';
import publicFn from './api/public.js';
import { respondToPair as allianceRespondToPair, getAllianceSelfProfile as allianceGetSelfProfile, getAlliancePeerByInboundKey as allianceGetPeerByInboundKey, getAllianceShareableData as allianceGetShareableData,
    getOperationSnapshotForPeer, getOperationManifestForPeer, acceptInviteForPeer, declineInviteForPeer, upsertAlliedParticipant, removeAlliedParticipant,
    receiveMirrorInvite, receiveMirrorPush, receiveMirrorRevoke,
    getAllyRosterProjection, getAllyFleetProjection, getUserById, importOrgData, ImportRefusedError, getPlatformSettings, resolveOrgAppUrl,
    findActiveBan } from './lib/db.js';
import { runFirstBootCheck } from './lib/firstBoot.js';
import { findMissingApiKeyColumns } from './lib/db/system.js';
import { verifyToken, signToken, isSessionForceLoggedOut, isSessionRevokedByWatermark } from './lib/auth.js';
import { counts404TowardAbuse, isLoopbackIp } from './lib/abuseFilter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fail fast at startup if required config is missing in production — catches
// misconfig on boot instead of on the first DB query / first token verify.
// Single-org self-hosted: no Stripe/billing — the server just needs its
// Supabase connection. (JWT_SECRET is validated separately in lib/auth.ts.)
if (process.env.NODE_ENV === 'production') {
    const requiredEnvVars: Array<[string, string]> = [
        ['SUPABASE_URL', 'The Supabase project URL — the server cannot reach the database without it.'],
        ['SUPABASE_SERVICE_ROLE_KEY', 'The Supabase service-role key — required for all server-side database access.'],
        // Encryption-at-rest for admin-entered secrets is mandatory; encryptSecret
        // fails closed without this key. Surface the failure at boot rather than
        // deferring it to the first secret save.
        ['SECRETS_ENCRYPTION_KEY', 'Required to encrypt admin-entered secrets at rest. Generate with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`.'],
    ];
    const missing = requiredEnvVars.filter(([name]) => !process.env[name]);
    if (missing.length > 0) {
        for (const [name, hint] of missing) {
            log.error('required env var not set', { name, hint });
        }
        throw new Error(`Startup aborted: missing required env vars: ${missing.map(m => m[0]).join(', ')}`);
    }
    // The encryption key derives the AES-256-GCM master key (scrypt, fixed
    // salt), so a short/low-entropy value weakens every encrypted secret —
    // reject < 32 chars at boot. The salt is fixed (baked into every existing
    // ciphertext); rotating it would make stored secrets undecryptable.
    const encKey = process.env.SECRETS_ENCRYPTION_KEY || '';
    if (encKey.length < 32) {
        log.error('SECRETS_ENCRYPTION_KEY too short', { length: encKey.length, hint: 'Use >= 32 chars. Generate with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`.' });
        throw new Error('Startup aborted: SECRETS_ENCRYPTION_KEY must be at least 32 characters.');
    }
}

const app = express();
// `trust proxy` controls how req.ip resolves X-Forwarded-For, and req.ip backs
// every IP-keyed control (see lib/clientIp.ts). SECURE BY DEFAULT: 0 = trust no
// forwarded header and use the real TCP socket peer, which a client cannot spoof.
// That's correct for a directly-exposed Node (the common self-host) out of the box —
// no X-Forwarded-For spoofing, limiter-bypass, or victim-framing. Operators running
// a reverse proxy set TRUST_PROXY_HOPS to the number of proxies in front (1 for a
// single TLS terminator, 2+ for CDN→LB→app) so req.ip becomes the real client.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? '0');
app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 0);
// Don't advertise the framework — drop the default `X-Powered-By: Express` header so
// responses carry no free server fingerprint.
app.disable('x-powered-by');
const port = process.env.PORT || 3000;

// --- Early scanner / blackhole gate ---
// First middleware in the chain so blocked IPs and known-scanner paths
// never trigger body parsing, static lookup, or any downstream handler.
// Stashes the resolved client IP on req for downstream use.
app.use((req, res, next) => {
    const ip = getClientIp(req);
    (req as any)._clientIp = ip;

    if (isBlocked(ip)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).send('Not Found');
    }
    if (SCANNER_PATH_RE.test(req.path)) {
        bumpAbuseCounter(ip);
        const now = Date.now();
        const last = lastScannerLog.get(ip) || 0;
        if (now - last > SCANNER_LOG_DEDUPE_MS) {
            log.info('scanner probe', { ip, method: req.method, path: req.path });
            lastScannerLog.set(ip, now);
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).send('Not Found');
    }
    next();
});

/** Did this request arrive over HTTPS? Per-request, and used ONLY for deriving the set of
 *  origins that count as ours — never for choosing a cookie name. */
function isRequestSecure(req: express.Request): boolean {
    return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

/**
 * The session cookie's mode, resolved ONCE at boot.
 *
 * Deliberately a process constant rather than a per-request decision: a mode derived from
 * X-Forwarded-Proto could flap on a spoofed header, and a flapping mode would accept an
 * attacker-settable plain-name cookie on an HTTPS origin. One deployment has one scheme.
 */

if (!SESSION_COOKIE_IS_SECURE) {
    // Loud, because the trade-off is real and invisible otherwise: without Secure the session
    // cookie can be sent over plain HTTP, so anyone on the network path can read it. The
    // alternative — setting Secure anyway — means the browser silently never stores it and
    // NOBODY CAN LOG IN, with no error message anywhere. Working-and-warned beats
    // strict-and-silently-broken.
    log.warn('session cookie will NOT be marked Secure', {
        reason: 'APP_URL is not https:// (or SESSION_COOKIE_SECURE=0)',
        effect: 'The session cookie can travel over plain HTTP. Fine on a trusted LAN; not fine on the internet.',
        fix: 'Serve over HTTPS and set APP_URL=https://your.domain, or set SESSION_COOKIE_SECURE=1 if TLS terminates upstream.',
    });
}

// ---------------------------------------------------------------------------
// CSRF ORIGIN GATE — must run BEFORE body parsing.
//
// The session credential can now ride an HttpOnly cookie, and the browser attaches a cookie to
// every request to this origin whoever caused it. SameSite=Lax is a partial control only (it
// still permits top-level GET navigation, and this app's reads are GETs on /api/query), so the
// cookie-authenticated surfaces additionally demand positive evidence that the request came
// from our own page.
//
// Mounted on the FOUR BROWSER paths by name, never on `/api` as a whole. /api/alliance/* is
// deliberately excluded: those are SERVER-TO-SERVER calls authenticated by x-api-key, a peer has
// no Origin header to send, and seven of them are POSTs — mounting this on /api would hard-403
// pairing and mirror-push while leaving the GET routes working, which is a partial break and
// therefore a harder one to diagnose.
//
// Placed before the parsers so a rejected cross-site request never has its body read.
const CSRF_GUARDED_PATHS = ['/api/services', '/api/query', '/api/admin/import-stream', '/api/org/upload'];

const csrfOriginGate: express.RequestHandler = (req, res, next) => {
    // Unauthenticated public reads have no cookie to abuse and must stay reachable from a
    // link, a crawler, or the PWA manifest fetch. GET-only, so it cannot relax a mutation, and
    // none of the three can reach session-authenticated data.
    const target = typeof req.query?.target === 'string' ? req.query.target : '';
    if (req.method === 'GET' && (target === 'config' || target === 'manifest' || target === 'feed')) return next();

    const secure = isRequestSecure(req);
    const host = (req.headers['x-forwarded-host'] || req.headers['host'] || '') as string;
    const verdict = checkRequestOrigin({
        method: req.method,
        origin: req.headers['origin'] as string | undefined,
        secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
        allowedOrigins: allowedOriginsFor(host, secure, process.env.APP_URL),
    });
    if (verdict === 'deny') {
        // NOT audited to the durable trail. This runs before ANY rate limiter, on a path
        // reachable without a credential, so an emit here is one durable IP-bearing row per
        // request — trivially amplified with a bogus Origin from many addresses, and retained
        // for a year. api/orgUpload.ts refuses its own pre-auth cross-site emit for exactly
        // this reason; the two surfaces stay at parity. A deduped log line is the right sink.
        log.warn('cross-site request blocked', {
            path: req.originalUrl,
            method: req.method,
            secFetchSite: req.headers['sec-fetch-site'] ?? null,
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).json({ message: 'Forbidden: cross-site request blocked' });
    }
    return next();
};

// MOUNTED PER PATH, not matched with `req.path === …`. Express routes with `strict routing` and
// `case sensitive routing` BOTH DISABLED by default, so `/api/services/` and `/API/services`
// reach the same handler — while an exact-string `includes(req.path)` misses them. That is a
// complete bypass of this gate, and SameSite=Lax does not cover it: a page on a sibling origin
// can POST to `https://org.example/api/services/`, the browser attaches the session cookie, and
// the mutation executes as the victim. `app.use(path, …)` applies Express's own normalisation,
// so the mount matches every form the router does.
for (const guardedPath of CSRF_GUARDED_PATHS) app.use(guardedPath, csrfOriginGate);

// ---------------------------------------------------------------------------
// SPLIT BODY CAP.
//
// A flat 10 MB was granted to every caller including unauthenticated ones, so anyone could make
// the server buffer 10 MB per request before a single auth check ran. The cap is now chosen by
// whether the caller presents a credential — and the choice has to happen HERE, inside the
// parser middleware, because body parsing runs before the dispatcher's auth.
//
// `verifyToken` is pure crypto with no I/O (and rejects any token carrying a `purpose` field, so
// a scoped grant cannot be replayed as a session), which is what makes it safe to call this
// early. It answers "is this a real token" only — revocation, force-logout and the user load all
// still happen later, in the dispatcher, unchanged. The worst a valid-but-revoked token buys is
// the larger body cap on a request that is about to be refused anyway.
const ANON_BODY_LIMIT = '128kb';
const AUTHED_BODY_LIMIT = '10mb';

function callerIsAuthenticated(req: express.Request): boolean {
    // The PROCESS constant, not the per-request scheme — see SESSION_COOKIE_IS_SECURE.
    const credential = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
    return !!credential && !!verifyToken(credential);
}

/** Pick a parser per request. Both parsers share the chooser so the two caps cannot drift. */
function bodyLimitChooser(parserFor: (limit: string) => express.RequestHandler): express.RequestHandler {
    const anon = parserFor(ANON_BODY_LIMIT);
    const authed = parserFor(AUTHED_BODY_LIMIT);
    return (req, res, next) => {
        // No body to parse. Short-circuits before any credential work so express.static asset
        // hits do not pay for a token verify and a Cookie-header parse.
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        // import-stream has its OWN express.text parser on the route, so it must reach the route
        // unparsed. This is the only path that may skip a parser entirely.
        if (req.path === '/api/admin/import-stream') return next();
        // Alliance federation is x-api-key server-to-server, so `callerIsAuthenticated` (which
        // looks for a SESSION credential) is always false for it. It must still be PARSED —
        // these two mounts are the only JSON parser in the app, so falling through to next()
        // here leaves req.body undefined and silently breaks five of the seven federation POST
        // routes: /pair 403s as "forbidden", op-mirror/push 500s, rsvp writes undefined fields.
        // Given the generous cap, not the anonymous one: peers push operation snapshots.
        if (req.path.startsWith('/api/alliance/')) return authed(req, res, next);
        return (callerIsAuthenticated(req) ? authed : anon)(req, res, next);
    };
}

// Middleware to parse JSON bodies (Vercel functions expect parsed body)
app.use(bodyLimitChooser((limit) => express.json({ limit })));
app.use(bodyLimitChooser((limit) => express.urlencoded({ extended: true, limit })));
app.use(compression());

// Explicit connect-src list for the CSP, replacing a bare `https:` (which let the
// page send fetch/WebSocket/beacon to any https site — so an XSS could ship the
// stored token anywhere). Lists exactly what the browser talks to: same-origin
// /api, the Supabase project's REST + Realtime origin, LiveKit, and the
// Cloudflare analytics beacon. img-src/media-src keep `https:` for user-supplied
// images.
//
// Built by the pure helper in lib/cspConnectSrc.ts so the allow-list can be tested
// directly rather than by grepping this file. The exact configured origin is
// pinned whenever it is known; a platform wildcard is the fallback ONLY when it
// is not, because a wildcard matches every project on that platform — including
// a free one an attacker can register — which would re-open the exfiltration
// channel this list exists to close. Set LIVEKIT_URL in the environment to pin
// the radio origin too (it otherwise lives in the admin-console settings row,
// which this module-level header cannot read).
const CSP_CONNECT_SRC = buildConnectSrc({
    supabaseUrl: process.env.SUPABASE_URL,
    livekitUrl: process.env.LIVEKIT_URL,
});

// Security Headers Middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // '0' disables the legacy XSS auditor, which is itself an XS-leak oracle on
    // old browsers; CSP is the real control here. (Modern guidance, per OWASP.)
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Sever the cross-origin window.opener handle (XS-leak side channels). Discord
    // OAuth is a top-level redirect, so same-origin is safe.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Deny powerful features org-wide; microphone=(self) only for the LiveKit radio.
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');

    // Per-request CSP nonce. The SSR handler (api/index.ts) stamps it onto the
    // <script> tags it serves so script-src can drop 'unsafe-inline'. HTML
    // responses are no-store, so the nonce is fresh per document. style-src
    // keeps 'unsafe-inline' because React inline styles and the boot splash's
    // style="" attributes can't carry a nonce.
    const cspNonce = randomBytes(16).toString('base64');
    res.locals.cspNonce = cspNonce;

    // base-uri 'self' blocks an injected <base> from re-rooting relative URLs;
    // form-action 'self' blocks an injected form from exfiltrating to an
    // attacker origin. Neither falls back to default-src.
    res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'nonce-${cspNonce}' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src ${CSP_CONNECT_SRC}; font-src 'self' data: https://cdnjs.cloudflare.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://docs.google.com https://drive.google.com https://calendar.google.com https://www.google.com https://open.spotify.com https://codepen.io https://stackblitz.com; media-src 'self' blob: https:; manifest-src 'self';`);
    // Only set HSTS if using HTTPS in production
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// Liveness probe. A self-hosted Node app behind Coolify, Docker or nginx needs one, and
// there wasn't one — so an operator's health check hit the SPA catch-all instead, which reads
// the settings table on every probe and, because that read returns {data,error} rather than
// throwing, answers 200 with default branding even while the database is unreachable. A probe
// that cannot fail is not a probe.
//
// LIVENESS ONLY — deliberately no database touch. A DB-gated probe takes every instance out of
// rotation on a Supabase blip, converting a degraded read path into a total outage.
//
// Registered HERE, before the request logger and the static/API middleware, so a probe is not
// logged on every tick and never consumes a rate-limit bucket. `noStore` is a hoisted function
// declaration, so calling it above its definition is fine — do not "fix" that by moving this
// route below the logger.
//
// Body is a fixed literal: no version, no schema state, no database detail. Anything richer is
// an unauthenticated information leak, and the operator has Database Tools for the real answer.
app.get('/healthz', (req, res) => {
    noStore(res);
    const buildId = getBuildId();
    if (buildId) res.setHeader('X-Build-Id', buildId);
    res.status(200).json({ status: 'ok' });
});

// Request Logging
// - Production: method + status + path + tenant subdomain (no query string, avoids
//   leaking session/auth params like ?code=, ?token= to log storage).
// - Dev: full URL with query string for easier debugging.
// Tenant subdomain is derived from the Host header so faults can be traced to an org.
app.use((req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';
    const start = Date.now();
    const host = (req.headers['x-forwarded-host'] || req.headers['host'] || '') as string;
    const cleanHost = host.split(':')[0].toLowerCase();
    const subdomain = cleanHost.split('.')[0] || '-';
    const ip = (req as any)._clientIp || getClientIp(req);
    res.on('finish', () => {
        const dur = Date.now() - start;
        // Count non-scanner 404s towards the abuse threshold so wordlist
        // scanners that don't match SCANNER_PATH_RE still trip the blackhole.
        // Scanner-path 404s are already counted by the early-block middleware.
        // Ordinary browser/asset 404s are excluded so an office behind one IP can't
        // block itself.
        if (res.statusCode === 404 && counts404TowardAbuse(req.method, req.path)) bumpAbuseCounter(ip);

        if (isProd) {
            // Path only, no query — avoids persisting sensitive params.
            log.info('request', { method: req.method, status: res.statusCode, path: req.path, ip, org: subdomain, durationMs: dur });
        } else {
            log.info('request', { method: req.method, status: res.statusCode, hostname: req.hostname, url: req.originalUrl, ip, durationMs: dur });
        }
    });
    next();
});

// Serve Static Frontend (Vite Build Output)
// We assume 'dist' is sibling to 'dist-server' or in root.
// If running from dist-server/server.js, root is ../
const distPath = path.resolve(__dirname, '../dist');

// CORS for media assets — allows tenant subdomains to load images from root domain
app.use('/media', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// Serve static assets, but NOT index.html automatically for the root route,
// so we can let the SSR handler do its job.
// setHeaders ensures HTML is never cached by CDN/browser (prevents stale chunk references after deploys),
// while hashed assets (JS/CSS) get long-term caching.
app.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('CDN-Cache-Control', 'no-store');
        } else if (filePath.includes('assets')) {
            // Hashed assets (JS/CSS) are content-addressed — safe to cache indefinitely.
            // This lets Cloudflare edge cache them, avoiding 522 origin timeouts.
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
            // Non-hashed static files (icon.svg, media, etc.) — short-lived cache so
            // Cloudflare doesn't permanently cache 404s or stale responses for these paths.
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    }
}));

// Rate limiting. Every IP-keyed control shares getClientIp (the single
// trusted-proxy-aware resolver) so no limiter can be sidestepped by spoofing a
// header another control trusts. Callers resolving to 'unknown' collapse into
// one shared bucket (acceptable: only when there is no socket address at all).
const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    keyGenerator: (req) => ipKeyGenerator(getClientIp(req as express.Request)),
});
app.use('/api', apiLimiter);

// Public page endpoints — unauth, GET-only, tighter per-(ip+slug) rate limit.
// The global apiLimiter already applies; this is an additional cap to deter
// scraping/abuse of the unauthenticated endpoints.
const publicLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    // ipKeyGenerator handles IPv6 properly; using raw req.ip would let IPv6
    // clients bypass the limit by varying the trailing 64 bits of their addr.
    keyGenerator: (req) => `${ipKeyGenerator(getClientIp(req as express.Request))}:${(req.query?.slug as string) || ''}`,
});
app.get('/api/public', publicLimiter, async (req, res) => {
    try {
        await publicFn(req, res);
    } catch (e) {
        log.error('api public error', { err: e });
        if (!res.headersSent) res.status(404).json({ error: 'not_found' });
    }
});

// Per-user, per-org dynamic data must NEVER be cached at the edge.
// Without an explicit Cache-Control, Cloudflare (and other intermediaries)
// can cache JSON GET responses based on URL alone, serving one user's data
// to another user in the same org. Apply on every dynamic RPC endpoint.
function noStore(res: express.Response): void {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vary', 'Authorization, Cookie');
}

// Extra cap on auth:* dispatches (Discord OAuth callback, setup finalisation)
// at 10/min/IP — above legitimate retries, below useful probing throughput.
// Applied as per-route middleware that only triggers when the parsed body's
// action starts with 'auth:', so non-auth RPCs hit only the global limiter.
const authActionLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    keyGenerator: (req) => ipKeyGenerator(getClientIp(req as express.Request)),
    message: { message: 'Too many authentication attempts. Please wait a minute and try again.' },
});
app.use('/api/services', (req, res, next) => {
    const action = (req as express.Request).body?.action;
    if (typeof action === 'string' && action.startsWith('auth:')) {
        return authActionLimiter(req, res, next);
    }
    next();
});

/** Stamp the deployment's build id on a browser-bound API response, so an open tab can notice
 *  it is running a bundle the server no longer serves and offer a reload.
 *
 *  Only the two routes the BROWSER calls. Deliberately not inside noStore(): that would also
 *  stamp the /api/alliance/* federation responses and import-stream, where nothing consumes it.
 *  The id is a hash of the public index.html — not a secret, but there is no reason to hand a
 *  federation peer a deployment fingerprint it has no use for. */
function stampBuildId(res: express.Response): void {
    const buildId = getBuildId();
    if (buildId) res.setHeader('X-Build-Id', buildId);
}

// API Routes
app.post('/api/services', async (req, res) => {
    noStore(res);
    stampBuildId(res);
    try {
        // Adapt Express req/res to Vercel-like handler expectation
        await servicesFn(req, res);
    } catch (e) {
        log.error('api service error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
});

// The federation feed is server-to-server and API-key authenticated, which makes the
// global per-IP cap the wrong instrument for it in BOTH directions: several peers can
// sit behind one NAT and share a bucket they should not, while one stolen key replayed
// from many addresses gets a fresh bucket per address and evades the bucket it should
// hit. Key on the KEY. Hashed, so a live credential never becomes a rate-limiter
// bucket name held in memory. Falls back to the IP when no key is presented, so an
// unauthenticated prober is still capped.
const feedLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    keyGenerator: (req) => {
        const raw = req.headers['x-api-key'];
        const key = typeof raw === 'string' ? raw : '';
        return key
            ? `feedkey:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
            : ipKeyGenerator(getClientIp(req as express.Request));
    },
});
// Engages ONLY for target=feed so the interactive app keeps the ordinary /api cap.
app.get('/api/query', (req, res, next) => (req.query?.target === 'feed' ? feedLimiter(req, res, next) : next()));

app.get('/api/query', async (req, res) => {
    noStore(res);
    stampBuildId(res);
    try {
        await queryFn(req, res);
    } catch (e) {
        log.error('api query error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
});

// First-run / admin STREAMED data import. Streams per-table progress as NDJSON so
// the onboarding wizard + admin console render a real progress bar + live log. The
// body is the raw NDJSON export (text/*, up to 64 MB); each event is flushed through
// the compression middleware so the client sees progress incrementally.
// Gated on the genuine system Admin (role identity) — a HIGHER bar than the
// admin:import_org RPC's admin:access map entry, because this route replaces every
// seeded table and can re-anchor the acting admin onto a new users.id.
/**
 * Cheap pre-parse credential check for the import stream.
 *
 * `express.text` is route middleware, so it reads the ENTIRE 64 MB body into memory before the
 * handler's first auth line runs. The whole point of splitting the body cap was that an
 * unauthenticated caller could make the server buffer megabytes before any check — and this
 * surface is six times larger than the one that motivated it, so leaving it would be fixing the
 * smaller half of the problem and calling it done.
 *
 * Signature-only, using the same pure, no-I/O verify the body-cap chooser already calls. The
 * real ladder — force-logout, revocation watermark, the isSystemAdmin gate — stays exactly where
 * it is in the handler and is unchanged; this just refuses an anonymous caller before they can
 * cost us 64 MB.
 */
const importStreamPreAuth: express.RequestHandler = (req, res, next) => {
    if (!callerIsAuthenticated(req)) {
        noStore(res);
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
};

app.post('/api/admin/import-stream', importStreamPreAuth, express.text({ type: () => true, limit: '64mb' }), async (req, res) => {
    noStore(res);
    try {
        // DUAL-ACCEPT: cookie preferred, Authorization header still honoured for sessions issued before the cookie existed.
        const token = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
        const decoded = token ? verifyToken(token) : null;
        if (!decoded) { res.status(401).json({ error: 'Unauthorized' }); return; }
        // Mirror the dispatcher's force-logout enforcement (api/services.ts): a
        // force-logged-out admin's still-unexpired JWT must not stream a full
        // org import on this sibling route.
        const platformSettings = await getPlatformSettings();
        if (isSessionForceLoggedOut(decoded, platformSettings?.force_logout_timestamp)) {
            res.status(401).json({ error: 'Session expired. Please log in again.', force_logout: true });
            return;
        }
        const user = await getUserById(decoded.userId);
        // Mirror the dispatcher's per-user revocation check too: a token issued before
        // the user's tokens_valid_from (admin revoke / delete / ban) must not stream an
        // import here, and must never be re-anchored into a fresh session below.
        if (isSessionRevokedByWatermark(decoded, user?.tokensValidFrom)) {
            res.status(401).json({ error: 'Session expired. Please log in again.' });
            return;
        }
        // ───────────────────────── ORG BAN GATE ─────────────────────────
        // Unreachable in practice — the system Admin role is always a ban-permission
        // holder (getBanPermissionHolderIds arm 2) and the peer rule in ban:place
        // refuses to ban a peer — but this route re-anchors admin identity and
        // replaces every seeded table, and the rule for this build is that EVERY
        // authenticated surface carries the gate. A gate that is only present on the
        // paths someone remembered is the one that gets missed on the next route.
        //
        // Above the admin gate so the refusal does not depend on role state that an
        // import is about to rewrite. Fails closed, never into a ban screen.
        try {
            const activeBan = await findActiveBan({ userId: user?.id, discordId: user?.discordId });
            if (activeBan) { res.status(403).json({ error: 'Forbidden' }); return; }
        } catch (e) {
            if ((e as Error)?.name !== 'BanCheckUnavailable') {
                log.error('ban gate failed unexpectedly on import-stream', { userId: user?.id, err: e });
            }
            res.status(503).json({ error: 'Unable to verify account status. Please try again.' });
            return;
        }

        // TIGHTENED: the genuine system Admin only, by role IDENTITY
        // (lib/db/adminIdentity.ts). This used to admit `admin:access`, which the
        // seeded Dispatcher holds — so a Dispatcher could stream a 64 MB org import,
        // wipe every seeded table and trigger an admin re-anchor, while every other
        // apex surface (danger zone, maintenance toggle, force-logout-all, apex
        // government seats) explicitly refuses that permission. It also used to
        // admit the name-derived `role === 'Admin'` tier, i.e. any custom role
        // called "Commander". Unstamped ⇒ 403 (fail closed).
        if (!user || user.isSystemAdmin !== true) { res.status(403).json({ error: 'Forbidden' }); return; }

        const ndjson = typeof req.body === 'string' ? req.body : '';
        if (!ndjson.trim()) { res.status(400).json({ error: 'No import data provided.' }); return; }
        if (ndjson.length > 64 * 1024 * 1024) { res.status(413).json({ error: 'Import file too large (max 64 MB).' }); return; }

        // Optional admin↔imported-user MERGE: the client passes the export user id
        // the admin mapped to ("this imported user is me"). The merge TARGET (the
        // acting admin's own users.id) is server-derived from the verified token,
        // never client-trusted — an admin can only re-anchor onto their own account.
        const mergeRaw = req.query.mergeUserId;
        const mergeId = Number(Array.isArray(mergeRaw) ? mergeRaw[0] : mergeRaw);
        const merge = Number.isInteger(mergeId) && mergeId > 0
            ? { importedUserId: mergeId, adminUserId: user.id }
            : undefined;

        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('X-Accel-Buffering', 'no');
        // A MERGE can re-anchor this admin onto a different users.id, and the whole `users`
        // table is replaced along the way. Any session cookie still on this browser then names
        // a PRE-import id — which after the import either does not exist (every call 401s
        // mid-wizard) or belongs to a DIFFERENT imported member, whose identity the browser
        // would then silently assume, because the cookie is preferred over the header.
        //
        // It has to be cleared HERE, before the first write. importOrgData emits a `phase` event
        // as its first statement, so by the time the re-anchor is known the headers are long
        // flushed and no Set-Cookie can be added. The `reauth` event below carries the fresh
        // token to the client, which sends it as an Authorization header from then on; the next
        // login re-mints the cookie.
        //
        // Cost accepted: a merge that does NOT re-anchor also clears the cookie, so that admin
        // may have to sign in again after the import. On a flow that has just replaced the
        // database wholesale that is a fair price for never handing someone another member's
        // session.
        if (merge) res.setHeader('Set-Cookie', clearSessionCookie(SESSION_COOKIE_IS_SECURE));
        const write = (evt: unknown) => {
            res.write(JSON.stringify(evt) + '\n');
            (res as unknown as { flush?: () => void }).flush?.();
        };
        try {
            const result = await importOrgData(ndjson, (evt) => { write(evt); }, merge);
            // A merge can re-anchor the admin onto a new users.id; issue a fresh
            // session token so the client stays authenticated as the merged identity.
            if (result.reanchoredAdminUserId != null && result.reanchoredAdminUserId !== decoded.userId) {
                const token = signToken({ userId: result.reanchoredAdminUserId });
                // No Set-Cookie here — headers were flushed by the first streamed event. The
                // stale cookie was already cleared before streaming began (see above), so this
                // token is the client's only credential and rides the Authorization header.
                write({ type: 'reauth', token, userId: result.reanchoredAdminUserId });
            }
        } catch (err) {
            // `refused: true` means the import was DECLINED before any write, so the
            // instance is untouched. The client uses it to offer "fix this and retry"
            // instead of the mid-import "you may hold partial data, reset the database"
            // guidance, which would be actively wrong (and, for the empty-ship-catalog
            // refusal, would be the ordinary first-run outcome).
            //
            // Deliberately NOT run through isOpaqueServerError (lib/errors.ts) the way
            // the dispatcher's 500 catch-alls are: this route is Admin-gated and the raw
            // message is the operator's import diagnostic. If this surface ever widens
            // past the system Admin role, classify here too.
            write({
                type: 'error',
                message: err instanceof Error ? err.message : 'Import failed.',
                refused: err instanceof ImportRefusedError,
            });
        }
        res.end();
    } catch (e) {
        log.error('import-stream error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
        else { try { res.end(); } catch { /* already streaming */ } }
    }
});

// Native image upload (raw image bytes). Outside the RPC dispatcher; the handler runs the
// same auth + permission checks. Per-IP limiter here; per-user throttle inside the handler.
const orgUploadLimiter = rateLimit({
    windowMs: 60_000,
    max: 40,
    standardHeaders: true,
    keyGenerator: (req) => ipKeyGenerator(getClientIp(req as express.Request)),
    message: { message: 'Too many uploads. Please slow down and try again shortly.' },
});
app.post(
    '/api/org/upload',
    orgUploadLimiter,
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'], limit: MAX_UPLOAD_BYTES }),
    (req, res) => {
        orgUploadHandler(req, res).catch((e) => {
            log.error('org upload handler error', { err: e });
            if (!res.headersSent) res.status(500).json({ message: 'Upload failed' });
        });
    },
);

// --- Alliance federation: SERVER-TO-SERVER ONLY (never browser-facing) ---
// Peers reach these directly. /pair runs the code-authenticated ECDH handshake
// responder; /profile returns our advertised directory card to a key-verified
// peer. Dedicated 20/min/IP limiter on top of the global 100/min/IP cap.
const allianceLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    keyGenerator: (req) => ipKeyGenerator(getClientIp(req as express.Request)),
});
const ALLIANCE_PAIR_DENIED = new Set([
    'no_pending_pairing', 'pairing_expired', 'handshake_verification_failed',
    'invalid_from_url', 'malformed_request',
]);
app.post('/api/alliance/pair', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const result = await allianceRespondToPair({
            fromBaseUrl: req.body?.fromBaseUrl,
            ephemeralPub: req.body?.ephemeralPub,
            nonce: req.body?.nonce,
            codeProof: req.body?.codeProof,
        });
        res.json(result);
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'pairing_failed';
        if (ALLIANCE_PAIR_DENIED.has(msg)) {
            log.warn('alliance pair rejected', { reason: msg });
            if (!res.headersSent) res.status(403).json({ error: 'forbidden' });
            return;
        }
        log.error('alliance pair error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'pairing_failed' });
    }
});
app.get('/api/alliance/profile', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const key = req.headers['x-api-key'];
        // Gate identically to every other inbound federation route: the caller
        // must resolve to an Active alliance_peers row. A raw api_keys hash match
        // (verifyApiKey) would also admit manual / legacy intel-feed keys that
        // were never an alliance peer, leaking the self-profile to non-allies.
        const peer = typeof key === 'string' ? await allianceGetPeerByInboundKey(key) : null;
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        const profile = await allianceGetSelfProfile();
        // Honor the operator's directory-visibility choice: if the org opted out
        // of exposing its contact card, return a minimal card even to allies.
        if (!profile.directoryVisible) return res.json({ orgName: '', directoryVisible: false });
        res.json(profile);
    } catch (e) {
        log.error('alliance profile error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'profile_failed' });
    }
});
// Intel channel (Phase 2): a paired peer pulls the data we share with THEM,
// gated by that peer's enabled channels + outbound clearance. The presented
// x-api-key resolves to the calling peer (Active only).
app.get('/api/alliance/data', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const key = req.headers['x-api-key'];
        const peer = typeof key === 'string' ? await allianceGetPeerByInboundKey(key) : null;
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        const since = typeof req.query.since === 'string' ? req.query.since : undefined;
        const data = await allianceGetShareableData(peer, since);
        res.json({
            countReports: data.reports.length,
            countWarrants: data.warrants.length,
            countBulletins: data.bulletins.length,
            // MIRROR _meta, never the wall clock: a peer falls back to this top-level
            // field when _meta is absent (lib/db/intel.ts) and writes it into
            // alliance_peers.intel_synced_at. A fresh timestamp here would defeat the
            // saturation clamp and skip the rows a truncated page withheld, for good.
            fetchedAt: data._meta.fetchedAt,
            reports: data.reports,
            warrants: data.warrants,
            bulletins: data.bulletins,
            _meta: data._meta,
        });
    } catch (e) {
        log.error('alliance data error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'data_failed' });
    }
});

// --- Joint-operation federation (alliance P3): SERVER-TO-SERVER ONLY ---
// All gated by getAlliancePeerByInboundKey (the calling peer must be an Active ally).
async function allianceCaller(req: express.Request): Promise<{ id: string } | null> {
    const key = req.headers['x-api-key'];
    return typeof key === 'string' ? await allianceGetPeerByInboundKey(key) : null;
}
const OP_FED_DENIED = new Set(['forbidden', 'malformed_request']);
function handleOpFedError(res: express.Response, e: unknown, label: string): void {
    const msg = e instanceof Error ? e.message : 'error';
    if (OP_FED_DENIED.has(msg)) { if (!res.headersSent) res.status(403).json({ error: 'forbidden' }); return; }
    log.error(`${label} error`, { err: e });
    if (!res.headersSent) res.status(500).json({ error: 'failed' });
}
// Host inbound — the live-sync reconcile manifest: every op the CALLING peer
// was invited to, with current versions for accepted ones, in one call
// (replaces N per-op polls; doubles as the peer's health probe). Built solely
// from that peer's own operation_allied_orgs rows, so it stays peer-scoped.
app.get('/api/alliance/op-manifest', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        res.json(await getOperationManifestForPeer(peer.id));
    } catch (e) { handleOpFedError(res, e, 'alliance op-manifest'); }
});
// Host inbound — guests poll / accept / decline / RSVP against the host op.
app.get('/api/alliance/op/:opId', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        const since = typeof req.query.since === 'string' ? Number(req.query.since) : undefined;
        res.json(await getOperationSnapshotForPeer(String(req.params.opId), peer.id, Number.isFinite(since as number) ? since : undefined));
    } catch (e) { handleOpFedError(res, e, 'alliance op snapshot'); }
});
app.post('/api/alliance/op/:opId/accept', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        res.json(await acceptInviteForPeer(String(req.params.opId), peer.id));
    } catch (e) { handleOpFedError(res, e, 'alliance op accept'); }
});
app.post('/api/alliance/op/:opId/decline', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        await declineInviteForPeer(String(req.params.opId), peer.id);
        res.json({ ok: true });
    } catch (e) { handleOpFedError(res, e, 'alliance op decline'); }
});
app.post('/api/alliance/op/:opId/rsvp', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        if (req.body?.removed === true) {
            // RSVP withdrawal: deletes ONLY the calling peer's own participant
            // row (scoped like the upsert key inside removeAlliedParticipant).
            await removeAlliedParticipant(String(req.params.opId), peer.id, req.body?.remoteUserHandle);
        } else {
            await upsertAlliedParticipant(String(req.params.opId), peer.id, {
                remoteUserHandle: req.body?.remoteUserHandle,
                displayName: req.body?.displayName, avatarUrl: req.body?.avatarUrl,
                role: req.body?.role, shipText: req.body?.shipText,
                rsvpStatus: req.body?.rsvpStatus, isReady: req.body?.isReady,
            });
        }
        res.json({ ok: true });
    } catch (e) { handleOpFedError(res, e, 'alliance op rsvp'); }
});
// Guest inbound — the host pushes invite / state / revoke to us.
app.post('/api/alliance/op-mirror/invite', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        await receiveMirrorInvite(peer, req.body);
        res.json({ ok: true });
    } catch (e) { handleOpFedError(res, e, 'alliance op-mirror invite'); }
});
app.post('/api/alliance/op-mirror/push', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        await receiveMirrorPush(peer, req.body);
        res.json({ ok: true });
    } catch (e) { handleOpFedError(res, e, 'alliance op-mirror push'); }
});
app.post('/api/alliance/op-mirror/revoke', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const peer = await allianceCaller(req);
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        await receiveMirrorRevoke(peer, req.body?.op_id);
        res.json({ ok: true });
    } catch (e) { handleOpFedError(res, e, 'alliance op-mirror revoke'); }
});

// Roster / fleet visibility (alliance P4): a paired peer pulls the minimal
// projection we've opted to share with them (channels.roster / channels.fleet).
app.get('/api/alliance/roster', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const key = req.headers['x-api-key'];
        const peer = typeof key === 'string' ? await allianceGetPeerByInboundKey(key) : null;
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        const data = await getAllyRosterProjection(peer);
        if (!data) return res.status(403).json({ error: 'forbidden' });
        res.json(data);
    } catch (e) { handleOpFedError(res, e, 'alliance roster'); }
});
app.get('/api/alliance/fleet', allianceLimiter, async (req, res) => {
    noStore(res);
    try {
        const key = req.headers['x-api-key'];
        const peer = typeof key === 'string' ? await allianceGetPeerByInboundKey(key) : null;
        if (!peer) return res.status(403).json({ error: 'forbidden' });
        const data = await getAllyFleetProjection(peer);
        if (!data) return res.status(403).json({ error: 'forbidden' });
        res.json(data);
    } catch (e) { handleOpFedError(res, e, 'alliance fleet'); }
});

// PWA Service Worker — must never be cached by Cloudflare/browser.
//
// swFn (api/sw.ts) reads branding/openGraph rows from the DB on every call, and
// this route is unauthenticated and outside /api (not covered by apiLimiter), so
// it is guarded two ways against DB-read amplification: an in-process TTL cache
// that replays a captured response, plus a dedicated per-IP limiter. SW-update
// correctness holds because the cache TTL is short and the SW source carries a
// process-lifetime DEPLOY_ID that changes (and drops this cache) on redeploy.

interface CapturedSwResponse {
    status: number;
    headers: Array<[string, string]>;
    body: string;
}

// Small pure TTL memo, exported for unit testing. A get() within the TTL returns
// the cached value without re-invoking the DB-hitting producer. It also
// collapses a concurrent burst: while the first producer promise is in flight,
// further get()s for the same key await it rather than firing their own (a
// thundering herd of /sw.js hits collapses to one DB read). If the producer
// rejects, the in-flight slot is cleared so the next call retries.
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now) {
    let entry: { key: string; value: T; expiresAt: number } | null = null;
    let inflight: { key: string; promise: Promise<T> } | null = null;
    return {
        async get(key: string, produce: () => Promise<T>): Promise<T> {
            const t = now();
            if (entry && entry.key === key && entry.expiresAt > t) {
                return entry.value;
            }
            if (inflight && inflight.key === key) {
                return inflight.promise;
            }
            const promise = (async () => {
                const value = await produce();
                entry = { key, value, expiresAt: now() + ttlMs };
                return value;
            })();
            inflight = { key, promise };
            try {
                return await promise;
            } finally {
                if (inflight && inflight.promise === promise) inflight = null;
            }
        },
        // test/inspection helper
        peek(): { key: string; expiresAt: number } | null {
            return entry ? { key: entry.key, expiresAt: entry.expiresAt } : null;
        },
    };
}

// A few seconds: long enough that a burst of requests collapses to one DB read,
// short enough that an admin branding edit shows up almost immediately.
const SW_CACHE_TTL_MS = 10_000;
const swResponseCache = createTtlCache<CapturedSwResponse>(SW_CACHE_TTL_MS);

// Capture what swFn writes to `res` (setHeader / status / send) without sending,
// so the rendered bytes can be cached and replayed. swFn only ever uses these
// three sinks; anything else is ignored (it never reads from the response).
function captureSwResponse(produce: (res: express.Response) => Promise<void>): Promise<CapturedSwResponse> {
    const captured: CapturedSwResponse = { status: 200, headers: [], body: '' };
    const sink = {
        setHeader(name: string, value: string) { captured.headers.push([name, String(value)]); return sink; },
        status(code: number) { captured.status = code; return sink; },
        send(body: unknown) { captured.body = typeof body === 'string' ? body : String(body); return sink; },
        get headersSent() { return false; },
    } as unknown as express.Response;
    return produce(sink).then(() => captured);
}

const swLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    keyGenerator: (req) => ipKeyGenerator(getClientIp(req as express.Request)),
});

app.get('/sw.js', swLimiter, async (req, res) => {
    try {
        // Key on the SW source-version constant. DEPLOY_ID lives in api/sw.ts and
        // is fixed for this process lifetime; a redeploy restarts the process and
        // drops this cache, so a static key is sufficient here while the short TTL
        // bounds branding-edit staleness.
        const cached = await swResponseCache.get('sw', () => captureSwResponse((r) => swFn(req, r)));
        for (const [name, value] of cached.headers) res.setHeader(name, value);
        // Always re-assert no-store at the edge regardless of what was captured —
        // the SW script must never be cached by Cloudflare/browser.
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.status(cached.status).send(cached.body);
    } catch (e) {
        log.error('sw error', { err: e });
        if (!res.headersSent) res.status(500).send('SW Error');
    }
});

// PWA Manifest — public branding only (name / icon / theme colour). Deliberately
// edge-cacheable; handleManifest sets its own Content-Type + Cache-Control.
//
// Single-org: no Access-Control-Allow-Origin and no OPTIONS preflight. There is
// exactly one origin, the manifest is linked same-origin (index.html /
// api/index.ts) and CSP manifest-src 'self' already forbids a cross-origin one, so
// the CORS grant had no consumer.
app.get('/api/manifest', async (req, res) => {
    try {
        // Call the manifest sub-handler DIRECTLY. This used to pin the target by
        // rewriting the URL (`req.url += '&target=manifest'`) and then calling the
        // generic query handler — which is forgeable: a trailing '#' makes parseurl
        // treat the appended text as a fragment and DISCARD it, so
        // '/api/manifest?target=state&subset=hr#' reached handleState, and config /
        // initial-state / feed the same way, while riding THIS route — which never
        // calls noStore() (verified against express 5.2.1; the %23 a browser sends
        // is not the raw byte parseurl looks for, so that form fell closed to a 404
        // and only curl-class clients could reach it). Do not reintroduce the
        // rewrite — the target must be structurally unforgeable, not dependent on
        // two URL parsers agreeing.
        await handleManifest(req, res);
    } catch (e) {
        // Belt-and-braces: handleManifest is double-try/catch and returns a default
        // manifest rather than throwing, so this is not expected to fire.
        log.error('manifest error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'Manifest Error' });
    }
});

// SSR / Metadata Handler (The Catch-All)
// Intercept all GET requests that accept HTML
app.get(/(.*)/, async (req, res) => {
    // If it's a static file request that fell through express.static (e.g. missing asset), 404 it.
    // no-store prevents Cloudflare from caching the 404 at the edge — without this,
    // a missing asset during a deploy window can stay "stuck" as a cached 404.
    if (req.path.includes('.') && !req.path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('CDN-Cache-Control', 'no-store');
        return res.status(404).send('Not Found');
    }

    try {
        await handlerFn(req, res);
    } catch (e) {
        log.error('ssr handler error', { err: e });
        // Fallback to static index.html if SSR fails
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('CDN-Cache-Control', 'no-store');
        res.sendFile(path.join(distPath, 'index.html'));
    }
});

// Terminal handler for anything the routes above didn't match — primarily a
// stray NON-GET to a SPA path (stale service worker / bfcache replay). Without
// it, the request falls through to Express's finalhandler, which serves a bare
// error page with no app shell, so pwa-init.js never runs to self-heal the stale
// SW and the user is stuck until a hard refresh.
app.all(/(.*)/, (req, res) => {
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ message: 'Not found' });
    }
    // Health paths are exempt. This counter is UNCONDITIONAL for anything reaching here —
    // BENIGN_404_RE is never consulted on this path — so an uptime monitor configured to POST
    // or HEAD /healthz (several do) would blackhole its own IP after 20 probes, and take its
    // NAT neighbours with it, since a blocked IP gets a 404 on everything.
    if (req.path !== '/healthz' && req.path !== '/readyz') bumpAbuseCounter(getClientIp(req));
    if (req.method === 'OPTIONS') return res.status(204).end();
    // Hardcoded literal '/' — NEVER derive the Location from req.path/host (open-redirect).
    return res.redirect(303, '/');
});

/**
 * Terminal error handler. There was none, so a body-parser fault escaped to Express's
 * finalhandler and answered a JSON API with an HTML error page — including, outside production,
 * a stack trace and absolute filesystem paths. Splitting the body cap makes 413 a routine
 * outcome rather than a curiosity, so the shape of that response now matters.
 *
 * Four arguments, and `_next` must stay: Express identifies an error handler by ARITY, so
 * dropping the unused parameter silently turns this back into ordinary middleware that never
 * runs. Registered last, after every route.
 */
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const type = (err as { type?: string } | null)?.type;
    const status = (err as { status?: number; statusCode?: number } | null)?.status
        ?? (err as { statusCode?: number } | null)?.statusCode
        ?? 500;

    if (type === 'entity.too.large') {
        log.warn('request body over cap', { path: req.originalUrl, method: req.method, ip: getClientIp(req) });
        res.setHeader('Cache-Control', 'no-store');
        res.status(413).json({ message: 'That upload is too large.' });
        return;
    }
    if (type === 'entity.parse.failed') {
        res.setHeader('Cache-Control', 'no-store');
        res.status(400).json({ message: 'Malformed request body.' });
        return;
    }

    // Anything else: log it server-side with an id, return an opaque message. The raw error
    // text never crosses the wire — it can carry file paths and query fragments.
    const requestId = randomUUID();
    log.error('unhandled request error', { requestId, path: req.originalUrl, method: req.method, err });
    res.setHeader('Cache-Control', 'no-store');
    if (!res.headersSent) res.status(status >= 400 && status < 600 ? status : 500).json({ message: 'An internal server error occurred.', requestId });
});

// Cron jobs run in-process, each wrapped in withCronLease (a table-based lease,
// see lib/cronLock.ts) so they are safe under multi-instance deploys: only the
// instance holding the unexpired lease runs a given job per tick.
import cron from 'node-cron';
import { cleanupInactiveDutyUsers } from './lib/db/users.js';
import { cleanupExpiredBulletins } from './lib/db/intel.js';
import { allianceSyncTick } from './lib/db/allianceSync.js';
import { sendDueOperationReminders } from './lib/db/opReminders.js';
import { sendDueOperationStartNotices } from './lib/db/opStartNotices.js';
import { pruneOldNotifications } from './lib/db/notifications.js';
import { pruneSecurityEvents } from './lib/db/securityEvents.js';
import { withCronLease } from './lib/cronLock.js';

// Only bind the port / register cron + signal handlers when this module is the
// process entrypoint (node dist-server/server.js). When it is merely imported
// (e.g. a unit test importing the exported createTtlCache helper) we skip the
// side-effecting bootstrap so importing the module doesn't open a socket. In
// production process.argv[1] is this file, so boot runs exactly as before.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const server = isMainModule ? app.listen(Number(port), '0.0.0.0', () => {
    log.info('server running', { port });
    log.info('deployment timestamp', { timestamp: new Date().toISOString() });
    log.info('serving static files', { distPath });

    // First-boot install: seed defaults + mint a one-time admin setup code if
    // no Admin exists yet. Non-blocking — the listener is already up so the
    // operator can reach the login page as soon as the code is printed.
    runFirstBootCheck().catch((err) => {
        log.error('first-boot check threw (unhandled)', { err });
    });

    // Validate permission-map coverage. A protected action missing from
    // fullPermissionMap silently 403s in production; surface it at boot so
    // deploy logs catch the drift immediately.
    const permCheck = validatePermissionMap();
    if (permCheck.missing.length > 0) {
        log.error('protected actions missing from permission map (will silently 403)', { count: permCheck.missing.length, actions: permCheck.missing });
    }
    if (permCheck.stale.length > 0) {
        log.warn('stale permission map entries (no matching action)', { count: permCheck.stale.length, entries: permCheck.stale });
    }
    if (permCheck.missing.length === 0 && permCheck.stale.length === 0) {
        log.info('permission map ok');
    }

    // SCHEMA PREFLIGHT for the api_keys lifecycle columns. The code refuses API-key
    // authentication when they are absent (fail closed), and the only symptom a peer sees is
    // that we look down — so the operator has to be told here, at boot, in the deploy log,
    // rather than finding out from an ally. Also surfaced in Database Tools and, for admins,
    // as a banner in the app.
    findMissingApiKeyColumns()
        .then((missing) => {
            if (missing.length > 0) {
                log.error('DATABASE UPDATE REQUIRED — api_keys is missing columns; API key authentication is REFUSED until schema.sql is re-run', {
                    missing,
                    fix: 'Paste the current schema.sql into the Supabase SQL editor and run it.',
                });
            }
        })
        .catch((err) => log.warn('could not preflight api_keys columns', { err }));

    // Report the public origin this deployment will actually put in Discord deep links
    // and advertise to alliance peers, plus which source it came from. Deliberately
    // READ-ONLY — converging the stored row to APP_URL at boot would let a staging
    // container pointed at a clone of the production database silently rewrite the live
    // org's origin, with no audit row and no undo. Non-blocking and non-fatal: a DB
    // hiccup here must never stop the server coming up.
    resolveOrgAppUrl().then((appUrl) => {
        log.info('app origin resolved', { effective: appUrl.url, source: appUrl.source });
        for (const r of appUrl.rejected) {
            log.warn('app origin candidate ignored', { source: r.source, value: r.value, reason: r.reason });
        }
        if (appUrl.drift) {
            // The migration case: a restored database carries the OLD deployment's
            // origin. APP_URL wins, so this is informational — but naming the stale
            // stored value is what turns "links point at the wrong host" into a
            // one-line diagnosis.
            log.warn('APP_URL and the stored systemConfig.appUrl disagree — APP_URL wins', appUrl.drift);
        }
        if (appUrl.source === 'fallback' && process.env.NODE_ENV === 'production') {
            log.error('no usable APP_URL — Discord deep links and alliance pairing will use the localhost fallback', { effective: appUrl.url });
        }
    }).catch((err) => {
        log.warn('app origin resolution failed at boot (non-fatal)', { err });
    });

    cron.schedule('* * * * *', async () => {
      await withCronLease('duty_cleanup', 50, async () => {
        const t0 = Date.now();
        try {
            const cleaned = await cleanupInactiveDutyUsers();
            const ms = Date.now() - t0;
            const n = cleaned?.length || 0;
            log.info('cron duty-cleanup', { usersOffDuty: n, durationMs: ms });
        } catch (e) {
            log.error('cron duty cleanup failed', { err: e });
        }
      });
    });

    // Intel bulletin cleanup — fallback for pg_cron.
    cron.schedule('*/5 * * * *', async () => {
      await withCronLease('bulletin_cleanup', 270, async () => {
        const t0 = Date.now();
        try {
            await cleanupExpiredBulletins();
            log.info('cron bulletin-cleanup done', { durationMs: Date.now() - t0 });
        } catch (e) {
            log.error('cron bulletin cleanup failed', { err: e });
        }
      });
    });

    // Operation push reminders (every minute). The consumer for the
    // operation_reminders rows lib/db/ops.ts has written since day one and that
    // nothing ever read — until this job existed, no reminder had ever been
    // delivered on any deployment. Fail-OPEN lease on purpose: the job claims each
    // row with a conditional UPDATE (lib/db/opReminders.ts), so two instances
    // running through a lease outage claim disjoint sets — alliance_sync's
    // fail-closed rationale (peer rate limits) does not apply here.
    cron.schedule('* * * * *', async () => {
      await withCronLease('op_reminders', 50, async () => {
        const t0 = Date.now();
        try {
            const sent = await sendDueOperationReminders();
            if (sent > 0) log.info('cron op-reminders', { sent, durationMs: Date.now() - t0 });
        } catch (e) {
            log.error('cron op reminders failed', { err: e });
        }
        // Rides the SAME lease and the same tick — no second cron, no second lease
        // key. Its OWN try/catch, so a Discord outage cannot stop the web-push
        // reminders above it.
        try {
            const notices = await sendDueOperationStartNotices();
            if (notices > 0) log.info('cron op-start-notices', { notices, durationMs: Date.now() - t0 });
        } catch (e) {
            log.error('cron op start notices failed', { err: e });
        }
      });
    });

    // Alliance live-sync engine (every minute): per-peer due-time scheduling
    // (ops manifest reconcile / intel delta pull / directory refresh), peer
    // health + backoff, and rate budgeting all live inside the tick — see
    // lib/db/allianceSync.ts. The tick caps its own wall-clock at 40s, under
    // the 50s fail-open lease hold.
    cron.schedule('* * * * *', async () => {
      // fail-closed: skip this tick if the lease check errors, rather than letting
      // every instance hit allies' rate limits at once.
      await withCronLease('alliance_sync', 50, async () => {
        const t0 = Date.now();
        try {
            await allianceSyncTick();
            log.info('cron alliance-sync done', { durationMs: Date.now() - t0 });
        } catch (e) {
            log.error('cron alliance sync failed', { err: e });
        }
      }, { failClosed: true });
    });

    // Notification Center retention (daily, 03:30 UTC): prune inbox rows older
    // than 90 days. The bell only ever surfaces the latest 100 per recipient, so
    // anything this old is already unreachable. pruneOldNotifications never throws
    // and deletes in bounded <=500-id chunks. 10-minute lease hold is ample.
    cron.schedule('30 3 * * *', async () => {
      await withCronLease('prune_notifications', 600, async () => {
        const t0 = Date.now();
        try {
            const deleted = await pruneOldNotifications(90);
            log.info('cron notification-prune done', { deleted, durationMs: Date.now() - t0 });
        } catch (e) {
            log.error('cron notification prune failed', { err: e });
        }
      });
    });

    // Security audit retention. The trail is PII-bearing (actor IPs), so it is pruned
    // rather than kept forever - an audit log that grows without bound is a liability
    // as well as an asset. 365 days by default; SECURITY_EVENT_RETENTION_DAYS overrides.
    cron.schedule('45 3 * * *', async () => {
      await withCronLease('prune_security_events', 600, async () => {
        const t0 = Date.now();
        try {
            const days = Number(process.env.SECURITY_EVENT_RETENTION_DAYS) || 365;
            const deleted = await pruneSecurityEvents(days);
            log.info('cron security-event-prune done', { deleted, days, durationMs: Date.now() - t0 });
        } catch (e) {
            log.error('cron security event prune failed', { err: e });
        }
      });
    });

    cron.schedule('30 4 * * *', async () => {
      await withCronLease('org_media_gc', 1800, async () => {
        const t0 = Date.now();
        try {
            await runOrgMediaGc();
            log.info('cron media-gc done', { durationMs: Date.now() - t0 });
        } catch (e) {
            log.error('cron media gc failed', { err: e });
        }
      });
    });

    log.info('cron jobs initialized');
}) : null;

// Slowloris mitigation: cap how long a client may take to send headers / a full
// request. More valuable self-hosted (direct origin, no CDN in front). Guarded —
// `server` is null on test import.
if (server) {
    server.requestTimeout = 60_000;
    server.headersTimeout = 20_000;
}

// Graceful Shutdown
const gracefulShutdown = (signal: string) => {
    log.info('signal received, starting graceful shutdown', { signal });
    server?.close(() => {
        log.info('all connections drained, server closed cleanly');
        process.exit(0);
    });
    // Force exit after 30 seconds if connections don't drain
    setTimeout(() => {
        log.error('forced shutdown after 30s timeout');
        process.exit(1);
    }, 30_000);
};

if (isMainModule) {
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    // Log async failures that would otherwise be silent (or only show Node's default
    // stderr trace). An unhandled rejection is logged but not fatal — one stray
    // background error shouldn't take the server down. An uncaught exception leaves
    // the process in an unknown state, so log it and shut down cleanly; the process
    // manager (see DEPLOYMENT_GUIDE) restarts it.
    process.on('unhandledRejection', (reason) => {
        log.error('unhandled promise rejection', { err: reason });
    });
    process.on('uncaughtException', (err) => {
        log.error('uncaught exception', { err });
        gracefulShutdown('uncaughtException');
    });
}
