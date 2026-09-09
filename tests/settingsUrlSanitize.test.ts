import { describe, it, expect, vi, beforeEach } from 'vitest';

// Write-boundary validation for the two branding config writers, both gated on the
// DELEGABLE admin:config:branding perm rather than Admin:
//
//   updateHeroCardConfig  — discordUrl / organizationUrl are rendered straight into
//     <a href> on the dashboard hero card (components/ui/HeroCard.tsx:27,36).
//   updateBrandingConfig  — iconUrl reaches the SSR <link rel=icon>, the boot splash,
//     the PWA manifest, the service worker, the UNAUTHENTICATED public page and the
//     outbound Discord embed icon_url; the seven audio *Url fields are fetched by
//     lib/audioCache.ts prefetchSound() (sets .src + .load()) with no user gesture, so
//     an attacker-chosen host harvests every member's IP + User-Agent at boot.
//
// Both used to spread the payload and sanitize only ONE field, so everything else was
// persisted verbatim. The contract pinned here:
//   - an empty value CLEARS the field (''), and
//   - a value the sanitizer refuses is REJECTED, not silently blanked — both editors
//     re-send the WHOLE config object and the upsert replaces the whole `value`, so a
//     silent clear would destroy a working icon/chime as a side effect of saving an
//     unrelated field. A throw refuses the write and leaves the stored value intact.
//
// The sanitizer CHOICE is load-bearing and pinned below: iconUrl needs the
// OrLocalPath variant (the shipped default is the same-origin '/media/cross-swords.png'),
// and the sound fields need sanitizePublicLinkUrl (they are .mp3 URLs — an image
// sanitizer's extension allow-list would blank every seeded chime).

const h = vi.hoisted(() => ({
    upserts: [] as Array<{ key: string; value: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder() {
        let lastUpsert: Record<string, unknown> | null = null;
        const b: any = {};
        b.select = () => b;
        b.eq = () => b;
        b.upsert = (value: Record<string, unknown>) => { lastUpsert = value; return b; };
        b.maybeSingle = () => Promise.resolve({ data: null, error: null });
        b.single = () => Promise.resolve({ data: null, error: null });
        b.then = (resolve: any, reject: any) => {
            if (lastUpsert) {
                const v = lastUpsert as { key: string; value: Record<string, unknown> };
                h.upserts.push({ key: v.key, value: v.value });
            }
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        };
        return b;
    }
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import { updateBrandingConfig, updateHeroCardConfig } from '../lib/db/system';

// The seeded shipped defaults (lib/db/seeder.ts) — none of them may be refused.
const SEEDED_ICON = '/media/cross-swords.png';
const SEEDED_SOUND = 'https://www.myinstants.com/media/sounds/rto.mp3';

// Every audio field on BrandingConfig. Iterated rather than spelled out per-test, so a
// field added later without a sanitizer fails here.
const SOUND_FIELDS = [
    'bootSoundUrl', 'newRequestSoundUrl', 'assignmentSoundUrl',
    'eamSoundUrl', 'radioMicCueUrl', 'radioSquelchUrl', 'notificationSoundUrl',
] as const;

const persisted = (key: string) => h.upserts.find(u => u.key === key)?.value ?? {};

beforeEach(() => { h.upserts = []; });

describe('updateHeroCardConfig — <a href> write boundary', () => {
    it.each([
        'javascript:alert(1)',
        'http://example.com',
        'data:text/html,<script>alert(1)</script>',
        'https://127.0.0.1/x',
        'https://localhost/admin',
        'https://box.internal/panel',
        'https://user:pass@example.com/',
    ])('refuses %s as a discordUrl, persisting nothing', async (bad) => {
        await expect(updateHeroCardConfig({ discordUrl: bad, organizationUrl: '' })).rejects.toThrow(/discordUrl/);
        expect(h.upserts).toHaveLength(0);
    });

    it('refuses the same values on organizationUrl', async () => {
        await expect(updateHeroCardConfig({ discordUrl: '', organizationUrl: 'javascript:alert(1)' }))
            .rejects.toThrow(/organizationUrl/);
        expect(h.upserts).toHaveLength(0);
    });

    it('keeps public https and discord: hrefs verbatim, and empty means cleared', async () => {
        await updateHeroCardConfig({
            discordUrl: 'https://discord.gg/abc',
            organizationUrl: 'https://robertsspaceindustries.com/orgs/ACME',
            title: 'T',
        });
        const v = persisted('heroCardConfig');
        expect(v.discordUrl).toBe('https://discord.gg/abc');
        expect(v.organizationUrl).toBe('https://robertsspaceindustries.com/orgs/ACME');
        expect(v.title).toBe('T');

        h.upserts = [];
        await updateHeroCardConfig({ discordUrl: 'discord://invite/abc', organizationUrl: undefined });
        const v2 = persisted('heroCardConfig');
        expect(v2.discordUrl).toBe('discord://invite/abc');
        expect(v2.organizationUrl).toBe('');
    });

    it('still silently clears a bad backgroundImageUrl (unchanged contract) and keeps a good one', async () => {
        await updateHeroCardConfig({ backgroundImageUrl: 'https://evil.example/not-an-image', discordUrl: '', organizationUrl: '' });
        expect(persisted('heroCardConfig').backgroundImageUrl).toBe('');
        h.upserts = [];
        await updateHeroCardConfig({ backgroundImageUrl: 'https://cdn.example/bg.webp', discordUrl: '', organizationUrl: '' });
        expect(persisted('heroCardConfig').backgroundImageUrl).toBe('https://cdn.example/bg.webp');
    });
});

describe('updateBrandingConfig — icon + audio write boundary', () => {
    it.each(SOUND_FIELDS)('refuses an http:// host on %s', async (field) => {
        await expect(updateBrandingConfig({ name: 'Org', [field]: 'http://evil.example/a.mp3' }))
            .rejects.toThrow(new RegExp(field));
        expect(h.upserts).toHaveLength(0);
    });

    it.each(SOUND_FIELDS)('accepts the seeded default on %s verbatim', async (field) => {
        await updateBrandingConfig({ name: 'Org', [field]: SEEDED_SOUND });
        // Load-bearing: an image sanitizer here would blank every shipped chime.
        expect(persisted('brandingConfig')[field]).toBe(SEEDED_SOUND);
    });

    it('refuses a private-host / javascript: sound URL', async () => {
        await expect(updateBrandingConfig({ eamSoundUrl: 'https://192.168.1.5/a.mp3' })).rejects.toThrow(/eamSoundUrl/);
        await expect(updateBrandingConfig({ eamSoundUrl: 'javascript:alert(1)' })).rejects.toThrow(/eamSoundUrl/);
        expect(h.upserts).toHaveLength(0);
    });

    it('treats an empty sound field as cleared, not refused', async () => {
        await updateBrandingConfig({ bootSoundUrl: '', eamSoundUrl: null });
        const v = persisted('brandingConfig');
        expect(v.bootSoundUrl).toBe('');
        expect(v.eamSoundUrl).toBe('');
    });

    it('keeps the seeded same-origin iconUrl verbatim', async () => {
        // Load-bearing: fails if the strict https-only sanitizeImageUrl is used here
        // instead of sanitizeImageUrlOrLocalPath — that would blank the default logo of
        // every deployment on the next branding save.
        await updateBrandingConfig({ name: 'Org', iconUrl: SEEDED_ICON });
        expect(persisted('brandingConfig').iconUrl).toBe(SEEDED_ICON);
    });

    it('keeps a valid https iconUrl verbatim (incl. the uploaded-media .webp shape)', async () => {
        await updateBrandingConfig({ iconUrl: 'https://cdn.example/logo.webp' });
        expect(persisted('brandingConfig').iconUrl).toBe('https://cdn.example/logo.webp');
    });

    it.each([
        'javascript:alert(1)',
        'http://cdn.example/a.png',
        '//evil.example/a.png',
        '/etc/passwd.png',
        '/media/../../etc/passwd.png',
        'https://cdn.example/tracker',
    ])('refuses %s as an iconUrl, persisting nothing', async (bad) => {
        await expect(updateBrandingConfig({ name: 'Org', iconUrl: bad })).rejects.toThrow(/iconUrl/);
        expect(h.upserts).toHaveLength(0);
    });

    it('treats an empty iconUrl as cleared (every read site falls back to /icon.svg)', async () => {
        await updateBrandingConfig({ iconUrl: '' });
        expect(persisted('brandingConfig').iconUrl).toBe('');
    });

    it('sanitizes a NON-STRING termsOfService instead of spreading it through', async () => {
        // An array of markup used to skip the `typeof === 'string'` ternary entirely, and
        // String(['<img …onerror>']) is live markup.
        await updateBrandingConfig({ termsOfService: ['<img src=x onerror=alert(1)>'] });
        const v = persisted('brandingConfig');
        expect(v.termsOfService).toBe('');
        expect(Array.isArray(v.termsOfService)).toBe(false);
    });

    it('still strips dangerous markup from a string termsOfService', async () => {
        await updateBrandingConfig({ termsOfService: '<p>ok</p><script>alert(1)</script>' });
        const tos = persisted('brandingConfig').termsOfService as string;
        expect(tos).not.toMatch(/<script/i);
        expect(tos).toContain('ok');
    });

    it('drops an invalid themeColor and normalises a valid one', async () => {
        await updateBrandingConfig({ themeColor: 'red;}body{display:none}' });
        expect('themeColor' in persisted('brandingConfig')).toBe(false);
        h.upserts = [];
        await updateBrandingConfig({ themeColor: '#0EA5E9' });
        expect(persisted('brandingConfig').themeColor).toBe('#0EA5E9');
    });

    it('leaves absent keys absent — a partial save cannot inject an empty icon or chime', async () => {
        await updateBrandingConfig({ name: 'Org' });
        const v = persisted('brandingConfig');
        expect(v).toEqual({ name: 'Org' });
    });
});
