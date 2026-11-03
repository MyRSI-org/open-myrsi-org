import type { HydratedOperation, OperationPayoutMode } from '../../types.js';

export interface PayoutRow {
    userId: number;
    name: string;
    sharePercent: number;
    amount: number;
}

type Participant = HydratedOperation['participants'][number];

/**
 * Compute estimated payouts for an operation under the operation's current
 * `payoutMode`. Pure function — easy to unit-test, no React/DOM dependencies.
 *
 *   * `equal`     — each *active* (timeLeft === null) participant gets 1/N.
 *   * `weighted`  — time-weighted across the whole operation lifetime; mirrors
 *                   the legacy OpLedgerTab behaviour. Falls back to equal-split
 *                   when the op has no `activeStartTime`.
 *   * `custom`    — uses each participant's `payoutSharePercent`. If the sum
 *                   doesn't equal 100 (defensive — server validates on write),
 *                   the values are renormalised so the math still holds.
 *
 * `netPool` may be negative (when costs exceed deposits); the function passes
 * that sign through to the caller, which decides how to render.
 */
export function computePayouts(
    operation: HydratedOperation,
    netPool: number,
    nowMs: number = Date.now(),
): PayoutRow[] {
    const participants = operation.participants || [];
    const mode: OperationPayoutMode = operation.payoutMode || 'equal';

    if (participants.length === 0) return [];

    if (mode === 'custom') {
        const rawShares = participants.map((p: Participant) => ({
            userId: p.userId,
            name: p.user?.name || 'Unknown',
            share: typeof p.payoutSharePercent === 'number' ? p.payoutSharePercent : 0,
        }));
        const totalShare = rawShares.reduce((s: number, r: { share: number }) => s + r.share, 0);
        // Renormalise if the persisted shares don't sum to 100 — defensive
        // safety net so the UI doesn't render misleading totals.
        const norm = totalShare > 0 ? 100 / totalShare : 0;
        return rawShares.map((r: { userId: number; name: string; share: number }) => {
            const sharePercent = norm > 0 ? r.share * norm : 0;
            return {
                userId: r.userId,
                name: r.name,
                sharePercent,
                // Floor the EXACT ratio. Routing through the float percentage
                // (sharePercent / 100 * netPool) drops a unit on exact splits
                // (a 1:2 split of 900 came out 299 instead of 300).
                amount: norm > 0 ? Math.floor((r.share * netPool) / totalShare) : 0,
            };
        });
    }

    if (mode === 'weighted' && operation.activeStartTime) {
        const opStart = new Date(operation.activeStartTime).getTime();
        const opEnd = operation.activeEndTime ? new Date(operation.activeEndTime).getTime() : nowMs;
        // Aggregate per-user time across (re)joins.
        const byUser = new Map<number, { name: string; totalTime: number }>();

        for (const p of participants) {
            const joined = new Date(p.timeJoined).getTime();
            const left = p.timeLeft ? new Date(p.timeLeft).getTime() : opEnd;
            const start = Math.max(opStart, joined);
            const end = Math.max(start, left);
            const seconds = Math.max(0, (end - start) / 1000);
            const existing = byUser.get(p.userId);
            if (existing) {
                existing.totalTime += seconds;
            } else {
                byUser.set(p.userId, { name: p.user?.name || 'Unknown', totalTime: seconds });
            }
        }

        const grandTotal = Array.from(byUser.values()).reduce((s, r) => s + r.totalTime, 0);
        if (grandTotal === 0) return [];

        return Array.from(byUser.entries()).map(([userId, r]) => {
            const sharePercent = (r.totalTime / grandTotal) * 100;
            return {
                userId,
                name: r.name,
                sharePercent,
                // Exact ratio, floored — see the custom branch above.
                amount: Math.floor((r.totalTime * netPool) / grandTotal),
            };
        });
    }

    // 'equal' (and weighted-without-activeStartTime fallback): all currently
    // active participants split evenly.
    const active = participants.filter((p: Participant) => !p.timeLeft);
    const list = active.length > 0 ? active : participants;
    const sharePercent = 100 / list.length;
    const equalShare = Math.floor(netPool / list.length);
    return list.map((p: Participant) => ({
        userId: p.userId,
        name: p.user?.name || 'Unknown',
        sharePercent,
        amount: equalShare,
    }));
}
