import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripSecrets } from '../api/query';

// Guards the secret-stripping on the client-facing state payload — including the
// admin_setup_code leak (org-Admin takeover) found in the warrant-data audit.
describe('stripSecrets', () => {
    it('removes the one-time admin_setup_code from the settings blob', () => {
        const out = stripSecrets({ admin_setup_code: { code: 'SETUP-DEADBEEF', created_at: 'now' }, foo: 1 });
        expect(out.admin_setup_code).toBeUndefined();
        expect(out.foo).toBe(1); // benign fields preserved
    });

    it('strips integration secrets but keeps the public bits', () => {
        const out = stripSecrets({
            geminiKey: 'raw-gemini',
            discordConfig: { botToken: 'secret-bot', clientId: 'cid', newRequestChannelId: 'ch' },
            aiConfig: { apiKey: 'secret-ai', model: 'gemini' },
            radioConfig: { apiKey: 'lk-key', apiSecret: 'lk-secret', url: 'wss://x', someFlag: true },
        });
        expect(out.geminiKey).toBeUndefined();
        expect(out.discordConfig.botToken).toBeUndefined();
        expect(out.discordConfig.clientId).toBe('cid');
        expect(out.aiConfig.apiKey).toBeUndefined();
        expect(out.aiConfig.model).toBe('gemini');
        expect(out.radioConfig.apiKey).toBeUndefined();
        expect(out.radioConfig.apiSecret).toBeUndefined();
        expect(out.radioConfig.url).toBeUndefined();
        expect(out.radioConfig.configured).toBe(true);
    });

    it('aiConfig is rebuilt from an allowlist — an unexpected (future secret-ish) field drops by default', () => {
        const out = stripSecrets({
            aiConfig: { enabled: true, model: 'gemini', apiKey: 'secret-ai', orgSecretToken: 'should-not-leak', endpoint: 'https://x' },
        });
        expect(out.aiConfig).toEqual({ enabled: true, model: 'gemini' });
        expect(out.aiConfig.apiKey).toBeUndefined();
        expect(out.aiConfig.orgSecretToken).toBeUndefined();
        expect(out.aiConfig.endpoint).toBeUndefined();
    });

    // Pattern-based failsafe: getAllSettings overlays EVERY settings row by key,
    // so a FUTURE secret-bearing setting would ride the state by default. Any
    // top-level STRING key that looks secret-bearing is dropped.
    it('drops a future top-level secret-named string setting by default', () => {
        const out = stripSecrets({
            some_service_api_key: 'sk-leak',
            partner_webhook_url: 'https://hooks.example/secret',
            billing_secret: 'whsec_leak',
            smtp_password: 'hunter2',
            session_token: 'tok-leak',
            orgName: 'Acme', // benign string preserved
        });
        expect(out.some_service_api_key).toBeUndefined();
        expect(out.partner_webhook_url).toBeUndefined();
        expect(out.billing_secret).toBeUndefined();
        expect(out.smtp_password).toBeUndefined();
        expect(out.session_token).toBeUndefined();
        expect(out.orgName).toBe('Acme');
    });

    it('platformSettings is rebuilt from an allowlist — keeps the typed fields, drops a future nested secret', () => {
        const out = stripSecrets({
            platformSettings: {
                maintenance_mode: true,
                maintenance_message: 'Back at 9',
                support_discord_url: 'https://discord.gg/x',
                force_logout_timestamp: '2026-06-21T00:00:00.000Z',
                support_api_key: 'sk-should-not-leak',   // future nested secret
                webhook_secret: 'whsec-leak',
                internal_flag: { hidden: true },
            },
        });
        expect(out.platformSettings).toEqual({
            maintenance_mode: true,
            maintenance_message: 'Back at 9',
            support_discord_url: 'https://discord.gg/x',
            force_logout_timestamp: '2026-06-21T00:00:00.000Z',
        });
        expect(out.platformSettings.support_api_key).toBeUndefined();
        expect(out.platformSettings.webhook_secret).toBeUndefined();
        expect(out.platformSettings.internal_flag).toBeUndefined();
    });

    it('platformSettings boot projection (maintenance only) is unchanged by the allowlist', () => {
        const out = stripSecrets({ platformSettings: { maintenance_mode: false, maintenance_message: null } });
        expect(out.platformSettings).toEqual({ maintenance_mode: false, maintenance_message: null });
    });

    it('is STRING-guarded — never nulls non-string values whose key does NOT match the secret pattern', () => {
        const out = stripSecrets({
            webhook_endpoints: [{ id: 1 }, { id: 2 }],   // array preserved (key not underscore-anchored)
            api_key_rotation: { enabled: true },          // object preserved
            token_count: 5,                               // number preserved (no _token)
        });
        expect(out.webhook_endpoints).toEqual([{ id: 1 }, { id: 2 }]);
        expect(out.api_key_rotation).toEqual({ enabled: true });
        expect(out.token_count).toBe(5);
    });

    it('recursively drops secret-named scalar values at any depth, keeping safe siblings (G6)', () => {
        const out: any = stripSecrets({
            nested: { inner: { discord_webhook: 'https://hooks/xxx', keep_me: 'visible' } },
            list: [{ smtp_password: 'p', label: 'A' }],
            rotation_secret: 999,   // number with a matching key — now dropped too
            note_token: 7,          // _token matches → dropped
        });
        expect(out.nested.inner.discord_webhook).toBeUndefined();
        expect(out.nested.inner.keep_me).toBe('visible');
        expect(out.list[0].smtp_password).toBeUndefined();
        expect(out.list[0].label).toBe('A');
        expect(out.rotation_secret).toBeUndefined();
        expect(out.note_token).toBeUndefined();
    });

    // The outbound intel-federation ceiling rides the settings blob to every
    // authenticated member on `main` and `initial-state`. Nothing in the bundle
    // renders it (the Admin console reads it via admin:get_intel_sharing_config),
    // so it is dropped at the wire.
    it('deletes intelSharingConfig — the outbound federation ceiling never reaches a member', () => {
        const out = stripSecrets({
            intelSharingConfig: { maxShareableClearance: 3 },
            brandingConfig: { name: 'Jims Org', iconUrl: '/icon.svg' },
        });
        expect(out.intelSharingConfig).toBeUndefined();
        // Not collateral damage on the rest of the settings blob.
        expect(out.brandingConfig).toEqual({ name: 'Jims Org', iconUrl: '/icon.svg' });
    });

    it('the unconditional delete is what removes it — the key-name scrub never would', () => {
        // maxShareableClearance: 0 so a truthiness-based fix would not pass, and
        // neither `intelSharingConfig` nor `maxShareableClearance` matches SECRET_KEY.
        const out = stripSecrets({ intelSharingConfig: { maxShareableClearance: 0 }, dutyTimeoutMinutes: 30 });
        expect(out.intelSharingConfig).toBeUndefined();
        expect(out.dutyTimeoutMinutes).toBe(30);
    });

    // --- Phase 3 item 8: the two named deletes behind the settings allow-list ---
    //
    // Both are REDUNDANT on the three merged payloads now that
    // projectSettingsForViewer (lib/settingsProjection.ts) allow-lists the blob one layer
    // earlier. They are kept deliberately, as the belt to the projection's braces: a
    // future FOURTH merge site that forgets the projection still cannot ship these two.
    // The ratchet at the bottom of this file is what makes removing one a decision
    // rather than an accident.

    it('deletes system_broadcast — the last org tasking never rides the settings blob', () => {
        // broadcastSystemAlert persists the org's last org-wide tasking to a settings row,
        // so a permanently-stale copy of the message body rode `main` / `initial-state` to
        // every authenticated member, a Client included. Nothing READS the key: the live
        // delivery path is the auth-alerts broadcast that SessionContext consumes.
        const out = stripSecrets({
            system_broadcast: { message: 'FLASH — all hands', id: '1' },
            brandingConfig: { name: 'Jims Org', iconUrl: '/icon.svg' },
        });
        expect(out.system_broadcast).toBeUndefined();
        expect(out.brandingConfig).toEqual({ name: 'Jims Org', iconUrl: '/icon.svg' });
    });

    it('the unconditional delete is what removes system_broadcast — the key-name scrub never would', () => {
        // Falsy scalars so a truthiness-based fix fails, and no
        // _api_key|_secret|_password|_webhook|_token substring anywhere in the payload.
        const out = stripSecrets({ system_broadcast: { message: '', id: '' }, dutyTimeoutMinutes: 30 });
        expect(out.system_broadcast).toBeUndefined();
        expect(out.dutyTimeoutMinutes).toBe(30);
    });

    it('deletes orgFeatures — the duplicate module map — while orgMeta.features survives', () => {
        // A DUPLICATE, not a secret. orgMeta.features is the authoritative module map and
        // is deliberately kept for EVERY caller (HelpView is Client-reachable and reads
        // it); this is the raw settings row it is built from, riding the blob a second
        // time under its storage key with no consumer at all. Both directions pinned: the
        // duplicate goes, the authoritative copy stays.
        const out = stripSecrets({
            orgFeatures: { academy: { enabled: true } },
            orgMeta: { features: { academy: { enabled: true } } },
        });
        expect(out.orgFeatures).toBeUndefined();
        expect(out.orgMeta).toEqual({ features: { academy: { enabled: true } } });
    });

    it('the unconditional delete is what removes orgFeatures', () => {
        const out = stripSecrets({ orgFeatures: { academy: { enabled: false } }, dutyTimeoutMinutes: 30 });
        expect(out.orgFeatures).toBeUndefined();
        expect(out.dutyTimeoutMinutes).toBe(30);
    });

    it('RATCHET — the delete list is a superset of the named set', () => {
        // Superset, not equality, so a future delete does not need this test edited — but
        // REMOVING one fails CI. The two item-8 entries are the ones most likely to look
        // deletable to a later reader, precisely because the allow-list makes them
        // redundant on today's three paths.
        const src = readFileSync(join(process.cwd(), 'api/query.ts'), 'utf8');
        const deleted = new Set(
            [...src.matchAll(/delete\s+cleaned\.([A-Za-z_][A-Za-z0-9_]*)\s*;/g)].map(m => m[1]),
        );
        for (const key of ['geminiKey', 'allianceLocalPairingCode', 'admin_setup_code', 'active_eam',
            'intelSharingConfig', 'role_permission_backfills', 'systemConfig',
            'system_broadcast', 'orgFeatures']) {
            expect(deleted.has(key), `delete cleaned.${key} is missing from stripSecrets`).toBe(true);
        }
    });
});
