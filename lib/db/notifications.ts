// Persistent Notification Center — per-user inbox data layer.
//
// SECURITY (Rules 1/2/4): the `notifications` table is service-role only (RLS
// deny-by-default + no authenticated policy — see schema.sql SECTION 6). App
// code is therefore the ONLY boundary, so EVERY query is scoped by user_id, and
// userId is ALWAYS server-derived (never client-supplied — the caller passes the
// authed session's user id). Reads use an explicit column list (no wildcard) and
// are capped + ordered. Mutations assert ownership before touching a row and
// throw SecurityDenial on a cross-user id.
//
// Single-org: there is no organization_id — the tenant dimension the hosted
// build scoped by is gone; the user_id scoping (the real authz boundary here) stays.
//
// The row type comes from the generated schema (Tables<'notifications'>); the
// toNotification mapper is co-located with this feature module.

import { supabase, handleSupabaseError, safeFetch, broadcastToOrg } from './common.js';
import { log as baseLog } from '../log.js';
import { sendPushToUsers } from '../push.js';
import { SecurityDenial } from '../errors.js';
import type { PersistentNotification } from '../../types.js';
import type { Tables } from './rows.js';

const log = baseLog.child({ module: 'db.notifications' });

type NotificationRow = Tables<'notifications'>;

// Explicit, minimal columns (Rule 1). user_id is selected for the ownership check
// but deliberately NOT surfaced by the mapper.
const NOTIFICATION_COLS = 'id, user_id, type, title, body, link, metadata, read_at, created_at';

const DEFAULT_LIST = 50;
const MAX_LIST = 100;

const toNotification = (row: NotificationRow): PersistentNotification => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? '',
    link: row.link ?? null,
    metadata: (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) ? row.metadata as Record<string, unknown> : {},
    readAt: row.read_at,
    createdAt: row.created_at,
});

export interface CreateNotificationInput {
    type: string;
    title: string;
    body?: string;
    link?: string | null;
    metadata?: Record<string, unknown>;
}

/** Self-scoped list: newest-first, capped. userId is server-derived. */
export async function getUserNotifications(
    userId: number,
    opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<PersistentNotification[]> {
    if (!userId || userId <= 0) throw new Error('getUserNotifications: userId is required');
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIST, 1), MAX_LIST);
    let query = supabase.from('notifications')
        .select(NOTIFICATION_COLS)
        .eq('user_id', userId);
    if (opts.unreadOnly) query = query.is('read_at', null);
    query = query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
    if (opts.offset) query = query.range(opts.offset, opts.offset + limit - 1);
    const rows = await safeFetch<NotificationRow[]>(query, [], 'getUserNotifications');
    return (rows || []).map(toNotification);
}

/** Unread badge count. Head-only count query; tolerates a not-yet-migrated table. */
export async function getUnreadCount(userId: number): Promise<number> {
    if (!userId || userId <= 0) throw new Error('getUnreadCount: userId is required');
    const { count, error } = await supabase.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('read_at', null);
    if (error) {
        if (error.code === '42P01') return 0;
        handleSupabaseError({ error, message: 'Failed to count notifications' });
    }
    return count ?? 0;
}

/**
 * Create a notification for a single recipient, then emit an id-only realtime
 * signal (base channel) + a best-effort OS web-push. Best-effort overall: a
 * not-yet-migrated table returns null rather than breaking the triggering mutation.
 * CONTRACT: `input` must carry only NON-SENSITIVE summary content + a deep-link —
 * never clearance-gated detail (it seeds a durable row AND rides a push payload).
 */
export async function createNotification(
    userId: number,
    input: CreateNotificationInput,
): Promise<PersistentNotification | null> {
    if (!userId || userId <= 0) throw new Error('createNotification: userId is required');
    if (!input?.type || !input?.title) throw new Error('createNotification: type and title are required');
    const { data, error } = await supabase.from('notifications')
        .insert({
            user_id: userId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
            metadata: (input.metadata ?? {}) as NotificationRow['metadata'],
        })
        .select(NOTIFICATION_COLS)
        .single();
    if (error) {
        if (error.code === '42P01') return null;
        handleSupabaseError({ error, message: 'Failed to create notification' });
    }
    const notification = data ? toNotification(data as NotificationRow) : null;
    if (notification) {
        // id-only realtime signal on the base 'db-changes' channel — NO content on
        // the wire. Every member receives it; each client acts only if
        // targetUserId === self, then refetches the self-scoped notifications subset.
        await broadcastToOrg('notification_update', {
            notificationId: notification.id,
            targetUserId: userId,
        });
        // Best-effort OS web-push (non-sensitive summary + deep-link). Fire-and-
        // forget so a slow/dead push endpoint never delays the triggering mutation;
        // sendPushToUsers is SSRF-guarded + resilient and logs its own failures.
        void sendPushToUsers([userId], {
            title: notification.title,
            body: notification.body || 'Open the dashboard to view.',
            tag: `notification-${notification.id}`,
            data: { url: notification.link || '/' },
        }).catch(() => { /* best-effort */ });
    }
    return notification;
}

/** Assert every id belongs to `userId`; throw SecurityDenial on any foreign id (BOLA). */
async function assertNotificationsOwned(userId: number, ids: number[]): Promise<void> {
    const { data, error } = await supabase.from('notifications')
        .select('id')
        .eq('user_id', userId)
        .in('id', ids);
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to validate notifications' });
    const owned = new Set((data || []).map((r: { id: number }) => r.id));
    const foreign = ids.filter((id) => !owned.has(id));
    if (foreign.length > 0) {
        throw new SecurityDenial('One or more notifications do not belong to this user.', {
            auditEvent: 'authz.cross_user.denied',
            fields: { userId, count: foreign.length },
        });
    }
}

/** Mark specific notifications read. Asserts ownership first. Returns rows updated. */
export async function markNotificationsRead(
    userId: number,
    notificationIds: number[],
): Promise<number> {
    if (!userId || userId <= 0) throw new Error('markNotificationsRead: userId is required');
    const ids = (notificationIds || []).filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return 0;
    await assertNotificationsOwned(userId, ids);
    const { data, error } = await supabase.from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('id', ids)
        .is('read_at', null)
        .select('id');
    if (error) handleSupabaseError({ error, message: 'Failed to mark notifications read' });
    return (data || []).length;
}

/** Mark every unread notification for `userId` read. Returns rows updated. */
export async function markAllNotificationsRead(userId: number): Promise<number> {
    if (!userId || userId <= 0) throw new Error('markAllNotificationsRead: userId is required');
    const { data, error } = await supabase.from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .is('read_at', null)
        .select('id');
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to mark all notifications read' });
    return (data || []).length;
}

/** Delete one notification, scoped to userId so a foreign id no-ops without leaking. */
export async function deleteNotification(userId: number, notificationId: number): Promise<void> {
    if (!userId || userId <= 0) throw new Error('deleteNotification: userId is required');
    if (!Number.isInteger(notificationId) || notificationId <= 0) throw new Error('deleteNotification: valid notificationId is required');
    const { error } = await supabase.from('notifications')
        .delete()
        .eq('user_id', userId)
        .eq('id', notificationId);
    if (error) handleSupabaseError({ error, message: 'Failed to delete notification' });
}

/**
 * Self-scoped inbox bundle for the `notifications` read subset: the capped list +
 * the unread badge count, in one call. userId is server-derived by the read path.
 */
export async function getUserNotificationState(userId: number): Promise<{ notifications: PersistentNotification[]; unreadCount: number }> {
    const [notifications, unreadCount] = await Promise.all([
        getUserNotifications(userId),
        getUnreadCount(userId),
    ]);
    return { notifications, unreadCount };
}

/**
 * Retention sweep (Rule 3 — cap unbounded growth): delete notifications older than
 * `days` (default 90). These are ephemeral "while you were away" alerts and the UI
 * only ever surfaces the latest 100 per recipient (getUserNotifications MAX_LIST),
 * so anything this old is already unreachable. Platform-wide (all users): this is a
 * server-side maintenance job, NOT a user action, so it is intentionally not
 * user-scoped. Works in bounded steps: select up to 5000 old ids, then delete them
 * in <=500-id chunks — postgrest serialises .in() into the request URI, so a
 * whole-batch delete of thousands of ids would overflow the gateway limit (HTTP 414)
 * and silently no-op. Never throws — returns the rows deleted so the cron can log it.
 */
export async function pruneOldNotifications(days = 90): Promise<number> {
    const SELECT_BATCH = 5000;
    const DELETE_CHUNK = 500;
    const MAX_BATCHES = 500; // runaway backstop: 500 * 5000 = 2.5M rows/run
    let total = 0;
    try {
        // Inside the try so a bad `days` (NaN → new Date(NaN).toISOString() throws)
        // is caught and returns 0 rather than escaping the "never throws" contract.
        const cutoff = new Date(Date.now() - Math.max(days, 1) * 86_400_000).toISOString();
        for (let i = 0; i < MAX_BATCHES; i++) {
            const { data, error } = await supabase.from('notifications')
                .select('id')
                .lt('created_at', cutoff)
                .order('id', { ascending: true }).limit(SELECT_BATCH);
            if (error) {
                if (error.code !== '42P01') log.warn('pruneOldNotifications select failed', { code: error.code });
                break;
            }
            const ids = (data as { id: number }[] | null)?.map((r) => r.id) ?? [];
            if (ids.length === 0) break;
            let failed = false;
            for (let j = 0; j < ids.length; j += DELETE_CHUNK) {
                const chunk = ids.slice(j, j + DELETE_CHUNK);
                const { error: delErr } = await supabase.from('notifications').delete().in('id', chunk);
                if (delErr) { log.warn('pruneOldNotifications delete failed', { code: delErr.code }); failed = true; break; }
                total += chunk.length;
            }
            if (failed || ids.length < SELECT_BATCH) break;
        }
    } catch (e) {
        log.warn('pruneOldNotifications threw', { err: e });
    }
    return total;
}
