import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Pins lib/db/uex.ts — the single funnel for every UEX HTTP call (warehouse commodity
// sync, quartermaster item sync, all nine location syncs).
//
// Two operator-reported problems drive this file:
//
//  1. Catalog sync failed with a 403 carrying a Cloudflare "Just a moment..." page,
//     while a plain curl with the SAME token from the SAME host returned 200 — the CDN
//     challenging the server's egress IP on that zone. The base host was hardcoded, so
//     the only fix was editing source and rebuilding. It is now UEX_API_BASE.
//
//  2. That interstitial surfaced to the admin as 300 characters of raw HTML, because
//     the thrown message interpolated `body.slice(0, 300)`. Third-party response bytes
//     must never reach a client-visible string — and there are TWO channels, not one:
//     the throw path (api/services.ts returns error.message), and fetchAllUexItems'
//     `errors[]`, which rides a 200 OK to the admin catalog tab. The classifier
//     therefore lives INSIDE uexFetch, before the Error is constructed.

const h = vi.hoisted(() => ({ warns: [] as Array<{ msg: string; fields: Record<string, unknown> }> }));

vi.mock('../lib/log', () => {
    const child = () => ({
        info: () => {}, error: () => {}, debug: () => {},
        warn: (msg: string, fields: Record<string, unknown>) => { h.warns.push({ msg, fields }); },
        child,
    });
    return { log: { child, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };
});

import {
    classifyUexFailure,
    uexFailureMessage,
    fetchUexCommodities,
    fetchUexCategories,
    fetchAllUexItems,
    UEX_TIMEOUT_MS,
} from '../lib/db/uex';

const DEFAULT_BASE = 'https://api.uexcorp.space/2.0';
const ALT_BASE = 'https://api.uexcorp.uk/2.0';
const KEY = 'uex-secret-token-value';

// A trimmed-down version of what Cloudflare actually serves.
const CHALLENGE_HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title></head>'
    + '<body><div id="cf-wrapper">Checking your browser… ray id 8f2c1d0e</div></body></html>';

let fetchSpy: ReturnType<typeof vi.fn>;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['UEX_API_KEY', 'UEX_API_BASE', 'UEX_REQUEST_DELAY_MS'] as const;

/** Queue one response per call, in order. */
function respondWith(...responses: Array<{ status?: number; contentType?: string; body?: string }>) {
    let i = 0;
    fetchSpy.mockImplementation(async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        const status = r.status ?? 200;
        const contentType = r.contentType ?? 'application/json';
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : n.toLowerCase() === 'cf-ray' ? '8f2c1d0e-LHR' : null) },
            text: async () => r.body ?? '',
            json: async () => JSON.parse(r.body ?? '{"status":"ok","data":[]}'),
        } as unknown as Response;
    });
}

const okJson = (data: unknown) => ({ body: JSON.stringify({ status: 'ok', data }) });

beforeEach(() => {
    h.warns.length = 0;
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.UEX_API_KEY = KEY;
    delete process.env.UEX_API_BASE;
    process.env.UEX_REQUEST_DELAY_MS = '0'; // don't sleep 600ms per request in tests
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('classifyUexFailure — the three failures need three different operator actions', () => {
    it('classifies an HTML interstitial as a CDN challenge, whatever the status', () => {
        expect(classifyUexFailure(403, 'text/html; charset=UTF-8', CHALLENGE_HTML)).toBe('challenge');
        expect(classifyUexFailure(503, 'text/html', CHALLENGE_HTML)).toBe('challenge');
        // Body sniffing covers a mislabelled or absent content-type.
        expect(classifyUexFailure(403, '', CHALLENGE_HTML)).toBe('challenge');
        expect(classifyUexFailure(403, '', '  \n<html><body>Just a moment...</body></html>')).toBe('challenge');
    });

    it('classifies a JSON 401/403 as a credential problem, NOT a challenge', () => {
        const denied = '{"status":"access_denied","message":"Invalid bearer token"}';
        expect(classifyUexFailure(403, 'application/json', denied)).toBe('credential');
        expect(classifyUexFailure(401, 'application/json', denied)).toBe('credential');
    });

    it('classifies 429 as rate-limit ahead of everything else', () => {
        expect(classifyUexFailure(429, 'application/json', '{}')).toBe('rate-limit');
        expect(classifyUexFailure(429, 'text/html', CHALLENGE_HTML)).toBe('rate-limit');
    });

    it('classifies anything else as an upstream fault', () => {
        expect(classifyUexFailure(500, 'application/json', '{"status":"error"}')).toBe('upstream');
        expect(classifyUexFailure(404, 'application/json', '{}')).toBe('upstream');
    });
});

describe('uexFailureMessage — actionable, and derived only from classified fields', () => {
    it('points a challenge at UEX_API_BASE and names the alternate host', () => {
        const m = uexFailureMessage('/commodities', 403, 'challenge');
        expect(m).toContain('UEX_API_BASE');
        expect(m).toContain(ALT_BASE);
        // The distinguishing symptom, so the operator doesn't chase their API key.
        expect(m).toContain('not a bad API key');
    });

    it('points a credential failure at UEX_API_KEY and a 429 at the delay knob', () => {
        expect(uexFailureMessage('/commodities', 403, 'credential')).toContain('UEX_API_KEY');
        expect(uexFailureMessage('/commodities', 429, 'rate-limit')).toContain('UEX_REQUEST_DELAY_MS');
    });
});

describe('UEX_API_BASE', () => {
    it('defaults to api.uexcorp.space — working installs are not migrated off it', async () => {
        respondWith(okJson([]));
        await fetchUexCommodities();
        expect(fetchSpy.mock.calls[0][0]).toBe(`${DEFAULT_BASE}/commodities`);
    });

    it('is overridable, so the Cloudflare workaround needs no source edit or rebuild', async () => {
        process.env.UEX_API_BASE = ALT_BASE;
        respondWith(okJson([]));
        await fetchUexCommodities();
        expect(fetchSpy.mock.calls[0][0]).toBe(`${ALT_BASE}/commodities`);
    });

    it('strips a trailing slash rather than emitting a doubled path separator', async () => {
        process.env.UEX_API_BASE = `${ALT_BASE}/`;
        respondWith(okJson([]));
        await fetchUexCommodities();
        expect(fetchSpy.mock.calls[0][0]).toBe(`${ALT_BASE}/commodities`);
    });

    it('falls back to the default — and sends the Bearer NOWHERE ELSE — when the value is junk', async () => {
        for (const junk of ['not a url', 'ftp://api.uexcorp.uk/2.0', '   ']) {
            fetchSpy.mockClear();
            process.env.UEX_API_BASE = junk;
            respondWith(okJson([]));
            await fetchUexCommodities();
            // Asserted on the recorded URL, not the return value: a rejected base must
            // never receive a credentialed request in the first place.
            expect(fetchSpy.mock.calls[0][0]).toBe(`${DEFAULT_BASE}/commodities`);
        }
    });

    it('is part of the category cache key, so repointing mid-hour actually repoints', async () => {
        respondWith(okJson([{ id: 1, name: 'Ship Weapons', type: 'item' }]));
        await fetchUexCategories(true);
        const callsAfterFirst = fetchSpy.mock.calls.length;

        // Same base → served from cache.
        await fetchUexCategories();
        expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);

        // New base → must go back out to the new host.
        process.env.UEX_API_BASE = ALT_BASE;
        await fetchUexCategories();
        expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst + 1);
        expect(fetchSpy.mock.calls[callsAfterFirst][0]).toBe(`${ALT_BASE}/categories`);
    });
});

describe('request shape', () => {
    it('sends the Bearer, identifies itself, and bounds the request', async () => {
        respondWith(okJson([]));
        await fetchUexCommodities();
        const init = fetchSpy.mock.calls[0][1];
        expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
        expect(init.headers['User-Agent']).toContain('myRSI');
        // No timeout previously, against undici's 300s default — ~67 sequential calls
        // could hang an admin's sync for hours. Assert the BOUND, not just that a
        // signal exists: `toBeInstanceOf(AbortSignal)` alone would still pass if the
        // timeout were raised back to 300s.
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(UEX_TIMEOUT_MS).toBeGreaterThan(0);
        expect(UEX_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    });

    it('throws before any fetch when UEX_API_KEY is unset', async () => {
        delete process.env.UEX_API_KEY;
        await expect(fetchUexCommodities()).rejects.toThrow(/UEX_API_KEY/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------

/** Every way a third party's bytes could have leaked into an operator-visible string. */
function expectNoUpstreamBytes(message: string) {
    expect(message).not.toContain('<');
    expect(message).not.toMatch(/doctype/i);
    expect(message).not.toContain('cf-wrapper');
    expect(message).not.toContain('Checking your browser');
    // Rule 5: nothing that could carry a reflected credential.
    expect(message).not.toContain(KEY);
    expect(message).not.toContain('Bearer');
}

describe('a Cloudflare interstitial never reaches the operator as raw HTML', () => {
    it('THROW PATH: the thrown message is classified, not the response body', async () => {
        respondWith({ status: 403, contentType: 'text/html; charset=UTF-8', body: CHALLENGE_HTML });
        await expect(fetchUexCommodities()).rejects.toThrow(/anti-bot challenge/);

        const err = await fetchUexCommodities().catch((e: Error) => e);
        expectNoUpstreamBytes((err as Error).message);
        expect((err as Error).message).toContain('UEX_API_BASE');
    });

    it('SUCCESS PATH: fetchAllUexItems errors[] is client-visible too, and is equally clean', async () => {
        // /categories succeeds, then every per-category /items call is challenged —
        // the warm-cache shape, where the action returns 200 with fetchErrors rather
        // than failing loudly.
        process.env.UEX_API_BASE = 'https://items-challenged.uexcorp.uk/2.0'; // also busts the category cache
        respondWith(
            okJson([{ id: 1, name: 'Ship Weapons', type: 'item' }]),
            { status: 403, contentType: 'text/html', body: CHALLENGE_HTML },
        );

        const { errors, items } = await fetchAllUexItems();
        expect(items).toEqual([]);
        expect(errors.length).toBe(1);
        expectNoUpstreamBytes(errors[0].message);
        expect(errors[0].message).toContain('UEX_API_BASE');
    });

    it('logs the diagnostic detail server-side, where the operator can actually use it', async () => {
        respondWith({ status: 403, contentType: 'text/html', body: CHALLENGE_HTML });
        await fetchUexCommodities().catch(() => {});

        const warn = h.warns.find(w => w.msg === 'uex request failed');
        expect(warn).toBeDefined();
        expect(warn!.fields).toMatchObject({ status: 403, kind: 'challenge', cfRay: '8f2c1d0e-LHR' });
    });

    it('scrubs a reflected credential out of the logged body preview', async () => {
        // The realistic trigger for the feature this diff adds: UEX_API_BASE pointed at
        // the operator's own proxy, whose debug/error page echoes the request headers.
        // lib/log.ts cannot catch this — it redacts by field KEY, and value-scans only
        // Errors and stringified objects, never a plain string field like bodyPreview.
        respondWith({
            status: 502,
            contentType: 'text/plain',
            body: `proxy error, upstream request was:\nAuthorization: Bearer ${KEY}\nHost: api.uexcorp.space`,
        });
        await fetchUexCommodities().catch(() => {});

        const warn = h.warns.find(w => w.msg === 'uex request failed');
        const preview = String(warn!.fields.bodyPreview);
        expect(preview).not.toContain(KEY);
        expect(preview).toContain('[REDACTED]');
        // Still useful: the non-secret part of the upstream message survives.
        expect(preview).toContain('proxy error');
    });
});

describe('non-JSON 2xx is caught before res.json()', () => {
    it('reports a challenge served with a 200 instead of leaking a JSON parser error', async () => {
        // A SyntaxError from res.json() has no code/errno, so lib/errors.ts does not
        // treat it as opaque and the raw parser message would cross the wire.
        respondWith({ status: 200, contentType: 'text/html', body: CHALLENGE_HTML });
        const err = await fetchUexCommodities().catch((e: Error) => e) as Error;
        expect(err.message).toContain('anti-bot challenge');
        expect(err.message).not.toMatch(/Unexpected token|is not valid JSON|JSON\.parse/i);
        expectNoUpstreamBytes(err.message);
    });
});
