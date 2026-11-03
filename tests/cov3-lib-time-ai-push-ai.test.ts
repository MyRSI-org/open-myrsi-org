// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/ai.ts — the two Gemini one-shot calls (dossier summary, AAR draft). Pinned here:
//   - config read is an explicit two-key projection of `settings`, fail-closed on error;
//   - disabled AI / missing key short-circuit BEFORE any SDK client is built;
//   - the API key reaches only the SDK constructor — never a log line or the prompt;
//   - prompt construction (fallbacks, grouping, truncation) and model-name migration;
//   - response parsing (fenced JSON, prose fallback, empty draft);
//   - error mapping to curated messages, never the raw third-party error text.

const h = vi.hoisted(() => ({
    ctor: vi.fn(),
    generate: vi.fn(),
    getOrgSecret: vi.fn(),
    saveDossierSummary: vi.fn(),
    settingsResult: { data: null as unknown, error: null as unknown },
    reads: [] as Array<{ table: string; select?: unknown; in?: unknown[] }>,
    logs: [] as Array<{ level: string; msg: string; fields?: Record<string, unknown> }>,
}));

vi.mock('@google/genai', () => ({
    GoogleGenAI: class {
        models = { generateContent: h.generate };
        constructor(opts: unknown) { h.ctor(opts); }
    },
}));

vi.mock('../lib/db', () => ({
    supabase: {
        from: (table: string) => {
            const rec: { table: string; select?: unknown; in?: unknown[] } = { table };
            h.reads.push(rec);
            const b = {
                select: (cols: unknown) => { rec.select = cols; return b; },
                in: (...args: unknown[]) => { rec.in = args; return Promise.resolve(h.settingsResult); },
            };
            return b;
        },
    },
    saveDossierSummary: h.saveDossierSummary,
}));

vi.mock('../lib/secrets', () => ({ getOrgSecret: h.getOrgSecret }));

vi.mock('../lib/log', () => {
    const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const logger = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => logger };
    return { log: logger };
});

import { generateDossierSummary, generateAARSummary, GEMINI_TIMEOUT_MS } from '../lib/ai';
import type { DossierData } from '../types';

const KEY = 'AIzaSy-test-secret-key-value-0001';

const settingsRows = (aiConfig: unknown, brandingConfig?: unknown) => {
    const rows: Array<{ key: string; value: unknown }> = [{ key: 'aiConfig', value: aiConfig }];
    if (brandingConfig !== undefined) rows.push({ key: 'brandingConfig', value: brandingConfig });
    return { data: rows, error: null };
};

const dossier = (over: Partial<DossierData> = {}): DossierData => ({ targetId: 'TGT-1', ...over } as DossierData);

const lastPrompt = () => String(h.generate.mock.calls.at(-1)![0].contents);
const lastModel = () => h.generate.mock.calls.at(-1)![0].model;

/** True if `needle` appears anywhere in the recorded log records (deep, incl. Error message/stack). */
const logsContain = (needle: string) => {
    const seen = new Set<unknown>();
    const walk = (v: unknown): boolean => {
        if (typeof v === 'string') return v.includes(needle);
        if (v && typeof v === 'object') {
            if (seen.has(v)) return false;
            seen.add(v);
            if (v instanceof Error && (walk(v.message) || walk(v.stack))) return true;
            return Object.values(v as Record<string, unknown>).some(walk);
        }
        return false;
    };
    return h.logs.some(r => walk(r.msg) || walk(r.fields));
};

const apiError = (props: Record<string, unknown>) => Object.assign(new Error(String(props.message ?? '')), props);

beforeEach(() => {
    h.ctor.mockReset();
    h.generate.mockReset();
    h.getOrgSecret.mockReset().mockResolvedValue(KEY);
    h.saveDossierSummary.mockReset().mockResolvedValue(undefined);
    h.settingsResult = settingsRows({ enabled: true }, { name: 'Test Org' });
    h.reads = [];
    h.logs = [];
});

describe('generateDossierSummary — configuration and credentials', () => {
    it('reads exactly the aiConfig + brandingConfig settings with an explicit projection', async () => {
        h.generate.mockResolvedValue({ text: 'ok' });
        await generateDossierSummary(dossier());
        expect(h.reads).toEqual([{ table: 'settings', select: 'key, value', in: ['key', ['aiConfig', 'brandingConfig']] }]);
    });

    it('FAILS CLOSED on a settings read error (even alongside stale rows): no key lookup, no SDK client', async () => {
        h.settingsResult = { data: settingsRows({ enabled: true }).data, error: { code: '08006', message: 'connection failure' } };
        await expect(generateDossierSummary(dossier())).resolves.toBe('Error: Could not retrieve system configuration.');
        expect(h.getOrgSecret).not.toHaveBeenCalled();
        expect(h.ctor).not.toHaveBeenCalled();
        expect(h.logs).toContainEqual({ level: 'error', msg: 'failed to fetch settings', fields: { err: { code: '08006', message: 'connection failure' } } });
    });

    it('FAILS CLOSED when the settings read returns no rows object', async () => {
        h.settingsResult = { data: null, error: null };
        await expect(generateDossierSummary(dossier())).resolves.toBe('Error: Could not retrieve system configuration.');
        expect(h.ctor).not.toHaveBeenCalled();
    });

    it('refuses when AI is disabled (or unconfigured) before touching the key', async () => {
        for (const cfg of [{ enabled: false }, null]) {
            h.settingsResult = settingsRows(cfg);
            await expect(generateDossierSummary(dossier())).resolves.toBe('AI analysis is disabled by administrator.');
        }
        h.settingsResult = { data: [], error: null };
        await expect(generateDossierSummary(dossier())).resolves.toBe('AI analysis is disabled by administrator.');
        expect(h.getOrgSecret).not.toHaveBeenCalled();
        expect(h.ctor).not.toHaveBeenCalled();
    });

    it('refuses with a configuration hint when no Gemini key is stored', async () => {
        h.getOrgSecret.mockResolvedValue(null);
        await expect(generateDossierSummary(dossier())).resolves.toBe(
            'System Error: AI Service unreachable (Missing Credentials). Please configure a Gemini API key in your Organization Portal.',
        );
        expect(h.getOrgSecret).toHaveBeenCalledWith('GEMINI_API_KEY');
        expect(h.ctor).not.toHaveBeenCalled();
        expect(h.logs).toContainEqual({ level: 'debug', msg: 'gemini api key lookup', fields: { found: false } });
        expect(h.logs.some(r => r.level === 'warn' && r.msg.startsWith('gemini api key missing'))).toBe(true);
    });

    it('hands the key only to the SDK constructor: logged as presence only, never in the prompt', async () => {
        h.generate.mockResolvedValue({ text: 'ok' });
        await generateDossierSummary(dossier());
        expect(h.ctor).toHaveBeenCalledWith({ apiKey: KEY, vertexai: false, httpOptions: { timeout: GEMINI_TIMEOUT_MS } });
        expect(h.logs).toContainEqual({ level: 'debug', msg: 'gemini api key lookup', fields: { found: true } });
        expect(logsContain(KEY)).toBe(false);
        expect(lastPrompt()).not.toContain(KEY);
        expect(h.generate.mock.calls[0][0].config).toEqual({ automaticContinuation: false, store: false });
    });
});

describe('generateDossierSummary — prompt construction', () => {
    it('renders every dossier section with the documented line formats', async () => {
        h.generate.mockResolvedValue({ text: 'summary' });
        await generateDossierSummary(dossier({
            targetId: 'Vex',
            reports: [{ threatLevel: 'High', tags: ['pirate', 'ganker'], summary: 'Seen at Grim HEX' }],
            warrants: [{ status: 'active', action: 'Kill on sight', reason: 'Ambush' }],
            requests: [{ serviceType: 'Escort', status: 'Completed', description: 'x'.repeat(80) }],
            operations: [{ name: 'Op Thunder', type: 'Combat', status: 'Complete' }],
            affiliates: [{ targetId: 'Kade', threatLevel: 'Medium' }],
        } as unknown as Partial<DossierData>));
        const p = lastPrompt();
        expect(p).toContain('private security company (Test Org)');
        expect(p).toContain('internal dossier for target "Vex"');
        expect(p).toContain('REPORTS: - [High] pirate, ganker: Seen at Grim HEX');
        expect(p).toContain('CAUTION NOTES: - [ACTIVE] Caution Level: Kill on sight. Reason: Ambush');
        // Request descriptions are truncated to 50 chars in the prompt.
        expect(p).toContain(`HISTORY: - Escort Request (Completed): ${'x'.repeat(50)}...`);
        expect(p).not.toContain('x'.repeat(51));
        expect(p).toContain('OPS: - Operation: Op Thunder (Combat) - Status: Complete');
        expect(p).toContain('AFFILIATES: - Kade (Threat: Medium)');
    });

    it('uses placeholder text for empty or non-array sections and "Organization" with no branding', async () => {
        h.settingsResult = settingsRows({ enabled: true });
        h.generate.mockResolvedValue({ text: 'summary' });
        await generateDossierSummary(dossier({ reports: 'nope', warrants: undefined, requests: [], operations: null, affiliates: {} } as unknown as Partial<DossierData>));
        const p = lastPrompt();
        expect(p).toContain('private security company (Organization)');
        expect(p).toContain('REPORTS: No direct intelligence reports filed.');
        expect(p).toContain('CAUTION NOTES: No active or past caution notes.');
        expect(p).toContain('HISTORY: No service request history.');
        expect(p).toContain('OPS: No operation participation history.');
        expect(p).toContain('AFFILIATES: No known affiliated individuals.');
    });

    it('coerces null fields to "" and non-array tags to nothing, without throwing', async () => {
        h.generate.mockResolvedValue({ text: 'summary' });
        await generateDossierSummary(dossier({
            reports: [{ threatLevel: null, tags: 'not-an-array', summary: { nested: true } }],
            warrants: [{ status: null, action: undefined, reason: 7 }],
            requests: [{ serviceType: null, status: null, description: null }],
        } as unknown as Partial<DossierData>));
        const p = lastPrompt();
        expect(p).toContain('REPORTS: - [] : [object Object]');
        expect(p).toContain('CAUTION NOTES: - [] Caution Level: . Reason: 7');
        expect(p).toContain('HISTORY: -  Request (): ...');
    });
});

describe('generateDossierSummary — model selection', () => {
    it('defaults to gemini-2.5-flash when no model is configured', async () => {
        h.generate.mockResolvedValue({ text: 'ok' });
        await generateDossierSummary(dossier());
        expect(lastModel()).toBe('gemini-2.5-flash');
        expect(h.logs).toContainEqual({ level: 'debug', msg: 'using gemini model', fields: { model: 'gemini-2.5-flash', migratedFrom: undefined } });
    });

    it('migrates every sunset model name to its current replacement', async () => {
        const migrations: Record<string, string> = {
            'gemini-1.5-flash': 'gemini-2.5-flash',
            'gemini-1.5-pro': 'gemini-2.5-pro',
            'gemini-2.0-flash': 'gemini-2.5-flash',
            'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
            'gemini-flash-latest': 'gemini-2.5-flash',
        };
        h.generate.mockResolvedValue({ text: 'ok' });
        for (const [from, to] of Object.entries(migrations)) {
            h.settingsResult = settingsRows({ enabled: true, model: from });
            await generateDossierSummary(dossier());
            expect(lastModel()).toBe(to);
            expect(h.logs).toContainEqual({ level: 'debug', msg: 'using gemini model', fields: { model: to, migratedFrom: from } });
        }
    });

    it('passes a current model name through unchanged', async () => {
        h.settingsResult = settingsRows({ enabled: true, model: 'gemini-2.5-pro' });
        h.generate.mockResolvedValue({ text: 'ok' });
        await generateDossierSummary(dossier());
        expect(lastModel()).toBe('gemini-2.5-pro');
    });
});

describe('generateDossierSummary — result handling', () => {
    it('caches the generated summary against the target and returns it', async () => {
        h.generate.mockResolvedValue({ text: '[1.0] TARGET OVERVIEW: ...' });
        await expect(generateDossierSummary(dossier({ targetId: 'Vex' }))).resolves.toBe('[1.0] TARGET OVERVIEW: ...');
        expect(h.saveDossierSummary).toHaveBeenCalledWith('Vex', '[1.0] TARGET OVERVIEW: ...');
    });

    it('substitutes (and caches) a fixed notice when the model returns no text', async () => {
        h.generate.mockResolvedValue({ text: '' });
        await expect(generateDossierSummary(dossier())).resolves.toBe('AI failed to generate summary.');
        expect(h.saveDossierSummary).toHaveBeenCalledWith('TGT-1', 'AI failed to generate summary.');
    });

    it('a cache-write failure surfaces as the generic error, not the db error text', async () => {
        h.generate.mockResolvedValue({ text: 'summary' });
        h.saveDossierSummary.mockRejectedValue(new Error('duplicate key value violates unique constraint "intel_dossiers_pkey"'));
        await expect(generateDossierSummary(dossier())).resolves.toBe(
            'Error generating tactical summary. Please try again later or check the AI configuration.',
        );
    });
});

describe('generateDossierSummary — error mapping', () => {
    const modelGone = "Error: The AI model 'gemini-2.5-flash' was not found or has been retired by Google. Please switch to 'Gemini 2.5 Flash' in Admin > AI Settings.";
    const denied = 'Error: The Gemini API key does not have permission for this model. Verify your API key has access to the selected model.';
    const badKey = 'Error: The configured Gemini API key is invalid. Please verify it in the Organization Portal.';
    const quota = 'QUOTA_EXCEEDED: AI Analysis throughput has reached its current limit. Operations will resume in the next cycle.';
    const generic = 'Error generating tactical summary. Please try again later or check the AI configuration.';

    const cases: Array<[string, Record<string, unknown>, string]> = [
        ['404 status', { status: 404, message: 'x' }, modelGone],
        ['NOT_FOUND text', { message: 'models/x is NOT_FOUND' }, modelGone],
        ['"not found" text', { message: 'model not found for API version' }, modelGone],
        ['"is not available" text', { message: 'model is not available' }, modelGone],
        ['"deprecated" text', { message: 'this model is deprecated' }, modelGone],
        ['403 statusCode', { statusCode: 403, message: 'x' }, denied],
        ['PERMISSION_DENIED text', { message: 'PERMISSION_DENIED: caller lacks access' }, denied],
        ['API_KEY_INVALID text', { message: 'API key not valid. API_KEY_INVALID' }, badKey],
        ['429 status', { status: 429, message: 'x' }, quota],
        ['"429" string code', { code: '429', message: 'x' }, quota],
        ['RESOURCE_EXHAUSTED text', { message: 'RESOURCE_EXHAUSTED' }, quota],
        ['429 + quota text', { message: 'got 429: Quota exceeded for metric' }, quota],
        ['429 text without quota', { message: 'got 429 too many' }, generic],
        ['bare "invalid" text', { message: 'invalid request' }, generic],
        ['500 status', { status: 500, message: 'internal' }, generic],
    ];

    it.each(cases)('%s → curated message', async (_label, props, expected) => {
        h.generate.mockRejectedValue(apiError(props));
        await expect(generateDossierSummary(dossier())).resolves.toBe(expected);
        expect(h.saveDossierSummary).not.toHaveBeenCalled();
    });

    it('checks model-not-found before quota (a sunset model must not read as a quota problem)', async () => {
        h.generate.mockRejectedValue(apiError({ status: 429, message: 'NOT_FOUND' }));
        await expect(generateDossierSummary(dossier())).resolves.toBe(modelGone);
    });

    it('names the migrated model in the not-found message', async () => {
        h.settingsResult = settingsRows({ enabled: true, model: 'gemini-1.5-pro' });
        h.generate.mockRejectedValue(apiError({ status: 404, message: 'x' }));
        await expect(generateDossierSummary(dossier())).resolves.toContain("The AI model 'gemini-2.5-pro' was not found");
    });

    it('never returns raw upstream error text, and logs only the curated status/message', async () => {
        const err = apiError({ status: 500, message: 'upstream detail: projects/123456/internal-trace-abc' });
        (err as unknown as Record<string, unknown>).config = { headers: { 'x-goog-api-key': KEY } };
        h.generate.mockRejectedValue(err);
        const out = await generateDossierSummary(dossier());
        expect(out).toBe(generic);
        expect(out).not.toContain('internal-trace-abc');
        expect(h.logs).toContainEqual({ level: 'error', msg: 'gemini api error', fields: { status: 500, message: 'upstream detail: projects/123456/internal-trace-abc' } });
        expect(h.logs).toContainEqual({ level: 'error', msg: 'dossier summary failed', fields: { message: 'upstream detail: projects/123456/internal-trace-abc' } });
        expect(logsContain(KEY)).toBe(false);
    });

    it('tolerates an error with no message or status', async () => {
        h.generate.mockRejectedValue({});
        await expect(generateDossierSummary(dossier())).resolves.toBe(generic);
        expect(h.logs).toContainEqual({ level: 'error', msg: 'gemini api error', fields: { status: '', message: '' } });
    });
});

describe('generateAARSummary — configuration and credentials', () => {
    const op = { name: 'Op Thunder', participantCount: 3, entries: [] };

    it('reads the same explicit settings projection', async () => {
        h.generate.mockResolvedValue({ text: '{"summary":"s","lessonsLearned":"l"}' });
        await generateAARSummary(op);
        expect(h.reads).toEqual([{ table: 'settings', select: 'key, value', in: ['key', ['aiConfig', 'brandingConfig']] }]);
    });

    it('throws (fail closed) on a settings read error or a null result, before any SDK client', async () => {
        h.settingsResult = { data: settingsRows({ enabled: true }).data, error: { message: 'boom' } };
        await expect(generateAARSummary(op)).rejects.toThrow('Could not retrieve AI configuration.');
        h.settingsResult = { data: null, error: null };
        await expect(generateAARSummary(op)).rejects.toThrow('Could not retrieve AI configuration.');
        expect(h.getOrgSecret).not.toHaveBeenCalled();
        expect(h.ctor).not.toHaveBeenCalled();
    });

    it('throws when AI is disabled, before the key lookup', async () => {
        h.settingsResult = settingsRows({ enabled: false });
        await expect(generateAARSummary(op)).rejects.toThrow('AI analysis is disabled by administrator.');
        expect(h.getOrgSecret).not.toHaveBeenCalled();
        expect(h.ctor).not.toHaveBeenCalled();
    });

    it('throws when no key is stored, before any SDK client', async () => {
        h.getOrgSecret.mockResolvedValue('');
        await expect(generateAARSummary(op)).rejects.toThrow('Missing Gemini API key. Configure one in Admin → AI Settings.');
        expect(h.getOrgSecret).toHaveBeenCalledWith('GEMINI_API_KEY');
        expect(h.ctor).not.toHaveBeenCalled();
    });

    it('hands the key only to the bounded SDK constructor', async () => {
        h.generate.mockResolvedValue({ text: '{"summary":"s"}' });
        await generateAARSummary(op);
        expect(h.ctor).toHaveBeenCalledWith({ apiKey: KEY, vertexai: false, httpOptions: { timeout: GEMINI_TIMEOUT_MS } });
        expect(h.generate.mock.calls[0][0].config).toEqual({ automaticContinuation: false, store: false });
        expect(lastPrompt()).not.toContain(KEY);
        expect(logsContain(KEY)).toBe(false);
    });
});

describe('generateAARSummary — prompt construction and model', () => {
    it('renders operation fields and groups entries by category (case-insensitive, unknown → observations)', async () => {
        h.settingsResult = settingsRows({ enabled: true, model: 'gemini-2.0-flash-lite' }, { name: 'Test Org' });
        h.generate.mockResolvedValue({ text: '{"summary":"s"}' });
        await generateAARSummary({
            name: 'Op Thunder', type: 'Combat', status: 'Completed', description: 'Clear the outpost',
            scheduledStart: '2026-04-01T10:00:00Z', scheduledEnd: '2026-04-01T12:00:00Z', location: 'Daymar',
            participantCount: 7,
            entries: [
                { category: 'SUSTAIN', content: 'Comms discipline', authorName: 'Ava' },
                { category: 'improve', content: 'Late QRF' },
                { category: 'action_item', content: 'Brief medics', authorName: 'Bo' },
                { category: 'banter', content: 'Unknown bucket' },
                { category: '', content: 'No category' },
            ],
        });
        const p = lastPrompt();
        expect(lastModel()).toBe('gemini-2.5-flash-lite');
        expect(p).toContain('You are an after-action review writer for Test Org,');
        expect(p).toContain('- Name: Op Thunder\n- Type: Combat\n- Status: Completed\n- Scheduled: 2026-04-01T10:00:00Z → 2026-04-01T12:00:00Z\n- Location: Daymar\n- Participants: 7\n- Description: Clear the outpost');
        expect(p).toContain('OBSERVATIONS:\n- Unknown bucket\n- No category\n');
        expect(p).toContain('SUSTAIN (what went well):\n- Comms discipline (Ava)\n');
        expect(p).toContain('IMPROVE (what to fix):\n- Late QRF\n');
        expect(p).toContain('ACTION ITEMS:\n- Brief medics (Bo)\n');
    });

    it('fills the documented fallbacks for missing operation fields and empty buckets', async () => {
        h.settingsResult = settingsRows({ enabled: true });
        h.generate.mockResolvedValue({ text: '{"summary":"s"}' });
        await generateAARSummary({ name: 'Op Quiet', participantCount: 0, entries: undefined as unknown as [] });
        const p = lastPrompt();
        expect(lastModel()).toBe('gemini-2.5-flash');
        expect(p).toContain('for Organization, a Star Citizen organization');
        expect(p).toContain('- Type: Unspecified\n- Status: Unspecified\n- Scheduled: n/a → n/a\n- Location: n/a\n- Participants: 0\n- Description: (none)');
        expect(p).toContain('OBSERVATIONS:\n(none)');
        expect(p).toContain('SUSTAIN (what went well):\n(none)');
        expect(p).toContain('IMPROVE (what to fix):\n(none)');
        expect(p).toContain('ACTION ITEMS:\n(none)');
    });

    it('passes a non-legacy model name through', async () => {
        h.settingsResult = settingsRows({ enabled: true, model: 'gemini-2.5-pro' });
        h.generate.mockResolvedValue({ text: '{"summary":"s"}' });
        await generateAARSummary({ name: 'Op', participantCount: 1, entries: [] });
        expect(lastModel()).toBe('gemini-2.5-pro');
    });
});

describe('generateAARSummary — response parsing', () => {
    const op = { name: 'Op', participantCount: 1, entries: [] };

    it('parses a bare JSON object, trimming both fields', async () => {
        h.generate.mockResolvedValue({ text: '  {"summary":"  It went well.  ","lessonsLearned":"- Keep comms\\n- Fix QRF  "}  ' });
        await expect(generateAARSummary(op)).resolves.toEqual({ summary: 'It went well.', lessonsLearned: '- Keep comms\n- Fix QRF' });
    });

    it('strips ```json fences before parsing', async () => {
        h.generate.mockResolvedValue({ text: '```json\n{"summary":"S","lessonsLearned":"L"}\n```' });
        await expect(generateAARSummary(op)).resolves.toEqual({ summary: 'S', lessonsLearned: 'L' });
        h.generate.mockResolvedValue({ text: '```\n{"summary":"S2"}\n```' });
        await expect(generateAARSummary(op)).resolves.toEqual({ summary: 'S2', lessonsLearned: '' });
    });

    it('falls back to the raw prose as the summary when the model ignores the JSON format', async () => {
        h.generate.mockResolvedValue({ text: 'The operation succeeded with no losses.' });
        await expect(generateAARSummary(op)).resolves.toEqual({ summary: 'The operation succeeded with no losses.', lessonsLearned: '' });
    });

    it('accepts a draft with lessons only', async () => {
        h.generate.mockResolvedValue({ text: '{"lessonsLearned":"- one"}' });
        await expect(generateAARSummary(op)).resolves.toEqual({ summary: '', lessonsLearned: '- one' });
    });

    it('rejects an empty draft with the generic error, keeping the reason as the cause', async () => {
        for (const text of ['{"summary":"","lessonsLearned":"  "}', '', undefined]) {
            h.generate.mockResolvedValue({ text });
            const err = await generateAARSummary(op).then(() => null, (e: Error) => e);
            expect(err?.message).toBe('AI draft failed. Please try again later or verify the AI configuration.');
            expect((err?.cause as Error).message).toBe('AI returned empty draft.');
        }
    });
});

describe('generateAARSummary — error mapping', () => {
    const op = { name: 'Op', participantCount: 1, entries: [] };
    const overloaded = "Gemini is temporarily overloaded for the configured model (gemini-2.5-flash). This is usually a brief spike on Google's end — try again in a few minutes, or switch to a less-busy model (e.g. Gemini 2.5 Flash) in Admin → Integrations → AI Settings.";
    const quota = 'AI quota exceeded for the configured Gemini API key. Wait for the quota to reset (usually within an hour on the free tier) or upgrade the key in Admin → Integrations → AI Settings.';
    const gone = 'AI model "gemini-2.5-flash" was not found or has been retired by Google. Switch to a current model (e.g. Gemini 2.5 Flash) in Admin → Integrations → AI Settings.';
    const denied = 'The configured Gemini API key does not have permission to use "gemini-2.5-flash". Verify the key in Admin → Integrations → AI Settings has access to this model.';
    const badKey = 'The configured Gemini API key is invalid. Update it in Admin → Integrations → AI Settings.';
    const internal = "Gemini returned an internal error. This is on Google's end — try again in a few minutes.";
    const generic = 'AI draft failed. Please try again later or verify the AI configuration.';
    const jsonErr = (status: string, message = 'm') => `got status: 400 . ${JSON.stringify({ error: { code: 400, message, status } })}`;

    const cases: Array<[string, unknown, string]> = [
        ['503 status', apiError({ status: 503 }), overloaded],
        ['UNAVAILABLE in JSON payload', apiError({ message: jsonErr('UNAVAILABLE') }), overloaded],
        ['"overloaded" text', apiError({ message: 'The model is overloaded.' }), overloaded],
        ['UNAVAILABLE as string code', apiError({ code: 'UNAVAILABLE' }), overloaded],
        ['429 statusCode', apiError({ statusCode: 429 }), quota],
        ['RESOURCE_EXHAUSTED in JSON payload', apiError({ message: jsonErr('RESOURCE_EXHAUSTED') }), quota],
        ['"Quota" text (case-insensitive)', apiError({ message: 'Quota exceeded for metric' }), quota],
        ['404 status', apiError({ status: 404 }), gone],
        ['NOT_FOUND in JSON payload', apiError({ message: jsonErr('NOT_FOUND') }), gone],
        ['"deprecated" text', apiError({ message: 'model deprecated' }), gone],
        ['"not found" text', apiError({ message: 'model not found' }), gone],
        ['403 status', apiError({ status: 403 }), denied],
        ['PERMISSION_DENIED in JSON payload', apiError({ message: jsonErr('PERMISSION_DENIED') }), denied],
        ['INVALID_ARGUMENT in JSON payload', apiError({ message: jsonErr('INVALID_ARGUMENT') }), badKey],
        ['API_KEY_INVALID text', apiError({ message: 'API_KEY_INVALID' }), badKey],
        ['500 status', apiError({ status: 500 }), internal],
        ['INTERNAL in JSON payload', apiError({ message: jsonErr('INTERNAL') }), internal],
        ['unmatched error', apiError({ message: 'socket hang up' }), generic],
        ['malformed JSON payload', apiError({ message: '{"error": nope' }), generic],
        ['JSON payload without an error object', apiError({ message: '{"detail":"x"}' }), generic],
        ['non-Error rejection', 'boom', generic],
        ['null rejection', null, generic],
    ];

    it.each(cases)('%s → curated message with the original as cause', async (_label, rejection, expected) => {
        h.generate.mockRejectedValue(rejection);
        const err = await generateAARSummary(op).then(() => null, (e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toBe(expected);
        expect(err!.cause).toBe(rejection);
    });

    it('applies the documented precedence (overloaded before quota before not-found before permission)', async () => {
        h.generate.mockRejectedValue(apiError({ status: 503, message: 'quota NOT_FOUND PERMISSION_DENIED' }));
        await expect(generateAARSummary(op)).rejects.toThrow(overloaded);
        h.generate.mockRejectedValue(apiError({ status: 404, message: 'quota exceeded' }));
        await expect(generateAARSummary(op)).rejects.toThrow(quota);
        h.generate.mockRejectedValue(apiError({ status: 403, message: 'deprecated' }));
        await expect(generateAARSummary(op)).rejects.toThrow(gone);
        h.generate.mockRejectedValue(apiError({ status: 500, message: 'PERMISSION_DENIED' }));
        await expect(generateAARSummary(op)).rejects.toThrow(denied);
    });

    it('names the migrated model in model-specific messages', async () => {
        h.settingsResult = settingsRows({ enabled: true, model: 'gemini-1.5-pro' });
        h.generate.mockRejectedValue(apiError({ status: 403 }));
        await expect(generateAARSummary(op)).rejects.toThrow('does not have permission to use "gemini-2.5-pro"');
    });

    it('logs the extracted upstream message for unmatched errors but never surfaces it or the key', async () => {
        const err = apiError({ message: `oops ${JSON.stringify({ error: { status: 'FAILED_PRECONDITION', message: 'billing account 0042 suspended' } })}` });
        (err as unknown as Record<string, unknown>).request = { headers: { 'x-goog-api-key': KEY } };
        h.generate.mockRejectedValue(err);
        const thrown = await generateAARSummary(op).then(() => null, (e: Error) => e);
        expect(thrown!.message).toBe(generic);
        expect(thrown!.message).not.toContain('billing account');
        expect(h.logs).toContainEqual({ level: 'error', msg: 'draft failed', fields: { message: 'billing account 0042 suspended' } });
        expect(h.logs.find(r => r.msg === 'aar gemini error')!.fields).toEqual({ status: '', message: err.message });
        expect(logsContain(KEY)).toBe(false);
    });
});
