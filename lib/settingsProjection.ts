import { permissionSatisfied } from './permissionImplications.js';

/**
 * The settings keys a browser-bound payload may carry, UNCONDITIONALLY.
 *
 * ALLOWLIST, not a denylist — and that direction is the whole point. getAllSettings
 * (lib/db/system.ts) reduces EVERY row of the `settings` table into one blob by key with
 * no filter, and that blob was spread wholesale into three authenticated payloads
 * (lib/db.ts getState, for target=initial-state AND the no-subset full state; api/query.ts's
 * `main` case, for the refresh path). stripSecrets is a NAMED-KEY pass, so anything it does
 * not name ships: that is how schema_version, setup_completed, allianceSelfProfile,
 * allianceSyncConfig, system_broadcast and orgFeatures all reached every authenticated
 * member — an external customer on the Client role included — with zero consumers between
 * them.
 *
 * It also shipped keys this fork has never heard of. lib/db/importer.ts filters imported
 * settings rows against a denylist and then falls through to `default: return row`, so an
 * unknown key (hosted's `starCommsConfig`, say) is inserted verbatim and then rode this
 * blob. Its `apiKey` field would survive the regex backstop in stripSecrets because that
 * pattern is underscore-anchored (`_api_key`, `_secret`, …) and a camelCase `apiKey` /
 * `apiSecret` has no leading underscore.
 *
 * SCOPE — this closes the KEY set, not the FIELD set. Five of the keys below are persisted
 * by spread or verbatim (lib/db/system.ts: heroCardConfig, brandingConfig and openGraphConfig
 * spread `{ ...(config || {}) }`; governmentsConfig and hrConfig upsert `value: config`), and
 * stripSecrets rebuilds only discordConfig / aiConfig / radioConfig / publicPageConfig /
 * platformSettings on the way out. So a new field added under one of the other five reaches
 * the browser even though its key was allow-listed here. Every writer is permission-gated and
 * admin-authored and the SECRET_KEY backstop catches underscore-shaped names, so this is a
 * follow-up (F7 — extend the rebuild pattern), not a hole this module can close.
 *
 * ADDING A KEY HERE PUBLISHES IT TO EVERY AUTHENTICATED CALLER, INCLUDING A CLIENT.
 * Do not add one because "the admin console needs it" — check whether a permission-gated RPC
 * already serves it (alliance:get_self_profile and admin:get_intel_sharing_config are the
 * precedents), and if the consumer is domain-gated, add it to GATED_SETTINGS_KEYS instead.
 * tests/settingsProjection.test.ts pins this exact array.
 *
 * NOT typed `ReadonlyArray<keyof SettingsBlob>`, deliberately: SettingsBlob
 * (lib/db/system.ts) has no `platformSettings` member, yet lib/db/platform.ts stores it under
 * exactly that settings key, so getAllSettings' reduce puts it in the blob at RUNTIME. The
 * type-safe-looking declaration will not compile, and "fixing" that by deleting the entry
 * would silently kill the maintenance banner and force-logout on every subset=main refresh
 * (contexts/DataContext.tsx is the sole application site, and the boot path appends its own
 * copy AFTER the spread — so on `main` this blob copy is the only carrier).
 */
export const CLIENT_SETTINGS_KEYS = [
    'brandingConfig',
    'themeConfig',
    'discordConfig',
    'heroCardConfig',
    'openGraphConfig',
    'radioConfig',
    'aiConfig',
    'publicPageConfig',
    'governmentsConfig',
    'platformSettings',
] as const;

/**
 * Settings keys whose CONSUMERS all sit behind one domain read permission, gated on that
 * same permission here so the config cannot outrun the subset it configures.
 *
 * wikiHomeConfig configures the `wiki` subset, which api/query.ts's
 * SUBSET_REQUIRED_PERMISSION gates on wiki:view — but the config itself rode `main` to every
 * member, welcomeContent (the wiki home page's whole rich-text body) included; the read path
 * gated only the private-image SIGNING. hrConfig is the same drift one domain over
 * (`hr: 'hr:view'`).
 *
 * BARE gate strings, matching SUBSET_REQUIRED_PERMISSION exactly. Do NOT widen either to a
 * `view || edit` disjunct: that would make this read WIDER than the subset it configures,
 * which is precisely the drift getMainState's boundary comment records was deliberately
 * removed. The destructive-save hazard that widening was proposed to fix is closed on the
 * WRITE side instead — updateWikiHomeConfig (lib/db/system.ts) read-merges rather than
 * replacing wholesale, so an entitled writer who never received the config cannot blank it.
 *
 * DELETE, not an empty object: every client setter guards presence
 * (contexts/ConfigContext.tsx, `if (data.wikiHomeConfig)`) over a safe useState default
 * (`{}`), so absent degrades to the default and an entitled reader is unaffected. Absent
 * means absent.
 *
 * This is a no-op for every SEEDED tier: MEMBER_DEFAULT_PERMS and DISPATCHER_DEFAULT_PERMS
 * (lib/roleDefaultPermissions.ts) both hold wiki:view AND hr:view, and the seeder defines
 * Admin as every permission. CLIENT_DEFAULT_PERMS is request:create|cancel|rate only. The
 * only tiers that lose anything are Client and custom roles below staff — the intended shape.
 *
 * NOT THE ONLY ROUTE to wikiHomeConfig's body: exportWikiPages (lib/db/wiki.ts) reads the
 * row directly and returns it in the export bundle, gated `admin:access` rather than
 * wiki:view (api/services.ts 'wiki:export_pages'). Not a Client leak — a Client holds
 * neither string — but do not read this gate as "the key is fully closed on wiki:view".
 *
 * ACCEPTED RESIDUAL R9 (Phase 3 owner decision OD-7): a member granted wiki:view or
 * hr:view MID-SESSION gets the nav and the page list (the subset passes on mount) but a
 * BLANK wiki home page / missing probation banner until the next `main` fetch, because
 * updateRolePermissions emits no broadcast and nothing refetches `main` on a permission
 * change. Self-healing on any reload or admin config save. Deliberately not mitigated by
 * firing refreshMainState from the permission-change effect.
 */
export const GATED_SETTINGS_KEYS: ReadonlyArray<{ key: string; perm: string }> = [
    { key: 'wikiHomeConfig', perm: 'wiki:view' },
    { key: 'hrConfig', perm: 'hr:view' },
];

/**
 * Rebuild the settings blob as the projection this viewer is entitled to.
 *
 * FAILS CLOSED by construction: an unknown key is absent because it was never copied, and a
 * null/undefined/non-array permission list satisfies nothing (permissionSatisfied fails
 * closed on a non-array), so a caller we cannot authorize gets the unconditional set only.
 *
 * Generic in T so the caller's SettingsBlob type is preserved as Partial<T>. Returning a bare
 * Record<string, unknown> makes the property vanish from getState()'s inferred spread —
 * `state.discordConfig` then fails to compile under tsconfig.server.json — which is the same
 * class of breakage lib/db/system.ts's SettingsBlob docblock records an earlier narrowing was
 * reverted for. Run BOTH `npx tsc --noEmit` and `npm run build:server` after touching this.
 *
 * `permissions` is the server-resolved array off the user row. This is the same predicate
 * api/query.ts's callerHasSubsetPermission runs with a null ctx, so the implication table
 * (lib/permissionImplications.ts) applies identically and the two cannot drift. A hand-rolled
 * `permissions.includes(perm)` here would silently drop a future implication.
 *
 * Two implementation details that are load-bearing, not style:
 *  1. hasOwnProperty guard, not `if (src[key] !== undefined)`. An absent key must stay ABSENT,
 *     never present-with-undefined: JSON.stringify drops undefined so the wire is the same,
 *     but the in-process return would carry an own property that `'x' in obj` and Object.keys
 *     treat differently — and the pinning tests assert on both.
 *  2. Shallow copy, not a clone. `out[key] = src[key]` keeps the same object references, so
 *     the in-place `wikiHome.welcomeContent = await signDocMediaForClient(...)` mutation on
 *     both read paths continues to work unchanged. getAllSettings builds a fresh object per
 *     call, so nothing is shared across requests.
 */
export function projectSettingsForViewer<T extends object>(
    settings: T | null | undefined,
    permissions: readonly string[] | undefined | null,
): Partial<T> {
    const out: Record<string, unknown> = {};
    if (!settings || typeof settings !== 'object') return out as Partial<T>;
    const src = settings as unknown as Record<string, unknown>;
    for (const key of CLIENT_SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
    }
    for (const { key, perm } of GATED_SETTINGS_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        if (!permissionSatisfied(permissions, perm)) continue;
        out[key] = src[key];
    }
    return out as Partial<T>;
}
