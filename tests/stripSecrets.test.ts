import { describe, it, expect } from 'vitest';
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

    it('is STRING-guarded — never nulls non-string values whose key looks secret-bearing', () => {
        const out = stripSecrets({
            webhook_endpoints: [{ id: 1 }, { id: 2 }],   // array preserved
            api_key_rotation: { enabled: true },          // object preserved
            token_count: 5,                               // number preserved
        });
        expect(out.webhook_endpoints).toEqual([{ id: 1 }, { id: 2 }]);
        expect(out.api_key_rotation).toEqual({ enabled: true });
        expect(out.token_count).toBe(5);
    });
});
