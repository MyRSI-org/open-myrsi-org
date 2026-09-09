import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFeedCursor, FEED_CURSOR_MAX_SKEW_MS } from '../lib/feedCursor';

// =============================================================================
// Federation feed cursor — the silent-data-loss guard
// =============================================================================
// The failure this prevents is not an error, which is what makes it dangerous. The
// cursor goes into `.gt('created_at', since)` and the response hands back
// `_meta.fetchedAt`, which the consumer stores as its NEXT cursor. So a cursor the
// server accepts but cannot honour returns an empty page, the consumer reads that as
// "no new intel", advances past rows it never received, and never asks for them again.
//
// A future-dated cursor is the worst version: it is valid SQL, matches nothing, and
// every subsequent pull from that peer is empty until the wall clock catches up. A peer
// whose clock is a day fast loses a day of intel and sees no error at either end.

const NOW = Date.parse('2026-09-05T12:00:00.000Z');

describe('parseFeedCursor accepts what it can honour', () => {
    it('treats an absent cursor as "from the beginning"', () => {
        for (const v of [undefined, null, '', '   ']) {
            const r = parseFeedCursor(v, NOW);
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.since).toBeUndefined();
        }
    });

    it('accepts an ISO timestamp and normalises it', () => {
        const r = parseFeedCursor('2026-09-01T00:00:00Z', NOW);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.since).toBe('2026-09-01T00:00:00.000Z');
    });

    it('accepts a peer a few seconds ahead — normal clock skew is not an error', () => {
        const slightlyAhead = new Date(NOW + 30_000).toISOString();
        expect(parseFeedCursor(slightlyAhead, NOW).ok).toBe(true);
    });

    it('accepts exactly the skew allowance', () => {
        const edge = new Date(NOW + FEED_CURSOR_MAX_SKEW_MS).toISOString();
        expect(parseFeedCursor(edge, NOW).ok).toBe(true);
    });
});

describe('parseFeedCursor refuses what it cannot honour', () => {
    it('rejects a malformed timestamp rather than passing it to the query', () => {
        for (const v of ['yesterday', 'NaN', '2026-13-45', '; DROP TABLE']) {
            const r = parseFeedCursor(v, NOW);
            expect(r.ok, `${v} must be rejected`).toBe(false);
            if (!r.ok) expect(r.reason).toBe('malformed');
        }
    });

    it('rejects a bare number — it parses as a far-future YEAR, not a timestamp', () => {
        // Date.parse('12345') is year 12345, not "12345 milliseconds". So a consumer
        // that sent epoch millis instead of ISO gets caught by the future guard rather
        // than the malformed one. Either way it is refused, which is what matters —
        // recorded here because the reason is surprising and the next reader will hit it.
        const r = parseFeedCursor('12345', NOW);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('future');
    });

    it('rejects a FUTURE cursor — the silent-loss case', () => {
        // Without this the peer gets 200 + an empty page forever, and reads it as
        // "no new intel" rather than "my clock is wrong".
        const wayAhead = new Date(NOW + 25 * 3600_000).toISOString();
        const r = parseFeedCursor(wayAhead, NOW);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toBe('future');
            expect(r.message).toMatch(/clock/i);
        }
    });

    it('rejects a non-string cursor', () => {
        const r = parseFeedCursor({ evil: true } as unknown, NOW);
        expect(r.ok).toBe(false);
    });

    it('treats a REPEATED param as absent rather than guessing', () => {
        // ?since=a&since=b arrives as an array. Picking one silently serves the wrong
        // window; serving from the beginning over-serves, which the consumer dedups.
        // Over-serving is recoverable, under-serving is not.
        const r = parseFeedCursor(['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'], NOW);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.since).toBeUndefined();
    });
});

describe('the feed endpoint wires the validator and is rate limited', () => {
    const ROOT = resolve(__dirname, '..');
    const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

    it('handleFeed validates the cursor and 400s instead of passing it through', () => {
        const query = read('api/query.ts');
        expect(query).toContain('parseFeedCursor(req.query.since)');
        expect(query, 'an unhonourable cursor must be refused, not silently served')
            .toContain('return res.status(400).json({ message: cursor.message })');
        expect(query, 'the raw query value must not reach the data layer any more')
            .not.toContain('const since = req.query.since as string;');
    });

    it('the feed has its own limiter, keyed on the API key rather than the IP', () => {
        const server = read('server.ts');
        expect(server).toContain('const feedLimiter = rateLimit(');
        expect(server, 'a live credential must not become a rate-limiter bucket name')
            .toContain("createHash('sha256').update(key)");
        expect(server, 'it must engage only for the feed target, not the whole app')
            .toContain("req.query?.target === 'feed' ? feedLimiter(req, res, next) : next()");
    });

    it('the limiter is registered BEFORE the query handler', () => {
        // Express matches in registration order: registered after, it never runs.
        const server = read('server.ts');
        const limiterAt = server.indexOf("? feedLimiter(req, res, next) : next()");
        const handlerAt = server.indexOf("app.get('/api/query', async (req, res)");
        expect(limiterAt).toBeGreaterThan(-1);
        expect(handlerAt).toBeGreaterThan(-1);
        expect(limiterAt, 'the limiter middleware must be registered first or it is dead code')
            .toBeLessThan(handlerAt);
    });
});
