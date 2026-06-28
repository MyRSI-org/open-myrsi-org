import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// RSI handle verification (verifyRsiHandle) is reachable PRE-AUTH
// (auth:finalize_setup is a PUBLIC_ACTION) with an attacker-chosen handle, so its
// outbound request to robertsspaceindustries.com MUST flow through the SSRF guard
// (ssrfSafeFetch: DNS-pin + redirect refusal + body ceiling) and NEVER bare
// fetch(). These tests fail if the handler reverts to a bare global fetch().

const h = vi.hoisted(() => ({
    body: '' as string,
    status: 200 as number,
    redirectStatus: 0 as number,
    calls: [] as Array<{ url: string; init: { headers?: Record<string, string> } | undefined }>,
}));

// ssrfSafeFetch is mocked to a controllable stub. If production code uses bare
// fetch() instead, this mock is never invoked → the call-count assertions fail.
vi.mock('../lib/ssrf', () => ({
    assertResolvesToPublicHost: vi.fn(async () => []),
    ssrfSafeFetch: vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        h.calls.push({ url, init });
        // Mirror the real guard: a 3xx is a hard error (redirect refusal).
        if (h.redirectStatus >= 300 && h.redirectStatus < 400) {
            throw new Error(`Peer responded with a redirect (${h.redirectStatus}) — refused (SSRF guard)`);
        }
        return {
            ok: h.status < 400,
            status: h.status,
            text: async () => h.body,
        } as unknown as Response;
    }),
}));

import { ssrfSafeFetch } from '../lib/ssrf';
import { verifyRsiHandle, generateRsiVerificationCode } from '../lib/rsi';

// A bare global fetch must never be touched by the verification path.
let bareFetch: ReturnType<typeof vi.fn>;

const VALID_CODE = 'MYRSI-validcode123';

beforeEach(() => {
    vi.clearAllMocks();
    h.body = '';
    h.status = 200;
    h.redirectStatus = 0;
    h.calls = [];
    bareFetch = vi.fn(async () => { throw new Error('bare fetch must not be used by verifyRsiHandle'); });
    vi.stubGlobal('fetch', bareFetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('verifyRsiHandle outbound fetch goes through ssrfSafeFetch', () => {
    it('routes the request through ssrfSafeFetch exactly once and never bare fetch()', async () => {
        h.body = `<html>... ${VALID_CODE} ...</html>`;
        const result = await verifyRsiHandle('SomeHandle', VALID_CODE);
        expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
        expect(bareFetch).not.toHaveBeenCalled();
        expect(result).toBe(true);
    });

    it('targets the canonical citizens URL with the verification User-Agent', async () => {
        h.body = VALID_CODE;
        await verifyRsiHandle('SomeHandle', VALID_CODE);
        expect(h.calls[0].url).toBe('https://robertsspaceindustries.com/citizens/SomeHandle');
        expect(h.calls[0].init?.headers?.['User-Agent']).toBe('MyRSI-Dashboard-Verification/1.0');
    });

    it('encodeURIComponent-escapes reserved chars in the handle (no path injection)', async () => {
        h.body = VALID_CODE;
        await verifyRsiHandle('a/b', VALID_CODE);
        expect(h.calls[0].url).toBe('https://robertsspaceindustries.com/citizens/a%2Fb');
    });

    it('result reflects html.includes(code): false when the code is absent', async () => {
        h.body = '<html>nothing to see here</html>';
        const result = await verifyRsiHandle('SomeHandle', VALID_CODE);
        expect(result).toBe(false);
        expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a too-short code without making ANY outbound request', async () => {
        const result = await verifyRsiHandle('SomeHandle', 'short');
        expect(result).toBe(false);
        expect(ssrfSafeFetch).not.toHaveBeenCalled();
        expect(bareFetch).not.toHaveBeenCalled();
    });

    it('surfaces a friendly not-found error on HTTP 404', async () => {
        h.status = 404;
        await expect(verifyRsiHandle('Ghost', VALID_CODE)).rejects.toThrow(/not found/i);
        expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
    });

    it('a 3xx redirect from the guard never yields a passing verification', async () => {
        h.redirectStatus = 302;
        await expect(verifyRsiHandle('SomeHandle', VALID_CODE)).rejects.toThrow(/could not connect/i);
        expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
        expect(bareFetch).not.toHaveBeenCalled();
    });

    it('a server-issued code clears the length gate and is verified end-to-end', async () => {
        const code = generateRsiVerificationCode();
        expect(code.length).toBeGreaterThanOrEqual(10);
        h.body = `bio contains ${code}`;
        await expect(verifyRsiHandle('SomeHandle', code)).resolves.toBe(true);
        expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
    });
});
