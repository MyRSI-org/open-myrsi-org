import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizePublicLinkUrl } from '../lib/linkUrl';

// Intel write-boundary hygiene:
//   - intel report evidence_urls run through the public-link allowlist on
//     write (https:/discord: only; javascript:/data:/http: dropped) — closes
//     the link-injection / stored-XSS anchor-href sink.
//   - own-org warrant + intel write paths get the same stripHtml + length-cap
//     + threat-level normalisation + tag sanitisation the feed-ingest path
//     already applies (no unbounded blobs, no arbitrary threat_level).
//
// The builder mocks ../lib/db/common so it captures every insert/update payload.

const cap = vi.hoisted(() => ({
    inserts: [] as Array<{ table: string; payload: any }>,
    updates: [] as Array<{ table: string; payload: any }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select' as 'select' | 'insert' | 'update' | 'delete' };
        const b: any = {};
        b.select = () => b;
        b.insert = (payload: any) => { state.op = 'insert'; cap.inserts.push({ table, payload }); return b; };
        b.update = (payload: any) => { state.op = 'update'; cap.updates.push({ table, payload }); return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = () => b; b.is = () => b; b.in = () => b; b.not = () => b;
        b.ilike = () => b; b.order = () => b; b.limit = () => b; b.contains = () => b;
        const settle = (mode: 'single' | 'many') => {
            // Inserts hand back a synthetic id so create* paths proceed.
            if (state.op === 'insert') return Promise.resolve({ data: { id: `${table}-id` }, error: null });
            // Existence checks (.maybeSingle()) must return a row so
            // updateIntelReport doesn't throw "not found".
            return Promise.resolve({ data: mode === 'single' ? { id: `${table}-existing` } : [], error: null, count: 1 });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (r: any, j: any) => settle('many').then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {},
        safeFetch: async () => [],
    };
});

import { createIntelReport, updateIntelReport, createWarrant, bulkUpdateIntelAffiliation } from '../lib/db/intel';
import { IntelThreatLevel } from '../types';

const VALID_THREAT_LEVELS = new Set<string>(Object.values(IntelThreatLevel));

const lastInsert = (table: string) => [...cap.inserts].reverse().find((i) => i.table === table)?.payload;
const lastUpdate = (table: string) => [...cap.updates].reverse().find((u) => u.table === table)?.payload;

beforeEach(() => { cap.inserts = []; cap.updates = []; });

describe('intel report evidence_urls are allowlisted on the write boundary', () => {
    const input = [
        'javascript:alert(1)',
        'data:text/html,<b>pwn</b>',
        'http://attacker/phish',
        'https://good.example/a',
        'discord://chan',
    ];

    it('createIntelReport drops javascript:/data:/http: and keeps only https:/discord:', async () => {
        await createIntelReport({ targetId: 'x', evidenceUrls: input, createdById: 1, classificationLevel: 0, user: { role: 'Admin' } });
        const payload = lastInsert('intel_reports');
        const urls: string[] = payload.evidence_urls;
        // The dangerous schemes are gone.
        expect(urls.some((u) => u.startsWith('javascript:'))).toBe(false);
        expect(urls.some((u) => u.startsWith('data:'))).toBe(false);
        expect(urls.some((u) => u.startsWith('http:'))).toBe(false);
        // Only the allowlisted entries survive, in normalised form.
        expect(urls).toEqual(input.map(sanitizePublicLinkUrl).filter(Boolean));
        expect(urls).toContain('https://good.example/a');
    });

    it('updateIntelReport applies the same allowlist', async () => {
        await updateIntelReport('00000000-0000-0000-0000-000000000001', { evidenceUrls: input, threatLevel: 'High' });
        const payload = lastUpdate('intel_reports');
        const urls: string[] = payload.evidence_urls;
        expect(urls.some((u) => u.startsWith('javascript:'))).toBe(false);
        expect(urls.some((u) => u.startsWith('data:'))).toBe(false);
        expect(urls.some((u) => u.startsWith('http:'))).toBe(false);
        expect(urls).toEqual(input.map(sanitizePublicLinkUrl).filter(Boolean));
    });

    it('caps the evidence_urls array length', async () => {
        const many = Array.from({ length: 50 }, (_, i) => `https://good.example/${i}`);
        await createIntelReport({ targetId: 'x', evidenceUrls: many, createdById: 1, classificationLevel: 0, user: { role: 'Admin' } });
        expect(lastInsert('intel_reports').evidence_urls.length).toBeLessThanOrEqual(20);
    });
});

describe('own-org intel/warrant writes get stripHtml + length-cap + normalisation', () => {
    it('createIntelReport normalises an arbitrary threat_level and clamps tags', async () => {
        await createIntelReport({
            targetId: 'x',
            summary: 'ok',
            threatLevel: 'garbage',
            tags: ['x'.repeat(100000), 'y'.repeat(100000)],
            classificationLevel: 0,
            user: { role: 'Admin' },
        });
        const payload = lastInsert('intel_reports');
        expect(VALID_THREAT_LEVELS.has(payload.threat_level)).toBe(true);
        expect(payload.threat_level).toBe('Medium'); // garbage → fallback
        for (const t of payload.tags) expect(t.length).toBeLessThanOrEqual(40);
        expect(payload.tags.length).toBeLessThanOrEqual(20);
    });

    it('updateIntelReport normalises threat_level and clamps tags', async () => {
        await updateIntelReport('00000000-0000-0000-0000-000000000001', {
            threatLevel: 'totally-bogus',
            tags: ['z'.repeat(5000)],
        });
        const payload = lastUpdate('intel_reports');
        expect(VALID_THREAT_LEVELS.has(payload.threat_level)).toBe(true);
        for (const t of payload.tags) expect(t.length).toBeLessThanOrEqual(40);
    });

    it('createWarrant caps target_rsi_handle and reason', async () => {
        await createWarrant({ targetRsiHandle: 'x'.repeat(5000), reason: 'y'.repeat(20000) }, 1);
        const payload = lastInsert('warrants');
        expect(payload.target_rsi_handle.length).toBeLessThanOrEqual(200);
        expect(payload.reason.length).toBeLessThanOrEqual(8000);
    });

    it('bulkUpdateIntelAffiliation caps affiliated_org to match the single-row path', async () => {
        await bulkUpdateIntelAffiliation(['00000000-0000-0000-0000-000000000002'], 'z'.repeat(5000));
        const payload = lastUpdate('intel_reports');
        expect(payload.affiliated_org.length).toBeLessThanOrEqual(200);
    });
});

describe('warrantsOnly is a WARRANT read, and needs warrant:view', () => {
    // intel:get_dossier withholds the warrant array unless the caller holds
    // warrant:view. The warrantsOnly FILTER discloses the same fact by another route:
    // it narrows the list to subjects carrying an active warrant, so the result set
    // itself is the answer to "who is under warrant". Reached through a filter rather
    // than a field, it bypassed the gate entirely — any intel:view holder could set it.
    const src = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'intel.ts'), 'utf8');
    const handler = src.slice(src.indexOf("'intel:list':"), src.indexOf("'intel:hub_stats':"));

    it('the flag is gated on warrant:view, not passed through from the payload', () => {
        expect(handler, 'the raw payload flag reaches the db layer again').not.toMatch(/warrantsOnly:\s*payload\.warrantsOnly/);
        expect(handler).toMatch(/canViewWarrants \? payload\.warrantsOnly : undefined/);
        expect(handler).toMatch(/includes\('warrant:view'\)/);
    });

    it('uses the same predicate shape as the dossier handler, so the two cannot drift', () => {
        const dossier = src.slice(src.indexOf("'intel:get_dossier'"), src.indexOf("'intel:get_recent'"));
        expect(dossier).toMatch(/includes\('warrant:view'\)/);
    });

    it('is DROPPED rather than refused, so an unentitled caller still gets their list', () => {
        // Refusing would turn a filter nobody is entitled to into a broken action; the
        // ordinary intel list is the right degraded result.
        expect(handler).not.toMatch(/throw new SecurityDenial/);
    });
});
