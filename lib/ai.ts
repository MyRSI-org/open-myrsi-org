
import { GoogleGenAI } from "@google/genai";
import { DossierData } from "../types.js";
import { supabase, saveDossierSummary } from "./db.js";

import { getOrgSecret } from "./secrets.js";
import { log as baseLog } from "./log.js";

const log = baseLog.child({ module: 'lib.ai' });

export async function generateDossierSummary(dossier: DossierData): Promise<string> {
    // 1. Fetch AI and Branding settings
    const { data: settings, error } = await supabase
        .from('settings')
        .select('key, value')
        .in('key', ['aiConfig', 'brandingConfig']);

    if (error || !settings) {
        log.error('failed to fetch settings', { err: error });
        return "Error: Could not retrieve system configuration.";
    }

    const configMap = settings.reduce((acc: any, curr: any) => {
        acc[curr.key] = curr.value;
        return acc;
    }, {});

    const aiConfig = configMap['aiConfig'];
    const brandingConfig = configMap['brandingConfig'];

    if (!aiConfig?.enabled) {
        return "AI analysis is disabled by administrator.";
    }

    // 2. Validate API Key
    const apiKey = await getOrgSecret('GEMINI_API_KEY');
    // Never log key material (length / prefix is still a partial disclosure).
    // Log only presence, at debug (not on every dossier run in prod).
    log.debug('gemini api key lookup', { found: !!apiKey });
    if (!apiKey) {
        log.warn('gemini api key missing — set it in admin settings or the server environment');
        return "System Error: AI Service unreachable (Missing Credentials). Please configure a Gemini API key in your Organization Portal.";
    }

    // 3. Determine Context Variables
    const orgName = brandingConfig?.name || "Organization";
    const str = (v: any, fallback = ''): string => {
        if (v == null) return fallback;
        if (typeof v === 'object') return fallback || String(v);
        return String(v);
    };

    // Prepare data strings with defensive guards
    const reports = Array.isArray(dossier.reports) ? dossier.reports : [];
    const warrants = Array.isArray(dossier.warrants) ? dossier.warrants : [];
    const requests = Array.isArray(dossier.requests) ? dossier.requests : [];
    const operations = Array.isArray(dossier.operations) ? dossier.operations : [];
    const affiliates = Array.isArray(dossier.affiliates) ? dossier.affiliates : [];

    const reportTexts = reports.length > 0
        ? reports.map(r => `- [${str(r.threatLevel)}] ${Array.isArray(r.tags) ? r.tags.join(', ') : ''}: ${str(r.summary)}`).join('\n')
        : "No direct intelligence reports filed.";

    const warrantTexts = warrants.length > 0
        ? warrants.map(w => `- [${str(w.status).toUpperCase()}] Caution Level: ${str(w.action)}. Reason: ${str(w.reason)}`).join('\n')
        : "No active or past caution notes.";

    const requestTexts = requests.length > 0
        ? requests.map(r => `- ${str(r.serviceType)} Request (${str(r.status)}): ${str(r.description).substring(0, 50)}...`).join('\n')
        : "No service request history.";

    const opTexts = operations.length > 0
        ? operations.map(o => `- Operation: ${str(o.name)} (${str(o.type)}) - Status: ${str(o.status)}`).join('\n')
        : "No operation participation history.";

    const affiliateTexts = affiliates.length > 0
        ? affiliates.map(a => `- ${str(a.targetId)} (Threat: ${str(a.threatLevel)})`).join('\n')
        : "No known affiliated individuals.";

    // Respect the model choice from admin config, fallback to gemini-2.5-flash if not set
    // Migrate legacy model names that have been sunset by Google
    const RAW_MODEL = aiConfig.model || 'gemini-2.5-flash';
    const MODEL_MIGRATIONS: Record<string, string> = {
        'gemini-1.5-flash': 'gemini-2.5-flash',
        'gemini-1.5-pro': 'gemini-2.5-pro',
        'gemini-2.0-flash': 'gemini-2.5-flash',
        'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
        'gemini-flash-latest': 'gemini-2.5-flash',
    };
    const modelName = MODEL_MIGRATIONS[RAW_MODEL] || RAW_MODEL;
    // Debug-level + no targetId (per-call intel PII must not sit in plaintext logs).
    log.debug('using gemini model', { model: modelName, migratedFrom: modelName !== RAW_MODEL ? RAW_MODEL : undefined });

    try {
        const ai = new GoogleGenAI({ apiKey });

        const prompt = `
            You are a military intelligence officer for a private security company (${orgName}).
            Analyze the following internal dossier for target "${dossier.targetId}".
            
            Synthesize a structured tactical dossier report.
            
            Section structure:
            [1.0] TARGET OVERVIEW: Basic summary of identity.
            [2.0] EXECUTIVE SUMMARY: Synthesis of internal data and search findings.
            [3.0] PILLARS OF OPERATION: Notable behaviors identified.
            [4.0] COMMAND STRUCTURE: Member hierarchy or personal rank/role and affiliations.
            [5.0] TACTICAL ANALYSIS: Skill level, ship preferences, and combat effectiveness.
            [6.0] OPERATIONAL ADVISORY: ROE and caution level.
            
            RULES:
            - Plain text with [X.0] headers.
            - Professional, direct, terse.
            - Max 350 words.

            INTERNAL DATA:
            REPORTS: ${reportTexts}
            CAUTION NOTES: ${warrantTexts}
            HISTORY: ${requestTexts}
            OPS: ${opTexts}
            AFFILIATES: ${affiliateTexts}
        `;

        const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
        });

        const summaryText = response.text || "AI failed to generate summary.";

        // Cache result
        await saveDossierSummary(dossier.targetId, summaryText);

        return summaryText;

    } catch (error: any) {
        const errMsg = error.message || '';
        const errStatus = error.status || error.statusCode || error.code || '';
        // Log the curated status/message only — NOT a full own-property dump of the
        // third-party error (the comment below warns it can carry internal request
        // detail; dumping it to logs is the same leak class).
        log.error('gemini api error', { status: errStatus, message: errMsg });

        // Check model not found FIRST — sunset models return NOT_FOUND and should not be confused with quota issues
        if (errStatus === 404 || errMsg.includes('NOT_FOUND') || errMsg.includes('not found') || errMsg.includes('is not available') || errMsg.includes('deprecated')) {
            return `Error: The AI model '${modelName}' was not found or has been retired by Google. Please switch to 'Gemini 2.5 Flash' in Admin > AI Settings.`;
        }

        // Permission denied
        if (errStatus === 403 || errMsg.includes('PERMISSION_DENIED')) {
            return "Error: The Gemini API key does not have permission for this model. Verify your API key has access to the selected model.";
        }

        // Invalid API key — only check for explicit API_KEY_INVALID, not generic 'invalid'
        if (errMsg.includes('API_KEY_INVALID')) {
            return "Error: The configured Gemini API key is invalid. Please verify it in the Organization Portal.";
        }

        // Quota / rate limit — only for genuine 429 or RESOURCE_EXHAUSTED
        if (errStatus === 429 || String(errStatus) === '429' || errMsg.includes('RESOURCE_EXHAUSTED') || (errMsg.includes('429') && errMsg.toLowerCase().includes('quota'))) {
            return "QUOTA_EXCEEDED: AI Analysis throughput has reached its current limit. Operations will resume in the next cycle.";
        }

        // Don't surface the raw third-party (Gemini SDK) error text to the
        // browser — it can carry internal request detail. Log it server-side and
        // return a generic message for the unmatched cases.
        log.error('dossier summary failed', { message: errMsg });
        return 'Error generating tactical summary. Please try again later or check the AI configuration.';
    }
}

export interface AARSourceData {
    name: string;
    type?: string;
    status?: string;
    description?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    location?: string;
    participantCount: number;
    entries: { category: string; content: string; authorName?: string }[];
}

export interface AARDraftResult {
    summary: string;
    lessonsLearned: string;
}

export async function generateAARSummary(op: AARSourceData): Promise<AARDraftResult> {
    const { data: settings, error } = await supabase
        .from('settings')
        .select('key, value')
        .in('key', ['aiConfig', 'brandingConfig']);
    if (error || !settings) {
        throw new Error('Could not retrieve AI configuration.');
    }

    const configMap = settings.reduce((acc: any, curr: any) => { acc[curr.key] = curr.value; return acc; }, {} as any);
    const aiConfig = configMap['aiConfig'];
    const brandingConfig = configMap['brandingConfig'];

    if (!aiConfig?.enabled) throw new Error('AI analysis is disabled by administrator.');

    const apiKey = await getOrgSecret('GEMINI_API_KEY');
    if (!apiKey) {
        throw new Error('Missing Gemini API key. Configure one in Admin → AI Settings.');
    }

    const orgName = brandingConfig?.name || 'Organization';

    const RAW_MODEL = aiConfig.model || 'gemini-2.5-flash';
    const MODEL_MIGRATIONS: Record<string, string> = {
        'gemini-1.5-flash': 'gemini-2.5-flash',
        'gemini-1.5-pro': 'gemini-2.5-pro',
        'gemini-2.0-flash': 'gemini-2.5-flash',
        'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
        'gemini-flash-latest': 'gemini-2.5-flash',
    };
    const modelName = MODEL_MIGRATIONS[RAW_MODEL] || RAW_MODEL;

    const groupedEntries: Record<string, string[]> = { observation: [], sustain: [], improve: [], action_item: [] };
    for (const e of op.entries || []) {
        const cat = (e.category || 'observation').toLowerCase();
        const bucket = groupedEntries[cat] || groupedEntries.observation;
        const author = e.authorName ? ` (${e.authorName})` : '';
        bucket.push(`- ${e.content}${author}`);
    }
    const fmtBucket = (rows: string[]) => rows.length > 0 ? rows.join('\n') : '(none)';

    const prompt = `
You are an after-action review writer for ${orgName}, a Star Citizen organization. You will draft a concise, factual AAR for the operation below from the structured feedback collected from participants. The output is a draft for human review — be neutral, do not invent details, and do not editorialize beyond what the entries support.

OPERATION:
- Name: ${op.name}
- Type: ${op.type || 'Unspecified'}
- Status: ${op.status || 'Unspecified'}
- Scheduled: ${op.scheduledStart || 'n/a'} → ${op.scheduledEnd || 'n/a'}
- Location: ${op.location || 'n/a'}
- Participants: ${op.participantCount}
- Description: ${op.description || '(none)'}

PARTICIPANT FEEDBACK BY CATEGORY:

OBSERVATIONS:
${fmtBucket(groupedEntries.observation)}

SUSTAIN (what went well):
${fmtBucket(groupedEntries.sustain)}

IMPROVE (what to fix):
${fmtBucket(groupedEntries.improve)}

ACTION ITEMS:
${fmtBucket(groupedEntries.action_item)}

OUTPUT FORMAT — return ONLY a single JSON object, no prose, no code fences:
{
  "summary": "3–5 sentences summarizing what happened, the outcome, and overall effectiveness. Plain text, no markdown.",
  "lessonsLearned": "Bulleted list (one '- ' per line) consolidating the strongest sustain, improve, and action-item themes. 4–8 bullets max."
}

If a section has no entries, infer cautiously from the available information rather than fabricating. If almost no information is available, say so plainly in the summary.
`;

    try {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({ model: modelName, contents: prompt });
        const text = (response.text || '').trim();

        let summary = '';
        let lessons = '';
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        try {
            const parsed = JSON.parse(cleaned);
            summary = String(parsed.summary || '').trim();
            lessons = String(parsed.lessonsLearned || '').trim();
        } catch {
            summary = cleaned;
            lessons = '';
        }
        if (!summary && !lessons) throw new Error('AI returned empty draft.');
        return { summary, lessonsLearned: lessons };
    } catch (error: any) {
        const errMsg = String(error?.message || '');
        const errStatus = error?.status || error?.statusCode || error?.code || '';
        log.error('aar gemini error', { status: errStatus, message: errMsg });

        // Some Gemini errors arrive as JSON-stringified payloads in error.message.
        // Try to extract the structured fields so we can match on status text.
        let extractedStatus = '';
        let extractedMessage = '';
        if (errMsg.startsWith('{') || errMsg.includes('"error"')) {
            try {
                const parsed = JSON.parse(errMsg.slice(errMsg.indexOf('{')));
                extractedStatus = parsed?.error?.status || '';
                extractedMessage = parsed?.error?.message || '';
            } catch { /* fall through */ }
        }
        const status = extractedStatus || (typeof errStatus === 'string' ? errStatus : '');

        if (errStatus === 503 || status === 'UNAVAILABLE' || errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded')) {
            throw new Error(`Gemini is temporarily overloaded for the configured model (${modelName}). This is usually a brief spike on Google's end — try again in a few minutes, or switch to a less-busy model (e.g. Gemini 2.5 Flash) in Admin → Integrations → AI Settings.`);
        }
        if (errStatus === 429 || status === 'RESOURCE_EXHAUSTED' || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.toLowerCase().includes('quota')) {
            throw new Error(`AI quota exceeded for the configured Gemini API key. Wait for the quota to reset (usually within an hour on the free tier) or upgrade the key in Admin → Integrations → AI Settings.`);
        }
        if (errStatus === 404 || status === 'NOT_FOUND' || errMsg.includes('NOT_FOUND') || errMsg.includes('not found') || errMsg.includes('deprecated')) {
            throw new Error(`AI model "${modelName}" was not found or has been retired by Google. Switch to a current model (e.g. Gemini 2.5 Flash) in Admin → Integrations → AI Settings.`);
        }
        if (errStatus === 403 || status === 'PERMISSION_DENIED' || errMsg.includes('PERMISSION_DENIED')) {
            throw new Error(`The configured Gemini API key does not have permission to use "${modelName}". Verify the key in Admin → Integrations → AI Settings has access to this model.`);
        }
        if (status === 'INVALID_ARGUMENT' || errMsg.includes('API_KEY_INVALID')) {
            throw new Error(`The configured Gemini API key is invalid. Update it in Admin → Integrations → AI Settings.`);
        }
        if (errStatus === 500 || status === 'INTERNAL' || errMsg.includes('INTERNAL')) {
            throw new Error(`Gemini returned an internal error. This is on Google's end — try again in a few minutes.`);
        }
        // The matched cases above return curated, actionable text. For anything
        // else, log the real error server-side and surface a generic message
        // rather than the raw third-party error string.
        log.error('draft failed', { message: extractedMessage || errMsg });
        throw new Error('AI draft failed. Please try again later or verify the AI configuration.');
    }
}
