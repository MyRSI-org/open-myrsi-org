// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// @google/genai 2.29.0 stopped inheriting undici's 300s timeouts: a client built without
// httpOptions.timeout now sends with no client-side bound, and re-sends without limit while the
// server answers finish_reason CONTINUATION. lib/ai.ts sets both explicitly. These pin the
// wiring, and that the installed SDK really aborts a hung call on its default transport, so an
// SDK bump that stops honouring the option fails here instead of hanging an RPC in production.

const sdk = vi.hoisted(() => ({ ctor: vi.fn(), generate: vi.fn() }));

vi.mock('@google/genai', () => ({
    GoogleGenAI: class {
        models = { generateContent: sdk.generate };
        constructor(opts: unknown) { sdk.ctor(opts); }
    },
}));
vi.mock('../lib/db', () => ({
    supabase: {
        from: () => ({ select: () => ({ in: async () => ({ data: [{ key: 'aiConfig', value: { enabled: true } }], error: null }) }) }),
    },
    saveDossierSummary: vi.fn(),
}));
vi.mock('../lib/secrets', () => ({ getOrgSecret: async () => 'test-key' }));

import { generateDossierSummary, generateAARSummary, GEMINI_TIMEOUT_MS } from '../lib/ai';
import type { DossierData } from '../types';

beforeEach(() => {
    sdk.ctor.mockReset();
    sdk.generate.mockReset();
});

const expectBoundedCall = () => {
    expect(sdk.ctor).toHaveBeenCalledTimes(1);
    expect(sdk.ctor).toHaveBeenCalledWith({ apiKey: 'test-key', httpOptions: { timeout: GEMINI_TIMEOUT_MS } });
    expect(sdk.generate).toHaveBeenCalledTimes(1);
    expect(sdk.generate.mock.calls[0][0]).toMatchObject({ config: { automaticContinuation: false } });
};

describe('Gemini calls are bounded explicitly, not by SDK defaults', () => {
    it('never looser than the 300s the SDK used to inherit from undici', () => {
        expect(Number.isFinite(GEMINI_TIMEOUT_MS)).toBe(true);
        expect(GEMINI_TIMEOUT_MS).toBeGreaterThan(0);
        expect(GEMINI_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
    });

    it('dossier summary: timeout on the client, one request per call', async () => {
        sdk.generate.mockResolvedValue({ text: 'summary' });
        await expect(generateDossierSummary({ targetId: 'T' } as DossierData)).resolves.toBe('summary');
        expectBoundedCall();
    });

    it('AAR draft: timeout on the client, one request per call', async () => {
        sdk.generate.mockResolvedValue({ text: '{"summary":"s","lessonsLearned":"- l"}' });
        await expect(generateAARSummary({ name: 'Op', participantCount: 1, entries: [] })).resolves.toEqual({ summary: 's', lessonsLearned: '- l' });
        expectBoundedCall();
    });
});

describe('the installed SDK honours httpOptions.timeout on its default transport', () => {
    it('aborts a request the server never answers', async () => {
        const { GoogleGenAI } = await vi.importActual<typeof import('@google/genai')>('@google/genai');
        let received = 0;
        // Accepts and then never answers, the shape of a hung upstream.
        const server: Server = createServer(() => { received++; });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const { port } = server.address() as AddressInfo;
        try {
            const ai = new GoogleGenAI({ apiKey: 'k', httpOptions: { baseUrl: `http://127.0.0.1:${port}`, timeout: 200 } });
            const t0 = performance.now();
            await expect(ai.models.generateContent({ model: 'm', contents: 'x', config: { automaticContinuation: false } })).rejects.toThrow();
            const elapsed = performance.now() - t0;
            // The request reached the server and the rejection came from the timer, not from
            // a transport that failed before sending.
            expect(received).toBe(1);
            expect(elapsed).toBeGreaterThanOrEqual(150);
            expect(elapsed).toBeLessThan(3000);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((r) => server.close(() => r()));
        }
    }, 5000);
});
