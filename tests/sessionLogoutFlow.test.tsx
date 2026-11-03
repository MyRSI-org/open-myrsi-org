import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The browser half of logout and of push hygiene on a shared browser.
//
//   1. endServerSession reports 'signed_out' only when the server confirmed it. logout()
//      used to ignore the RPC result and redirect, so a logout refused before the
//      dispatcher (the per-IP apiLimiter's 429, offline) left the HttpOnly cookie alive
//      and boot signed the member straight back in.
//   2. It tears the push subscription down whatever the outcome, and sends the endpoint so
//      the server can drop the caller's row.
//   3. On boot, a subscription the browser already holds is re-bound to whoever is
//      signed in now (PushNotificationProvider).
//   4. The banner's dismissed flag is per user (DashboardApp).

const h = vi.hoisted(() => ({
    currentUser: null as { id: number } | null,
    rpc: vi.fn(async (_action: string, _payload: unknown) => ({}) as unknown),
}));
vi.mock('../contexts/SessionContext', () => ({ useSession: () => ({ currentUser: h.currentUser }) }));
vi.mock('../services/apiService', () => ({ default: { rpc: h.rpc } }));

import { endServerSession, getCurrentPushSubscription, type LogoutPushSubscription } from '../utils/sessionLogout';
import { PushNotificationProvider } from '../contexts/PushNotificationContext';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const httpError = (status: number) => Object.assign(new Error(`status ${status}`), { status });

function fakeSub(): LogoutPushSubscription & { unsubscribe: ReturnType<typeof vi.fn> } {
    return { endpoint: ENDPOINT, unsubscribe: vi.fn(async () => true) };
}

describe('endServerSession — success only when the server says so', () => {
    it('signs out on a 2xx, sending this browser\'s push endpoint', async () => {
        const sub = fakeSub();
        const rpc = vi.fn(async () => ({ success: true }));
        expect(await endServerSession({ rpc, getPushSubscription: async () => sub })).toBe('signed_out');
        expect(rpc).toHaveBeenCalledWith('user:logout', { pushEndpoint: ENDPOINT });
        expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['the per-IP apiLimiter 429', httpError(429)],
        ['a maintenance 503', httpError(503)],
        ['a 500', httpError(500)],
        ['no network (fetch rejects, no status)', new TypeError('Failed to fetch')],
    ])('FAILS on %s — and still unsubscribes', async (_label, err) => {
        const sub = fakeSub();
        const rpc = vi.fn(async () => { throw err; });
        expect(await endServerSession({ rpc, getPushSubscription: async () => sub })).toBe('failed');
        expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });

    // A 401 on /api/services comes only from the dispatcher and means there is no live
    // session left to end (deleteCurrentUser's follow-up logout gets one by design).
    it('treats a 401 as already signed out', async () => {
        const sub = fakeSub();
        const rpc = vi.fn(async () => { throw httpError(401); });
        expect(await endServerSession({ rpc, getPushSubscription: async () => sub })).toBe('signed_out');
        expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('sends no endpoint when the browser holds no subscription', async () => {
        const rpc = vi.fn(async () => ({}));
        expect(await endServerSession({ rpc, getPushSubscription: async () => null })).toBe('signed_out');
        expect(rpc).toHaveBeenCalledWith('user:logout', {});
    });

    it('a failing subscription lookup or unsubscribe never blocks the logout', async () => {
        const rpc = vi.fn(async () => ({}));
        expect(await endServerSession({ rpc, getPushSubscription: async () => { throw new Error('denied'); } })).toBe('signed_out');
        const sub = { endpoint: ENDPOINT, unsubscribe: vi.fn(async () => { throw new Error('gone'); }) };
        expect(await endServerSession({ rpc, getPushSubscription: async () => sub })).toBe('signed_out');
        expect(rpc).toHaveBeenLastCalledWith('user:logout', { pushEndpoint: ENDPOINT });
    });
});

// Browser plumbing for the provider / lookup tests.
function installPush(sub: unknown) {
    const reg = { pushManager: { getSubscription: vi.fn(async () => sub) } };
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { ready: Promise.resolve(reg), getRegistration: vi.fn(async () => reg) },
    });
    (window as unknown as { PushManager?: unknown }).PushManager = function PushManager() {};
}
function uninstallPush() {
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    delete (window as unknown as { PushManager?: unknown }).PushManager;
}

describe('getCurrentPushSubscription', () => {
    afterEach(uninstallPush);

    it('is null, not a throw or a hang, when the browser has no push support', async () => {
        uninstallPush();
        await expect(getCurrentPushSubscription()).resolves.toBeNull();
    });

    // `.ready` never settles without a registered worker; getRegistration resolves undefined.
    it('is null when no worker is registered', async () => {
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: { ready: new Promise(() => {}), getRegistration: async () => undefined },
        });
        (window as unknown as { PushManager?: unknown }).PushManager = function PushManager() {};
        await expect(getCurrentPushSubscription()).resolves.toBeNull();
    });
});

describe('PushNotificationProvider — re-binds an inherited subscription on boot', () => {
    const subJson = { endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'BPk', auth: 'aGVsbG8' } };
    beforeEach(() => {
        h.rpc.mockClear();
        installPush({ endpoint: ENDPOINT, toJSON: () => subJson, unsubscribe: async () => true });
    });
    afterEach(uninstallPush);

    it('re-binds the browser\'s existing subscription to the signed-in user', async () => {
        h.currentUser = { id: 42 };
        render(<PushNotificationProvider><span /></PushNotificationProvider>);
        await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('user:subscribe_push', subJson));
    });

    it('does nothing before anyone is signed in', async () => {
        h.currentUser = null;
        render(<PushNotificationProvider><span /></PushNotificationProvider>);
        await new Promise((r) => setTimeout(r, 20));
        expect(h.rpc.mock.calls.filter(([a]) => a === 'user:subscribe_push')).toHaveLength(0);
    });

    it('re-binds once per user, not on every render', async () => {
        h.currentUser = { id: 42 };
        const view = render(<PushNotificationProvider><span /></PushNotificationProvider>);
        await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('user:subscribe_push', subJson));
        view.rerender(<PushNotificationProvider><span>again</span></PushNotificationProvider>);
        await new Promise((r) => setTimeout(r, 20));
        expect(h.rpc.mock.calls.filter(([a]) => a === 'user:subscribe_push')).toHaveLength(1);
    });
});

// SessionProvider and DashboardApp need the whole provider tree to render, so these two
// wiring points are pinned on the source. Normalised: CRLF locally, LF in CI.
const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

describe('wiring — SessionContext.logout()', () => {
    const src = read('contexts', 'SessionContext.tsx');
    const start = src.indexOf('const logout = useCallback(async () => {');
    const body = src.slice(start, src.indexOf('}, [addToast]);', start));

    it('goes through endServerSession with the push lookup', () => {
        expect(start).toBeGreaterThan(-1);
        expect(body).toContain('const outcome = await endServerSession({');
        expect(body).toContain('getPushSubscription: getCurrentPushSubscription');
        // The old swallow-and-redirect is gone.
        expect(body).not.toMatch(/catch\s*\{\s*\/\*\s*fall through to local clear/);
    });

    it('on failure toasts and RETURNS before clearing anything or redirecting', () => {
        const failedAt = body.indexOf("if (outcome === 'failed') {");
        const failedBranch = body.slice(failedAt, body.indexOf('\n        }\n', failedAt));
        expect(failedAt).toBeGreaterThan(-1);
        expect(failedBranch).toContain('addToast(');
        expect(failedBranch).toMatch(/try again/i);
        expect(failedBranch).toMatch(/\breturn;/);
        for (const clear of ["localStorage.removeItem('myrsi_auth_token')", 'setCurrentUser(null)', "window.location.href = '/'"]) {
            expect(body.indexOf(clear), clear).toBeGreaterThan(failedAt + failedBranch.length);
        }
    });
});

describe('wiring — the push banner dismissal is per user', () => {
    const src = read('DashboardApp.tsx');

    it('never reads or writes the shared, unscoped key', () => {
        expect(src).not.toMatch(/localStorage\.(get|set)Item\(\s*'push_banner_dismissed'\s*[,)]/);
    });

    it('scopes the key on the user id and re-keys the banner per user', () => {
        expect(src).toContain('const pushBannerDismissedKey = (userId: number | undefined) => `push_banner_dismissed:${userId ?? \'anon\'}`;');
        expect(src).toContain('const dismissedKey = pushBannerDismissedKey(currentUser?.id);');
        expect(src).toContain('localStorage.getItem(dismissedKey)');
        expect(src).toContain('localStorage.setItem(dismissedKey, \'true\')');
        expect(src).toContain('<PushNotificationBanner key={currentUser.id} />');
    });
});
