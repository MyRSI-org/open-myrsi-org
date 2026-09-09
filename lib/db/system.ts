
import { supabase, handleSupabaseError, safeFetch, broadcastToOrg, broadcastToChannel, getSystemRoles } from './common.js';
import { cache } from '../cache.js';
import { sendPushToAll, sendPushToStaff, sendPushToPermission } from '../push.js';
import { drainStaleOperationReminders } from './opReminders.js';
import { liftBansOnSystemAdmins } from './bans.js';
import { backfillOptionalModuleRoleDefaults, type RoleDefaultsBackfillResult } from './roleDefaults.js';
import { toUnitPost, toServiceTypeConfig } from './mappers.js';
import type { Tables } from './rows.js';
import type { AIConfig, Announcement, BrandingConfig, Certification, Commendation, DiscordConfig, ExternalTool, GovernmentsFeatureConfig, HeroCardConfig, HRConfig, IntelSharingConfig, Location, OpenGraphConfig, PublicPageConfig, RadioChannel, RadioConfig, Rank, Role, ServiceTypeConfig, SpecializationTag, SystemConfig, ThemeConfig, UnitPost, WikiHomeConfig } from '../../types.js';
import { normalizeHexColor } from '../color.js';
import { normalizeDocMediaForStorage, assertDocImageCap } from '../orgMediaDocs.js';
import { randomBytes, createHash } from 'node:crypto';
import { assertRoleIsNotClient, enforceClientRolePermissionLock } from './clientRoleLock.js';
import { encryptConfigSecrets, decryptConfigSecrets, encryptSecret, decryptSecret, hasPreviousKey } from '../crypto.js';
import { inventorySecretCiphertexts } from './secretsRotation.js';
import { recordSecurityEvent } from './securityEvents.js';
import { isKeyExpired, normalizeScopes, type ApiKeyScope } from '../apiKeyScopes.js';
import { sanitizeImageUrl, sanitizeImageUrlOrLocalPath } from '../imageUrl.js';
import { ADMIN_WRITABLE_DISCORD_KEYS, normaliseDiscordSnowflake } from '../discordConfigKeys.js';
import { stripHtml as sharedStripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { sanitizeTiptapJson, tryParseTiptapJson } from '../tiptapValidate.js';
import { sanitizePublicLinkUrl } from '../linkUrl.js';
import { sanitizeRichHtml } from '../htmlSanitize.js';
import { SecurityDenial } from '../errors.js';
import { requireUuid } from '../pgrest.js';
import { log as baseLog } from '../log.js';
import { compareSchemaVersion } from '../schemaVersion.js';

const log = baseLog.child({ module: 'db.system' });

const defaultIconUrl = '/media/cross-swords.png';

const DEFAULT_PUBLIC_PAGE_CONFIG = {
    enabled: false,
    motto: '',
    blurb: '',
    heroImageUrl: '',
    profileImageUrl: '',
    modules: { stats: false, testimonials: false, services: false, links: false },
    links: [] as Array<{ id: string; label: string; url: string; icon?: string }>,
    featuredTestimonialIds: [] as string[],
};

// Settings are stored one row per `key` and reduced into this typed blob by
// getAllSettings. The first ten keys are always present (seeded by `defaults`);
// the remainder are DB-row dependent. Deliberately NO catch-all index signature
// — getState() spreads this into the combined app state, and an index signature
// would collapse that state's property types to `unknown` (the reason an earlier
// narrowing attempt was reverted). The dynamic-key reduce uses a local cast.
// heroCard/openGraph/radio are Partial because their seeded default is `{}`.
export interface SettingsBlob {
    brandingConfig: BrandingConfig;
    discordConfig: DiscordConfig;
    heroCardConfig: Partial<HeroCardConfig>;
    openGraphConfig: Partial<OpenGraphConfig>;
    radioConfig: Partial<RadioConfig>;
    aiConfig: AIConfig;
    systemConfig: SystemConfig;
    wikiHomeConfig: WikiHomeConfig;
    governmentsConfig: GovernmentsFeatureConfig;
    publicPageConfig: PublicPageConfig;
    hrConfig?: HRConfig;
    intelSharingConfig?: IntelSharingConfig;
    themeConfig?: Partial<ThemeConfig>;
    geminiKey?: string;
    admin_setup_code?: { code: string; created_at: string };
}

// Returns the typed settings blob. The ten always-present keys come from
// `defaults`; DB rows overlay them (including dynamic keys like admin_setup_code,
// captured via a local cast on the reduce). Decrypt/merge steps reintroduce
// secret-bearing supersets, so they carry localized `as` casts.
export async function getAllSettings(opts?: { decryptSecrets?: boolean }): Promise<SettingsBlob> {
    const query = supabase.from('settings').select('key, value');

    const { data, error } = await query;
    if (error && error.code === '42P01') return { brandingConfig: { name: 'OPERATIONS', iconUrl: defaultIconUrl }, discordConfig: {}, heroCardConfig: {}, openGraphConfig: {}, radioConfig: {}, aiConfig: { enabled: false }, systemConfig: { appUrl: '' }, wikiHomeConfig: {}, governmentsConfig: { enabled: false }, publicPageConfig: DEFAULT_PUBLIC_PAGE_CONFIG };
    handleSupabaseError({ error, message: 'Failed to get settings' });
    const defaults: SettingsBlob = { discordConfig: {}, brandingConfig: { name: 'OPERATIONS', iconUrl: defaultIconUrl }, heroCardConfig: {}, openGraphConfig: {}, radioConfig: {}, aiConfig: { enabled: false }, systemConfig: { appUrl: '' }, wikiHomeConfig: {}, governmentsConfig: { enabled: false }, publicPageConfig: DEFAULT_PUBLIC_PAGE_CONFIG };
    const result = ((data || []) as Array<{ key: string; value: unknown }>).reduce((acc: SettingsBlob, curr) => { (acc as unknown as Record<string, unknown>)[curr.key] = curr.value; return acc; }, defaults);
    // Decrypt sensitive fields after reading from DB. Client-facing / boot /
    // public read paths pass { decryptSecrets: false } so live credentials are
    // never pulled into memory there — stripSecrets becomes defense-in-depth, not
    // the only line. Server-internal consumers that need plaintext omit the opt.
    if (opts?.decryptSecrets !== false) {
        result.discordConfig = decryptConfigSecrets('discordConfig', result.discordConfig) as DiscordConfig;
        result.radioConfig = decryptConfigSecrets('radioConfig', result.radioConfig) as Partial<RadioConfig>;
        // Merge separately-stored geminiKey back into aiConfig for frontend consumption
        if (result.geminiKey) {
            const decryptedGeminiKey = typeof result.geminiKey === 'string' ? decryptSecret(result.geminiKey) : result.geminiKey;
            result.aiConfig = { ...result.aiConfig, apiKey: decryptedGeminiKey };
        }
    }
    return result;
}

// Minimal reader for pre-JWT / unauthenticated surfaces (public org page,
// testimonials). Selects only the public-intent config keys and NEVER decrypts a
// secret — so the anonymous path can't pull the Discord/LiveKit/Gemini
// credentials into memory at all.
export async function getPublicSettings(): Promise<Pick<SettingsBlob, 'publicPageConfig' | 'brandingConfig'>> {
    const fallback = { brandingConfig: { name: 'OPERATIONS', iconUrl: defaultIconUrl }, publicPageConfig: DEFAULT_PUBLIC_PAGE_CONFIG } as Pick<SettingsBlob, 'publicPageConfig' | 'brandingConfig'>;
    const { data, error } = await supabase.from('settings').select('key, value').in('key', ['publicPageConfig', 'brandingConfig']);
    if (error && error.code === '42P01') return fallback;
    handleSupabaseError({ error, message: 'Failed to get public settings' });
    const result = { ...fallback };
    for (const row of (data || []) as Array<{ key: string; value: unknown }>) {
        (result as unknown as Record<string, unknown>)[row.key] = row.value;
    }
    return result;
}

// --- FIRST-RUN SETUP STATE --------------------------------------------------

/** True once the onboarding wizard's final screen has been dismissed. */
export async function isSetupCompleted(): Promise<boolean> {
    const { data } = await supabase.from('settings').select('value').eq('key', 'setup_completed').maybeSingle();
    return data?.value === true;
}

/** Mark first-run setup complete (idempotent). Called from system:complete_setup. */
export async function setSetupCompleted(): Promise<{ success: true }> {
    const { error } = await supabase.from('settings').upsert({ key: 'setup_completed', value: true }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to mark setup complete' });
    return { success: true };
}

/**
 * Pre-auth preflight status for the onboarding wizard. Returns BOOLEANS ONLY —
 * never env values or secrets. Critical (the wizard blocks on these) =
 * dbConnected + discordConfigured (you sign in with Discord next); the rest are
 * advisories with fix-it tips.
 */
// A signing/encryption secret is only acceptable when it is present AND has
// sufficient entropy. We use the same >=32-char floor as the production boot
// guard (server.ts SECRETS_ENCRYPTION_KEY check) — a short/low-entropy key
// weakens HMAC session signing (JWT_SECRET), realtime-token signing
// (SUPABASE_JWT_SECRET), and AES key derivation (SECRETS_ENCRYPTION_KEY).
// Raw length (no trim) to stay byte-aligned with the boot check.
const SECRET_MIN_LENGTH = 32;
const isStrongSecret = (v: string | undefined): boolean => typeof v === 'string' && v.length >= SECRET_MIN_LENGTH;

export async function getPreflightStatus(): Promise<{
    dbConnected: boolean; adminExists: boolean; discordConfigured: boolean;
    realtimeEnabled: boolean; secretsEncrypted: boolean; sessionSecretStrong: boolean;
    setupCompleted: boolean; setupCodeExists: boolean;
}> {
    let dbConnected = false, adminExists = false, setupCompleted = false, setupCodeExists = false;
    let discordClientId: string | undefined = process.env.DISCORD_CLIENT_ID || undefined;
    try {
        // A trivial keyed read doubles as the DB-reachability probe.
        const { data, error } = await supabase.from('settings').select('key, value')
            .in('key', ['setup_completed', 'admin_setup_code', 'discordConfig']);
        if (!error) {
            dbConnected = true;
            const byKey = new Map((data || []).map((r) => [r.key, r.value]));
            setupCompleted = byKey.get('setup_completed') === true;
            setupCodeExists = byKey.get('admin_setup_code') != null;
            if (!discordClientId) discordClientId = (byKey.get('discordConfig') as { clientId?: string } | undefined)?.clientId || undefined;
        }
    } catch { /* dbConnected stays false (DB unreachable) */ }

    // Once setup is complete, this PUBLIC action stops being a posture oracle: an
    // anonymous caller must not learn whether secrets are weak/encrypted, whether
    // an admin exists, or whether a claim code is outstanding. The wizard only
    // calls preflight pre-setup, so a post-setup caller gets nothing actionable.
    if (setupCompleted) {
        return {
            dbConnected, adminExists: true, discordConfigured: true,
            realtimeEnabled: true, secretsEncrypted: true, sessionSecretStrong: true,
            setupCompleted: true, setupCodeExists: false,
        };
    }
    try {
        const roles = await getSystemRoles();
        if (dbConnected && roles.admin) {
            const { count } = await supabase.from('users').select('id', { count: 'exact', head: true })
                .eq('role_id', roles.admin.id).is('deleted_at', null);
            adminExists = (count ?? 0) > 0;
        }
    } catch { /* adminExists stays false */ }
    return {
        dbConnected, adminExists,
        discordConfigured: !!discordClientId,
        // Each secret must be present AND >=32 chars (entropy floor). A present-
        // but-short secret reports false so the wizard flags it. Booleans only —
        // the env values themselves never cross the wire (pinned by the test).
        realtimeEnabled: isStrongSecret(process.env.SUPABASE_JWT_SECRET),
        secretsEncrypted: isStrongSecret(process.env.SECRETS_ENCRYPTION_KEY),
        sessionSecretStrong: isStrongSecret(process.env.JWT_SECRET),
        setupCompleted, setupCodeExists,
    };
}

function broadcastSettingsUpdate() {
    broadcastToOrg('settings_update', {});
}

export const updateDiscordSettings = async (config: Record<string, unknown>) => {
    // Fetch existing config to merge — prevents partial updates from wiping unrelated fields
    // (e.g. saving newRequestChannelId from tenant dashboard must not erase botToken/clientSecret set via portal)
    const existingQuery = supabase.from('settings').select('value').eq('key', 'discordConfig');
    const { data: existing } = await existingQuery.maybeSingle();
    // Decrypt existing before merging so we don't double-encrypt
    const decryptedExisting = decryptConfigSecrets('discordConfig', existing?.value || {});
    // ALLOWLIST REBUILD, never a spread of the client blob (Rule 2). The payload
    // reaches here as `stripActorFields(payload)` from admin:update_discord_config,
    // which removes actor ids but NOT arbitrary keys — without this an
    // admin:config:discord holder could POST botToken/clientSecret/guildId and
    // repoint the deployment's whole Discord integration (lib/crypto.ts encrypts
    // them, lib/secrets.ts then serves them as live credentials wherever the
    // matching env var is unset). Derived from lib/discordConfigKeys.ts, the same
    // source stripSecrets rebuilds the read-back from.
    const safeConfig: Record<string, unknown> = {};
    for (const key of ADMIN_WRITABLE_DISCORD_KEYS) {
        if (!Object.hasOwn(config, key)) continue;
        const incoming = config[key];
        // Validate only what actually CHANGES. These ids are interpolated straight
        // into Discord API paths, so a new junk value must be refused at the
        // boundary. But the settings tab posts EVERY field on each save, so
        // validating unconditionally would lock a deployment out of saving ANY
        // Discord setting because one unrelated field holds legacy junk from before
        // this validation existed. Pass an unchanged value through untouched;
        // refuse a changed one.
        const unchanged = String(incoming ?? '') === String((decryptedExisting as Record<string, unknown>)[key] ?? '');
        safeConfig[key] = unchanged ? incoming : normaliseDiscordSnowflake(incoming, key);
    }
    // The spread of `decryptedExisting` is load-bearing: a self-host that
    // configured botToken/clientSecret/guildId into settings.discordConfig would
    // otherwise lose its live credentials on the admin's next channel save. The
    // allowlist BOUNDS writes; it never deletes existing keys.
    const mergedConfig = { ...decryptedExisting, ...safeConfig };
    // Encrypt sensitive fields before storing
    const encryptedConfig = encryptConfigSecrets('discordConfig', mergedConfig);

    const { error } = await supabase.from('settings').upsert({ key: 'discordConfig', value: encryptedConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update Discord settings' });
    broadcastSettingsUpdate();
};
// Write-boundary check for an operator-supplied URL that is PUSHED to every browser.
// Empty clears the field; anything the sanitizer refuses is REJECTED, not silently
// blanked. Rejection (rather than the silent-clear contract the image fields use) is
// deliberate for these: both branding editors re-send the WHOLE config object and the
// upsert replaces the whole `value`, so a silent clear would destroy a stored icon or
// chime as a side effect of saving an unrelated field — including a Terms-of-Service
// save that never touched it. A throw refuses the write and leaves the stored value
// intact, and the operator is told which field to fix instead of losing it silently.
const requirePersistableUrl = (
    raw: unknown,
    sanitize: (v: unknown) => string | null,
    field: string,
    hint: string,
): string => {
    if (raw == null || raw === '') return '';
    const safe = sanitize(raw);
    if (!safe) throw new Error(`Invalid ${field}: ${hint}`);
    return safe;
};

const LINK_URL_HINT = 'must be a public https:// URL.';
const ICON_URL_HINT = 'must be an https image URL (.png/.jpg/.jpeg/.gif/.webp/.avif) or a shipped /media, /assets or /icons path.';

export const updateHeroCardConfig = async (config: Record<string, unknown>) => {
    // discordUrl/organizationUrl are rendered straight into <a href> on the dashboard
    // hero card (components/ui/HeroCard.tsx), settable by a holder of the delegable
    // admin:config:branding perm — so a typosquat/phishing target or an internal host
    // must not reach the column. Unconditional: both are non-optional on HeroCardConfig
    // and the sole client caller always sends the whole object, with '' as "cleared".
    // backgroundImageUrl keeps its established silent-clear contract (it is a CSS
    // background, and HeroCard re-validates it at render).
    const safeConfig = {
        ...(config || {}),
        backgroundImageUrl: sanitizeImageUrl(config?.backgroundImageUrl) || '',
        discordUrl: requirePersistableUrl(config?.discordUrl, sanitizePublicLinkUrl, 'discordUrl', LINK_URL_HINT),
        organizationUrl: requirePersistableUrl(config?.organizationUrl, sanitizePublicLinkUrl, 'organizationUrl', LINK_URL_HINT),
    };
    const { error } = await supabase.from('settings').upsert({ key: 'heroCardConfig', value: safeConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update hero card config' });
    broadcastSettingsUpdate();
};
// Audio *Url fields on brandingConfig. Every one of these is pushed to every member
// and fetched by lib/audioCache.ts prefetchSound(), which sets .src and calls .load()
// at boot with NO user gesture — so an attacker-chosen host harvests the IP and
// User-Agent of every member who opens the app (CSP media-src allows any https host).
// notificationSoundUrl is declared-but-unplayed today; validated anyway so it can't
// become a live forced-fetch vector the day something starts playing it.
const BRANDING_SOUND_URL_FIELDS = [
    'bootSoundUrl', 'newRequestSoundUrl', 'assignmentSoundUrl',
    'eamSoundUrl', 'radioMicCueUrl', 'radioSquelchUrl', 'notificationSoundUrl',
] as const;

export const updateBrandingConfig = async (config: Record<string, unknown>) => {
    const safeConfig: Record<string, unknown> = { ...(config || {}) };
    // iconUrl feeds the SSR <link rel=icon>, the boot splash, the PWA manifest, the
    // service worker, the UNAUTHENTICATED public page and the outbound Discord embed
    // icon_url — an arbitrary-origin forced fetch from every browser AND from Discord's
    // servers. OrLocalPath (not the strict https variant) because the shipped default is
    // the same-origin '/media/cross-swords.png' (lib/db/seeder.ts).
    if ('iconUrl' in safeConfig) {
        safeConfig.iconUrl = requirePersistableUrl(safeConfig.iconUrl, sanitizeImageUrlOrLocalPath, 'iconUrl', ICON_URL_HINT);
    }
    // termsOfService is rich HTML rendered with dangerouslySetInnerHTML on the
    // client. Sanitize on WRITE (mirrors the client's default DOMPurify) so raw
    // markup is never stored — defense in depth over the render-time DOMPurify.
    // Keyed on presence, not on `typeof === 'string'`: a crafted non-string (an ARRAY
    // of markup, say) used to skip the ternary entirely and survive the spread, and
    // String(['<img onerror=…>']) is live markup. sanitizeRichHtml returns '' for
    // non-strings, so coercing every present value is both simpler and closed.
    if ('termsOfService' in safeConfig) safeConfig.termsOfService = sanitizeRichHtml(safeConfig.termsOfService);
    // Emitted into the SSR <meta name="theme-color">. Escaped at the sink, so this is
    // normalisation rather than a hole — drop-on-invalid keeps branding consistent with
    // the sibling updateOpenGraphConfig writer below.
    if ('themeColor' in safeConfig) {
        const color = sanitizeThemeColor(safeConfig.themeColor);
        if (color) safeConfig.themeColor = color; else delete safeConfig.themeColor;
    }
    // Without this the spread persisted the sound URLs verbatim. sanitizePublicLinkUrl
    // (NOT an image sanitizer — these are .mp3 URLs, and the image extension allow-list
    // would reject every shipped default) rejects anything that is not a public https://
    // host, which is also what the client-side editor's own validator should require.
    for (const f of BRANDING_SOUND_URL_FIELDS) {
        if (f in safeConfig) safeConfig[f] = requirePersistableUrl(safeConfig[f], sanitizePublicLinkUrl, f, LINK_URL_HINT);
    }
    const { error } = await supabase.from('settings').upsert({ key: 'brandingConfig', value: safeConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update branding config' });
    broadcastSettingsUpdate();
};
export const updateThemeConfig = async (config: Record<string, unknown>) => {
    if (!config || typeof config !== 'object') throw new Error('Invalid theme config payload');
    // Mass-assignment defense: rebuild from an explicit allowlist — NEVER spread the
    // payload. Only { enabled, accent } are persisted; accent is re-validated to canonical
    // #rrggbb (an invalid value is dropped, so it can never reach the CSS sink).
    const accent = normalizeHexColor((config as { accent?: unknown }).accent);
    const value: { enabled: boolean; accent?: string } = { enabled: (config as { enabled?: unknown }).enabled === true };
    if (accent) value.accent = accent;
    const { error } = await supabase.from('settings').upsert({ key: 'themeConfig', value }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update theme config' });
    broadcastSettingsUpdate();
};
// Accepts #rgb / #rrggbb / #rrggbbaa (case-insensitive). Anything else (named
// colours, rgb()/hsl() functions, urls, expressions) is dropped on write so a
// crafted themeColor can never reach the SSR <meta name="theme-color"> tag.
const THEME_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const sanitizeThemeColor = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return THEME_COLOR_RE.test(trimmed) ? trimmed : undefined;
};

export const updateOpenGraphConfig = async (config: Record<string, unknown>) => {
    // Mirror the validation the 3 sibling config writers do
    // (updateHeroCardConfig/updateBrandingConfig/updatePublicPageConfig). The OG
    // imageUrl/faviconUrl feed SSR <meta og:image>/<link rel="icon"> tags and the
    // themeColor feeds <meta name="theme-color">; sanitize on WRITE so a tracking
    // host / non-image / non-colour value is never persisted. Image fields follow
    // the silent-clear contract (invalid → '', not a throw, matching heroCard).
    const safeConfig: Record<string, unknown> = { ...(config || {}) };
    if ('imageUrl' in safeConfig) safeConfig.imageUrl = sanitizeImageUrl(safeConfig.imageUrl) || '';
    if ('faviconUrl' in safeConfig) safeConfig.faviconUrl = sanitizeImageUrl(safeConfig.faviconUrl) || '';
    if ('pwaIconUrl' in safeConfig) safeConfig.pwaIconUrl = sanitizeImageUrl(safeConfig.pwaIconUrl) || '';
    if ('themeColor' in safeConfig) {
        const color = sanitizeThemeColor(safeConfig.themeColor);
        if (color) safeConfig.themeColor = color; else delete safeConfig.themeColor;
    }
    const { error } = await supabase.from('settings').upsert({ key: 'openGraphConfig', value: safeConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update OpenGraph config' });
    broadcastSettingsUpdate();
};
export const updateRadioConfig = async (config: Record<string, unknown>) => {
    // Fetch existing config to merge — prevents partial updates from wiping apiKey/apiSecret
    const existingQuery = supabase.from('settings').select('value').eq('key', 'radioConfig');
    const { data: existing } = await existingQuery.maybeSingle();
    const decryptedExisting = decryptConfigSecrets('radioConfig', existing?.value || {});
    const mergedConfig = { ...decryptedExisting, ...config };
    const encryptedConfig = encryptConfigSecrets('radioConfig', mergedConfig);

    const { error } = await supabase.from('settings').upsert({ key: 'radioConfig', value: encryptedConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update radio config' });
    broadcastSettingsUpdate();
};
// This was the only Tiptap write path storing its doc unsanitised, so the
// ALLOWED_IFRAME_HOSTS check on iframe/youtube nodes, the forced
// rel="noopener noreferrer" sanitizeMark stamps onto links, and MAX_DOC_IMAGES
// were all bypassed here — while the stored blob ships to every authenticated
// caller in the `main` subset and gets its media re-signed on each read. The
// `{ ...config }` spread also allowed arbitrary keys into the settings row.
// Now mirrors updateWikiPage (sanitize + image cap) and updatePublicPageConfig
// (explicit key allowlist).
export const updateWikiHomeConfig = async (config: Partial<WikiHomeConfig>, opts?: { merge?: boolean }) => {
    if (!config || typeof config !== 'object') throw new Error('Invalid wiki home config payload');

    const allowedKeys = new Set(['welcomeContent', 'featuredPageIds', 'hideRecentlyUpdated']);
    for (const k of Object.keys(config)) {
        if (!allowedKeys.has(k)) throw new Error(`Unknown wiki home config field: ${k}`);
    }

    // READ-MERGE, never a wholesale replace (Phase 3 owner decision OD-6). Every caller
    // posts `{ ...config, <one field> }` from the wiki home editor, where `config` is
    // whatever the browser hydrated. Building `value` from EMPTY meant that whenever that
    // hydrated copy was absent, one click of any single editor control replaced the org's
    // entire wiki home page with one field.
    //
    // Item 8 made that reachable rather than theoretical: projectSettingsForViewer
    // (lib/settingsProjection.ts) withholds wikiHomeConfig from a caller without wiki:view,
    // and the WRITE gate is wiki:edit_page (api/services.ts) — a pruned 'Admin'-named role
    // is the most reachable holder of one without the other, because the CLIENT
    // hasPermission short-circuits on role === 'Admin' and renders the editor regardless.
    // The read gate is deliberately NOT widened to close this: that would make the config
    // read wider than the `wiki` subset it configures. The write is made non-destructive
    // instead — strictly narrower, and it also closes a PRE-EXISTING first-paint race where
    // a toggle clicked before the first `main` payload landed had the same empty spread.
    //
    // Fails CLOSED on a read fault: without the explicit error check a transient DB blip
    // would yield `existing = undefined`, collapse the base to {} and perform exactly the
    // wipe this merge exists to prevent.
    //
    // `merge: false` is for the ORG IMPORTER only (lib/db/wiki.ts importWikiPages), which
    // posts a COMPLETE config exported from the source org — there, "the target keeps a
    // field the source did not have" is an import-fidelity break, not a rescue. Every
    // interactive caller posts a PARTIAL config and must merge. Do not pass it to quieten
    // an editor path: that re-creates the wipe this exists to close.
    const merge = opts?.merge !== false;
    const value: Partial<WikiHomeConfig> = {};
    let stored: Partial<WikiHomeConfig> | null = null;
    if (merge) {
        const { data: existing, error: readError } = await supabase.from('settings')
            .select('value').eq('key', 'wikiHomeConfig').maybeSingle();
        handleSupabaseError({ error: readError, message: 'Failed to read wiki home config' });

        // Base rebuilt through the SAME allow-list the payload is checked against, so a
        // stray key already sitting in the row is dropped rather than re-persisted forever.
        stored = (existing?.value || {}) as Partial<WikiHomeConfig>;
        for (const k of allowedKeys) {
            if (Object.hasOwn(stored, k)) (value as Record<string, unknown>)[k] = (stored as Record<string, unknown>)[k];
        }
    }

    // Posted fields overwrite the stored base — EXCEPT a welcome document that came back
    // structurally identical to the one already stored.
    //
    // All three client save paths POST `{...config, <one field>}`, so ticking the
    // "hide recently updated" checkbox hands the server back the entire welcome document.
    // Re-running the sanitiser over it MUTATES content nobody touched: the sanitiser is a
    // node/URL POLICY, and every policy decision it applies — a dropped node, a rewritten
    // embed src, an image collapsed because the read signer fell back — is a change the
    // user did not ask for, applied silently, 200 OK. assertDocImageCap is the same hazard
    // in reverse: an org already over the cap could no longer save the OTHER two fields.
    //
    // THIS WEAKENS NOTHING **BECAUSE THE IMPORTER NOW SANITISES TOO**. The branch re-stores a
    // value derived solely from what is persisted, so no client content can enter through it
    // — but that is only safe if "persisted" implies "sanitised", and until the
    // wikiHomeConfig case landed in sanitizeImportedSettingRow it did NOT: the org importer
    // was a second writer that sanitised nothing, and this passthrough would have made an
    // imported document permanently unsanitised instead of merely transiently so. Do not
    // remove that case. A real edit takes the sanitise path below, unchanged.
    //
    // Compare NORMALISED docs, never raw bytes: the read path hands the client freshly SIGNED
    // urls while the row holds durable KEYS, so a byte comparison would call every round-trip
    // an edit and defeat this on the first save. The branch is therefore NOT a byte-for-byte
    // no-op — normalizeDocMediaForStorage collapses signed urls to keys and drops an image
    // node whose src is empty. It re-stores the NORMALISED stored value, not the stored bytes.
    if (config.welcomeContent) {
        const storedWelcome = merge && stored && stored.welcomeContent
            ? normalizeDocMediaForStorage(stored.welcomeContent)
            : undefined;
        const postedNormalized = normalizeDocMediaForStorage(config.welcomeContent);
        if (storedWelcome !== undefined && isSameJson(postedNormalized, storedWelcome)) {
            value.welcomeContent = storedWelcome;
        } else {
            const safeContent = normalizeDocMediaForStorage(sanitizeTiptapJson(config.welcomeContent, 'wiki'));
            assertDocImageCap(safeContent);
            value.welcomeContent = safeContent;
        }
    } else if (config.welcomeContent !== undefined) {
        // Explicitly cleared — store the empty value rather than the raw falsy input.
        value.welcomeContent = null;
    }
    if (config.featuredPageIds !== undefined) {
        value.featuredPageIds = (Array.isArray(config.featuredPageIds) ? config.featuredPageIds : [])
            .filter((id): id is string => typeof id === 'string')
            .slice(0, 50);
    }
    if (config.hideRecentlyUpdated !== undefined) value.hideRecentlyUpdated = !!config.hideRecentlyUpdated;

    const { error } = await supabase.from('settings').upsert({ key: 'wikiHomeConfig', value }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update wiki home config' });
    broadcastSettingsUpdate();
};

/**
 * Structural equality by JSON serialisation — NOT canonicalised: key order counts.
 * Used ONLY to recognise a value the client read from us and handed straight back untouched.
 * `settings.value` is jsonb, so both the client's copy and the merge read come from the same
 * Postgres-normalised ordering. A false negative merely routes the value through the normal
 * sanitise path, so this fails in the safe direction and does not need to be exhaustive.
 */
const isSameJson = (a: unknown, b: unknown): boolean => {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

const PUBLIC_LINK_URL_RE = /^(https:\/\/|discord:\/\/)/i;
const HTML_TAG_RE = /<[^>]*>/g;

// Local alias — behaves the same as the shared helper. Retained as a named
// import site so existing call-sites in this file don't move.
const stripHtml = sharedStripHtml;

export const updatePublicPageConfig = async (config: Record<string, unknown>) => {
    if (!config || typeof config !== 'object') throw new Error('Invalid public page config payload');

    // Whitelist top-level keys to prevent silent field injection.
    const allowedKeys = new Set(['enabled', 'motto', 'blurb', 'heroImageUrl', 'profileImageUrl', 'modules', 'links', 'featuredTestimonialIds']);
    for (const k of Object.keys(config)) {
        if (!allowedKeys.has(k)) throw new Error(`Unknown public page config field: ${k}`);
    }

    const enabled = !!config.enabled;
    const motto = stripHtml(config.motto, 120);
    // #14: Blurb may arrive as either a Tiptap JSON document (serialized as
    // a string by the editor) OR a legacy plain-text string from older orgs
    // that haven't touched the field since the editor upgrade. Detect which
    // and route accordingly:
    //   - Plain text → stripHtml as before (defense in depth) and store
    //     verbatim. The public render path treats this as text.
    //   - Tiptap JSON → sanitizeTiptapJson with 'minimal' mode (drops disallowed
    //     nodes/marks, rejects javascript:/data: URLs) then re-serialize.
    //   - Length cap is enforced AFTER sanitization on whichever shape we got.
    let blurb: string;
    const rawBlurb = typeof config.blurb === 'string' ? config.blurb : '';
    const parsed = tryParseTiptapJson(rawBlurb);
    if (parsed) {
        const cleaned = sanitizeTiptapJson(parsed, 'minimal');
        const serialized = JSON.stringify(cleaned);
        blurb = serialized.length > 8000 ? serialized.slice(0, 8000) : serialized;
    } else {
        blurb = stripHtml(rawBlurb, 4000);
    }
    const validateImageUrl = (val: unknown, field: string): string => {
        if (val == null || val === '') return '';
        if (typeof val !== 'string') throw new Error(`${field} must be a string`);
        const cleaned = sanitizeImageUrl(val);
        if (!cleaned) throw new Error(`${field} must be an https URL ending in .png, .jpg, .jpeg, .gif, .webp, or .avif`);
        return cleaned;
    };
    const heroImageUrl = validateImageUrl(config.heroImageUrl, 'heroImageUrl');
    const profileImageUrl = validateImageUrl(config.profileImageUrl, 'profileImageUrl');

    const modulesIn = (config.modules && typeof config.modules === 'object' ? config.modules : {}) as Record<string, unknown>;
    const modules = {
        stats: !!modulesIn.stats,
        testimonials: !!modulesIn.testimonials,
        services: !!modulesIn.services,
        links: !!modulesIn.links,
    };

    const rawLinks = Array.isArray(config.links) ? config.links : [];
    if (rawLinks.length > 10) throw new Error('At most 10 external links are allowed');
    const links: Array<{ id: string; label: string; url: string; icon?: string }> = [];
    for (const rawLink of rawLinks) {
        if (!rawLink || typeof rawLink !== 'object') throw new Error('Invalid link entry');
        const l = rawLink as Record<string, unknown>;
        const url = sanitizePublicLinkUrl(l.url);
        if (!url) {
            throw new Error('Link URL must be a public https:// URL or a discord:// URI (no localhost / private IPs)');
        }
        // Backfill an id for legacy / id-less links rather than rejecting the whole
        // save (older configs predate the `id` field; the URL is validated above).
        const id = typeof l.id === 'string' && l.id ? l.id.slice(0, 64) : `lnk_${randomBytes(6).toString('base64url')}`;
        const label = stripHtml(l.label, 40);
        const icon = typeof l.icon === 'string' ? l.icon.replace(HTML_TAG_RE, '').slice(0, 40) : undefined;
        if (!label) throw new Error('Each link requires a label and a URL');
        links.push(icon ? { id, label, url, icon } : { id, label, url });
    }

    const rawIds = Array.isArray(config.featuredTestimonialIds) ? config.featuredTestimonialIds : [];
    if (rawIds.length > 6) throw new Error('At most 6 featured testimonials are allowed');
    const featuredTestimonialIds: string[] = [];
    const seenIds = new Set<string>();
    for (const id of rawIds) {
        if (typeof id !== 'string' || !id) throw new Error('Invalid testimonial id');
        if (seenIds.has(id)) throw new Error('Featured testimonials must be unique');
        seenIds.add(id);
        featuredTestimonialIds.push(id);
    }

    // Defence-in-depth: confirm each featured id belongs to THIS org and is a rated request with feedback.
    // Protects against a crafted payload that adds another org's testimonial via id injection.
    if (featuredTestimonialIds.length > 0) {
        const { verifyFeaturedTestimonialIdsBelongToOrg } = await import('./public.js');
        const check = await verifyFeaturedTestimonialIdsBelongToOrg(featuredTestimonialIds);
        if (!check.ok) {
            throw new Error(`Featured testimonial ids do not belong to your organization or are not rated with feedback: ${check.invalidIds.join(', ')}`);
        }
    }

    const value = { enabled, motto, blurb, heroImageUrl, profileImageUrl, modules, links, featuredTestimonialIds };

    const { error } = await supabase.from('settings').upsert(
        { key: 'publicPageConfig', value },
        { onConflict: 'key' },
    );
    handleSupabaseError({ error, message: 'Failed to update public page config' });
    broadcastSettingsUpdate();
};
export const updateAIConfig = async (config: Record<string, unknown>) => {
    // Extract API Key if present
    const { apiKey, ...rest } = config;

    // Save standard config (no secrets in rest)
    const { error } = await supabase.from('settings').upsert({ key: 'aiConfig', value: rest }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update AI config' });

    // Save API Key if provided — encrypted at rest
    if (apiKey) {
        const encryptedKey = encryptSecret(apiKey as string);
        const { error: keyError } = await supabase.from('settings').upsert({ key: 'geminiKey', value: encryptedKey }, { onConflict: 'key' });
        handleSupabaseError({ error: keyError, message: 'Failed to update Gemini API Key' });
    }

    broadcastSettingsUpdate();
};

// Wholesale replace, and that is CURRENTLY safe only because HRConfig has exactly one
// field (probationDays) and ProbationTab posts it whole rather than spreading a hydrated
// copy — so there is nothing a merge could preserve. It is NOT the same shape as
// updateWikiHomeConfig's read-merge above, and the difference is one field wide.
//
// KNOWN RESIDUAL (Phase 3 item 8, owner decision OD-6): projectSettingsForViewer withholds
// hrConfig from a caller without hr:view, while this write is gated hr:admin — so an
// hr:admin-without-hr:view holder sees a blank probation field and, if they save, sets
// probation to 0. A one-field regression, not data loss, deliberately accepted rather than
// widening the read gate past the `hr` subset it configures.
// THE MOMENT HRConfig GAINS A SECOND FIELD, that residual becomes the wiki wipe: give this
// the same read-merge as updateWikiHomeConfig before adding one.
export const updateHRConfig = async (config: HRConfig) => {
    const { error } = await supabase.from('settings').upsert({ key: 'hrConfig', value: config }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update HR config' });
    broadcastSettingsUpdate();
};

export const updateGovernmentsConfig = async (config: GovernmentsFeatureConfig) => {
    const { error } = await supabase.from('settings').upsert({ key: 'governmentsConfig', value: config }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update governments config' });
    broadcastSettingsUpdate();
};

// --- OPTIONAL MODULE TOGGLES (single-org admin config) ---
// Which optional modules (warehouse, quartermaster, finances, leaderboard,
// externalTools) are switched on for this org. Stored as one JSONB blob under
// the 'orgFeatures' settings key; the org Admin flips them in Admin → Optional
// Features (admin:update_features). Read back into orgMeta.features by
// getMainState so the Sidebar/views can gate on them. (Government keeps its own
// 'governmentsConfig' key.)
export const getOrgFeatures = async (): Promise<Record<string, unknown>> => {
    // THROWS on a read fault, deliberately. It used to discard the error and return {},
    // which made isFeatureEnabled's `catch { return false }` — and the fail-closed
    // guarantee documented below it — dead code that never ran. The gate still denied,
    // but by accident (missing key -> undefined -> falsy), not by the stated mechanism.
    //
    // Both live consumers keep their behaviour: isFeatureEnabled catches this into
    // `false` (fail closed), and getMainState catches it into {} (the nav hides optional
    // modules, which that call site already documents as cosmetic). What changes is that
    // the fault is now LOUD, and a future consumer that forgets to catch fails visibly
    // instead of silently reading "no modules enabled" as fact.
    const { data, error } = await supabase.from('settings').select('value').eq('key', 'orgFeatures').maybeSingle();
    handleSupabaseError({ error, message: 'Failed to read optional features' });
    return (data?.value as Record<string, unknown>) || {};
};

export const updateOrgFeatures = async (patch: Record<string, unknown>) => {
    // BIND THE READ ERROR — identical defect to updatePlatformSettings (lib/db/platform.ts).
    // The merge below is the only thing preserving the toggles the admin did not touch.
    // Unbound, a failed read gave `current = {}` and wrote just the patch, so flipping ONE
    // module during a DB hiccup silently dropped every other module's row. These are
    // default-OFF (`!!enabled`), so "dropped" reads as "switched off": one admin toggle
    // could take warehouse, quartermaster, finances and academy offline org-wide, behind a
    // success toast. Fail CLOSED — refuse the write and leave the stored blob alone.
    const { data, error: readError } = await supabase.from('settings').select('value').eq('key', 'orgFeatures').maybeSingle();
    handleSupabaseError({ error: readError, message: 'Failed to read optional features — no change was made' });
    const current = (data?.value as Record<string, unknown>) || {};
    // One-level deep merge so toggling one module preserves the others (and any
    // extra per-module settings nested under the same feature key).
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        const cur = current[key];
        next[key] = (value && typeof value === 'object' && !Array.isArray(value) && cur && typeof cur === 'object')
            ? { ...(cur as Record<string, unknown>), ...(value as Record<string, unknown>) }
            : value;
    }
    const { error } = await supabase.from('settings').upsert({ key: 'orgFeatures', value: next }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update optional features' });
    broadcastSettingsUpdate();
    return next;
};

// ── Optional-feature gate helpers ─────────────────────────────────────────────
// Server-side enable check for the optional modules (marketplace, warehouse,
// academy, finances, quartermaster, government). The dispatcher (api/services.ts
// OPTIONAL_FEATURE_NAMESPACES) and the read path (api/query.ts SUBSET_REQUIRED_FEATURE)
// both resolve a feature through isOptionalFeatureEnabled so a toggled-off module
// fails closed on the server, not just in the Sidebar nav.
//
// All three fail CLOSED: any thrown error (settings row missing, DB down) resolves
// to `false` so a read failure can never leave a disabled module reachable. These
// modules are all DEFAULT-OFF (`!!enabled`). The two DEFAULT-ON features
// (leaderboard, externalTools) have no action namespace/read subset and are
// deliberately NOT gated here — do not route them through isFeatureEnabled, whose
// `!!enabled` predicate would wrongly read them as disabled-by-default.
export const isFeatureEnabled = async (feature: string): Promise<boolean> => {
    try {
        const features = await getOrgFeatures();
        return !!(features?.[feature] as { enabled?: boolean } | undefined)?.enabled;
    } catch {
        return false;
    }
};

// Government keeps its on/off in its OWN settings row ('governmentsConfig'), not
// the orgFeatures blob — so it needs a dedicated reader. Default OFF.
export const isGovernmentEnabled = async (): Promise<boolean> => {
    try {
        const { data } = await supabase.from('settings').select('value').eq('key', 'governmentsConfig').maybeSingle();
        return !!(data?.value as { enabled?: boolean } | undefined)?.enabled;
    } catch {
        return false;
    }
};

// Route an optional-feature KEY to the right source of truth: government reads its
// separate settings key; every other module reads the orgFeatures blob.
export const isOptionalFeatureEnabled = async (feature: string): Promise<boolean> => {
    return feature === 'government' ? isGovernmentEnabled() : isFeatureEnabled(feature);
};

export const updateIntelSharingConfig = async (config: Record<string, unknown>) => {
    const { error } = await supabase.from('settings').upsert({ key: 'intelSharingConfig', value: config }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update intel sharing config' });
    broadcastSettingsUpdate();
};

export const getIntelSharingConfig = async () => {
    const query = supabase.from('settings').select('value').eq('key', 'intelSharingConfig');
    const { data } = await query.maybeSingle();
    return data?.value || { maxShareableClearance: 0 };
};

// NOTE: there is deliberately no updateSystemConfig writer. systemConfig.appUrl is this
// deployment's own public origin and is now operator config (process.env.APP_URL — see
// lib/appUrl.ts); the stored row survives only as a legacy fallback for installs that
// predate that. The removed writer had exactly one caller, the Organization Identity
// tab's save handler, which posted window.location.origin — an invisible side effect on
// a branding screen that let whatever host an admin happened to browse from silently
// become the origin advertised to alliance peers and embedded in Discord announcements.

export async function getRoleDetails(roleId: number) {
    const id = parseInt(roleId.toString());
    const { data: role, error: roleError } = await supabase.from('roles').select('id, name, description, is_system').eq('id', id).single();
    if (roleError) handleSupabaseError({ error: roleError, message: 'Failed to fetch role' });
    if (!role) throw new Error("Role not found");

    const { data: allPermissions, error: permError } = await supabase.from('permissions').select('id, name, description, category');
    if (permError) handleSupabaseError({ error: permError, message: 'Failed to fetch permissions' });

    const { data: rolePerms, error: rpError } = await supabase.from('role_permissions').select('permission_id').eq('role_id', id);
    if (rpError) handleSupabaseError({ error: rpError, message: 'Failed to fetch role permissions' });

    const permIds = new Set((rolePerms ?? []).map((rp: { permission_id: number }) => rp.permission_id));
    const assignedPermissionNames = (allPermissions ?? [])
        .filter((p: { id: number }) => permIds.has(p.id))
        .map((p: { name: string }) => p.name);

    // Resolve client role ID so the frontend can lock it
    const sysRoles = await getSystemRoles();
    const clientRoleId = sysRoles?.client?.id ?? null;

    return {
        role: { ...role, permissions: assignedPermissionNames },
        allPermissions: allPermissions || [],
        clientRoleId,
    };
}

export async function updateRolePermissions(roleId: number, permissionNames: string[]) {
    const id = parseInt(roleId.toString());
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid role id.');

    // The Client role's permission set is code-owned (CLIENT_DEFAULT_PERMS) and
    // reconverged by repairDatabase. The RPC handler asserts the same predicate so
    // the caller is refused before the round-trip; asserting it HERE too means any
    // future in-process caller is covered and the two cannot drift.
    await assertRoleIsNotClient(id);

    // Validate the target role exists BEFORE rewriting its permissions — the
    // delete-leg would otherwise run unchecked against a phantom/forged id.
    const { data: role } = await supabase.from('roles').select('id').eq('id', id).maybeSingle();
    if (!role) throw new Error('Role not found.');

    const { data: perms } = await supabase.from('permissions').select('id, name').in('name', permissionNames);
    const permIds = perms?.map(p => p.id) || [];
    await supabase.from('role_permissions').delete().eq('role_id', id);
    if (permIds.length > 0) await supabase.from('role_permissions').insert(permIds.map(pid => ({ role_id: id, permission_id: pid })));
}

export async function createApiKey(label: string, scopes?: unknown, expiresAt?: string | null) {
    // Sanitise the label: it is operator input that lands in a durable row and is rendered in
    // the admin list. stripHtml + a length cap, same as every other persisted plain string.
    const cleanLabel = sharedStripHtml(label, 120).trim();
    if (!cleanLabel) throw new Error('A label is required.');
    // The `alliance:` prefix is a load-bearing grammar, not a naming convention: the feed
    // refuses keys carrying it and deleteApiKey keys its orphan branch off it. Minting one by
    // hand produces a key nothing will ever accept. Refused the same way addRadioChannel
    // refuses its own reserved ids, and for the same reason.
    if (cleanLabel.startsWith(ALLIANCE_KEY_LABEL_PREFIX)) {
        throw new Error(`Labels starting with "${ALLIANCE_KEY_LABEL_PREFIX}" are reserved for alliance pairing credentials.`);
    }

    const key = `sk_${randomBytes(12).toString('base64url')}`;
    const hash = createHash('sha256').update(key).digest('hex');
    const keyPrefix = `${key.substring(0, 7)}****`;
    // Default a manually-created key to the FEED surface only. Federation credentials are
    // minted by the pairing handshake, never by hand, so a hand-made key has no business
    // reaching /api/alliance/*. An explicit scopes argument still wins.
    const wanted: ApiKeyScope[] = normalizeScopes(scopes);
    const finalScopes: ApiKeyScope[] = wanted.length > 0 ? wanted : ['feed'];

    const { data, error } = await supabase.from('api_keys')
        .insert({ label: cleanLabel, key_hash: hash, key_prefix: keyPrefix, scopes: finalScopes, expires_at: expiresAt ?? null })
        .select('id, label, created_at, last_used_at, scopes, expires_at, key_prefix')
        .single();
    // The error was previously not bound at all, so an insert failure returned
    // `{ ...null, rawKey: 'sk_...' }` and the admin console DISPLAYED that raw key as a
    // successfully-created credential. The operator wrote it down, handed it to an ally, and it
    // never authenticated — with no error at any point. Same phantom-success shape the delete
    // leg is already pinned against.
    handleSupabaseError({ error, message: 'Failed to create API key' });
    if (!data) throw new Error('Failed to create API key');

    // Return the raw key ONCE — it cannot be recovered after this response. Explicit columns so
    // key_hash never rides the response back to the browser.
    return { ...data, rawKey: key, keyPrefix };
}

export type ApiKeyListRow = Pick<Tables<'api_keys'>, 'id' | 'label' | 'created_at' | 'last_used_at'>
    & { scopes?: string[] | null; expires_at?: string | null; revoked_at?: string | null; revoked_reason?: string | null; key_prefix?: string | null };

export async function listApiKeys() {
    const query = supabase.from('api_keys')
        .select('id, label, created_at, last_used_at, scopes, expires_at, revoked_at, revoked_reason, key_prefix')
        .order('created_at', { ascending: false });

    const data = await safeFetch<ApiKeyListRow[]>(query, [], 'Failed to list API keys');
    // MAPPED, not spread. The rows are snake_case and the client renders camelCase, so
    // `{ ...k }` meant Created showed a literal em-dash and Last Used showed "Never" on every
    // row, forever — including for a key used a second ago. TypeScript never caught it because
    // the spread widened the return type. An operator deciding WHICH key to revoke had three
    // columns of no information; that is the practical reason this item exists.
    return data.map((k) => ({
        id: k.id,
        label: k.label,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at ?? undefined,
        scopes: Array.isArray(k.scopes) ? k.scopes : null,
        expiresAt: k.expires_at ?? null,
        revokedAt: k.revoked_at ?? null,
        revokedReason: k.revoked_reason ?? null,
        // Real prefix where we have one; the placeholder only for keys minted before the
        // column existed. It used to be the placeholder on every row.
        keyPrefix: k.key_prefix || 'sk_****',
    }));
}

// persistKeys (lib/db/alliances.ts) mints a paired ally's INBOUND credential into
// this same table, labelled `alliance:<peerId>`, and listApiKeys surfaces it to
// the admin UI beside ordinary keys. alliance_peers.inbound_key_id is ON DELETE
// SET NULL, so deleting one from here severs the pairing's inbound authentication
// with no signal at all: every /api/alliance/* call starts 403ing (getAlliancePeer-
// ByInboundKey finds no row) while the peer still reads Active, and recovering
// needs a fresh out-of-band code exchange. Teardown belongs to the alliance revoke
// path, which destroys BOTH directions of key material and records revoked_at.
const ALLIANCE_KEY_LABEL_PREFIX = 'alliance:';
const ALLY_KEY_MSG = 'That key is an alliance pairing credential. Remove the ally from the Alliances peer list — revoking there destroys both directions of key material and keeps the record.';

export async function deleteApiKey(id: string, revokedBy?: number | null, reason?: string | null) {
    const keyId = requireUuid(id, 'keyId');
    const { data: key, error: readError } = await supabase.from('api_keys').select('id, label')
        .eq('id', keyId)
        .maybeSingle();
    handleSupabaseError({ error: readError, message: 'Failed to load API key' });
    // Nothing to guard and nothing to delete — a delete stays idempotent.
    if (!key) return;
    // The FK is the authority, not the label: refuse while ANY peer row still
    // points at this key, so a mislabelled credential can't slip past. No TOCTOU
    // window either — persistKeys only ever INSERTS a fresh api_keys row, so an
    // unreferenced key can never later become an ally's inbound credential. A read
    // fault throws above rather than reading as "unreferenced".
    const { data: peer, error: peerError } = await supabase.from('alliance_peers').select('id')
        .eq('inbound_key_id', keyId)
        .maybeSingle();
    handleSupabaseError({ error: peerError, message: 'Failed to check alliance pairing' });
    if (peer) throw new SecurityDenial(ALLY_KEY_MSG, { auditEvent: 'authz.alliance_key.delete_denied', fields: { keyId } });
    // An unreferenced reserved-label key is an orphan left by a hard delete that
    // predates the peer-scope guards. It stays deletable by hand — that is
    // credential hygiene, not a live pairing — but never silently.
    if (key.label.startsWith(ALLIANCE_KEY_LABEL_PREFIX)) log.warn('deleting an orphaned alliance inbound key', { keyId, label: key.label });
    // SOFT revocation. Revoking used to DELETE the row, which destroyed the record an operator
    // needs after a leak: when it was issued, when it was last used, who killed it and why. The
    // credential is dead either way — verifyApiKey refuses a revoked row — but now there is
    // something left to read. The row is small and it IS the audit trail, so nothing purges it.
    const { error } = await supabase.from('api_keys')
        .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy ?? null, revoked_reason: reason ?? 'operator' })
        .eq('id', keyId)
        .is('revoked_at', null);
    handleSupabaseError({ error, message: 'Failed to revoke API key' });
}

// Intel feeds are now rows in the unified alliance_peers table, discriminated by
// pairing_state ('legacy' = backfilled, 'manual' = added here). A feed is a
// one-directional intel subscription (we hold a key to pull from the peer). The
// admin UI still speaks the old snake_case feed shape, so these map to/from it.
//
// SINGLE SOURCE OF TRUTH for "which alliance_peers rows the feed API may touch".
// EVERY feed verb — read, add, update, delete — must be filtered by it, because
// the other half of this table is handshake-paired allies whose teardown is the
// SOFT revoke in lib/db/alliances.ts. A hard delete through here would cascade
// mirrored ops (our own members' RSVPs), drop allied participants off live ops,
// null intel provenance (disabling the partial dedup indexes) and discard the
// revoked_at audit record. lib/db/alliances.ts imports this to derive its own
// PostgREST exclusion literal, so the two halves cannot drift apart.
export const FEED_PAIRING_STATES = ['legacy', 'manual'] as const;

// One message for both "no such row" and "that row is a paired ally": the
// SecurityDenial contract wants a message that can't be used as an existence
// oracle, and this sentence is true of both cases without pointing an admin at
// a remedy that doesn't apply to them.
const FEED_ONLY_MSG = 'No receive-only feed with that id. Handshake-paired allies are managed from the Alliances peer list.';

export async function getTrustedFeeds() {
    const query = supabase.from('alliance_peers').select('id, label, base_url, last_contact_at, created_at, inbound_max_clearance, outbound_key_enc, channels')
        .in('pairing_state', FEED_PAIRING_STATES)
        .order('created_at', { ascending: false });
    interface FeedPeerRow {
        id: string; label: string; base_url: string; last_contact_at: string | null;
        created_at: string; inbound_max_clearance: number;
        outbound_key_enc: string | null;
        channels: { reports?: boolean; warrants?: boolean; bulletins?: boolean } | null;
    }
    const rows = await safeFetch<FeedPeerRow[]>(query, [], 'Failed to get feeds');
    // Never expose the partner API key to the client — surface a presence flag.
    return rows.map((r) => ({
        id: r.id,
        label: r.label,
        url: r.base_url,
        last_synced_at: r.last_contact_at,
        created_at: r.created_at,
        sync_reports: r.channels?.reports !== false,
        sync_warrants: r.channels?.warrants !== false,
        sync_bulletins: r.channels?.bulletins !== false,
        inbound_max_clearance: r.inbound_max_clearance,
        hasApiKey: !!r.outbound_key_enc,
    }));
}
export async function addTrustedFeed(label: string, url: string, apiKey: string, filterOptions?: { syncReports?: boolean; syncWarrants?: boolean; syncBulletins?: boolean; inboundMaxClearance?: number }) {
    const { error } = await supabase.from('alliance_peers').insert({
        label,
        base_url: url,
        outbound_key_enc: encryptSecret(apiKey),
        status: 'Active',
        type: 'Alliance',
        pairing_state: 'manual',
        inbound_max_clearance: filterOptions?.inboundMaxClearance ?? 5,
        channels: {
            reports: filterOptions?.syncReports ?? true,
            warrants: filterOptions?.syncWarrants ?? true,
            bulletins: filterOptions?.syncBulletins ?? true,
        },
    });
    handleSupabaseError({ error, message: 'Failed to add feed' });
    broadcastSettingsUpdate();
}
export async function deleteTrustedFeed(id: string) {
    const feedId = requireUuid(id, 'feedId');
    // The discriminator is filtered INSIDE the delete, not read first and deleted
    // after: a select-then-delete leaves an unfiltered .delete() in the source for
    // the next refactor to lift out of its guard, and opens a TOCTOU window.
    const { data, error } = await supabase.from('alliance_peers').delete()
        .eq('id', feedId)
        .in('pairing_state', FEED_PAIRING_STATES)
        .select('id');
    // Error first: on a transport/RLS failure `data` is null too, and reporting
    // that as a scope denial would mask a real outage behind a 403.
    handleSupabaseError({ error, message: 'Failed to remove feed' });
    if (!data || data.length === 0) {
        throw new SecurityDenial(FEED_ONLY_MSG, { auditEvent: 'authz.feed_scope.denied', fields: { feedId } });
    }
    broadcastSettingsUpdate();
}
export async function updateTrustedFeed(id: string, updates: { syncReports?: boolean; syncWarrants?: boolean; syncBulletins?: boolean; inboundMaxClearance?: number }) {
    const feedId = requireUuid(id, 'feedId');
    const dbUpdates: Record<string, unknown> = {};
    // channels is a jsonb blob — merge against the existing value so a single
    // toggle doesn't wipe the others.
    if (updates.syncReports !== undefined || updates.syncWarrants !== undefined || updates.syncBulletins !== undefined) {
        const { data: existing, error: readError } = await supabase.from('alliance_peers').select('channels')
            .eq('id', feedId)
            .in('pairing_state', FEED_PAIRING_STATES)
            .maybeSingle();
        // Swallowing this read is destructive, not merely lossy: merging into {}
        // REPLACES the jsonb, after which getTrustedFeeds (`!== false`) shows all
        // three channels on while syncTrustedFeeds (`=== true`) treats the wiped
        // ones as off — the UI and the ingest engine silently disagree.
        handleSupabaseError({ error: readError, message: 'Failed to load feed' });
        if (!existing) {
            throw new SecurityDenial(FEED_ONLY_MSG, { auditEvent: 'authz.feed_scope.denied', fields: { feedId } });
        }
        const channels = { ...(existing.channels || {}) } as Record<string, boolean>;
        if (updates.syncReports !== undefined) channels.reports = updates.syncReports;
        if (updates.syncWarrants !== undefined) channels.warrants = updates.syncWarrants;
        if (updates.syncBulletins !== undefined) channels.bulletins = updates.syncBulletins;
        dbUpdates.channels = channels;
    }
    if (updates.inboundMaxClearance !== undefined) dbUpdates.inbound_max_clearance = updates.inboundMaxClearance;
    if (Object.keys(dbUpdates).length > 0) {
        dbUpdates.updated_at = new Date().toISOString();
        // Same guard on the write half — inbound_max_clearance is the ceiling on
        // how highly-classified inbound intel we accept, and the clearance-only
        // path never touches the read above.
        const { data, error } = await supabase.from('alliance_peers').update(dbUpdates)
            .eq('id', feedId)
            .in('pairing_state', FEED_PAIRING_STATES)
            .select('id');
        handleSupabaseError({ error, message: 'Failed to update feed' });
        if (!data || data.length === 0) {
            throw new SecurityDenial(FEED_ONLY_MSG, { auditEvent: 'authz.feed_scope.denied', fields: { feedId } });
        }
        broadcastSettingsUpdate();
    }
}

export async function getSecurityClearances() {
    const query = supabase.from('security_clearances').select('id, name, level, description').order('level', { ascending: true });
    return safeFetch<Tables<'security_clearances'>[]>(query, [], 'Failed to get clearances');
}

export async function updateSecurityClearance(id: number, name: string, description: string) {
    const { error } = await supabase.from('security_clearances').update({ name, description }).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update clearance' });
}

export async function getLimitingMarkers() {
    const query = supabase.from('security_limiting_markers').select('id, name, code, description, sync_restricted').order('name', { ascending: true });
    return safeFetch<Tables<'security_limiting_markers'>[]>(query, [], 'Failed to get markers');
}

export async function addLimitingMarker(name: string, code: string, description: string, syncRestricted: boolean) {
    const { error } = await supabase.from('security_limiting_markers').insert({ name, code, description, sync_restricted: syncRestricted});
    handleSupabaseError({ error, message: 'Failed to add marker' });
}

export async function updateLimitingMarker(id: number, name: string, code: string, description: string, syncRestricted: boolean) {
    const { error } = await supabase.from('security_limiting_markers').update({ name, code, description, sync_restricted: syncRestricted }).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update marker' });
}

export async function deleteLimitingMarker(id: number) {
    const { error } = await supabase.from('security_limiting_markers').delete().eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete marker' });
}

export async function getServiceTypes(): Promise<ServiceTypeConfig[]> {
    const query = supabase.from('service_types').select('id, name, icon, color, description, is_active, discord_channel_id, created_at').order('name');
    const data = await safeFetch<Parameters<typeof toServiceTypeConfig>[0][]>(query, [], 'Failed to get service types');
    return (data || []).map(toServiceTypeConfig);
}

export async function addServiceType(data: Partial<ServiceTypeConfig>) {
    const payload: Record<string, unknown> = {
        name: data.name,
        icon: data.icon,
        color: data.color,
        description: data.description,
        is_active: data.isActive,
        discord_channel_id: data.discordChannelId || null,
    };
    let { error } = await supabase.from('service_types').insert(payload);
    // Soft-fail: if discord_channel_id column isn't present yet (pre-migration
    // instance), strip it and retry. Override is dropped silently — the global
    // fallback path still works.
    if (error) {
        const code = (error as { code?: string } | null)?.code;
        if ((code === '42703' || code === 'PGRST204') && payload.discord_channel_id !== undefined) {
            log.warn('service_types.discord_channel_id unavailable; retrying without field', { migration: true });
            delete payload.discord_channel_id;
            const retry = await supabase.from('service_types').insert(payload);
            error = retry.error;
        }
    }
    handleSupabaseError({ error, message: 'Failed to add service type' });
}

export async function updateServiceType(data: Partial<ServiceTypeConfig>) {
    const payload: Record<string, unknown> = {
        name: data.name,
        icon: data.icon,
        color: data.color,
        description: data.description,
        is_active: data.isActive,
        discord_channel_id: data.discordChannelId || null,
    };
    let { error } = await supabase.from('service_types').update(payload).eq('id', data.id);
    if (error) {
        const code = (error as { code?: string } | null)?.code;
        if ((code === '42703' || code === 'PGRST204') && payload.discord_channel_id !== undefined) {
            log.warn('service_types.discord_channel_id unavailable; retrying without field', { migration: true });
            delete payload.discord_channel_id;
            const retry = await supabase.from('service_types').update(payload).eq('id', data.id);
            error = retry.error;
        }
    }
    handleSupabaseError({ error, message: 'Failed to update service type' });
}

export async function deleteServiceType(id: number) {
    const { error } = await supabase.from('service_types').delete().eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete service type' });
}


// --- ANNOUNCEMENTS ---

export async function addAnnouncement(data: Partial<Announcement>, userId: number) {
    const { data: user } = await supabase.from('users').select('name').eq('id', userId).single();
    await supabase.from('announcements').insert({
        title: stripHtmlSingleLine(data.title, 200),
        body: sharedStripHtml(data.body, 8000),
        type: data.type,
        audience: data.audience,
        expiry_date: data.expiryDate,
        author: user?.name || 'Unknown'
    });
    // id-only nudge — announcements are NOT in the realtime publication (their
    // audience boundary would leak via a raw postgres_changes row); clients
    // refetch the audience-scoped 'announcements' subset.
    broadcastToOrg('announcement_update', {});
}
export async function updateAnnouncement(data: Partial<Announcement>) {
    const query = supabase.from('announcements').update({
        title: stripHtmlSingleLine(data.title, 200),
        body: sharedStripHtml(data.body, 8000),
        type: data.type,
        audience: data.audience,
        expiry_date: data.expiryDate
    }).eq('id', data.id);
    await query;
    broadcastToOrg('announcement_update', { id: data.id });
}
export async function deleteAnnouncement(id: string) {
    const query = supabase.from('announcements').delete().eq('id', id);
    await query;
    broadcastToOrg('announcement_update', { id });
}

// --- ORG MANAGEMENT ---

// Import seeder
import { seedNewOrganization } from './seeder.js';

// Global Permissions List — the admin "repair database" backstop that
// re-inserts any permission missing from the live table. MUST stay in parity
// with the schema.sql §7 deploy seed (enforced by
// tests/permissionSeedParity.test.ts). Keep both in sync when adding a
// permission, or "repair" can't heal a fresh-deploy gap.
const GLOBAL_PERMISSIONS = [
    { name: 'admin:access', description: "Access the Admin Dashboard", category: 'System' },
    { name: 'admin:config:branding', description: "Manage Branding & System Config", category: 'System' },
    { name: 'admin:config:theme', description: "Manage Custom Theme", category: 'System' },
    { name: 'admin:config:discord', description: "Manage Discord Integration", category: 'System' },
    { name: 'admin:config:metadata', description: "Manage SEO & Metadata", category: 'System' },
    { name: 'admin:config:ai', description: "Manage AI Configuration", category: 'System' },
    { name: 'admin:config:api', description: "Manage API Keys", category: 'System' },
    { name: 'admin:config:tools', description: "Manage External Tools", category: 'System' },
    { name: 'admin:config:catalog', description: "Manage Global Catalog (Ships/Items/Commodities/Locations)", category: 'System' },
    { name: 'admin:db:destroy', description: "Destroy all data (full reset / full wipe)", category: 'System' },
    { name: 'admin:config:notices', description: "Manage Announcements", category: 'System' },
    { name: 'admin:config:roles', description: "Manage Roles & Permissions", category: 'System' },
    { name: 'admin:config:servicetypes', description: "Manage Service Types", category: 'System' },
    { name: 'admin:config:units', description: "Manage Units", category: 'Organization' },
    { name: 'admin:config:ranks', description: "Manage Ranks", category: 'Organization' },
    { name: 'admin:config:locations', description: "Manage Locations", category: 'Organization' },
    { name: 'admin:config:clearance', description: "Manage Security Clearances", category: 'Organization' },
    { name: 'admin:config:specializations', description: "Manage Specializations", category: 'Organization' },
    { name: 'admin:config:certifications', description: "Manage Certifications", category: 'Organization' },
    { name: 'admin:config:commendations', description: "Manage Commendations", category: 'Organization' },
    { name: 'admin:view:roster', description: "View Member Roster", category: 'User Management' },
    { name: 'admin:view:clients', description: "View Client Registry", category: 'User Management' },
    { name: 'admin:user:update', description: "Edit User Details", category: 'User Management' },
    { name: 'admin:user:update_role', description: "Promote/Demote Users", category: 'User Management' },
    { name: 'admin:user:manage_clearance', description: "Change User Clearance", category: 'User Management' },
    { name: 'admin:user:adjust_reputation', description: "Adjust User Reputation", category: 'User Management' },
    { name: 'admin:user:view_history', description: "View User History", category: 'User Management' },
    { name: 'admin:user:ban', description: "Ban & Unban Members", category: 'User Management' },
    { name: 'user:manage:conduct_record', description: "Add/Remove Conduct Entries", category: 'User Management' },
    { name: 'user:manage:personnel_notes', description: "Add/View Personnel Notes", category: 'User Management' },
    { name: 'user:toggle_duty', description: "Toggle Duty Status", category: 'User Management' },
    { name: 'admin:award:certification', description: "Award Certification", category: 'User Management' },
    { name: 'admin:revoke:certification', description: "Revoke Certification", category: 'User Management' },
    { name: 'admin:award:commendation', description: "Award Commendation", category: 'User Management' },
    { name: 'admin:revoke:commendation', description: "Revoke Commendation", category: 'User Management' },
    { name: 'user:view:roster', description: "View Duty Roster", category: 'User Management' },
    { name: 'hr:view', description: "View HR Dashboard", category: 'HR' },
    { name: 'hr:recruiter', description: "Manage Recruitment Cases", category: 'HR' },
    { name: 'hr:manager', description: "Manage HR Department", category: 'HR' },
    { name: 'hr:admin', description: "Full HR Administration", category: 'HR' },
    { name: 'hr:manage:positions', description: "Manage Job Roles", category: 'HR' },
    { name: 'admin:manage:documents', description: "Manage Documents", category: 'HR' },
    { name: 'intel:view', description: "View Intelligence Hub & Post Bulletins", category: 'Intelligence' },
    { name: 'intel:view:clearance', description: "View Classified Intel Reports", category: 'Intelligence' },
    { name: 'intel:create', description: "Create Formal Intelligence Reports", category: 'Intelligence' },
    { name: 'intel:manage', description: "Manage & Delete Intel Reports/Bulletins", category: 'Intelligence' },
    { name: 'warrant:view', description: "View Warrants", category: 'Intelligence' },
    { name: 'warrant:create', description: "Issue Warrants", category: 'Intelligence' },
    { name: 'warrant:manage', description: "Manage Warrants", category: 'Intelligence' },
    { name: 'operations:view', description: "View Operations Center", category: 'Operations' },
    { name: 'operations:create', description: "Create Operations", category: 'Operations' },
    { name: 'operations:manage', description: "Manage Any Operation", category: 'Operations' },
    { name: 'request:create', description: "Create Service Requests", category: 'Requests' },
    { name: 'request:create_adhoc', description: "Log Ad-Hoc Requests", category: 'Requests' },
    { name: 'request:triage', description: "Triage Incoming Requests", category: 'Requests' },
    { name: 'request:dispatch', description: "Dispatch Units", category: 'Requests' },
    { name: 'request:accept', description: "Accept Requests", category: 'Requests' },
    { name: 'request:start', description: "Start Mission", category: 'Requests' },
    { name: 'request:complete', description: "Complete Mission", category: 'Requests' },
    { name: 'request:cancel', description: "Cancel Own Request", category: 'Requests' },
    { name: 'request:delete', description: "Delete Request", category: 'Requests' },
    { name: 'request:manage_responders', description: "Manage Responders", category: 'Requests' },
    { name: 'request:set_lead', description: "Assign Lead Responder", category: 'Requests' },
    { name: 'request:update', description: "Update Request Status", category: 'Requests' },
    { name: 'request:rate', description: "Rate Completed Service", category: 'Requests' },
    { name: 'request:view:feedback', description: "View Client Feedback", category: 'Requests' },
    { name: 'radio:manage', description: "Manage Radio Frequencies", category: 'Communications' },
    { name: 'admin:broadcast:eam', description: "Broadcast EAM", category: 'Communications' },
    { name: 'user:manage:self', description: "Manage Own Profile", category: 'User Management' },
    { name: 'unit:manage:own', description: "Manage Own Unit", category: 'Organization' },
    { name: 'units:view_all', description: "View All Restricted Units", category: 'Organization' },
    { name: 'admin:config:settings', description: "Manage Client UI Settings", category: 'System' },
    { name: 'admin:security:view_audit', description: "View Security Audit Trail", category: 'System' },
    { name: 'user:receive:eam', description: "Receive EAM Alerts", category: 'Communications' },
    { name: 'fleet:view', description: "View Fleet Manager", category: 'Fleet' },
    { name: 'fleet:manage_own', description: "Manage Own Ship Hangar", category: 'Fleet' },
    { name: 'fleet:manage', description: "Manage Fleet Groups & Assignments", category: 'Fleet' },
    { name: 'alliance:view', description: "View Alliance Directory", category: 'Alliance' },
    { name: 'alliance:manage', description: "Manage Alliances & Directory Profile", category: 'Alliance' },
    { name: 'wiki:view', description: "View Org Wiki", category: 'Wiki' },
    { name: 'wiki:add_page', description: "Create Wiki Pages", category: 'Wiki' },
    { name: 'wiki:edit_page', description: "Edit Wiki Pages & Settings", category: 'Wiki' },
    { name: 'wiki:delete_page', description: "Delete Wiki Pages", category: 'Wiki' },
    { name: 'gov:view', description: "View Government", category: 'Government' },
    { name: 'gov:participate', description: "Vote & Run for Office", category: 'Government' },
    { name: 'gov:elected_official', description: "Propose/Vote on Legislation", category: 'Government' },
    { name: 'gov:electoral_officer', description: "Manage Elections", category: 'Government' },
    { name: 'gov:manage', description: "Manage Governance", category: 'Government' },
    { name: 'gov:admin', description: "Configure Government Structure", category: 'Government' },
    { name: 'gov:issue_orders', description: "Issue Executive Orders", category: 'Government' },
    { name: 'admin:config:features', description: "Toggle Optional Features", category: 'System Config' },
    { name: 'finance:view', description: "View Org Finances", category: 'Finances' },
    { name: 'finance:deposit', description: "Submit Deposit Claims", category: 'Finances' },
    { name: 'finance:withdraw_request', description: "Request Withdrawals", category: 'Finances' },
    { name: 'finance:approve', description: "Approve / Reject Pending Entries", category: 'Finances' },
    { name: 'finance:manage', description: "Manage Accounts, Adjustments, Reversals", category: 'Finances' },
    { name: 'finance:admin', description: "Configure Finances Module", category: 'Finances' },
    { name: 'qm:view', description: "View Org Armoury", category: 'Quartermaster' },
    { name: 'qm:request', description: "Request Issuance of Items", category: 'Quartermaster' },
    { name: 'qm:manage', description: "Manage Inventory & Issuances", category: 'Quartermaster' },
    { name: 'qm:admin', description: "Configure Catalog, Locations, Module", category: 'Quartermaster' },
    { name: 'warehouse:view', description: "View Org Warehouse", category: 'Warehouse' },
    { name: 'warehouse:request', description: "Request Withdrawal of Bulk Stock", category: 'Warehouse' },
    { name: 'warehouse:manage', description: "Manage Stock, Transfers & Withdrawals", category: 'Warehouse' },
    { name: 'warehouse:admin', description: "Configure Commodity Catalog", category: 'Warehouse' },
    { name: 'marketplace:view', description: "Browse the Marketplace", category: 'Marketplace' },
    { name: 'marketplace:list', description: "Post & Manage Own Listings", category: 'Marketplace' },
    { name: 'marketplace:contract', description: "Propose & Fulfil Contracts", category: 'Marketplace' },
    { name: 'marketplace:admin', description: "Moderate Marketplace & Reports", category: 'Marketplace' },
    { name: 'academy:view', description: "View Academy (staff surfaces)", category: 'Academy' },
    { name: 'academy:instruct', description: "Instruct Courses & Run Sessions", category: 'Academy' },
    { name: 'academy:manage', description: "Manage Academy (approve, certify, award)", category: 'Academy' },
    { name: 'blueprint:view', description: "Browse Blueprint Registry", category: 'Blueprints' },
    { name: 'blueprint:register', description: "Register & Manage Own Blueprints", category: 'Blueprints' },
    { name: 'blueprint:request', description: "Raise Crafting Requests", category: 'Blueprints' },
    { name: 'blueprint:craft', description: "Claim & Fulfil Crafting Requests", category: 'Blueprints' },
    { name: 'blueprint:manage', description: "Moderate Org Blueprints", category: 'Blueprints' },
];

export async function repairDatabase() {
    log.info('repair starting');

    // 0. Repair Global Permissions (Unrestricted by Org, these are system-wide definitions)
    const { data: existingPerms } = await supabase.from('permissions').select('name');
    const existingPermNames = new Set((existingPerms || []).map((p: { name: string }) => p.name));

    // Find missing permissions
    const missingPerms = GLOBAL_PERMISSIONS.filter(p => !existingPermNames.has(p.name));

    if (missingPerms.length > 0) {
        log.info('repair adding missing permissions', { count: missingPerms.length });
        const { error } = await supabase.from('permissions').insert(missingPerms);
        if (error) log.error('failed to add missing permissions', { err: error });
        else log.info('repair added permissions', { count: missingPerms.length });
    } else {
        log.info('repair all global permissions present');
    }

    // Also update descriptions for existing permissions
    for (const perm of GLOBAL_PERMISSIONS) {
        if (existingPermNames.has(perm.name)) {
            await supabase.from('permissions')
                .update({ description: perm.description, category: perm.category })
                .eq('name', perm.name);
        }
    }

    // Declared out here because the backfill runs inside the block below (it needs the
    // resolved system roles) but its outcome is reported in the return message.
    let roleDefaults: RoleDefaultsBackfillResult;
    // Same reason: the Client-role strip runs inside the block, its outcome (or its
    // failure) is reported in the return message. Repair's only reporting channel is
    // that string — DatabaseToolsTab toasts it verbatim.
    let clientLockNote = '';

    // 1. Fix Users with missing roles & seeds
    {
        let triggerSeed = false;

        // Check if Roles exist
        const { count: roleCount } = await supabase.from('roles').select('id', { count: 'exact', head: true });
        if (!roleCount || roleCount < 4) {
            log.info('repair roles missing; flagging for re-seed', { roleCount });
            triggerSeed = true;
        } else {
            // Check if Admin Role has Permissions
            const sysRoles = await getSystemRoles();
            if (sysRoles.admin) {
                const { count: adminPerms } = await supabase.from('role_permissions').select('role_id', { count: 'exact', head: true }).eq('role_id', sysRoles.admin.id);
                if (!adminPerms || adminPerms < 5) { // Admin should have ~60+ perms
                    log.info('repair admin permissions missing; flagging for re-seed', { adminPerms });
                    triggerSeed = true;
                }
            }
        }

        if (triggerSeed) {
            log.info('repair triggering seed process');
            try {
                const result = await seedNewOrganization();
                log.info('repair re-seed complete', { result });
            } catch (e) {
                log.error('repair re-seed failed', { err: e });
                return { success: false, message: `Re-seed failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        }

        // Sync Admin Role Permissions — ensure admin role has ALL permissions.
        // Catches newly-added permissions (e.g. gov:*) that weren't present at seed time.
        if (!triggerSeed) {
            const sysRoles = await getSystemRoles();
            if (sysRoles.admin) {
                const { data: allPerms } = await supabase.from('permissions').select('id');
                const { data: currentAdminPerms } = await supabase.from('role_permissions')
                    .select('permission_id').eq('role_id', sysRoles.admin.id);

                const adminRoleId = sysRoles.admin.id;
                const currentPermIds = new Set((currentAdminPerms || []).map((rp: { permission_id: number }) => rp.permission_id));
                const missingRolePerms = (allPerms || [])
                    .filter((p: { id: number }) => !currentPermIds.has(p.id))
                    .map((p: { id: number }) => ({ role_id: adminRoleId, permission_id: p.id }));

                if (missingRolePerms.length > 0) {
                    log.info('repair adding missing permissions to admin role', { count: missingRolePerms.length });
                    const { error: rpError } = await supabase.from('role_permissions')
                        .upsert(missingRolePerms, { ignoreDuplicates: true });
                    if (rpError) log.error('repair failed to sync admin permissions', { err: rpError });
                    else log.info('repair admin role now has all permissions', { count: (allPerms || []).length });
                }
            }
        }

        // Ensure is_system flag is set on all 4 system roles
        // Try by name first (handles both original and not-yet-migrated orgs), then mark any found
        const SYSTEM_ROLE_NAMES = ['Client', 'Member', 'Dispatcher', 'Admin'];
        const { data: byName } = await supabase.from('roles').select('id, name').in('name', SYSTEM_ROLE_NAMES);
        if (byName && byName.length > 0) {
            await supabase.from('roles').update({ is_system: true }).in('id', byName.map(r => r.id));
        }
        // Also mark any already-flagged roles (handles renamed roles that were previously flagged)
        const { data: byFlag } = await supabase.from('roles').select('id, name').eq('is_system', true).order('id', { ascending: true });

        // Use getSystemRoles helper for all subsequent lookups (works with renamed roles).
        // Drop the 5-minute memo first: getSystemRoles was already called twice above,
        // BEFORE the is_system stamp, so without this the lookups below — the Client
        // strip and the module-defaults backfill included — act on the pre-stamp
        // positional fallback the stamp just fixed.
        cache.invalidate('system_roles');
        const repairedRoles = await getSystemRoles();

        // Fix Client role: strip any permissions beyond the canonical defaults.
        // Shared with the post-import reconcile (lib/db/clientRoleLock.ts) so the
        // Client role converges identically whichever path re-populated it — the
        // import replaces role_permissions wholesale and used to skip this entirely.
        //
        // Contained on purpose. The helper throws so the RPC and the import can
        // REFUSE on an unverifiable read, but everything below this line is the
        // org's last-resort recovery — the null-role backfill, the module-defaults
        // backfill, the "ensure at least one Admin exists" promotion and the
        // reminder drain. A repair that cannot verify one invariant must still run
        // the other four, and the error copy for that fault tells the operator to
        // run Repair.
        const clientRole = repairedRoles.client;
        if (clientRole) {
            try {
                const { stripped } = await enforceClientRolePermissionLock(clientRole.id);
                if (stripped > 0) clientLockNote = ` Stripped ${stripped} excess permission(s) from the Client role.`;
            } catch (e) {
                log.error('repair client-role permission lock failed', { err: e });
                clientLockNote = ' The Client role permission lock could not be verified — re-run Repair.';
            }
        }

        // One-shot grant of the optional-module defaults (finances / quartermaster /
        // warehouse) onto the Member and Dispatcher roles. Those strings were never in
        // the seeder, so on an install created by the old code all three modules are
        // Admin-only. One-time STATE, not convergence, and marker-gated so a second
        // Repair can NEVER restore a permission the operator has since revoked — see
        // lib/db/roleDefaults.ts for the three guards. Placed after the Client strip so
        // the permission catalog is topped up and repairedRoles is live.
        roleDefaults = await backfillOptionalModuleRoleDefaults(repairedRoles);

        // Fix Users with null roles in this org
        if (repairedRoles.member) {
            const { error: userError } = await supabase.from('users').update({ role_id: repairedRoles.member.id }).is('role_id', null);
            if (userError) log.error('repair failed for users', { err: userError });
        }

        // Ensure at least one Admin exists
        if (repairedRoles.admin) {
            const { count: adminCount } = await supabase.from('users').select('id', { count: 'exact', head: true })
                .eq('role_id', repairedRoles.admin.id).is('deleted_at', null);
            if (!adminCount || adminCount === 0) {
                const { data: earliestUser } = await supabase.from('users').select('id')
                    .is('deleted_at', null)
                    .order('created_at', { ascending: true }).limit(1).maybeSingle();
                if (earliestUser) {
                    await supabase.from('users').update({ role_id: repairedRoles.admin.id }).eq('id', earliestUser.id);
                    log.info('repair promoted user to admin (no admin existed)', { userId: earliestUser.id });
                }
            }
        }
    }

    // Retire the backlog of operation_reminders rows that accumulated while nothing
    // consumed them (see lib/db/opReminders.ts). One-time STATE, which is why it
    // lives here and not in schema.sql — that script is a re-runnable convergence
    // script. Idempotent, and never fatal: the delivery job sweeps expired rows on
    // every tick anyway, so this is only the fast way to clear a large backlog.
    const drained = await drainStaleOperationReminders();

    // Report the backfill's OUTCOME, never infer it from a count: four of the helper's
    // five returns are zero-granted and only one of them means "nothing needed doing".
    // Telling an admin their roles are already correct when the pass actually aborted
    // on a read fault is the failure mode that makes this button untrustworthy.
    const grantNote = {
        'granted': ` Granted ${roleDefaults.granted} default module permission(s) to the Member/Dispatcher roles.`,
        'skipped-configured': ' Module role defaults were left alone — those roles are already configured.',
        'skipped-roles': ' Module role defaults were skipped — the Member/Dispatcher system roles could not be identified.',
        'failed': ' Module role defaults could not be applied — see the server log; Repair can be run again.',
        'already-applied': '',
    }[roleDefaults.status];
    const drainNote = drained > 0 ? ` Retired ${drained} stale operation reminder(s).` : '';

    // BREAK-GLASS for the one state that makes a ban unliftable: a member banned
    // first and promoted to Admin afterwards, with the org's other admin:user:ban
    // holders since gone. See liftBansOnSystemAdmins — it only ever touches bans the
    // peer rule in ban:place would have refused to place in the first place.
    //
    // Never fatal, and always REPORTED: repair's return string is its only channel
    // to the operator (DatabaseToolsTab toasts it verbatim), so a silently lifted
    // ban is not an acceptable outcome of a maintenance button.
    let banNote = '';
    try {
        const liftedAdminBans = await liftBansOnSystemAdmins();
        if (liftedAdminBans > 0) {
            banNote = ` Lifted ${liftedAdminBans} ban(s) on Admin-role holders — an Admin cannot be banned.`;
        }
    } catch (e) {
        log.error('repair could not check for bans on Admin-role holders', { err: e });
        banNote = ' Bans on Admin-role holders could not be checked — re-run Repair.';
    }

    return { success: true, message: `Database repair complete.${clientLockNote}${grantNote}${drainNote}${banNote}` };
}

// Reuses the 'user_update' realtime event (mapped to main subset in DataContext)
// to push reference-data + per-user-record changes to other clients. The
// explicit broadcast is the reliable path — postgres_changes for the units table
// has been observed to silently miss in some sessions.
//
// Pass `userId` when the change targets a specific user's heavy fields
// (certifications, commendations) so the recipient's AuthContext listener can
// re-hydrate currentUser. Omit it for broad reference-data changes (units).
function broadcastReferenceDataUpdate(userId?: number) {
    broadcastToOrg('user_update', userId ? { userId } : {});
}

// Accepts both the admin payload (Partial<OrganizationalUnit>) and the
// per-unit detail payload, which sends nullable FK/text fields to clear them.
// Kept wider than OrganizationalUnit so callers can pass `null` to unset.
interface UnitInput {
    id?: number;
    name?: string;
    parentUnitId?: number | null;
    sortOrder?: number;
    leaderId?: number | null;
    motto?: string | null;
    description?: string | null;
    logoUrl?: string | null;
    hasRadioChannel?: boolean;
    linkedChannelId?: string | null;
    isRestricted?: boolean;
}

// is_restricted ships via add-unit-visibility.sql. Both add/update first try
// with the column included; on PG 42703 (column missing) they retry without
// so pre-migration tenants can still save other unit fields. Same pattern
// as template_id and external_tools.category.
export async function addUnit(data: UnitInput) {
    const payload: Record<string, unknown> = {
        name: data.name,
        parent_unit_id: data.parentUnitId,
        sort_order: data.sortOrder,
        leader_id: data.leaderId,
        motto: data.motto,
        description: data.description,
        logo_url: data.logoUrl,
        has_radio_channel: data.hasRadioChannel ?? true,
        linked_channel_id: data.linkedChannelId || null,
        is_restricted: !!data.isRestricted
    };
    let { data: newUnit, error } = await supabase.from('units').insert(payload).select('id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted').single();
    if (error?.code === '42703' && 'is_restricted' in payload) {
        log.warn('units.is_restricted column missing — retrying without; run migrations/add-unit-visibility.sql', { migration: true });
        const { is_restricted, ...slim } = payload;
        ({ data: newUnit, error } = await supabase.from('units').insert(slim).select('id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id').single());
    }
    handleSupabaseError({ error, message: 'Failed to create unit' });
    broadcastReferenceDataUpdate();
    return newUnit;
}

export async function updateUnit(data: UnitInput) {
    const payload: Record<string, unknown> = {
        name: data.name,
        parent_unit_id: data.parentUnitId,
        sort_order: data.sortOrder,
        leader_id: data.leaderId,
        motto: data.motto,
        description: data.description,
        logo_url: data.logoUrl,
        has_radio_channel: data.hasRadioChannel ?? true,
        linked_channel_id: data.linkedChannelId || null,
    };
    if (data.isRestricted !== undefined) payload.is_restricted = !!data.isRestricted;
    const runUpdate = async (patch: Record<string, unknown>) => {
        const q = supabase.from('units').update(patch).eq('id', data.id);
        return q.select('id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id').single();
    };
    let { data: updatedUnit, error } = await runUpdate(payload);
    if (error?.code === '42703' && 'is_restricted' in payload) {
        log.warn('units.is_restricted column missing — retrying without; run migrations/add-unit-visibility.sql', { migration: true });
        const { is_restricted, ...slim } = payload;
        ({ data: updatedUnit, error } = await runUpdate(slim));
    }
    handleSupabaseError({ error, message: 'Failed to update unit' });
    broadcastReferenceDataUpdate();
    return updatedUnit;
}
export async function deleteUnit(id: number) {
    const query = supabase.from('units').delete().eq('id', id);
    const { error } = await query;
    if (error?.code === '23503') {
        log.error('deleteUnit fk violation', { err: error });
        throw new Error('Cannot delete unit: it is still referenced by other records. Reassign members and child units first.');
    }
    handleSupabaseError({ error, message: 'Failed to delete unit' });
    broadcastReferenceDataUpdate();
}

export async function addRank(data: Partial<Rank>) { await supabase.from('ranks').insert({ name: data.name, icon_url: sanitizeImageUrlOrLocalPath(data.iconUrl), sort_order: data.sortOrder}); }
export async function updateRank(data: Partial<Rank>) {
    const query = supabase.from('ranks').update({ name: data.name, icon_url: sanitizeImageUrlOrLocalPath(data.iconUrl), sort_order: data.sortOrder }).eq('id', data.id);
    await query;
}
export async function deleteRank(id: number) {
    const query = supabase.from('ranks').delete().eq('id', id);
    await query;
}

export async function addSpecializationTag(data: Partial<SpecializationTag>) { await supabase.from('specialization_tags').insert({ name: data.name, description: data.description, icon: data.icon, image_url: sanitizeImageUrl(data.imageUrl)}); }
export async function updateSpecializationTag(data: Partial<SpecializationTag>) { await supabase.from('specialization_tags').update({ name: data.name, description: data.description, icon: data.icon, image_url: sanitizeImageUrl(data.imageUrl) }).eq('id', data.id); }
export async function deleteSpecializationTag(id: number) {
    await supabase.from('specialization_tags').delete().eq('id', id);
}

export async function addCertification(data: Partial<Certification>) { await supabase.from('certifications').insert({ name: data.name, description: data.description, icon: data.icon, image_url: sanitizeImageUrl(data.imageUrl)}); }
export async function updateCertification(data: Partial<Certification>) { await supabase.from('certifications').update({ name: data.name, description: data.description, icon: data.icon, image_url: sanitizeImageUrl(data.imageUrl) }).eq('id', data.id); }
export async function deleteCertification(id: number) {
    await supabase.from('certifications').delete().eq('id', id);
}

export async function awardCertification(userId: number, certId: number, adminId: number) {
    // Idempotent: user_certifications has a composite PRIMARY KEY (user_id,
    // certification_id), so upsert-ignore-duplicates makes a re-award a silent
    // no-op instead of a PK-violation throw. This makes the Academy certify→award
    // path (double-click / re-certify) and the Award-Certification modal both
    // button-spam safe without a check-then-insert race.
    const { error } = await supabase.from('user_certifications').upsert(
        { user_id: userId, certification_id: certId, awarded_by: adminId },
        { onConflict: 'user_id,certification_id', ignoreDuplicates: true },
    );
    handleSupabaseError({ error, message: 'Failed to award certification' });
    // user_certifications isn't in the postgres_changes map, so broadcast
    // explicitly. Pass userId so the recipient re-hydrates their heavy nested
    // arrays (the lite roster query omits certs).
    broadcastReferenceDataUpdate(userId);
}
export async function revokeCertification(userId: number, certId: number) {
    await supabase.from('user_certifications').delete().eq('user_id', userId).eq('certification_id', certId);
    broadcastReferenceDataUpdate(userId);
}

/**
 * Award a single certification to N users. Validates the cert exists once at the
 * top, then verifies each target user exists before insert. Idempotent per user:
 * a re-grant is a no-op via the user_certifications composite PK (matches
 * single-user `awardCertification`). Capped at 100 targets per call; client chunks at 25.
 */
export async function bulkAwardCertification(
    targetUserIds: number[],
    certificationId: number,
    adminId: number,
): Promise<{ updated: number; total: number; skipped: number }> {
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return { updated: 0, total: 0, skipped: 0 };
    }
    if (targetUserIds.length > 100) {
        throw new Error(`bulkAwardCertification: bulk action capped at 100 users per call (got ${targetUserIds.length}).`);
    }

    const { data: cert } = await supabase
        .from('certifications')
        .select('id')
        .eq('id', certificationId)
        .maybeSingle();
    if (!cert) throw new Error('bulkAwardCertification: certification not found');

    let updated = 0;
    let skipped = 0;
    // Successfully-awarded ids only — shipped on the bulk broadcast so clients can
    // slice-refetch just these roster rows (users_slice).
    const updatedIds: number[] = [];
    for (const userId of targetUserIds) {
        try {
            const { data: u } = await supabase
                .from('users')
                .select('id')
                .eq('id', userId)
                
                .maybeSingle();
            if (!u) { skipped++; continue; }
            // Idempotent per user: the composite PK makes a re-grant a no-op
            // (upsert-ignore) rather than a PK-violation error that would skip it.
            const { error } = await supabase.from('user_certifications').upsert(
                { user_id: userId, certification_id: certificationId, awarded_by: adminId },
                { onConflict: 'user_id,certification_id', ignoreDuplicates: true },
            );
            if (error) { skipped++; continue; }
            updated++;
            updatedIds.push(userId);
        } catch (err) {
            log.warn('bulkAwardCertification skipped user', { userId, err });
            skipped++;
        }
    }
    await broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds });
    return { updated, total: targetUserIds.length, skipped };
}

export async function addCommendation(data: Partial<Commendation>) { await supabase.from('commendations').insert({ name: data.name, description: data.description, icon: data.icon, image_url: sanitizeImageUrl(data.imageUrl)}); }
export async function updateCommendation(data: Partial<Commendation>) { await supabase.from('commendations').update({ name: data.name, description: data.description, icon: data.icon, image_url: sanitizeImageUrl(data.imageUrl) }).eq('id', data.id); }
export async function deleteCommendation(id: number) {
    await supabase.from('commendations').delete().eq('id', id);
}

export async function awardCommendation(userId: number, commendId: number, reason: string, adminId: number) {
    await supabase.from('user_commendations').insert({ user_id: userId, commendation_id: commendId, reason, awarded_by: adminId });
    broadcastReferenceDataUpdate(userId);
}
export async function revokeCommendation(id: number) {
    // Look up the user_id before delete so the broadcast can target the
    // recipient. If the row doesn't exist, the delete is a no-op anyway.
    const { data: row } = await supabase.from('user_commendations').select('user_id').eq('id', id).maybeSingle();
    await supabase.from('user_commendations').delete().eq('id', id);
    broadcastReferenceDataUpdate(row?.user_id ?? undefined);
}

/**
 * Award a single commendation to N users with an optional shared reason.
 * Validates the commendation exists once; verifies each target exists. Allows
 * duplicates.
 */
export async function bulkAwardCommendation(
    targetUserIds: number[],
    commendationId: number,
    reason: string | null,
    adminId: number,
): Promise<{ updated: number; total: number; skipped: number }> {
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return { updated: 0, total: 0, skipped: 0 };
    }
    if (targetUserIds.length > 100) {
        throw new Error(`bulkAwardCommendation: bulk action capped at 100 users per call (got ${targetUserIds.length}).`);
    }

    const { data: commend } = await supabase
        .from('commendations')
        .select('id')
        .eq('id', commendationId)
        .maybeSingle();
    if (!commend) throw new Error('bulkAwardCommendation: commendation not found');

    let updated = 0;
    let skipped = 0;
    const updatedIds: number[] = [];
    for (const userId of targetUserIds) {
        try {
            const { data: u } = await supabase
                .from('users')
                .select('id')
                .eq('id', userId)
                
                .maybeSingle();
            if (!u) { skipped++; continue; }
            const { error } = await supabase.from('user_commendations').insert({
                user_id: userId, commendation_id: commendationId, reason, awarded_by: adminId,
            });
            if (error) { skipped++; continue; }
            updated++;
            updatedIds.push(userId);
        } catch (err) {
            log.warn('bulkAwardCommendation skipped user', { userId, err });
            skipped++;
        }
    }
    await broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds });
    return { updated, total: targetUserIds.length, skipped };
}

// ---------------------------------------------------------------------------
// Achievement Catalog Import — preview + bulk upsert
//
// Used by the admin "Import" flow on each MemberAchievementsTab sub-tab. Items
// are matched by name: existing names update editable fields, missing names
// insert; nothing the file omits is deleted.
//
// Bulk upserts are chunked client-side via offset/limit so a large import
// doesn't tie up a single RPC call and the UI can show progress. Per-row
// try/catch keeps a single bad row from aborting the rest. Server clamps `limit`
// to MAX_IMPORT_BATCH_SIZE upstream.
// ---------------------------------------------------------------------------

export const MAX_IMPORT_BATCH_SIZE = 100;

export interface AchievementImportItem {
    name: string;
    description?: string | null;
    icon?: string | null;
    imageUrl?: string | null;
}

export interface AchievementImportPreview {
    newCount: number;
    updateCount: number;
    skipCount: number;
    conflicts: Array<{
        name: string;
        changes: Record<string, { from: unknown; to: unknown }>;
    }>;
    invalid: Array<{ index: number; name?: string; reason: string }>;
    total: number;
}

export interface AchievementImportProgress {
    processed: number;
    total: number;
    nextOffset: number | null;
    inserted: number;
    updated: number;
    errors: Array<{ index: number; name?: string; reason: string }>;
}

const ACHIEVEMENT_TABLES = {
    specializations: 'specialization_tags',
    certifications: 'certifications',
    commendations: 'commendations',
} as const;

type AchievementKind = keyof typeof ACHIEVEMENT_TABLES;

// Normalize an item before compare/persist. Trims strings; coerces undefined to
// null so name-match diff doesn't surface noise like `null → ''`.
function normalizeImportItem(rawInput: unknown): AchievementImportItem | null {
    if (!rawInput || typeof rawInput !== 'object') return null;
    const raw = rawInput as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return null;
    return {
        name,
        description: typeof raw.description === 'string' ? raw.description : (raw.description == null ? null : String(raw.description)),
        icon: typeof raw.icon === 'string' ? raw.icon : (raw.icon == null ? null : String(raw.icon)),
        imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : (raw.imageUrl == null ? null : String(raw.imageUrl)),
    };
}

// Shape of an existing achievement row as read back for import compare/persist.
// `id` is only selected in the upsert path, so it's optional here.
interface ExistingAchievementRow {
    id?: number;
    name: string;
    description?: string | null;
    icon?: string | null;
    image_url?: string | null;
}

function diffRow(existing: ExistingAchievementRow, incoming: AchievementImportItem) {
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    if ((existing.description ?? null) !== (incoming.description ?? null)) {
        fields.description = { from: existing.description ?? null, to: incoming.description ?? null };
    }
    if ((existing.icon ?? null) !== (incoming.icon ?? null)) {
        fields.icon = { from: existing.icon ?? null, to: incoming.icon ?? null };
    }
    const sanitizedIncomingImage = sanitizeImageUrl(incoming.imageUrl) || null;
    if ((existing.image_url ?? null) !== sanitizedIncomingImage) {
        fields.imageUrl = { from: existing.image_url ?? null, to: sanitizedIncomingImage };
    }
    return fields;
}

export async function previewAchievementImport(
    kind: AchievementKind,
    items: unknown[],
): Promise<AchievementImportPreview> {
    const table = ACHIEVEMENT_TABLES[kind];
    if (!table) throw new Error(`Unknown achievement kind: ${kind}`);
    if (!Array.isArray(items)) throw new Error('items must be an array.');

    const invalid: AchievementImportPreview['invalid'] = [];
    const valid: AchievementImportItem[] = [];
    const seenNames = new Set<string>();
    items.forEach((raw, i) => {
        const normalized = normalizeImportItem(raw);
        if (!normalized) {
            invalid.push({ index: i, name: typeof (raw as { name?: unknown })?.name === 'string' ? (raw as { name: string }).name : undefined, reason: 'Missing or invalid name.' });
            return;
        }
        const lc = normalized.name.toLowerCase();
        if (seenNames.has(lc)) {
            invalid.push({ index: i, name: normalized.name, reason: 'Duplicate name within import file.' });
            return;
        }
        seenNames.add(lc);
        valid.push(normalized);
    });

    if (valid.length === 0) {
        return { newCount: 0, updateCount: 0, skipCount: 0, conflicts: [], invalid, total: items.length };
    }

    const names = valid.map(v => v.name);
    const { data: existingRows, error } = await supabase
        .from(table)
        .select('name, description, icon, image_url')
        
        .in('name', names);
    handleSupabaseError({ error, message: `Failed to load existing ${kind} for import preview` });

    const existingByName = new Map<string, ExistingAchievementRow>();
    for (const row of existingRows || []) existingByName.set(String(row.name).toLowerCase(), row);

    let newCount = 0;
    let updateCount = 0;
    let skipCount = 0;
    const conflicts: AchievementImportPreview['conflicts'] = [];
    for (const item of valid) {
        const existing = existingByName.get(item.name.toLowerCase());
        if (!existing) {
            newCount += 1;
            continue;
        }
        const changes = diffRow(existing, item);
        if (Object.keys(changes).length === 0) {
            skipCount += 1;
        } else {
            updateCount += 1;
            conflicts.push({ name: item.name, changes });
        }
    }

    return { newCount, updateCount, skipCount, conflicts, invalid, total: items.length };
}

export async function bulkUpsertAchievements(
    kind: AchievementKind,
    items: unknown[],
    offset: number,
    limit: number,
): Promise<AchievementImportProgress> {
    const table = ACHIEVEMENT_TABLES[kind];
    if (!table) throw new Error(`Unknown achievement kind: ${kind}`);
    if (!Array.isArray(items)) throw new Error('items must be an array.');

    const safeLimit = Math.max(1, Math.min(MAX_IMPORT_BATCH_SIZE, Math.floor(limit) || MAX_IMPORT_BATCH_SIZE));
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    const slice = items.slice(safeOffset, safeOffset + safeLimit);
    const errors: AchievementImportProgress['errors'] = [];
    let inserted = 0;
    let updated = 0;

    // Pre-fetch the existing rows in this slice by name to minimize round-trips.
    const sliceNames: string[] = [];
    const sliceIndex: { item: AchievementImportItem; index: number }[] = [];
    slice.forEach((raw, i) => {
        const normalized = normalizeImportItem(raw);
        const absoluteIndex = safeOffset + i;
        if (!normalized) {
            errors.push({ index: absoluteIndex, name: typeof (raw as { name?: unknown })?.name === 'string' ? (raw as { name: string }).name : undefined, reason: 'Missing or invalid name.' });
            return;
        }
        sliceNames.push(normalized.name);
        sliceIndex.push({ item: normalized, index: absoluteIndex });
    });

    const existingByName = new Map<string, ExistingAchievementRow>();
    if (sliceNames.length > 0) {
        const { data: existingRows, error } = await supabase
            .from(table)
            .select('id, name, description, icon, image_url')
            
            .in('name', sliceNames);
        if (error) {
            // If the lookup itself fails, every row in this batch fails — record
            // each individually so the client error panel matches the per-row UX.
            for (const { item, index } of sliceIndex) errors.push({ index, name: item.name, reason: error.message });
            return {
                processed: slice.length,
                total: items.length,
                nextOffset: safeOffset + slice.length < items.length ? safeOffset + slice.length : null,
                inserted, updated, errors,
            };
        }
        for (const row of existingRows || []) existingByName.set(String(row.name).toLowerCase(), row);
    }

    for (const { item, index } of sliceIndex) {
        try {
            const existing = existingByName.get(item.name.toLowerCase());
            const sanitizedImage = sanitizeImageUrl(item.imageUrl) || null;
            if (!existing) {
                const { error } = await supabase.from(table).insert({
                    name: item.name,
                    description: item.description,
                    icon: item.icon,
                    image_url: sanitizedImage,
                    });
                if (error) {
                    errors.push({ index, name: item.name, reason: error.message });
                } else {
                    inserted += 1;
                }
            } else {
                const changes = diffRow(existing, item);
                if (Object.keys(changes).length === 0) continue; // idempotent — skip silently
                const { error } = await supabase.from(table).update({
                    description: item.description,
                    icon: item.icon,
                    image_url: sanitizedImage,
                }).eq('id', existing.id);
                if (error) {
                    errors.push({ index, name: item.name, reason: error.message });
                } else {
                    updated += 1;
                }
            }
        } catch (err) {
            errors.push({ index, name: item.name, reason: (err instanceof Error ? err.message : '') || 'Unknown error.' });
        }
    }

    const processedThroughEnd = safeOffset + slice.length;
    return {
        processed: slice.length,
        total: items.length,
        nextOffset: processedThroughEnd < items.length ? processedThroughEnd : null,
        inserted,
        updated,
        errors,
    };
}

export async function addConductEntry(userId: number, type: string, reason: string, adminId: number) {
    const { data: user } = await supabase.from('users').select('id').eq('id', userId).single();
    if (!user) throw new Error('User not found');
    await supabase.from('conduct_records').insert({ user_id: userId, type, reason, entered_by_id: adminId});
}
export async function deleteConductEntry(id: number) {
    await supabase.from('conduct_records').delete().eq('id', id);
}

export async function updateRankMapping(discordRoleId: string, rankId: number | string, roleId?: number | string) {
    if (!rankId && !roleId) {
        const query = supabase.from('rank_mappings').delete().eq('discord_role_id', discordRoleId);
        await query;
    } else {
        await supabase.from('rank_mappings').upsert({
            discord_role_id: discordRoleId,
            rank_id: rankId ? parseInt(rankId.toString()) : null,
            role_id: roleId ? parseInt(roleId.toString()) : null
        }, { onConflict: 'discord_role_id' });
    }
    // This write had NO live carrier at all. The client used to bind postgres_changes on
    // `rank_mappings` and `synced_discord_roles`, but neither table is in
    // private.rt_client_tables(), which IS the realtime publication — so the bindings were
    // inert and an admin saw stale mappings until they reloaded. Empty payload: receivers
    // refetch the `discord` subset through the permission-gated read path.
    await broadcastToOrg('discord_config_update', {});
}

// --- UNIT FEED ---

// #1: gate per-unit RPCs by the new is_restricted flag. Throws UNIT_RESTRICTED
// when the viewer is neither a member of the unit nor holds units:view_all
// (admin override). Soft-fails on PG 42703 (column missing) so DBs that
// haven't run migrations/add-unit-visibility.sql treat every unit as open.
export async function assertUnitAccess(unitId: number, viewerUserId: number): Promise<void> {
    if (!unitId || !viewerUserId) return;
    const { data: unit, error } = await supabase
        .from('units')
        .select('id, is_restricted')
        .eq('id', unitId)
        .maybeSingle();
    if (error?.code === '42703') {
        // Column missing — pre-migration tenant; don't block.
        log.warn('units.is_restricted missing — skipping restriction check; run migrations/add-unit-visibility.sql', { migration: true });
        return;
    }
    if (!unit) {
        const err = new Error('Unit not found.') as Error & { code?: string };
        err.code = 'UNIT_NOT_FOUND';
        throw err;
    }
    if (!unit.is_restricted) return;

    // Restricted: viewer must be a member OR hold units:view_all.
    const { data: viewerData } = await supabase
        .from('users')
        .select('unit_id, role:roles(role_permissions(permission:permissions(name)))')
        .eq('id', viewerUserId)
        .maybeSingle();
    // Nested PostgREST join shape isn't captured by the generated row types;
    // describe exactly the fields dereferenced below.
    const viewer = viewerData as unknown as {
        unit_id?: number | null;
        role?: { role_permissions?: Array<{ permission?: { name?: string | null } | null }> | null } | null;
    } | null;
    const viewerUnitId = viewer?.unit_id;
    if (viewerUnitId === unitId) return;
    const perms: string[] = (viewer?.role?.role_permissions || [])
        .map((rp) => rp.permission?.name)
        .filter((name): name is string => Boolean(name));
    if (perms.includes('units:view_all')) return;

    const err = new Error('This unit is restricted to its members.') as Error & { code?: string };
    err.code = 'UNIT_RESTRICTED';
    throw err;
}

export async function getUnitFeed(unitId: number): Promise<UnitPost[]> {
    // The embedded author is rendered as name + avatar only. Select ONLY
    // roster-public identity columns — never HR/session-metadata PII
    // (probation_*, tenure_start_date, job_title, voice_channel_name,
    // rsi_verified, timezone, date_format). Those are withheld from non-HR
    // viewers by stripSensitiveUserFields on the roster/profile paths and the
    // unit-feed RPC result is returned without that pass, so over-selecting here
    // would leak them to any member who can read a unit feed.
    const { data } = await supabase.from('unit_posts')
        .select('id, unit_id, author_id, content, created_at, pinned, author:users(id, name, display_name, avatar_url, rsi_handle, role_id, reputation, is_duty, is_affiliate, is_vip, created_at)')
        .eq('unit_id', unitId)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(50);
    return (data || []).map((row) => toUnitPost(row as unknown as Parameters<typeof toUnitPost>[0]));
}

export async function createUnitPost(unitId: number, userId: number, content: string): Promise<UnitPost> {
    const { data, error } = await supabase.from('unit_posts').insert({
        unit_id: unitId,
        author_id: userId,
        content
    // Author embed is name + avatar only — mirror getUnitFeed and select ONLY
    // roster-public identity columns, no HR/session-metadata PII.
    }).select('id, unit_id, author_id, content, created_at, pinned, author:users(id, name, display_name, avatar_url, rsi_handle, role_id, reputation, is_duty, is_affiliate, is_vip, created_at)').single();
    handleSupabaseError({ error, message: 'Failed to post' });
    if (!data) throw new Error('Failed to post');
    return toUnitPost(data as unknown as Parameters<typeof toUnitPost>[0]);
}

export async function deleteUnitPost(postId: string, actor?: { id?: number; permissions?: string[] }) {
    const { data: post } = await supabase.from('unit_posts').select('unit_id, author_id').eq('id', postId).maybeSingle();
    if (!post) return; // already gone

    // unit:delete_post is gated only at the read-level user:view:roster perm, so
    // authorize the delete here against the POST's OWN unit (NOT any client unitId):
    // the author, the post-unit's leader, or a moderator (units:view_all; Admin
    // holds it via all-perms) may delete. Anyone else is refused.
    const actorId = actor?.id;
    const isAuthor = actorId !== undefined && post.author_id === actorId;

    let isLeader = false;
    if (!isAuthor && actorId !== undefined && post.unit_id != null) {
        const { data: unit } = await supabase.from('units').select('leader_id').eq('id', post.unit_id).maybeSingle();
        isLeader = !!unit && unit.leader_id === actorId;
    }

    const canModerate = !!actor?.permissions?.includes('units:view_all');

    if (!isAuthor && !isLeader && !canModerate) {
        throw new Error('You are not authorized to delete this post.');
    }

    const { error } = await supabase.from('unit_posts').delete().eq('id', postId);
    handleSupabaseError({ error, message: 'Failed to delete post' });
}

// --- TOOLS & LOCATIONS ---
// External tools: category and sort_order columns ship via
// migrations/add-external-tools-order-category.sql. We try writing them on
// create/update and fall back without those fields if the column doesn't
// exist yet (PG error 42703 = undefined column).
async function insertExternalToolWithRetry(payload: Record<string, unknown>) {
    let { error } = await supabase.from('external_tools').insert(payload);
    if (error?.code === '42703' && ('category' in payload || 'sort_order' in payload)) {
        log.warn('external_tools.category/sort_order missing — retrying without; run migrations/add-external-tools-order-category.sql', { migration: true });
        const { category, sort_order, ...slim } = payload;
        ({ error } = await supabase.from('external_tools').insert(slim));
    }
    if (error) throw error;
}
async function updateExternalToolWithRetry(id: number, patch: Record<string, unknown>) {
    let { error } = await supabase.from('external_tools').update(patch).eq('id', id);
    if (error?.code === '42703' && ('category' in patch || 'sort_order' in patch)) {
        log.warn('external_tools.category/sort_order missing — retrying without; run migrations/add-external-tools-order-category.sql', { migration: true });
        const { category, sort_order, ...slim } = patch;
        ({ error } = await supabase.from('external_tools').update(slim).eq('id', id));
    }
    if (error) throw error;
}

export async function addExternalTool(data: Partial<ExternalTool>) {
    await insertExternalToolWithRetry({
        title: data.title,
        description: data.description,
        url: data.url,
        icon: data.icon,
        audience: data.audience,
        category: data.category?.trim() || null,
        sort_order: typeof data.sortOrder === 'number' ? data.sortOrder : 0,
        });
    await broadcastToOrg('external_tools_update', {});
}
export async function updateExternalTool(data: Partial<ExternalTool>) {
    await updateExternalToolWithRetry(data.id as number, {
        title: data.title,
        description: data.description,
        url: data.url,
        icon: data.icon,
        audience: data.audience,
        category: data.category?.trim() || null,
        sort_order: typeof data.sortOrder === 'number' ? data.sortOrder : 0,
    });
    await broadcastToOrg('external_tools_update', {});
}
// Targeted reorder helper — used by the admin tab's up/down arrows so we
// don't have to round-trip every field on every nudge.
export async function reorderExternalTool(id: number, sortOrder: number) {
    await updateExternalToolWithRetry(id, { sort_order: sortOrder });
    await broadcastToOrg('external_tools_update', {});
}
export async function deleteExternalTool(id: number) {
    await supabase.from('external_tools').delete().eq('id', id);
    await broadcastToOrg('external_tools_update', {});
}

// roles.name is operator-supplied free text under a CASE-SENSITIVE unique
// constraint (roles_name_key), so 'admin' and ' Admin ' both slip past the
// constraint while normalising onto a system name downstream. Reserve the four
// seeded names case-insensitively (a SUPERSET of the byte-exact match toUser and
// getSystemRoles accept) so a custom role can never impersonate one in the audience
// vocabulary — announcements.audience / external_tools.audience store these literal
// strings. Deliberately NOT applied to lib/db/importer.ts: an export must import
// verbatim, and post-sweep an imported role named 'admin' is an audience label, not
// privilege.
const RESERVED_ROLE_NAMES = new Set(['client', 'member', 'dispatcher', 'admin']);

function assertRoleNameAvailable(name: string | undefined | null): string {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('Role name is required.');
    if (n.length > 60) throw new Error('Role name is too long (max 60 characters).');
    if (RESERVED_ROLE_NAMES.has(n.toLowerCase())) throw new Error('That role name is reserved for a system role.');
    return n;
}

/**
 * The description has no length guard of its own anywhere else, and it is rendered in
 * the Roles tab for every admin. Capped at the same order as the name so an
 * admin:config:roles delegate cannot park an unbounded blob in a table that the
 * permission UI reads on every load.
 */
const MAX_ROLE_DESCRIPTION_LEN = 500;
function normaliseRoleDescription(description: unknown): string | null {
    if (description == null) return null;
    const d = String(description).trim();
    if (!d) return null;
    if (d.length > MAX_ROLE_DESCRIPTION_LEN) throw new Error(`Role description is too long (max ${MAX_ROLE_DESCRIPTION_LEN} characters).`);
    return d;
}

export async function addRole(data: Partial<Role>) {
    const name = assertRoleNameAvailable(data.name);
    // The insert error used to be discarded, so a UNIQUE violation returned success
    // and the Roles tab toasted a role that was never created.
    const { error } = await supabase.from('roles').insert({ name, description: normaliseRoleDescription(data.description) });
    handleSupabaseError({ error, message: 'Failed to add role' });
}
export async function updateRole(data: Partial<Role>) {
    const id = data.id as number;
    const { data: existing } = await supabase.from('roles').select('name, is_system').eq('id', id).single();
    if (!existing) throw new Error('Role not found');
    if (existing.is_system && data.name && data.name.trim() !== existing.name) {
        throw new Error('System roles cannot be renamed.');
    }
    // Renaming a CUSTOM role onto a reserved name was unguarded; only creation-time
    // checks would have left the same channel open through the rename path.
    //
    // The is_system branch keeps the STORED name verbatim rather than echoing back
    // whatever the caller sent. The rename guard above compares `data.name.trim()`,
    // so '  Admin  ' passes it — and the old code then wrote that raw, untrimmed
    // string. getSystemRoles resolves the Admin slot by a BYTE-EXACT name match
    // (lib/db/common.ts, deliberately, so a decoy role called 'admin' cannot claim
    // it), so a padded name silently unresolves the slot and every apex gate that
    // depends on it — assertAdminRole, the danger zone, the ban identity arm —
    // starts denying the real Admin. A rename that is refused must be a no-op, not a
    // whitespace edit.
    const name = existing.is_system ? existing.name : assertRoleNameAvailable(data.name);
    const { error } = await supabase.from('roles')
        .update({ name, description: normaliseRoleDescription(data.description) }).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update role' });
}
export async function deleteRole(id: number) {
    const { data: role } = await supabase.from('roles').select('is_system').eq('id', id).single();
    if (!role) throw new Error('Role not found');
    if (role.is_system) throw new Error('Cannot delete a system role.');
    await supabase.from('roles').delete().eq('id', id);
}

export async function addLocation(data: Partial<Location>) { const { error } = await supabase.from('locations').insert({ name: data.name, type: data.type, parent_id: data.parent_id}); handleSupabaseError({ error, message: 'Failed to add location' }); }
export async function updateLocation(data: Partial<Location>) { const { error } = await supabase.from('locations').update({ name: data.name, type: data.type, parent_id: data.parent_id }).eq('id', data.id); handleSupabaseError({ error, message: 'Failed to update location' }); }
export async function deleteLocation(id: number) {
    const { error } = await supabase.from('locations').delete().eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete location' });
}

/**
 * How loudly an EAM pings Discord.
 *
 * A DELIBERATELY NARROW set. Hosted lets the sender pick any synced guild role;
 * this build offers 'role' meaning THE ONE role an admin configured
 * (discordConfig.eamPingRoleId) and nothing else, because configuring who may be
 * @-mentioned is admin:config:discord while SENDING an EAM is admin:broadcast:eam,
 * which the seeded Dispatcher role holds. A free-form role picker would hand every
 * Dispatcher an arbitrary @-mention primitive aimed at any role in the guild, and
 * would need its own read path into synced_discord_roles to populate.
 *
 * '@everyone' is NOT offered at all. buildMentionContent still supports it — it is
 * tested and it is the right shape if it is ever wanted — but nothing in this build
 * uses it, and adding it to a picker is a strict widening of the loudest thing the
 * product can do for no request anyone has made.
 */
export type EamPingTarget = 'none' | 'here' | 'role';

/**
 * Resolve the ping BEFORE the fan-out, never inside notifyDiscordEam.
 *
 * That function swallows every error by contract (an EAM must reach in-app and push
 * even when Discord is down), so a bad ping target resolved in there would vanish
 * silently instead of telling the sender. Resolving here also means a fault costs
 * the PING, never the EAM.
 */
function resolveEamPing(pingTarget: unknown, configuredRoleId?: string | null): { here?: boolean; roleId?: string | null } {
    // No explicit choice ⇒ the historical behaviour: @here, plus the configured
    // role if one is set. Existing callers keep working unchanged.
    if (pingTarget == null || pingTarget === '') return { here: true, roleId: configuredRoleId ?? null };
    if (pingTarget === 'none') return {};
    if (pingTarget === 'here') return { here: true };
    if (pingTarget === 'role') return { roleId: configuredRoleId ?? null };
    // Anything else is a client sending something this build does not offer. Fail
    // QUIET rather than loud: drop the ping, still send the EAM.
    log.warn('unknown EAM ping target — sending without a ping', { pingTarget: String(pingTarget).slice(0, 32) });
    return {};
}

export async function broadcastEAM(message: string, pingTarget?: EamPingTarget) {
    const eamData = { message, timestamp: new Date().toISOString() };

    // Update settings table (for persistence — the gated broadcast:get_active_eam
    // fetch reads it back)
    await supabase.from('settings').upsert({ key: 'active_eam', value: eamData });

    // The realtime emit is a TRIGGER ONLY ({timestamp}, no message body).
    // Authorized clients pull the body via the permission-gated
    // broadcast:get_active_eam RPC on receipt.
    //
    // The push body carries the EAM directive, so its audience MUST mirror that
    // read gate exactly — staff (any non-Client role) OR holders of
    // user:receive:eam. NEVER sendPushToAll here: Web-Push encryption only
    // protects transport to the vendor/device, not authorization, so an
    // all-users push would leak the directive to Client-role users who are
    // denied EAM access in-app. Overlap between the staff and permission sets is
    // collapsed at the device by the shared `tag: 'eam'`.
    const eamPushPayload = {
        title: '🚨 EMERGENCY ACTION MESSAGE 🚨',
        body: message,
        tag: 'eam',
        data: { type: 'eam' },
        requireInteraction: true,
        renotify: true,
    };
    await Promise.all([
        broadcastToChannel(
            'auth-alerts',
            'eam_broadcast',
            { timestamp: eamData.timestamp }
        ),
        sendPushToStaff(eamPushPayload),
        sendPushToPermission('user:receive:eam', eamPushPayload),
        notifyDiscordEam(message, eamData.timestamp, pingTarget),
    ]);
}

/**
 * Gated fetch backing the eam_broadcast trigger: returns the persisted active
 * EAM ({message, timestamp} | null). The dispatcher gates the action at
 * authenticated; the handler additionally enforces the same staff-or-
 * user:receive:eam audience the client UI applies (api/actions/system.ts).
 */
export async function getActiveEam(): Promise<{ message: string; timestamp: string } | null> {
    const { data } = await supabase.from('settings').select('value').eq('key', 'active_eam').maybeSingle();
    const v = data?.value as { message?: unknown; timestamp?: unknown } | null;
    if (!v || typeof v.message !== 'string' || !v.message) return null;
    return { message: v.message, timestamp: typeof v.timestamp === 'string' ? v.timestamp : '' };
}

async function notifyDiscordEam(message: string, timestamp: string, pingTarget?: EamPingTarget) {
    try {
        const { data: settingsData } = await supabase.from('settings')
            .select('key, value')
            
            .in('key', ['discordConfig', 'brandingConfig']);
        type EamSettings = {
            discordConfig?: { eamChannelId?: string; eamPingRoleId?: string };
            brandingConfig?: { name?: string; iconUrl?: string };
        };
        const settings = ((settingsData || []) as Array<{ key: string; value: unknown }>)
            .reduce<EamSettings>((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});

        const channelId = settings.discordConfig?.eamChannelId;
        if (!channelId) return;

        const branding = settings.brandingConfig || { name: 'Organization', iconUrl: '' };
        const truncated = message.length > 4000 ? message.substring(0, 3997) + '...' : message;

        const embed: Record<string, unknown> = {
            title: '🚨 EMERGENCY ACTION MESSAGE',
            description: `\`\`\`\n${truncated}\n\`\`\``,
            color: 0xdc2626, // red-600
            fields: [
                { name: 'Priority', value: 'Critical — Override Broadcast', inline: true },
                { name: 'Issued', value: `<t:${Math.floor(new Date(timestamp).getTime() / 1000)}:F>`, inline: true },
            ],
            timestamp,
            footer: {
                text: `${branding.name || 'Organization'} Command Authority`,
                ...(branding.iconUrl && branding.iconUrl.startsWith('http') ? { icon_url: branding.iconUrl } : {}),
            },
        };

        // Lazy-import to avoid a circular dep between system.ts and discord.ts.
        const { sendDiscordChannelMessage, buildMentionContent } = await import('../discord.js');
        // buildMentionContent, not a hand-written allowed_mentions. This line used to
        // be `parse: ['everyone']`, which asks Discord to parse EVERY mention out of
        // the content — the exact fail-open shape lib/discord.ts's suppression layer
        // exists to prevent. The builder emits an explicit, minimal allowlist.
        const ping = resolveEamPing(pingTarget, settings.discordConfig?.eamPingRoleId);
        const mention = buildMentionContent(ping);
        await sendDiscordChannelMessage(channelId, { ...mention, embeds: [embed] });
    } catch (err) {
        log.error('discord eam broadcast notification failed', { err });
    }
}

export async function broadcastSystemAlert(message: string) {
    await supabase.from('settings').upsert({ key: 'system_broadcast', value: { message, id: Date.now().toString() } });
    // Live in-app toast: emit on the private auth-alerts channel (same channel as
    // EAM / op-alert). An org-wide system broadcast is not per-viewer-scoped, so the
    // message rides the payload directly — no gated re-fetch needed.
    await broadcastToChannel('auth-alerts', 'system_broadcast', { message });
    sendPushToAll({ title: 'System Broadcast', body: message, tag: 'broadcast' });
}

// `radio_channels.id` is a caller-supplied text primary key. 'unit-'/'req-' are the
// grammar the radio resolver reserves for synthetic squad and mission nets
// (lib/radio.ts), which it parses BEFORE the channel lookup — so a row claiming one
// of those ids is unjoinable by construction. Refuse it at the write boundary too,
// rather than let a radio:manage holder create a channel that renders in the widget
// and 403s on every click.
export async function addRadioChannel(data: Partial<RadioChannel> & { sort_order?: number }) {
    const id = String(data.id || '').trim();
    if (!id) throw new Error('Radio channel id is required.');
    if (id.startsWith('unit-') || id.startsWith('req-')) {
        throw new Error("Radio channel ids starting with 'unit-' or 'req-' are reserved for squad and mission channels.");
    }
    const { error } = await supabase.from('radio_channels').insert({ id, name: data.name, color: data.color, type: data.type, sort_order: data.sort_order || 0});
    handleSupabaseError({ error, message: 'Failed to add radio channel' });
}
export async function updateRadioChannel(id: string, name: string, color: string, sort_order?: number) { const updates: Record<string, unknown> = { name, color }; if (sort_order !== undefined) updates.sort_order = sort_order; const { error } = await supabase.from('radio_channels').update(updates).eq('id', id); handleSupabaseError({ error, message: 'Failed to update radio channel' }); }
export async function deleteRadioChannel(id: string) {
    const { error } = await supabase.from('radio_channels').delete().eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete radio channel' });
}

/** Columns api_keys must have for key verification to run. Named here so the preflight can
 *  tell the operator exactly what is missing rather than "something is wrong". */
export const API_KEY_REQUIRED_COLUMNS = ['scopes', 'expires_at', 'revoked_at', 'key_prefix'] as const;

/** Set when a key read fails with 42703 (undefined column), i.e. the code is newer than the
 *  database. Surfaced to the operator by the boot preflight, the Database Tools health check and
 *  an admin-only banner — because the alternative is a federation blackout whose only symptom is
 *  an ally reporting that we look down. */
let apiKeySchemaOutdated = false;
export function isApiKeySchemaOutdated(): boolean { return apiKeySchemaOutdated; }
export function __resetApiKeySchemaFlagForTest(): void { apiKeySchemaOutdated = false; }

/**
 * Which of the required api_keys columns are absent?
 *
 * Probes each column with a bounded head-count read and reads the PostgREST error code, rather
 * than querying information_schema — the service-role client answers this the same way the real
 * query paths do, so the check cannot pass while the actual reads fail.
 *
 * Returns [] when everything is present. Throws only on an unexpected fault, so the caller can
 * distinguish "up to date" from "could not tell".
 */
export async function findMissingApiKeyColumns(): Promise<string[]> {
    // Each probe spells its column out as a LITERAL rather than looping a variable into
    // .select(). The wildcard-select ratchet resolves const strings but cannot resolve a loop
    // binding, so a dynamic select here would fail CI — and rightly: "the column list is a
    // variable" is exactly the shape the ratchet exists to refuse.
    const probes: Array<[string, () => PromiseLike<{ error: unknown }>]> = [
        ['scopes', () => supabase.from('api_keys').select('scopes', { count: 'exact', head: true })],
        ['expires_at', () => supabase.from('api_keys').select('expires_at', { count: 'exact', head: true })],
        ['revoked_at', () => supabase.from('api_keys').select('revoked_at', { count: 'exact', head: true })],
        ['key_prefix', () => supabase.from('api_keys').select('key_prefix', { count: 'exact', head: true })],
    ];
    const missing: string[] = [];
    for (const [name, run] of probes) {
        const { error } = await run();
        const code = (error as { code?: string } | null)?.code;
        if (code === '42703') { missing.push(name); continue; }
        if (error) throw error;
    }
    apiKeySchemaOutdated = missing.length > 0;
    return missing;
}

export async function verifyApiKey(key: string) {
    // All keys (manual + alliance) are stored as SHA-256 hashes and verified by
    // hash only — there is no plaintext fallback, so keys that predate hashing
    // must be re-issued.
    if (typeof key !== 'string' || !key) return null;
    const hash = createHash('sha256').update(key).digest('hex');
    // The label rides along so callers can tell a manual feed key from an alliance key
    // (labelled "alliance:<peerId>"). `scopes` is the declared capability; `revoked_at` and
    // `expires_at` are the lifecycle.
    const { data, error } = await supabase.from('api_keys')
        .select('id, label, scopes, expires_at, revoked_at')
        .eq('key_hash', hash)
        .maybeSingle();

    // FAIL CLOSED on any read fault, and say so loudly. The error was previously not bound at
    // all, so a missing column produced `data === undefined` → `return null` → every federation
    // route and every feed pull 403'd with NO log line anywhere. A silent total outage is worse
    // than a noisy one; a deliberate fail-OPEN would be worse than both.
    if (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === '42703') {
            apiKeySchemaOutdated = true;
            log.error('api_keys is missing lifecycle columns — re-run schema.sql', {
                code,
                required: [...API_KEY_REQUIRED_COLUMNS],
                effect: 'API key authentication is refused until the database is updated.',
            });
        } else {
            log.error('api key lookup failed', { err: error });
        }
        return null;
    }
    if (!data) return null;

    // A revoked or expired key is not a key. Checked HERE rather than in SQL so the reason is
    // greppable in the audit trail and so a clock-skewed database cannot quietly re-admit one.
    const row = data as { id: string; label: string; scopes: unknown; expires_at: unknown; revoked_at: unknown };
    if (row.revoked_at) {
        auditKeyDenial('authz.api_key.revoked', { keyId: row.id, label: row.label });
        return null;
    }
    if (isKeyExpired(row.expires_at)) {
        auditKeyDenial('authz.api_key.expired', { keyId: row.id, label: row.label });
        return null;
    }

    // Only stamp last_used_at for a key that actually authenticated, so a revoked credential
    // being replayed does not keep looking freshly used in the admin list.
    await supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', row.id);
    return { id: row.id, label: row.label, scopes: row.scopes };
}

/** Audit a key-level denial. Real try/catch, not a bare `void`: this sits on an
 *  unauthenticated-reachable path, and `void` protects a caller from a rejected promise but not
 *  from an absent export in a partial test double — which would turn a 403 into a 500. */
function auditKeyDenial(event: string, fields: Record<string, unknown>): void {
    try {
        void recordSecurityEvent({ event, action: 'api:verify_key', details: fields });
    } catch (err) {
        log.warn('security event emit threw', { err });
    }
}

// Org-wide outbound clearance ceiling (settings: intelSharingConfig). 0 = only
// unclassified. Shared by the legacy feed and the per-peer alliance channel.
// The unbound .error here is deliberate and fails CLOSED: a read fault leaves
// `setting` null, so the ceiling collapses to 0 (share nothing above unclassified).
export async function getMaxShareableClearance(): Promise<number> {
    const { data: setting } = await supabase.from('settings').select('value').eq('key', 'intelSharingConfig').maybeSingle();
    const v = (setting?.value as { maxShareableClearance?: number } | null)?.maxShareableClearance;
    return typeof v === 'number' ? v : 0;
}

// Pure shareability predicate (unit-tested): an item carrying a sync_restricted
// marker is never shared; otherwise it shares only at/below the clearance ceiling.
export function intelItemPasses(classificationLevel: number | null | undefined, isRestricted: boolean, maxClearance: number): boolean {
    if (isRestricted) return false;
    return (classificationLevel || 0) <= maxClearance;
}

// Outbound-federation read caps. Deliberately NOT safeFetch(): for these reads
// returning a fallback IS the fail-open — an empty exclusion set means "nothing is
// restricted", which federates exactly the rows a sync_restricted marker exists to
// withhold, silently and with a 200.
const FEED_MARKER_LIMIT = 500;   // caveat codes an org defines: tens at most
const FEED_ITEM_LIMIT = 500;     // per-channel page; peers page older history via ?since=
const MARKER_ASSOC_CHUNK = 100;  // ids per .in() — keeps the PostgREST GET URL short

// The only text a failed feed read may return. It reaches a peer org / API-key holder
// and is rendered into an ally's admin UI on the same-host path (lib/db/intel.ts), so
// it must carry no PostgREST message, column or constraint name. Same no-leak contract
// as handleSupabaseError; thrown directly rather than through it so each site can log
// WHICH leg failed, which the shared helper has no field for.
const FEED_UNAVAILABLE = 'Feed temporarily unavailable';

// PostgREST serialises .in() into the GET URL, so one filter carrying a whole page of
// ids builds a ~19KB request a proxy can reject with 414/400 — a rejection that used to
// land on an unchecked { data } destructure and empty the exclusion set. Chunk it, and
// throw on any error so the feed 500s instead of over-sharing.
async function fetchMarkerAssociations<T>(
    ids: string[],
    run: (batch: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
    const rows: T[] = [];
    for (let i = 0; i < ids.length; i += MARKER_ASSOC_CHUNK) {
        const { data, error } = await run(ids.slice(i, i + MARKER_ASSOC_CHUNK));
        if (error) {
            log.error('shareable-intel marker-association lookup failed', { err: error });
            throw new Error(FEED_UNAVAILABLE);
        }
        for (const row of (data || [])) rows.push(row);
    }
    return rows;
}

// One channel of the outbound page. A disabled channel is never awaited (the builder
// only fires on .then), so an unwanted channel's saturation cannot clamp the cursor
// the enabled ones share. An error THROWS: serving an empty page would still hand the
// peer a cursor it writes into alliance_peers.intel_synced_at (lib/db/intel.ts),
// permanently skipping the window we failed to read.
async function runFeedLeg<T extends { created_at: string }>(
    enabled: boolean,
    query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    leg: string,
): Promise<{ rows: T[]; saturated: boolean }> {
    if (!enabled) return { rows: [], saturated: false };
    const { data, error } = await query;
    if (error) {
        log.error('shareable-intel channel query failed', { leg, err: error });
        throw new Error(FEED_UNAVAILABLE);
    }
    const rows = data || [];
    return { rows, saturated: rows.length >= FEED_ITEM_LIMIT };
}

// Clamp to the last created_at strictly BELOW the final served row's, so the caller's
// next .gt('created_at', cursor) cannot skip rows sharing the tail timestamp that fell
// beyond the cap. null ⇒ the whole page is one timestamp ⇒ the cursor cannot advance
// without dropping the remainder. Re-serving the trailing rows is fine — the receiver
// dedups the replay, the same property fetchedAt's pre-query capture relies on.
function clampCursor(rows: Array<{ created_at: string }>): string | null {
    const lastTs = rows[rows.length - 1].created_at;
    for (let i = rows.length - 2; i >= 0; i--) if (rows[i].created_at !== lastTs) return rows[i].created_at;
    return null;
}

export interface ShareableIntelOpts {
    maxClearance: number;
    channels: { reports?: boolean; warrants?: boolean; bulletins?: boolean };
    // When true, only bulletins explicitly flagged shared_with_allies go out
    // (per-item opt-in for the alliance channel). The legacy feed passes false.
    bulletinsRequireSharedFlag: boolean;
    since?: string;
}

// Shared core for the outbound intel projection. Both getPublicFeedData (legacy
// org-wide feed) and getAllianceShareableData (per-peer alliance channel) call
// this. Deny-by-default: sync_restricted markers excluded, clearance ceiling
// applied, and only the enabled channels returned.
export async function collectShareableIntel(opts: ShareableIntelOpts) {
    // Captured BEFORE the queries run: items committed mid-query re-serve next
    // pull (dedup absorbs the replay) instead of being silently skipped. The
    // caller's next ?since= cursor — OUR clock domain, same as the items'
    // created_at, so cross-server clock skew can never lose intel.
    const fetchedAt = new Date().toISOString();
    const maxShareableLevel = opts.maxClearance ?? 0;
    const wantReports = !!opts.channels.reports;
    const wantWarrants = !!opts.channels.warrants;
    const wantBulletins = !!opts.channels.bulletins;
    const since = opts.since;

    // 1. Limiting markers (sync_restricted exclusion set + code lookup)
    const { data: allMarkers, error: markersError } = await supabase.from('security_limiting_markers')
        .select('id, code, sync_restricted')
        .order('id', { ascending: true })
        .limit(FEED_MARKER_LIMIT);
    if (markersError) {
        log.error('shareable-intel marker lookup failed', { err: markersError });
        throw new Error(FEED_UNAVAILABLE);
    }
    // marker id / marker_id are `integer` (schema.sql), not text — the old `string`
    // casts only worked because the Map was keyed by whatever the driver returned.
    type MarkerRow = Pick<Tables<'security_limiting_markers'>, 'id' | 'code' | 'sync_restricted'>;
    const markerRows = (allMarkers || []) as MarkerRow[];
    if (markerRows.length >= FEED_MARKER_LIMIT) {
        // SATURATED ⇒ FAIL CLOSED. A marker we did not fetch is a marker that cannot
        // exclude its rows, so truncation here degrades into exactly the silent
        // over-share the error branch above refuses. The cap is ~25x the caveat codes
        // an org defines, so refusing is not a denial of service on a real deployment.
        log.error('shareable-intel marker lookup hit the cap; refusing to federate against a partial marker set', { cap: FEED_MARKER_LIMIT });
        throw new Error(FEED_UNAVAILABLE);
    }
    const markerMap = new Map(markerRows.map((m) => [m.id, m] as const));
    const restrictedMarkerIds = new Set(markerRows.filter((m) => m.sync_restricted).map((m) => m.id));

    // 2. Query reports, warrants, and active bulletins
    // Federation loop guard: items WE ingested from an ally carry a non-null
    // source_feed_id. Re-sharing them to OTHER allies would relay one ally's intel
    // to peers it never consented to — so exclude them, mirroring the bulletin
    // loop guard below (source_bulletin_id / source_organization_id).
    let reportsQuery = supabase.from('intel_reports').select('id, target_id, subject_type, threat_level, tags, summary, created_at, affiliated_org, classification_level')
        .is('source_feed_id', null);
    // Only Active/Standing warrants are shared (a Claimed/Cancelled warrant is no
    // longer an actionable bounty and must not leave the org), and never one we
    // ingested from an ally (source_feed_id loop guard). Warrants carry no
    // classification column today, so the clearance ceiling is applied
    // conservatively at level 0 in step 4 below.
    const SHAREABLE_WARRANT_STATUSES = ['Active', 'Standing'];
    let warrantsQuery = supabase.from('warrants').select('id, target_rsi_handle, reason, action, uec_reward, status, created_at')
        .is('source_feed_id', null)
        .in('status', SHAREABLE_WARRANT_STATUSES);
    let bulletinsQuery = supabase.from('intel_bulletins').select('id, title, body, threat_level, location, expires_at, classification_level, created_at')
        .gt('expires_at', new Date().toISOString())
        .is('source_bulletin_id', null)
        // Never re-share a bulletin we ingested from an ally (loop guard).
        .is('source_organization_id', null);
    if (opts.bulletinsRequireSharedFlag) bulletinsQuery = bulletinsQuery.eq('shared_with_allies', true);

    if (since) {
        reportsQuery = reportsQuery.gt('created_at', since);
        warrantsQuery = warrantsQuery.gt('created_at', since);
        bulletinsQuery = bulletinsQuery.gt('created_at', since);
    }

    // Order + cap are applied HERE, not on the builders above: .order() returns a
    // transform builder that no longer exposes .gt(), which the `since` block needs.
    // ASCENDING, not descending: under ?since= cursor semantics a DESC-truncated page
    // drops the OLDEST rows in the window while the cursor still advances past them —
    // permanent loss. ASC plus an id tiebreak is a total order, so the cap always
    // truncates the NEWEST tail, which the clamped cursor below re-serves next pull.
    const ASC = { ascending: true } as const;
    const [reportsLeg, warrantsLeg, bulletinsLeg] = await Promise.all([
        runFeedLeg(wantReports, reportsQuery.order('created_at', ASC).order('id', ASC).limit(FEED_ITEM_LIMIT), 'reports'),
        runFeedLeg(wantWarrants, warrantsQuery.order('created_at', ASC).order('id', ASC).limit(FEED_ITEM_LIMIT), 'warrants'),
        runFeedLeg(wantBulletins, bulletinsQuery.order('created_at', ASC).order('id', ASC).limit(FEED_ITEM_LIMIT), 'bulletins'),
    ]);
    const reports = reportsLeg.rows;
    const bulletins = bulletinsLeg.rows;

    // 3. Get marker associations for all fetched reports
    const reportIds = reports.map((r) => r.id);
    const excludedReportIds = new Set<string>();
    const reportMarkersMap = new Map<string, string[]>();

    if (reportIds.length > 0) {
        const associations = await fetchMarkerAssociations<{ report_id: string; marker_id: number }>(
            reportIds,
            (batch) => supabase.from('intel_report_limiting_markers').select('report_id, marker_id').in('report_id', batch),
        );

        for (const { report_id, marker_id } of associations) {
            const marker = markerMap.get(marker_id);
            // An association we cannot resolve is an UNKNOWN restriction (a marker
            // created between the two reads). Withhold rather than share the report
            // unmarked — deny-by-default, same as the sync_restricted set below.
            if (!marker) { excludedReportIds.add(report_id); continue; }

            // Reports with sync_restricted markers are excluded from the feed entirely
            if (restrictedMarkerIds.has(marker_id)) {
                excludedReportIds.add(report_id);
            } else {
                if (!reportMarkersMap.has(report_id)) reportMarkersMap.set(report_id, []);
                reportMarkersMap.get(report_id)!.push(marker.code);
            }
        }
    }

    // 3b. Get marker associations for bulletins and filter restricted ones
    const bulletinIds = bulletins.map((b) => b.id);
    const excludedBulletinIds = new Set<string>();
    const bulletinMarkersMap = new Map<string, string[]>();

    if (bulletinIds.length > 0) {
        const bAssociations = await fetchMarkerAssociations<{ bulletin_id: string; marker_id: number }>(
            bulletinIds,
            (batch) => supabase.from('intel_bulletin_limiting_markers').select('bulletin_id, marker_id').in('bulletin_id', batch),
        );

        for (const { bulletin_id, marker_id } of bAssociations) {
            const marker = markerMap.get(marker_id);
            // Unresolvable association ⇒ unknown restriction ⇒ withhold (see reports).
            if (!marker) { excludedBulletinIds.add(bulletin_id); continue; }

            if (restrictedMarkerIds.has(marker_id)) {
                excludedBulletinIds.add(bulletin_id);
            } else {
                if (!bulletinMarkersMap.has(bulletin_id)) bulletinMarkersMap.set(bulletin_id, []);
                bulletinMarkersMap.get(bulletin_id)!.push(marker.code);
            }
        }
    }

    // 4. Filter out restricted items and apply clearance threshold
    const enrichedReports = reports
        .filter((r) => intelItemPasses(r.classification_level, excludedReportIds.has(r.id), maxShareableLevel))
        .map((r) => ({ ...r, limiting_markers: reportMarkersMap.get(r.id) || [] }));

    const enrichedBulletins = bulletins
        .filter((b) => intelItemPasses(b.classification_level, excludedBulletinIds.has(b.id), maxShareableLevel))
        .map((b) => ({ ...b, limiting_markers: bulletinMarkersMap.get(b.id) || [] }));

    // Warrants carry no per-item classification column, so they are treated as
    // level 0 and pass the same intelItemPasses ceiling the reports/bulletins do.
    // This keeps the warrant leg consistent with the other channels (it can no
    // longer be a raw unfiltered passthrough) and honours a sub-zero ceiling.
    const shareableWarrants = warrantsLeg.rows
        .filter(() => intelItemPasses(0, false, maxShareableLevel));

    // Saturation: a truncated page must NOT advance the caller's cursor past rows we
    // withheld — the receiver writes _meta.fetchedAt straight into
    // alliance_peers.intel_synced_at (lib/db/intel.ts), so an unclamped cursor skips
    // the remainder for good. Only the channels the caller actually asked for count:
    // a discarded leg's saturation must not clamp the cursor the others share.
    let effectiveFetchedAt = fetchedAt;
    const saturatedLegs = [reportsLeg, warrantsLeg, bulletinsLeg].filter((l) => l.saturated);
    if (saturatedLegs.length > 0) {
        const clamped: string[] = [];
        for (const leg of saturatedLegs) {
            const cursor = clampCursor(leg.rows);
            if (cursor === null) {
                // A whole page at one created_at: the cursor cannot move forward, so
                // any page we serve silently drops the remainder. Fail closed, loudly.
                log.error('shareable-intel page cannot advance the cursor; refusing to serve a page that would silently drop the remainder', { cap: FEED_ITEM_LIMIT });
                throw new Error(FEED_UNAVAILABLE);
            }
            clamped.push(cursor);
        }
        effectiveFetchedAt = clamped.reduce((a, b) => (a < b ? a : b));
        log.warn('shareable-intel page saturated; clamping the next cursor to the last row served', { cap: FEED_ITEM_LIMIT, effectiveFetchedAt });
    }

    return {
        reports: wantReports ? enrichedReports : [],
        warrants: wantWarrants ? shareableWarrants : [],
        bulletins: wantBulletins ? enrichedBulletins : [],
        // Do NOT disclose how many classified/restricted items were withheld — the
        // before-filter totals + per-reason excluded counts told a peer/API-key
        // holder exactly how much intel exists above their share ceiling. Expose
        // only the ceiling itself.
        _meta: {
            maxShareableLevel,
            fetchedAt: effectiveFetchedAt,
        }
    };
}

// Legacy org-wide feed projection (/api/intel/feed, /api/query?target=feed).
// Org clearance ceiling + all channels. Bulletins honour the per-item "Share
// with Allies" opt-in so intended-internal bulletins don't leak to any API-key
// holder. Matches the per-peer alliance channel.
export async function getPublicFeedData(since?: string) {
    const maxClearance = await getMaxShareableClearance();
    return collectShareableIntel({
        maxClearance,
        channels: { reports: true, warrants: true, bulletins: true },
        bulletinsRequireSharedFlag: true,
        since,
    });
}

// searchGlobal / the 'system:global_search' action were removed — they called a
// Postgres RPC (global_search) absent from schema.sql, had no client caller (the
// search UI uses intel:search), and were gated only by the near-public
// 'user:manage:self' pseudo-permission (a latent ungated cross-table read).

export async function runDatabaseHealthCheck() {
    const results: Array<{ check: string; status: string; count: number | null; action?: string }> = [];

    // Schema drift. The single most common upgrade mistake is pulling new code and
    // forgetting to re-run schema.sql, which used to be invisible until a feature
    // failed oddly. schema.sql stamps settings.schema_version on every apply; this
    // compares it to what the running build expects. Read defensively - a missing
    // settings row or an absent table must report UNKNOWN, never a false DRIFT.
    try {
        const { data: verRow } = await supabase.from('settings')
            .select('value')
            .eq('key', 'schema_version')
            .maybeSingle();
        const applied = typeof verRow?.value === 'string' ? verRow.value : null;
        const cmp = compareSchemaVersion(applied);
        if (cmp.status === 'drift') {
            results.push({ check: `Schema Version (found ${cmp.applied}, expected ${cmp.expected})`, status: 'WARNING', count: null, action: 'Re-run schema.sql' });
        } else if (cmp.status === 'unknown') {
            results.push({ check: 'Schema Version (not recorded)', status: 'WARNING', count: null, action: 'Re-run schema.sql' });
        } else {
            results.push({ check: `Schema Version (${cmp.expected})`, status: 'OK', count: null });
        }
    } catch {
        results.push({ check: 'Schema Version (unreadable)', status: 'WARNING', count: null, action: 'Re-run schema.sql' });
    }

    // Secret encryption-at-rest: which key is each stored credential under? Counts only —
    // this uses the discriminator-only probe, so no live credential is ever decrypted into
    // memory on this path. Same fail-safe shape as the schema-drift block above: unreadable
    // reports a WARNING, never a false alarm and never a false all-clear.
    try {
        const inv = await inventorySecretCiphertexts();
        if (inv.noKey > 0) {
            results.push({ check: `Secret Encryption (${inv.noKey} encrypted value(s), no key configured)`, status: 'ERROR', count: inv.noKey, action: 'Set SECRETS_ENCRYPTION_KEY and restart' });
        } else if (inv.undecryptable > 0) {
            results.push({ check: `Secret Encryption (${inv.undecryptable} value(s) decrypt under NEITHER key)`, status: 'ERROR', count: inv.undecryptable, action: 'Set SECRETS_ENCRYPTION_KEY_PREVIOUS to the old key and restart' });
        } else if (inv.underPrevious > 0) {
            results.push({ check: `Secret Encryption (${inv.underPrevious} value(s) still under the previous key)`, status: 'WARNING', count: inv.underPrevious, action: 'Rotate Encryption Key' });
        } else if (hasPreviousKey()) {
            results.push({ check: `Secret Encryption (${inv.underCurrent} current; previous key no longer needed)`, status: 'WARNING', count: inv.underCurrent, action: 'Remove SECRETS_ENCRYPTION_KEY_PREVIOUS' });
        } else {
            results.push({ check: `Secret Encryption (${inv.underCurrent} value(s) current)`, status: 'OK', count: inv.underCurrent });
        }
    } catch {
        results.push({ check: 'Secret Encryption (unreadable)', status: 'WARNING', count: null });
    }

    // API-key lifecycle columns. Named individually so the operator is told WHICH columns are
    // missing rather than "something is wrong" — this is the check that turns a silent
    // federation blackout into a sentence they can act on.
    try {
        const missing = await findMissingApiKeyColumns();
        if (missing.length > 0) {
            results.push({
                check: `Database Update Required — api_keys is missing: ${missing.join(', ')}`,
                status: 'ERROR',
                count: missing.length,
                action: 'Re-run schema.sql — API key authentication is refused until you do',
            });
        } else {
            results.push({ check: 'API Key Lifecycle Columns', status: 'OK', count: null });
        }
    } catch {
        results.push({ check: 'API Key Lifecycle Columns (unreadable)', status: 'WARNING', count: null });
    }

    // Rotating the key changes computeVoterHash's output, and for a SECRET-BALLOT motion that
    // hash is the only one-vote guard. Warn only while a rotation is actually in flight, and
    // only for motions in 'Voting' — a motion at 'Open' has no votes cast yet, so it is
    // precisely the status where the risk cannot exist. Its own try/catch: a fault here must
    // not take down the whole diagnostic.
    if (hasPreviousKey()) {
        try {
            const { count: openSecret } = await supabase.from('government_motions')
                .select('id', { count: 'exact', head: true })
                .eq('is_secret_ballot', true)
                .eq('status', 'Voting');
            if (openSecret && openSecret > 0) {
                results.push({ check: 'Secret-Ballot Motions Mid-Vote During Key Change', status: 'WARNING', count: openSecret, action: 'Set BALLOT_PEPPER or conclude the vote' });
            }
        } catch { /* diagnostic only — never fail the health check on it */ }
    }

    const { count: requests } = await supabase.from('service_requests')
        .select('id', { count: 'exact', head: true })
        ;
    results.push({ check: 'Total Service Requests', status: 'OK', count: requests });

    const { count: intel } = await supabase.from('intel_reports')
        .select('id', { count: 'exact', head: true })
        ;
    results.push({ check: 'Total Intel Reports', status: 'OK', count: intel });

    const { count: invalidUsers } = await supabase.from('users')
        .select('id', { count: 'exact', head: true })
        
        .is('role_id', null)
        .is('deleted_at', null);
    if (invalidUsers && invalidUsers > 0) results.push({ check: 'Users Missing Role', status: 'WARNING', count: invalidUsers, action: 'Repairable' });
    else results.push({ check: 'User Role Integrity', status: 'OK', count: 0 });

    const { count: ops } = await supabase.from('operations')
        .select('id', { count: 'exact', head: true })
        ;
    results.push({ check: 'Total Operations Logged', status: 'OK', count: ops });

    const { count: apps } = await supabase.from('hr_applications')
        .select('id', { count: 'exact', head: true })
        ;
    results.push({ check: 'HR Case Files', status: 'OK', count: apps });

    return results;
}

export async function pruneDatabaseData(retentionDays: number, targets: string[]) {
    // Fail closed on the retention window. The cutoff is `now - retentionDays`, so a
    // value of 0 or negative (or a non-integer) pushes the cutoff to now/the future
    // and the `.lt('created_at', cutoff)` deletes would wipe EVERY matching row
    // (all service_requests / intel_reports / …). A "prune" must never become a
    // full wipe — require a positive integer day count before issuing any DELETE.
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
        throw new Error('retentionDays must be a positive integer (>= 1).');
    }
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const dateStr = cutoffDate.toISOString();
    const results: Record<string, number | null> = {};

    if (targets.includes('requests')) {
        const { count, error } = await supabase.from('service_requests').delete({ count: 'exact' }).lt('created_at', dateStr);
        if (!error) results['requests'] = count;
    }
    if (targets.includes('warrants')) {
        const { count, error } = await supabase.from('warrants').delete({ count: 'exact' }).lt('updated_at', dateStr).in('status', ['Claimed', 'Cancelled']);
        if (!error) results['warrants'] = count;
    }
    if (targets.includes('intel')) {
        const { count, error } = await supabase.from('intel_reports').delete({ count: 'exact' }).lt('created_at', dateStr);
        if (!error) results['intel'] = count;
    }
    if (targets.includes('operations')) {
        const { count, error } = await supabase.from('operations').delete({ count: 'exact' }).lt('created_at', dateStr).eq('status', 'Concluded');
        if (!error) results['operations'] = count;
    }
    if (targets.includes('hr')) {
        const { count, error } = await supabase.from('hr_applications').delete({ count: 'exact' }).lt('created_at', dateStr).in('status', ['Rejected', 'Withdrawn']);
        if (!error) results['hr'] = count;
    }
    return results;
}

// ---------------------------------------------------------------------------
// Per-feature data reset — wipes ALL rows for the feature within a single org
// back to a clean slate. Used by the Admin Console "Reset" buttons.
// ---------------------------------------------------------------------------

export async function resetFinancesData() {
    const results: Record<string, number> = {};
    // Delete ledger entries before accounts to satisfy account_id ON DELETE RESTRICT.
    {
        const { count } = await supabase.from('treasury_ledger_entries').delete({ count: 'exact' });
        results['ledger_entries'] = count || 0;
    }
    {
        const { count } = await supabase.from('treasury_accounts').delete({ count: 'exact' });
        results['accounts'] = count || 0;
    }
    broadcastToOrg('finance:reset', {});
    return results;
}

export async function resetQuartermasterData() {
    const results: Record<string, number> = {};
    // Delete in dependency order: issuances and movements both reference inventory
    // (inventory ON DELETE RESTRICT for movements; SET NULL on movements.related_issuance).
    {
        const { count } = await supabase.from('quartermaster_issuances').delete({ count: 'exact' });
        results['issuances'] = count || 0;
    }
    {
        const { count } = await supabase.from('quartermaster_inventory_movements').delete({ count: 'exact' });
        results['movements'] = count || 0;
    }
    {
        const { count } = await supabase.from('quartermaster_inventory').delete({ count: 'exact' });
        results['inventory'] = count || 0;
    }
    {
        const { count } = await supabase.from('quartermaster_locations').delete({ count: 'exact' });
        results['locations'] = count || 0;
    }
    // Only the org's own custom catalog rows — never platform rows.
    {
        const { count } = await supabase.from('quartermaster_catalog').delete({ count: 'exact' }).eq('source', 'custom');
        results['catalog'] = count || 0;
    }
    broadcastToOrg('qm:reset', {});
    return results;
}

// =============================================================================
// FULL RESET / FULL WIPE (Database Tools → Danger Zone)
// =============================================================================
// Both call the service-role-only RPC admin_truncate_all_data() (schema.sql §4.1b),
// which truncates EVERY org-data table except the code-owned `permissions`
// catalog + the `cron_locks` lease. Gated admin:access + typed confirmation in
// api/services.ts / the client.

/**
 * Wipe all org data back to a fresh install while KEEPING the acting admin
 * signed in. Capture → truncate → re-seed defaults → restore the admin with its
 * ORIGINAL user id (TRUNCATE preserves sequences, so the session JWT stays
 * valid) bound to the freshly-seeded Admin role. Structural FKs
 * (rank/unit/position/clearance) are dropped — they pointed at rows the re-seed
 * replaced. Fails closed: if the admin can't be captured first, nothing is
 * wiped (no lock-out).
 */
export async function fullResetOrg(adminUserId: number) {
    const { data: admin, error: capErr } = await supabase.from('users')
        .select('id, auth_user_id, discord_id, name, rsi_handle, avatar_url')
        .eq('id', adminUserId).single();
    if (capErr || !admin) {
        throw new Error('Could not identify the acting admin — reset aborted, no data was changed.');
    }

    const { error: wipeErr } = await supabase.rpc('admin_truncate_all_data', {});
    if (wipeErr) throw new Error(`Reset failed during wipe: ${wipeErr.message}`);

    // The in-process role cache now holds ids of roles that no longer exist.
    cache.invalidate('system_roles');
    await seedNewOrganization();
    cache.invalidate('system_roles');

    // Resolve the freshly-seeded Admin role by name (cache-free).
    const { data: adminRole } = await supabase.from('roles').select('id').eq('name', 'Admin').maybeSingle();
    if (!adminRole?.id) {
        throw new Error('Reset re-seeded defaults but no Admin role was found — restart the server to mint a fresh claim code.');
    }

    const { error: insErr } = await supabase.from('users').insert({
        id: admin.id,
        auth_user_id: admin.auth_user_id,
        discord_id: admin.discord_id,
        name: admin.name,
        rsi_handle: admin.rsi_handle,
        avatar_url: admin.avatar_url,
        role_id: adminRole.id,
        rsi_verified: true,
    });
    if (insErr) {
        throw new Error(`Reset re-seeded defaults but could not restore your admin account: ${insErr.message}. Restart the server to mint a fresh claim code.`);
    }

    // Keep the onboarding wizard away — an admin already exists.
    await supabase.from('settings').upsert({ key: 'setup_completed', value: true }, { onConflict: 'key' });
    return { ok: true, message: 'Organization reset to a fresh install. You are still signed in as Admin — reload the app to see the clean slate.' };
}

/**
 * Destroy ALL data including users + settings, leaving an empty database. Does
 * NOT re-seed: on the next server start, firstBoot finds no admin, seeds the
 * defaults, and prints a fresh one-time SETUP-XXXX claim code to the console.
 * The acting admin is logged out (their row is gone); the client shows a
 * redeploy prompt.
 */
export async function fullWipeOrg() {
    const { error } = await supabase.rpc('admin_truncate_all_data', {});
    if (error) throw new Error(`Wipe failed: ${error.message}`);
    cache.invalidate('system_roles');
    return { ok: true, message: 'All data wiped. Restart or redeploy the server now to generate a new admin claim code.' };
}
