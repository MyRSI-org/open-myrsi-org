// Logout's server half and its Web Push teardown. Lives outside SessionContext so the
// one decision it makes — did the session actually end? — can be tested without
// rendering the provider tree, and so PushNotificationContext can share the
// subscription lookup.

/** The slice of a PushSubscription that logout needs. */
export interface LogoutPushSubscription {
    endpoint: string;
    unsubscribe: () => Promise<boolean>;
}

export interface EndServerSessionDeps {
    rpc: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
    getPushSubscription: () => Promise<LogoutPushSubscription | null>;
}

export type EndServerSessionOutcome = 'signed_out' | 'failed';

/**
 * The browser's current Web Push subscription, or null. Never throws, never hangs.
 *
 * getRegistration(), not `navigator.serviceWorker.ready`: `.ready` never settles when no
 * worker is registered — public/pwa-init.js unregisters it during first-run setup, and a
 * private window may refuse one outright — and neither logout nor boot may hang on it.
 */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
    try {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
        if (typeof window === 'undefined' || !('PushManager' in window)) return null;
        const reg = await navigator.serviceWorker.getRegistration();
        return (await reg?.pushManager?.getSubscription()) ?? null;
    } catch {
        return null;
    }
}

/**
 * Ask the server to end this session, and tear down this browser's push subscription
 * whatever the answer.
 *
 * 'signed_out' ONLY when the server confirms it. The HttpOnly session cookie can be
 * cleared by nothing but a server response, and a refusal that never reaches the
 * dispatcher — the per-IP apiLimiter's 429 in server.ts, or no network at all — cannot
 * carry that clear. Reporting success anyway sent the member to `/`, where boot signed
 * them straight back in on the surviving 24-hour cookie; on a shared machine, the next
 * person did. Any other refusal (a maintenance or ban-check 503) has not moved the
 * revocation watermark either, so it is a failure too: the member stays put and retries.
 *
 * A 401 counts as signed out: on /api/services only the dispatcher answers 401, and it
 * means no live session exists for this credential (missing, bad signature, account gone,
 * revoked). Every dispatcher answer to user:logout carries the cookie clear, and
 * deleteCurrentUser's follow-up logout gets a 401 by design — delete_self has already
 * moved the watermark.
 *
 * The push subscription goes REGARDLESS of the outcome. The endpoint rides on the RPC so
 * the server can drop the caller's row for it, and unsubscribe() kills it at the push
 * service, so even a server that never heard the logout cannot keep pushing the previous
 * member's directives and notifications to this browser. It is started before the RPC
 * (a 401 navigates the page away, which could cut it short) and awaited after.
 */
export async function endServerSession(deps: EndServerSessionDeps): Promise<EndServerSessionOutcome> {
    let sub: LogoutPushSubscription | null;
    try { sub = await deps.getPushSubscription(); } catch { sub = null; }
    const endpoint = typeof sub?.endpoint === 'string' && sub.endpoint ? sub.endpoint : null;

    let unsubscribed: Promise<unknown> = Promise.resolve();
    if (sub) {
        try { unsubscribed = sub.unsubscribe().catch(() => false); } catch { /* best-effort */ }
    }

    try {
        await deps.rpc('user:logout', endpoint ? { pushEndpoint: endpoint } : {});
        return 'signed_out';
    } catch (err) {
        return (err as { status?: unknown } | null)?.status === 401 ? 'signed_out' : 'failed';
    } finally {
        await unsubscribed;
    }
}
