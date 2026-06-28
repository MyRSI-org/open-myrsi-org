
import { supabase, handleSupabaseError, safeFetch, broadcastToOrg, broadcastToChannel, getSystemRoles } from './common.js';
import { cache } from '../cache.js';
import { sendPushToAll, sendPushToStaff, sendPushToPermission } from '../push.js';
import { toUnitPost, toServiceTypeConfig } from './mappers.js';
import type { Tables } from './rows.js';
import type { AIConfig, Announcement, BrandingConfig, Certification, Commendation, DiscordConfig, ExternalTool, GovernmentsFeatureConfig, HeroCardConfig, HRConfig, IntelSharingConfig, Location, OpenGraphConfig, PublicPageConfig, RadioChannel, RadioConfig, Rank, Role, ServiceTypeConfig, SpecializationTag, SystemConfig, UnitPost, WikiHomeConfig } from '../../types.js';
import { randomBytes, createHash } from 'node:crypto';
import { CLIENT_DEFAULT_PERMS } from '../clientRolePermissions.js';
import { encryptConfigSecrets, decryptConfigSecrets, encryptSecret, decryptSecret } from '../crypto.js';
import { sanitizeImageUrl, sanitizeImageUrlOrLocalPath } from '../imageUrl.js';
import { stripHtml as sharedStripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { sanitizeTiptapJson, tryParseTiptapJson } from '../tiptapValidate.js';
import { sanitizePublicLinkUrl } from '../linkUrl.js';
import { sanitizeRichHtml } from '../htmlSanitize.js';
import { log as baseLog } from '../log.js';

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
    const mergedConfig = { ...decryptedExisting, ...config };
    // Encrypt sensitive fields before storing
    const encryptedConfig = encryptConfigSecrets('discordConfig', mergedConfig);

    const { error } = await supabase.from('settings').upsert({ key: 'discordConfig', value: encryptedConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update Discord settings' });
    broadcastSettingsUpdate();
};
export const updateHeroCardConfig = async (config: Record<string, unknown>) => {
    const safeConfig = { ...(config || {}), backgroundImageUrl: sanitizeImageUrl(config?.backgroundImageUrl) || '' };
    const { error } = await supabase.from('settings').upsert({ key: 'heroCardConfig', value: safeConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update hero card config' });
    broadcastSettingsUpdate();
};
export const updateBrandingConfig = async (config: Record<string, unknown>) => {
    // termsOfService is rich HTML rendered with dangerouslySetInnerHTML on the
    // client. Sanitize on WRITE (mirrors the client's default DOMPurify) so raw
    // markup is never stored — defense in depth over the render-time DOMPurify.
    // Other branding fields are plain strings / URLs validated at their own edit
    // surfaces.
    const safeConfig = config && typeof config.termsOfService === 'string'
        ? { ...config, termsOfService: sanitizeRichHtml(config.termsOfService) }
        : config;
    const { error } = await supabase.from('settings').upsert({ key: 'brandingConfig', value: safeConfig }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update branding config' });
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
export const updateWikiHomeConfig = async (config: Partial<WikiHomeConfig>) => { const { error } = await supabase.from('settings').upsert({ key: 'wikiHomeConfig', value: config }, { onConflict: 'key' }); handleSupabaseError({ error, message: 'Failed to update wiki home config' }); broadcastSettingsUpdate(); };

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
    const { data } = await supabase.from('settings').select('value').eq('key', 'orgFeatures').maybeSingle();
    return (data?.value as Record<string, unknown>) || {};
};

export const updateOrgFeatures = async (patch: Record<string, unknown>) => {
    const { data } = await supabase.from('settings').select('value').eq('key', 'orgFeatures').maybeSingle();
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

export const updateSystemConfig = async (config: Record<string, unknown>) => {
    const sanitizedUrl = config.appUrl ? (config.appUrl as string).replace(/\/+$/, '') : '';
    const { error } = await supabase.from('settings').upsert({ key: 'systemConfig', value: { ...config, appUrl: sanitizedUrl } }, { onConflict: 'key' });
    handleSupabaseError({ error, message: 'Failed to update system config' });
    broadcastSettingsUpdate();
};

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

    // Validate the target role exists BEFORE rewriting its permissions — the
    // delete-leg would otherwise run unchecked against a phantom/forged id.
    const { data: role } = await supabase.from('roles').select('id').eq('id', id).maybeSingle();
    if (!role) throw new Error('Role not found.');

    const { data: perms } = await supabase.from('permissions').select('id, name').in('name', permissionNames);
    const permIds = perms?.map(p => p.id) || [];
    await supabase.from('role_permissions').delete().eq('role_id', id);
    if (permIds.length > 0) await supabase.from('role_permissions').insert(permIds.map(pid => ({ role_id: id, permission_id: pid })));
}

export async function createApiKey(label: string) {
    const key = `sk_${randomBytes(12).toString('base64url')}`;
    const hash = createHash('sha256').update(key).digest('hex');
    const { data } = await supabase.from('api_keys').insert({ label, key_hash: hash }).select('id, label, created_at, last_used_at').single();
    // Return the raw key ONCE — it cannot be recovered after this response. Select
    // explicit columns so the key_hash never rides the response back to the
    // browser (defence-in-depth; it's a SHA-256 hash, not the key, but it has no
    // business leaving the server).
    return { ...data, rawKey: key, keyPrefix: `${key.substring(0, 7)}****` };
}

export async function listApiKeys() {
    const query = supabase.from('api_keys').select('id, label, created_at, last_used_at').order('created_at', { ascending: false });

    type ApiKeyListRow = Pick<Tables<'api_keys'>, 'id' | 'label' | 'created_at' | 'last_used_at'>;
    const data = await safeFetch<ApiKeyListRow[]>(query, [], 'Failed to list API keys');
    return data.map((k) => ({ ...k, keyPrefix: 'sk_****' }));
}

export async function deleteApiKey(id: string) {
    await supabase.from('api_keys').delete().eq('id', id);
}

// Intel feeds are now rows in the unified alliance_peers table, discriminated by
// pairing_state ('legacy' = backfilled, 'manual' = added here). A feed is a
// one-directional intel subscription (we hold a key to pull from the peer). The
// admin UI still speaks the old snake_case feed shape, so these map to/from it.
const FEED_PAIRING_STATES = ['legacy', 'manual'];

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
    await supabase.from('alliance_peers').delete().eq('id', id);
    broadcastSettingsUpdate();
}
export async function updateTrustedFeed(id: string, updates: { syncReports?: boolean; syncWarrants?: boolean; syncBulletins?: boolean; inboundMaxClearance?: number }) {
    const dbUpdates: Record<string, unknown> = {};
    // channels is a jsonb blob — merge against the existing value so a single
    // toggle doesn't wipe the others.
    if (updates.syncReports !== undefined || updates.syncWarrants !== undefined || updates.syncBulletins !== undefined) {
        const { data: existing } = await supabase.from('alliance_peers').select('channels').eq('id', id).maybeSingle();
        const channels = { ...(existing?.channels || {}) } as Record<string, boolean>;
        if (updates.syncReports !== undefined) channels.reports = updates.syncReports;
        if (updates.syncWarrants !== undefined) channels.warrants = updates.syncWarrants;
        if (updates.syncBulletins !== undefined) channels.bulletins = updates.syncBulletins;
        dbUpdates.channels = channels;
    }
    if (updates.inboundMaxClearance !== undefined) dbUpdates.inbound_max_clearance = updates.inboundMaxClearance;
    if (Object.keys(dbUpdates).length > 0) {
        dbUpdates.updated_at = new Date().toISOString();
        await supabase.from('alliance_peers').update(dbUpdates).eq('id', id);
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

        // Use getSystemRoles helper for all subsequent lookups (works with renamed roles)
        const repairedRoles = await getSystemRoles();

        // Fix Client role: strip any permissions beyond the canonical defaults
        const ALLOWED_CLIENT_PERMS = CLIENT_DEFAULT_PERMS;
        const clientRole = repairedRoles.client;
        if (clientRole) {

            const { data: clientRolePerms } = await supabase.from('role_permissions')
                .select('permission_id, permissions!inner(name)')
                .eq('role_id', clientRole.id);

            const excessPermIds = (clientRolePerms as Array<{ permission_id: number; permissions: { name: string } }> | null || [])
                .filter((rp) => !ALLOWED_CLIENT_PERMS.includes(rp.permissions.name))
                .map((rp) => rp.permission_id);

            if (excessPermIds.length > 0) {
                log.info('repair stripping excess permissions from client role', { count: excessPermIds.length });
                await supabase.from('role_permissions')
                    .delete()
                    .eq('role_id', clientRole.id)
                    .in('permission_id', excessPermIds);
            }
        }

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

    return { success: true, message: "Database repair complete." };
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
    await supabase.from('user_certifications').insert({ user_id: userId, certification_id: certId, awarded_by: adminId });
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
 * top, then verifies each target user exists before insert. Allows duplicate
 * grants (matches single-user `awardCertification` — schema has no UNIQUE).
 * Capped at 100 targets per call; client chunks at 25.
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
            const { error } = await supabase.from('user_certifications').insert({
                user_id: userId, certification_id: certificationId, awarded_by: adminId,
            });
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
        .order('created_at', { ascending: false })
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

export async function addRole(data: Partial<Role>) { await supabase.from('roles').insert({ name: data.name, description: data.description}); }
export async function updateRole(data: Partial<Role>) {
    const id = data.id as number;
    const { data: existing } = await supabase.from('roles').select('name, is_system').eq('id', id).single();
    if (existing?.is_system && data.name && data.name.trim() !== existing.name) {
        throw new Error('System roles cannot be renamed.');
    }
    await supabase.from('roles').update({ name: data.name, description: data.description }).eq('id', id);
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

export async function broadcastEAM(message: string) {
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
        notifyDiscordEam(message, eamData.timestamp),
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

async function notifyDiscordEam(message: string, timestamp: string) {
    try {
        const { data: settingsData } = await supabase.from('settings')
            .select('key, value')
            
            .in('key', ['discordConfig', 'brandingConfig']);
        type EamSettings = {
            discordConfig?: { eamChannelId?: string };
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
        const { sendDiscordChannelMessage } = await import('../discord.js');
        await sendDiscordChannelMessage(channelId, { content: '@here', embeds: [embed], allowed_mentions: { parse: ['everyone'] } });
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

export async function addRadioChannel(data: Partial<RadioChannel> & { sort_order?: number }) { const { error } = await supabase.from('radio_channels').insert({ id: data.id, name: data.name, color: data.color, type: data.type, sort_order: data.sort_order || 0}); handleSupabaseError({ error, message: 'Failed to add radio channel' }); }
export async function updateRadioChannel(id: string, name: string, color: string, sort_order?: number) { const updates: Record<string, unknown> = { name, color }; if (sort_order !== undefined) updates.sort_order = sort_order; const { error } = await supabase.from('radio_channels').update(updates).eq('id', id); handleSupabaseError({ error, message: 'Failed to update radio channel' }); }
export async function deleteRadioChannel(id: string) {
    const { error } = await supabase.from('radio_channels').delete().eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete radio channel' });
}

export async function verifyApiKey(key: string) {
    // All keys (manual + alliance) are stored as SHA-256 hashes and verified by
    // hash only — there is no plaintext fallback, so keys that predate hashing
    // must be re-issued. Revocation is by row deletion (api:delete_key), so a
    // revoked key no longer matches.
    if (typeof key !== 'string' || !key) return null;
    const hash = createHash('sha256').update(key).digest('hex');
    // Return the label too so callers can tell a manual feed key from an alliance
    // key (labelled "alliance:<peerId>"). Both live in api_keys and verify the same
    // way, so without the label the legacy feed couldn't tell them apart and an
    // alliance key would skip the per-peer limits (the feed endpoint checks this).
    const { data } = await supabase.from('api_keys').select('id, label').eq('key_hash', hash).maybeSingle();
    if (data) {
        await supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
        return data;
    }
    return null;
}

// Org-wide outbound clearance ceiling (settings: intelSharingConfig). 0 = only
// unclassified. Shared by the legacy feed and the per-peer alliance channel.
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
    const { data: allMarkers } = await supabase.from('security_limiting_markers').select('id, code, sync_restricted');
    type MarkerRow = { id: string; code: string; sync_restricted: boolean | null };
    const markerRows = (allMarkers || []) as MarkerRow[];
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

    const [reportsResult, warrantsResult, bulletinsResult] = await Promise.all([reportsQuery, warrantsQuery, bulletinsQuery]);
    const reports = reportsResult.data || [];
    const bulletins = bulletinsResult.data || [];

    // 3. Get marker associations for all fetched reports
    const reportIds = reports.map((r) => r.id);
    const excludedReportIds = new Set<string>();
    const reportMarkersMap = new Map<string, string[]>();

    if (reportIds.length > 0) {
        const { data: associations } = await supabase.from('intel_report_limiting_markers')
            .select('report_id, marker_id')
            .in('report_id', reportIds);

        for (const { report_id, marker_id } of (associations || []) as Array<{ report_id: string; marker_id: string }>) {
            const marker = markerMap.get(marker_id);
            if (!marker) continue;

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
        const { data: bAssociations } = await supabase.from('intel_bulletin_limiting_markers')
            .select('bulletin_id, marker_id')
            .in('bulletin_id', bulletinIds);

        for (const { bulletin_id, marker_id } of (bAssociations || []) as Array<{ bulletin_id: string; marker_id: string }>) {
            const marker = markerMap.get(marker_id);
            if (!marker) continue;

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
    const shareableWarrants = (warrantsResult.data || [])
        .filter((w) => intelItemPasses(0, false, maxShareableLevel));

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
            fetchedAt,
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
