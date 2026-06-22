
import express from 'express';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { getClientIp } from './lib/clientIp.js';
import { pruneAuthRateLimitBuckets } from './lib/authRateLimit.js';
import { pruneAiRateLimitBuckets } from './lib/aiRateLimit.js';
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
    pruneAiRateLimitBuckets(now);
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
import queryFn from './api/query.js';
import swFn from './api/sw.js';
import publicFn from './api/public.js';
import { respondToPair as allianceRespondToPair, getAllianceSelfProfile as allianceGetSelfProfile, verifyApiKey as allianceVerifyApiKey, getAlliancePeerByInboundKey as allianceGetPeerByInboundKey, getAllianceShareableData as allianceGetShareableData,
    getOperationSnapshotForPeer, getOperationManifestForPeer, acceptInviteForPeer, declineInviteForPeer, upsertAlliedParticipant, removeAlliedParticipant,
    receiveMirrorInvite, receiveMirrorPush, receiveMirrorRevoke,
    getAllyRosterProjection, getAllyFleetProjection, getUserById, importOrgData, getPlatformSettings } from './lib/db.js';
import { runFirstBootCheck } from './lib/firstBoot.js';
import { verifyToken, signToken, isSessionForceLoggedOut } from './lib/auth.js';
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

// Middleware to parse JSON bodies (Vercel functions expect parsed body)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// Explicit connect-src list for the CSP, replacing a bare `https:` (which let the
// page send fetch/WebSocket/beacon to any https site — so an XSS could ship the
// stored token anywhere). Lists exactly what the browser talks to: same-origin
// /api, Supabase REST + Realtime (wildcard, plus the env origin for a custom domain),
// LiveKit, and the Cloudflare analytics beacon. img-src/media-src keep `https:` for
// user-supplied images.
const SUPABASE_ORIGIN = (() => {
    try { return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : ''; } catch { return ''; }
})();
const CSP_CONNECT_SRC = [
    "'self'",
    SUPABASE_ORIGIN,
    SUPABASE_ORIGIN ? SUPABASE_ORIGIN.replace(/^https:/, 'wss:') : '',
    'https://*.supabase.co', 'wss://*.supabase.co',
    'https://*.livekit.cloud', 'wss://*.livekit.cloud',
    'https://cloudflareinsights.com',
].filter(Boolean).join(' ');

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

// API Routes
app.post('/api/services', async (req, res) => {
    noStore(res);
    try {
        // Adapt Express req/res to Vercel-like handler expectation
        await servicesFn(req, res);
    } catch (e) {
        log.error('api service error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/query', async (req, res) => {
    noStore(res);
    try {
        await queryFn(req, res);
    } catch (e) {
        log.error('api query error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
});

// First-run / admin STREAMED data import. Same gate as the admin:import_org RPC
// (admin:access), but streams per-table progress as NDJSON so the onboarding
// wizard + admin console render a real progress bar + live log. The body is the
// raw NDJSON export (text/*, up to 64 MB); each event is flushed through the
// compression middleware so the client sees progress incrementally.
app.post('/api/admin/import-stream', express.text({ type: () => true, limit: '64mb' }), async (req, res) => {
    noStore(res);
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
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
        const isAdmin = !!user && (user.role === 'Admin' || (Array.isArray(user.permissions) && user.permissions.includes('admin:access')));
        if (!isAdmin) { res.status(403).json({ error: 'Forbidden' }); return; }

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
                write({ type: 'reauth', token, userId: result.reanchoredAdminUserId });
            }
        } catch (err) {
            write({ type: 'error', message: err instanceof Error ? err.message : 'Import failed.' });
        }
        res.end();
    } catch (e) {
        log.error('import-stream error', { err: e });
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
        else { try { res.end(); } catch { /* already streaming */ } }
    }
});

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
        const verified = typeof key === 'string' ? await allianceVerifyApiKey(key) : null;
        if (!verified) return res.status(403).json({ error: 'forbidden' });
        res.json(await allianceGetSelfProfile());
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
            fetchedAt: new Date().toISOString(),
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

// PWA Manifest — CORS enabled for cross-origin tenant subdomain → TLD fetches
app.options('/api/manifest', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
});
app.get('/api/manifest', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        // Express 5: req.query is an immutable getter, so inject target via URL rewrite
        const sep = req.url.includes('?') ? '&' : '?';
        req.url = req.url + sep + 'target=manifest';
        await queryFn(req, res);
    } catch (e) {
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
    bumpAbuseCounter(getClientIp(req));
    if (req.method === 'OPTIONS') return res.status(204).end();
    // Hardcoded literal '/' — NEVER derive the Location from req.path/host (open-redirect).
    return res.redirect(303, '/');
});

// Cron jobs run in-process, each wrapped in withCronLease (a table-based lease,
// see lib/cronLock.ts) so they are safe under multi-instance deploys: only the
// instance holding the unexpired lease runs a given job per tick.
import cron from 'node-cron';
import { cleanupInactiveDutyUsers } from './lib/db/users.js';
import { cleanupExpiredBulletins } from './lib/db/intel.js';
import { allianceSyncTick } from './lib/db/allianceSync.js';
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
