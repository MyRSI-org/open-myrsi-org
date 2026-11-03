// @vitest-environment node
//
// lib/operations/payouts.ts computePayouts — the estimated split of an op's net
// pool under its payout mode. Complements tests/computePayouts.test.ts with the
// data-integrity edges: the CONCLUDED op (every participant has timeLeft), weighted
// re-joins / clamping / zero-time, custom zero-share and all-zero renormalisation,
// the never-over-distribute floor, exact splits not shaved by float error, and the
// defaults for missing mode / roster / name.
//
// All instants are built with Date.UTC and passed as ISO strings, so the maths is
// independent of the machine time zone.
import { describe, it, expect } from 'vitest';
import { computePayouts } from '../lib/operations/payouts';
import type { HydratedOperation } from '../types';

const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function op(partial: Partial<HydratedOperation>): HydratedOperation {
    return { id: 'op-1', name: 'Op', payoutMode: 'equal', participants: [], ...partial } as unknown as HydratedOperation;
}

function part(userId: number, extras: Record<string, unknown> = {}) {
    return { userId, user: { id: userId, name: `U${userId}` }, timeJoined: iso(START), isReady: false, ...extras };
}

describe('defaults', () => {
    it('returns [] when participants is absent', () => {
        expect(computePayouts(op({ participants: undefined as unknown as HydratedOperation['participants'] }), 100)).toEqual([]);
    });

    it('treats a missing payoutMode as equal', () => {
        const rows = computePayouts(op({ payoutMode: undefined, participants: [part(1), part(2)] as any }), 100);
        expect(rows).toEqual([
            { userId: 1, name: 'U1', sharePercent: 50, amount: 50 },
            { userId: 2, name: 'U2', sharePercent: 50, amount: 50 },
        ]);
    });

    it("falls back to 'Unknown' when a participant has no hydrated user — in every mode", () => {
        const anon = { userId: 9, timeJoined: iso(START), isReady: false };
        expect(computePayouts(op({ payoutMode: 'equal', participants: [anon] as any }), 10)[0].name).toBe('Unknown');
        expect(computePayouts(op({ payoutMode: 'custom', participants: [{ ...anon, payoutSharePercent: 100 }] as any }), 10)[0].name).toBe('Unknown');
        expect(computePayouts(op({
            payoutMode: 'weighted', activeStartTime: iso(START), activeEndTime: iso(START + MIN), participants: [anon] as any,
        }), 10)[0].name).toBe('Unknown');
    });
});

describe('equal mode', () => {
    it('floors each share so the rows never sum to more than the pool', () => {
        const rows = computePayouts(op({ participants: [part(1), part(2), part(3)] as any }), 100);
        expect(rows.map(r => r.amount)).toEqual([33, 33, 33]);
        expect(rows.reduce((s, r) => s + r.amount, 0)).toBeLessThanOrEqual(100);
        for (const r of rows) expect(r.sharePercent).toBeCloseTo(100 / 3, 10);
    });

    it('CONCLUDED op (every participant has left) splits across the full roster instead of returning nothing', () => {
        const rows = computePayouts(op({
            status: 'Completed' as any,
            participants: [
                part(1, { timeLeft: iso(START + 60 * MIN) }),
                part(2, { timeLeft: iso(START + 30 * MIN) }),
            ] as any,
        }), 1000);
        expect(rows).toEqual([
            { userId: 1, name: 'U1', sharePercent: 50, amount: 500 },
            { userId: 2, name: 'U2', sharePercent: 50, amount: 500 },
        ]);
    });
});

describe('weighted mode', () => {
    it('CONCLUDED op uses each participant\'s real departure time, not the op end', () => {
        const rows = computePayouts(op({
            payoutMode: 'weighted',
            activeStartTime: iso(START),
            activeEndTime: iso(START + 90 * MIN),
            participants: [
                part(1, { timeLeft: iso(START + 60 * MIN) }), // 60 min
                part(2, { timeLeft: iso(START + 30 * MIN) }), // 30 min
            ] as any,
        }), 900);
        expect(rows.map(r => [r.userId, r.amount])).toEqual([[1, 600], [2, 300]]);
        expect(rows[0].sharePercent).toBeCloseTo(200 / 3, 10);
        expect(rows[1].sharePercent).toBeCloseTo(100 / 3, 10);
    });

    it('an exact split is not shaved by float error (1:2 of 900 is 300 / 600, not 299 / 600)', () => {
        const rows = computePayouts(op({
            payoutMode: 'weighted',
            activeStartTime: iso(START),
            activeEndTime: iso(START + 3 * MIN),
            participants: [part(1, { timeLeft: iso(START + MIN) }), part(2, { timeJoined: iso(START + MIN) })] as any,
        }), 900);
        expect(rows.map(r => r.amount)).toEqual([300, 600]);
        expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(900);
    });

    it('a live op (no activeEndTime) measures still-active participants up to nowMs', () => {
        const rows = computePayouts(op({
            payoutMode: 'weighted',
            activeStartTime: iso(START),
            participants: [
                part(1),                                         // active: start..now = 40 min
                part(2, { timeLeft: iso(START + 10 * MIN) }),    // 10 min
            ] as any,
        }), 500, START + 40 * MIN);
        expect(rows.map(r => [r.userId, r.amount])).toEqual([[1, 400], [2, 100]]);
    });

    it('clamps a join before the op started to the op start', () => {
        const rows = computePayouts(op({
            payoutMode: 'weighted',
            activeStartTime: iso(START),
            activeEndTime: iso(START + 20 * MIN),
            participants: [
                part(1, { timeJoined: iso(START - 600 * MIN) }), // early join counts from START: 20 min
                part(2, { timeJoined: iso(START + 10 * MIN) }),  // 10 min
            ] as any,
        }), 300);
        expect(rows.map(r => [r.userId, r.amount])).toEqual([[1, 200], [2, 100]]);
    });

    it('a departure recorded before the join contributes zero time, never negative time', () => {
        const rows = computePayouts(op({
            payoutMode: 'weighted',
            activeStartTime: iso(START),
            activeEndTime: iso(START + 30 * MIN),
            participants: [
                part(1),
                part(2, { timeJoined: iso(START + 20 * MIN), timeLeft: iso(START + 5 * MIN) }),
            ] as any,
        }), 100);
        expect(rows).toEqual([
            { userId: 1, name: 'U1', sharePercent: 100, amount: 100 },
            { userId: 2, name: 'U2', sharePercent: 0, amount: 0 },
        ]);
    });

    it('aggregates a re-join into ONE row per user, summing both stints', () => {
        const rows = computePayouts(op({
            payoutMode: 'weighted',
            activeStartTime: iso(START),
            activeEndTime: iso(START + 60 * MIN),
            participants: [
                part(1, { timeLeft: iso(START + 10 * MIN) }),                                     // 10 min
                part(2),                                                                         // 60 min
                part(1, { timeJoined: iso(START + 30 * MIN), user: { id: 1, name: 'Renamed' } }), // +30 min
            ] as any,
        }), 1000);
        expect(rows).toHaveLength(2);
        const u1 = rows.find(r => r.userId === 1)!;
        // 40 of 100 total minutes; the name is taken from the FIRST stint.
        expect(u1).toEqual({ userId: 1, name: 'U1', sharePercent: 40, amount: 400 });
        expect(rows.find(r => r.userId === 2)!.amount).toBe(600);
    });

    it('returns [] when no participant accrued any time (no divide-by-zero NaN rows)', () => {
        const rows = computePayouts(op({
            payoutMode: 'weighted',
            activeStartTime: iso(START),
            activeEndTime: iso(START),
            participants: [part(1), part(2)] as any,
        }), 1000);
        expect(rows).toEqual([]);
    });
});

describe('custom mode', () => {
    it('a participant without a persisted share gets 0, the others are renormalised to 100', () => {
        const rows = computePayouts(op({
            payoutMode: 'custom',
            participants: [part(1, { payoutSharePercent: 30 }), part(2), part(3, { payoutSharePercent: 30 })] as any,
        }), 1000);
        expect(rows).toEqual([
            { userId: 1, name: 'U1', sharePercent: 50, amount: 500 },
            { userId: 2, name: 'U2', sharePercent: 0, amount: 0 },
            { userId: 3, name: 'U3', sharePercent: 50, amount: 500 },
        ]);
    });

    it('a non-numeric persisted share is treated as 0, not concatenated or coerced', () => {
        const rows = computePayouts(op({
            payoutMode: 'custom',
            participants: [part(1, { payoutSharePercent: '90' }), part(2, { payoutSharePercent: 10 })] as any,
        }), 100);
        expect(rows.map(r => [r.userId, r.sharePercent, r.amount])).toEqual([[1, 0, 0], [2, 100, 100]]);
    });

    it('all-zero shares yield 0% / 0 for everyone (no NaN from 100/0)', () => {
        const rows = computePayouts(op({
            payoutMode: 'custom',
            participants: [part(1, { payoutSharePercent: 0 }), part(2)] as any,
        }), 1000);
        expect(rows).toEqual([
            { userId: 1, name: 'U1', sharePercent: 0, amount: 0 },
            { userId: 2, name: 'U2', sharePercent: 0, amount: 0 },
        ]);
    });

    it('ignores timeLeft — a departed participant keeps their agreed share', () => {
        const rows = computePayouts(op({
            payoutMode: 'custom',
            participants: [part(1, { payoutSharePercent: 25, timeLeft: iso(START) }), part(2, { payoutSharePercent: 75 })] as any,
        }), 400);
        expect(rows.map(r => [r.userId, r.amount])).toEqual([[1, 100], [2, 300]]);
    });

    it('an exact split is not shaved by float error (3:6 of 900 is 300 / 600, not 299 / 600)', () => {
        const rows = computePayouts(op({
            payoutMode: 'custom',
            participants: [part(1, { payoutSharePercent: 3 }), part(2, { payoutSharePercent: 6 })] as any,
        }), 900);
        expect(rows.map(r => r.amount)).toEqual([300, 600]);
        expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(900);
    });

    it('floors each amount (sum never exceeds the pool)', () => {
        const rows = computePayouts(op({
            payoutMode: 'custom',
            participants: [part(1, { payoutSharePercent: 1 }), part(2, { payoutSharePercent: 1 }), part(3, { payoutSharePercent: 1 })] as any,
        }), 100);
        expect(rows.map(r => r.amount)).toEqual([33, 33, 33]);
    });
});
