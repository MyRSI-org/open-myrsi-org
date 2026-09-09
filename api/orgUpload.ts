// Image-upload endpoint (POST /api/org/upload?for=<feature>).
//
// Served outside the RPC dispatcher because it takes raw image bytes, not a JSON action.
// It runs the same security checks as a mutation: verify the session token (with the
// force-logout and revocation checks the dispatcher applies), reject a cross-site POST,
// refuse non-Admin writes while maintenance mode is declared, require the same permission
// that gates the feature's write action, throttle per user, refuse a target whose optional
// module is switched off, then magic-byte-check + re-encode the image via uploadOrgMedia.
// Public features return a URL to store; private (wiki/government) features return the
// object key (signed on read).

import { Request, Response } from 'express';
import { verifyToken, isSessionForceLoggedOut, isSessionRevokedByWatermark } from '../lib/auth.js';
import { getUserById, getPlatformSettings, isOptionalFeatureEnabled, resolveIsSystemAdminFresh, recordSecurityEvent, findActiveBan } from '../lib/db.js';
import { getClientIp } from '../lib/clientIp.js';
import { isOrgMediaFeature, uploadOrgMedia } from '../lib/storage.js';
import { FEATURE_UPLOAD_PERMS, FEATURE_WRITE_ACTION } from './orgUploadPerms.js';
import { OPTIONAL_FEATURE_NAMESPACES } from './services.js';
import { permissionSatisfied } from '../lib/permissionImplications.js';
import { log as baseLog } from '../lib/log.js';
import { credentialFromRequest, SESSION_COOKIE_IS_SECURE } from '../lib/sessionCookie.js';

const log = baseLog.child({ module: 'api.orgUpload' });

// Per-user upload throttle, on top of the per-IP limiter on the route. The IP limiter
// caps each source address; this caps the identity, so a member behind rotating IPs can't
// flood Storage. Pruned from server.ts's periodic cleanup.
const UPLOAD_PER_USER_MAX = 30;
const UPLOAD_WINDOW_MS = 60_000;
const UPLOAD_MAX_BUCKETS = 50_000;

interface UploadBucket { count: number; windowStart: number }
const userBuckets = new Map<string, UploadBucket>();

function checkUserUploadLimit(userId: number, now: number = Date.now()): { ok: boolean; retryAfter: number } {
    const key = `u:${userId}`;
    const existing = userBuckets.get(key);
    if (!existing || now - existing.windowStart >= UPLOAD_WINDOW_MS) {
        // Cap the map size so a spray of distinct ids can't grow memory unbounded; shed
        // brand-new entries rather than evicting already-tracked ones.
        if (!existing && userBuckets.size >= UPLOAD_MAX_BUCKETS) return { ok: true, retryAfter: 0 };
        userBuckets.set(key, { count: 1, windowStart: now });
        return { ok: true, retryAfter: 0 };
    }
    existing.count += 1;
    if (existing.count > UPLOAD_PER_USER_MAX) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((existing.windowStart + UPLOAD_WINDOW_MS - now) / 1000)) };
    }
    return { ok: true, retryAfter: 0 };
}

export function pruneOrgUploadBuckets(now: number = Date.now()): number {
    let removed = 0;
    for (const [k, b] of userBuckets.entries()) {
        if (now - b.windowStart >= UPLOAD_WINDOW_MS) { userBuckets.delete(k); removed++; }
    }
    return removed;
}

// Same-origin check. This endpoint is authenticated by a bearer token (not a cookie), so
// it isn't classically CSRF-able, but a mismatched Origin still has no business posting
// here — reject it. A missing Origin (e.g. a same-origin navigation) is allowed; the token
// is the real gate.
function isSameOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin || typeof origin !== 'string') return true;
    let originHost: string;
    try { originHost = new URL(origin).host; } catch { return false; }
    const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host;
    return typeof host === 'string' && originHost === host;
}

/**
 * Emit a denial into the durable security trail. This endpoint bypasses api/services.ts
 * entirely, so none of its denials reach that file's auditDenial helper — without this the
 * trail has a blind spot on a real write surface.
 *
 * The try/catch is LOAD-BEARING and must not be reduced to a bare `void`: `void fn()`
 * protects a caller from a REJECTED promise, not from an absent export or a synchronous
 * throw. A test double that hand-lists lib/db's exports makes the emitter `undefined`, and
 * calling it would turn every denial on this surface into a 500 — i.e. an attacker who can
 * break the audit table would convert 403s into 500s. Losing an audit row is bad; losing the
 * denial is worse. Same shape, and the same reasoning, as the dispatcher's helper.
 *
 * WHAT IS DELIBERATELY NOT AUDITED HERE:
 *  - the cross-site 403, because it runs BEFORE token verification. An emit there would write
 *    a durable, IP-bearing row for a fully unauthenticated request, bounded only by the
 *    per-IP limiter and trivially amplified by sending a bogus Origin from many addresses.
 *    It also cannot answer the question the trail exists for — there is no account.
 *  - the maintenance-mode 503, because the dispatcher does not audit its own maintenance
 *    denial either. These two surfaces are kept at parity on purpose: audit both or neither,
 *    never one.
 *  - the unknown-target 404, because `?for=` is not narrowed to a known feature at that
 *    point, so the only thing to record would be caller-supplied text.
 */
function auditUploadDenial(event: string, ctx: {
    user?: { id?: number; rsiHandle?: string } | null;
    ip?: string | null;
    details?: Record<string, unknown>;
}): void {
    try {
        void recordSecurityEvent({
            event,
            action: 'org:upload',
            actorUserId: typeof ctx.user?.id === 'number' ? ctx.user.id : null,
            actorLabel: ctx.user?.rsiHandle ?? null,
            actorIp: ctx.ip ?? null,
            details: ctx.details,
        });
    } catch (err) {
        log.warn('security event emit threw', { err });
    }
}

export default async function orgUploadHandler(req: Request, res: Response): Promise<void> {
    if (!isSameOrigin(req)) {
        res.status(403).json({ message: 'Forbidden: cross-site request blocked' });
        return;
    }

    // Authenticate the same way the dispatcher does: token -> force-logout -> revocation
    // watermark -> load user.
    // DUAL-ACCEPT: cookie preferred, Authorization header still honoured for sessions issued before the cookie existed.
    const token = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
    const decoded = token ? verifyToken(token) : null;
    if (!decoded) { res.status(401).json({ message: 'Unauthorized' }); return; }
    const platformSettings = await getPlatformSettings();
    if (isSessionForceLoggedOut(decoded, platformSettings?.force_logout_timestamp)) {
        res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
        return;
    }
    const user = await getUserById(decoded.userId);
    if (isSessionRevokedByWatermark(decoded, user?.tokensValidFrom)) {
        res.status(401).json({ message: 'Session expired. Please log in again.' });
        return;
    }
    if (!user) { res.status(401).json({ message: 'Unauthorized' }); return; }

    // ───────────────────────── ORG BAN GATE ─────────────────────────
    // BELOW the null guard above, deliberately: the check needs user.discordId, and
    // reading it off a possibly-null user would turn every upload into a 500.
    //
    // This endpoint bypasses the dispatcher entirely, so without this a banned member
    // keeps pushing objects into org storage — against the shared bucket cap — using a
    // token that stays valid because ban:place does not revoke sessions.
    //
    // Fails closed, but never INTO a ban screen: a read fault is a retryable 503.
    try {
        const activeBan = await findActiveBan({ userId: user.id, discordId: user.discordId });
        if (activeBan) {
            auditUploadDenial('authz.org_ban.denied', {
                user, ip: getClientIp(req), details: { banId: activeBan.id, surface: 'org_upload' },
            });
            res.status(403).json({ message: 'Your access to this organization has been suspended.' });
            return;
        }
    } catch (e) {
        // Not a bare catch — see the dispatcher's half. An unexpected throw in the gate
        // itself must be visible, not a permanent silent 503 on every upload.
        if ((e as Error)?.name !== 'BanCheckUnavailable') {
            log.error('ban gate failed unexpectedly on org upload', { userId: user.id, err: e });
        }
        res.status(503).json({ message: 'Unable to verify account status. Please try again.' });
        return;
    }

    // MAINTENANCE MODE — mirrors the dispatcher (api/services.ts) and the read path
    // (api/query.ts) on the settings object already loaded above, so it costs zero extra
    // reads. This is a WRITE surface: an operator who declared maintenance has closed
    // non-Admin writes, and api/query.ts deliberately lets target=initial-state through so
    // the app can still boot and render the maintenance screen — which keeps the token
    // live. Without this gate an already-loaded tab (or a curl) keeps pushing objects into
    // the shared storage cap for the whole window.
    //
    // Admin bypass kept IDENTICAL to both siblings: the stamped role IDENTITY first
    // (getUserById stamps isSystemAdmin), then a cache-free re-resolve on the DENY path
    // only — an org import rebuilds `roles`, so the 5-minute memo behind the stamp can
    // name a dead id, and lifting maintenance is the escape hatch with no other in-app
    // exit. Deliberately NOT admin:access: the seeded Dispatcher holds it, and handing a
    // Dispatcher the bypass would defeat the window the operator declared.
    // resolveIsSystemAdminFresh never throws, and getPlatformSettings never throws (it
    // falls back to last-known-good), so no try/catch is added here — one would only
    // manufacture a fail-open path that does not exist today. Unknown => not Admin.
    if (platformSettings?.maintenance_mode === true) {
        let isAdmin = user.isSystemAdmin === true;
        if (!isAdmin) isAdmin = await resolveIsSystemAdminFresh(user.roleId);
        if (!isAdmin) {
            log.warn('upload blocked by maintenance mode', { userId: user.id });
            res.status(503).json({ message: 'The platform is currently undergoing maintenance. Please try again later.' });
            return;
        }
    }

    // Feature allowlist. An unknown or absent `?for=` has no upload surface.
    const feature = typeof req.query.for === 'string' ? req.query.for : '';
    if (!isOrgMediaFeature(feature)) {
        res.status(404).json({ message: 'Unknown upload target' });
        return;
    }

    // Require the same permission that gates the feature's write action (any-of). No Admin
    // role shortcut: an Admin uploads exactly when their granted permissions would let them
    // do the write, matching the dispatcher.
    const required = FEATURE_UPLOAD_PERMS[feature];
    const requiredPerms = Array.isArray(required) ? required : [required];
    const userPerms = Array.isArray(user.permissions) ? user.permissions : [];
    // permissionSatisfied, not a bare includes(): FEATURE_UPLOAD_PERMS.academy asks for
    // academy:instruct, which academy:manage satisfies through the ladder in
    // lib/permissionImplications.ts — a Learning Manager who can approve and publish a
    // course must be able to upload its cover. Same table the dispatcher's write gate
    // consults, so this stays the SAME question as the feature's write action.
    if (!requiredPerms.some(p => permissionSatisfied(userPerms, p))) {
        log.warn('upload permission denied', { userId: user.id, feature });
        // Same slug the dispatcher uses, so an operator filtering on one event sees denials
        // from both surfaces. `feature` is safe to record: it is narrowed by isOrgMediaFeature
        // above, so it is one of our own enum values, never caller-supplied text.
        auditUploadDenial('authz.permission.denied', { user, ip: getClientIp(req), details: { feature } });
        res.status(403).json({ message: 'Forbidden: you do not have permission to upload here.' });
        return;
    }

    const limit = checkUserUploadLimit(user.id);
    if (!limit.ok) {
        auditUploadDenial('upload.rate_limited', { user, ip: getClientIp(req), details: { feature } });
        res.setHeader('Retry-After', String(limit.retryAfter));
        res.status(429).json({ message: 'Too many uploads. Please slow down and try again shortly.' });
        return;
    }

    // OPTIONAL-MODULE FEATURE GATE — the same registry and the same message the dispatcher
    // gates WRITES with (OPTIONAL_FEATURE_NAMESPACES, api/services.ts) and api/query.ts
    // gates READS with (SUBSET_REQUIRED_FEATURE). A module the org has switched OFF has no
    // upload surface either: this endpoint is a second write surface for resources the
    // dispatcher already guards, so it must answer the dispatcher's namespace-level
    // question too. The registry is IMPORTED, never copied, so the write gate, the read
    // gate and the upload gate cannot disagree about which module owns a namespace.
    //
    // The namespace is DERIVED from the write action this upload exists to feed, never
    // re-declared: FEATURE_WRITE_ACTION is already pinned to fullPermissionMap by
    // tests/orgUploadPermParity.test.ts, so there is no second fact to keep in sync and no
    // hand-typed prefix to get wrong. A map here would be fail-OPEN on a missing trailing
    // colon ('qm' vs 'qm:'): a startsWith parity assertion would accept it, the registry
    // lookup would miss, and the module gate would silently vanish for that target.
    //
    // There is deliberately NO exclusion/skip list. Every target whose derived namespace
    // is in the registry is gated — four of four: quartermaster, government, legislation,
    // academy. Item 6 shipped an upload-gate skip list carrying `quartermaster` un-gated,
    // because its one UI consumer (the PLATFORM Item Catalog tab) had been pointed at it
    // by mistake; follow-up F1 gave that tab its own ungated `catalog` target
    // (catalog:update_item / admin:config:catalog) and the lever was deleted. The lever's
    // former NAME is spelled out only in tests/orgUploadPermParity.test.ts (A3b), which
    // ratchets on that identifier being absent from THIS file — so do not name it here.
    // ?for=quartermaster now serves exactly what its name says: the org's OWN custom
    // quartermaster_catalog rows (qm:update_catalog_item / qm:admin), which live inside
    // the module and are correctly gated with it. Re-introducing a skip list is a
    // fail-OPEN lever — a row added to it un-gates a target with nothing able to tell
    // that from a deliberate choice. Its absence is pinned by
    // tests/orgUploadPermParity.test.ts (A3/A3b) and tests/orgUploadFeatureGate.test.ts
    // (B4/B4d).
    //
    // Placed AFTER the permission gate, unlike the dispatcher's (which must gate first
    // because it also serves permission-less actions). Every upload target here requires a
    // real staff permission, so ordering it later keeps module-enablement state from
    // leaking to an unpermitted caller and skips a settings read on a denied request — the
    // same reasoning api/query.ts records for the read gate's ordering. Placed AFTER the
    // per-user throttle as well, so a feature-denied request consumes the caller's own
    // budget instead of being an unmetered settings read, and a request already over the
    // limit is 429'd for free.
    //
    // isOptionalFeatureEnabled routes 'government' to its own settings row and every other
    // module to the orgFeatures blob, and fails CLOSED on a read fault. `exempt` is
    // deliberately not consulted: it exists so a disabled module's own re-enable ACTION
    // stays reachable, and no upload is needed to switch a module back on.
    //
    // NOT a storage-abuse fix. Twelve of the sixteen targets ride never-gated namespaces
    // (admin:, alliance:, wiki:, catalog:), the deployment cap in lib/storage.ts is one
    // global, feature-blind counter, and the per-user throttle counts requests, not bytes
    // — so any holder of an ungated permission can still fill the cap at exactly the same
    // rate, modules off or on. What this closes is dispatcher parity plus disabled-module
    // folder hygiene. The control that actually bounds the abuse is a per-user BYTE
    // budget (F3).
    const writeActions = [FEATURE_WRITE_ACTION[feature]].flat();
    const firstAction = writeActions[0];
    // `typeof` guard, not a bare index: neither tsconfig sets noUncheckedIndexedAccess, so
    // an empty (or colon-less) write-action entry would type as a string and throw here
    // instead of reaching the deny branch below.
    const colon = typeof firstAction === 'string' ? firstAction.indexOf(':') : -1;
    if (colon <= 0) {
        // Unreachable while orgUploadPermParity pins the map shape. Fail CLOSED anyway: an
        // unresolvable namespace must never read as "no gate applies".
        log.error('upload namespace underivable', { userId: user.id, feature });
        auditUploadDenial('upload.namespace_underivable.denied', { user, ip: getClientIp(req), details: { feature } });
        res.status(500).json({ message: 'Upload failed' });
        return;
    }
    const namespace = firstAction.slice(0, colon + 1);
    // The hasOwnProperty ternary is what gives `gate` the type `… | undefined`: neither
    // tsconfig sets noUncheckedIndexedAccess, so a bare index would type as non-undefined
    // and `if (gate)` would read as an always-true test. Same idiom as the dispatcher's
    // action lookup and lib/permissionImplications.ts's table lookup.
    const gate = Object.prototype.hasOwnProperty.call(OPTIONAL_FEATURE_NAMESPACES, namespace)
        ? OPTIONAL_FEATURE_NAMESPACES[namespace]
        : undefined;
    if (gate && !(await isOptionalFeatureEnabled(gate.feature))) {
        log.warn('upload target feature-disabled', { userId: user.id, feature, module: gate.feature });
        auditUploadDenial('upload.feature_disabled.denied', { user, ip: getClientIp(req), details: { feature, module: gate.feature } });
        res.status(403).json({ message: `The ${gate.label} feature is not enabled.` });
        return;
    }

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
        res.status(400).json({ message: 'Empty or invalid image body' });
        return;
    }

    try {
        const result = await uploadOrgMedia(feature, buf);
        // Ids and byte count only — never the image content or PII.
        log.info('org media uploaded', { userId: user.id, feature, bytes: buf.length, key: result.key });
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ success: true, url: result.url, key: result.key, visibility: result.visibility });
    } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (msg === 'Image too large') {
            res.status(413).json({ message: 'Image too large.' });
            return;
        }
        if (msg === 'Unsupported or invalid image') {
            res.status(415).json({ message: 'Unsupported image type. Use PNG, JPEG, WEBP, GIF, or AVIF.' });
            return;
        }
        if (msg === 'Storage limit reached') {
            auditUploadDenial('upload.storage_cap.denied', { user, ip: getClientIp(req), details: { feature } });
            res.status(507).json({ message: 'Storage limit reached. Remove some uploaded images to free space.' });
            return;
        }
        log.error('org media upload failed', { err: e });
        res.status(500).json({ message: 'Upload failed' });
    }
}
