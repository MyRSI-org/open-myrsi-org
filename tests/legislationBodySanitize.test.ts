import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Legislation body write boundary (lib/db/government/legislation.ts).
//
// createLegislation / updateLegislation sanitised the body only when it was an
// OBJECT; any other value (a string of HTML, a JSON string, a number) was stored
// exactly as received — skipping sanitizeTiptapJson, the private-media key
// normalisation and assertDocImageCap. A non-object body is now refused; an
// absent/empty body keeps the legacy '' default; TipTap JSON objects (what
// LegislationTab sends) go through the same sanitiser path as before.
//
// createMotion had the same flaw for the motion description and gets the same
// treatment (absent/empty keeps its legacy NULL) — see the last describe block.

const h = vi.hoisted(() => ({
    writes: [] as Array<{ op: 'insert' | 'update'; values: Record<string, unknown> }>,
    status: 'Draft' as string,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        let op: 'select' | 'insert' | 'update' = 'select';
        let values: Record<string, unknown> = {};
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.insert = (v: Record<string, unknown>) => { op = 'insert'; values = v; h.writes.push({ op, values: v }); return b; };
        b.update = (v: Record<string, unknown>) => { op = 'update'; values = v; h.writes.push({ op, values: v }); return b; };
        const settle = () => {
            if (table === 'government_motions' && op === 'insert') {
                return Promise.resolve({ data: { id: 2, status: 'Open', created_at: 't', updated_at: 't', votes_for: 0, votes_against: 0, votes_abstain: 0, is_secret_ballot: false, ...values }, error: null });
            }
            if (table !== 'government_legislation') return Promise.resolve({ data: null, error: null });
            if (op === 'insert') {
                return Promise.resolve({ data: { id: 1, created_at: 't', updated_at: 't', votes_for: 0, votes_against: 0, votes_abstain: 0, ...values }, error: null });
            }
            if (op === 'update') return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: { status: h.status }, error: null });
        };
        b.single = settle;
        b.maybeSingle = settle;
        b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
    };
});

// orgMediaDocs → lib/storage imports the storage client; mock it so importing
// needs no env (normalisation itself is pure).
vi.mock('../lib/supabaseServer.js', () => ({
    supabase: { storage: { from: () => ({}) } },
    handleSupabaseError: () => {},
}));

import { createLegislation, updateLegislation, createMotion } from '../lib/db/government/legislation';
import { MAX_DOC_IMAGES } from '../lib/orgMediaDocs';

const CLEAN_DOC = {
    type: 'doc',
    content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section 1' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'The org shall keep a fleet register.' }] },
    ],
};

const lastWrite = (op: 'insert' | 'update') => [...h.writes].reverse().find(w => w.op === op)?.values;

const prevUrl = process.env.SUPABASE_URL;
beforeEach(() => {
    h.writes = [];
    h.status = 'Draft';
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
});
afterEach(() => { process.env.SUPABASE_URL = prevUrl; });

const NON_OBJECT_BODIES: Array<[string, unknown]> = [
    ['an HTML string', '<img src=x onerror=alert(1)><p>Bill</p>'],
    ['a plain string', 'Section 1. The org shall...'],
    ['a JSON-encoded TipTap string', JSON.stringify(CLEAN_DOC)],
    ['a whitespace-only string', '   '],
    ['a number', 42],
    ['a boolean', true],
];

describe('createLegislation — body must be a TipTap object', () => {
    for (const [label, body] of NON_OBJECT_BODIES) {
        it(`rejects ${label} and writes nothing`, async () => {
            await expect(createLegislation({ title: 'Bill', body, userId: 5 })).rejects.toThrow(/rich-text document/);
            expect(h.writes).toHaveLength(0);
        });
    }

    it('stores a clean TipTap object body unchanged', async () => {
        const created = await createLegislation({ title: 'Bill', body: structuredClone(CLEAN_DOC), userId: 5 });
        expect(lastWrite('insert')?.body).toEqual(CLEAN_DOC);
        expect(created?.body).toEqual(CLEAN_DOC);
    });

    it('still sanitises an object body (unsafe link href dropped)', async () => {
        const hostile = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }],
        };
        await createLegislation({ title: 'Bill', body: hostile, userId: 5 });
        expect(JSON.stringify(lastWrite('insert')?.body)).not.toContain('javascript:');
    });

    it('still normalises our signed private-media URL to its bare key', async () => {
        const signed = 'https://proj.supabase.co/storage/v1/object/sign/org-media/media/legislation/0b6f4c1e-1111-4222-8333-944445555666.webp?token=abc';
        const body = { type: 'doc', content: [{ type: 'image', attrs: { src: signed } }] };
        await createLegislation({ title: 'Bill', body, userId: 5 });
        const stored = JSON.stringify(lastWrite('insert')?.body);
        expect(stored).toContain('"media/legislation/0b6f4c1e-1111-4222-8333-944445555666.webp"');
        expect(stored).not.toContain('token=');
    });

    it('still enforces the per-document image cap on an object body', async () => {
        const body = {
            type: 'doc',
            content: Array.from({ length: MAX_DOC_IMAGES + 1 }, (_, i) => ({ type: 'image', attrs: { src: `https://img.example/${i}.png` } })),
        };
        await expect(createLegislation({ title: 'Bill', body, userId: 5 })).rejects.toThrow(/Too many images/);
        expect(h.writes).toHaveLength(0);
    });

    it('an absent / null / empty body keeps the legacy empty default', async () => {
        for (const body of [undefined, null, '']) {
            h.writes = [];
            await createLegislation({ title: 'Bill', body, userId: 5 });
            expect(lastWrite('insert')?.body).toBe('');
        }
    });
});

describe('updateLegislation — body must be a TipTap object', () => {
    for (const [label, body] of NON_OBJECT_BODIES) {
        it(`rejects ${label} and writes nothing`, async () => {
            await expect(updateLegislation(1, { body })).rejects.toThrow(/rich-text document/);
            expect(h.writes).toHaveLength(0);
        });
    }

    it('patches a clean TipTap object body unchanged', async () => {
        await updateLegislation(1, { body: structuredClone(CLEAN_DOC) });
        expect(lastWrite('update')?.body).toEqual(CLEAN_DOC);
    });

    it('still sanitises an object body on update', async () => {
        const hostile = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }],
        };
        await updateLegislation(1, { body: hostile });
        expect(JSON.stringify(lastWrite('update')?.body)).not.toContain('javascript:');
    });

    it('an update without a body leaves the body column out of the patch', async () => {
        await updateLegislation(1, { title: 'Renamed' });
        const patch = lastWrite('update');
        expect(patch?.title).toBe('Renamed');
        expect(patch).not.toHaveProperty('body');
    });

    it('the Voting-status guard still runs first', async () => {
        h.status = 'Voting';
        await expect(updateLegislation(1, { body: 'raw' })).rejects.toThrow(/voting is active/);
        expect(h.writes).toHaveLength(0);
    });
});

describe('createMotion — description must be a TipTap object', () => {
    for (const [label, description] of NON_OBJECT_BODIES) {
        it(`rejects ${label} and writes nothing`, async () => {
            await expect(createMotion({ title: 'Motion', description, userId: 5 })).rejects.toThrow(/rich-text document/);
            expect(h.writes).toHaveLength(0);
        });
    }

    it('stores a clean TipTap object description unchanged', async () => {
        const created = await createMotion({ title: 'Motion', description: structuredClone(CLEAN_DOC), userId: 5 });
        expect(lastWrite('insert')?.description).toEqual(CLEAN_DOC);
        expect(created?.description).toEqual(CLEAN_DOC);
    });

    it('still sanitises an object description (unsafe link href dropped)', async () => {
        const hostile = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }],
        };
        await createMotion({ title: 'Motion', description: hostile, userId: 5 });
        expect(JSON.stringify(lastWrite('insert')?.description)).not.toContain('javascript:');
    });

    it('enforces the per-document image cap on an object description', async () => {
        const description = {
            type: 'doc',
            content: Array.from({ length: MAX_DOC_IMAGES + 1 }, (_, i) => ({ type: 'image', attrs: { src: `https://img.example/${i}.png` } })),
        };
        await expect(createMotion({ title: 'Motion', description, userId: 5 })).rejects.toThrow(/Too many images/);
        expect(h.writes).toHaveLength(0);
    });

    it('an absent / null / empty description keeps the legacy NULL', async () => {
        for (const description of [undefined, null, '']) {
            h.writes = [];
            await createMotion({ title: 'Motion', description, userId: 5 });
            expect(lastWrite('insert')?.description).toBeNull();
        }
    });

    // Pinned so nobody "completes" the parity with the bill body by adding
    // normalizeDocMediaForStorage alone: getMotionsState never re-signs private keys,
    // so a bare key stored here would render as a broken image on the next read.
    it('does NOT collapse a signed private-media URL to its key (the motion read path never re-signs)', async () => {
        const signed = 'https://proj.supabase.co/storage/v1/object/sign/org-media/media/legislation/0b6f4c1e-1111-4222-8333-944445555666.webp?token=abc';
        await createMotion({ title: 'Motion', description: { type: 'doc', content: [{ type: 'image', attrs: { src: signed } }] }, userId: 5 });
        expect(JSON.stringify(lastWrite('insert')?.description)).toContain(signed);
    });
});
