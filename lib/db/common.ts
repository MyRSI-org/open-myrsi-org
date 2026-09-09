
import { supabase, handleSupabaseError } from '../supabaseServer.js';
import { cache, TTL } from '../cache.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db' });

export { supabase, handleSupabaseError };

/**
 * Broadcasts an event to the single-org Supabase Realtime channel 'db-changes'.
 * (Single-org build: no per-tenant channel scoping.)
 */
export function broadcastToOrg(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    return broadcastToChannel('db-changes', event, payload);
}

/**
 * Persistent channel pool — reuses Supabase Realtime channels instead of
 * creating/subscribing/destroying per broadcast (was adding 1-5s latency each).
 */
type PooledChannel = ReturnType<typeof supabase.channel>;

interface PoolEntry {
    channel: PooledChannel;
    ready: Promise<void>;
    /**
     * Monotonic use counter, NOT a clock. Date.now() has millisecond resolution and a burst
     * of broadcasts lands inside one tick, so timestamps TIE and the LRU sort degrades to an
     * arbitrary order — it would evict a channel just refreshed. A counter cannot tie.
     */
    lastUsed: number;
    /** Broadcasts currently mid-send on this channel. An entry is never evicted above 0. */
    inFlight: number;
    /** Set once removal has started, so two callers cannot race the same teardown. */
    evicting: boolean;
}

const channelPool = new Map<string, PoolEntry>();

/**
 * Topics that must never be evicted. These two carry the org-wide event stream and the
 * auth alerts; they are recreated on demand anyway, but churning them would drop broadcasts
 * for every connected client rather than for one stale operation board.
 * Mirrors the `topic IN ('db-changes','auth-alerts')` arm of the realtime RLS policy.
 */
const PINNED_CHANNELS = new Set(['db-changes', 'auth-alerts']);

/**
 * The pool was UNBOUNDED. Static topics are two, but `op-board-<uuid>` is minted per
 * operation (lib/db/ops.ts boardChannelName), so a long-running server accumulated one
 * permanently-subscribed websocket topic for every operation board anyone had ever touched —
 * never removed, because nothing ever removed a channel except the error path.
 */
const MAX_DYNAMIC_CHANNELS = 64;

/** Ever-increasing; stamped onto an entry each time it is acquired. */
let channelUseSeq = 0;

// Every broadcast channel is PRIVATE (Supabase Realtime Authorization).
// Subscribing requires a JWT that passes the realtime.messages RLS policies in
// schema.sql; the public anon key alone cannot observe org broadcasts. The
// server authorizes its own connection with the service-role key (RLS-bypassing).
let serverRealtimeAuthSet = false;
function ensureServerRealtimeAuth() {
    if (serverRealtimeAuthSet) return;
    serverRealtimeAuthSet = true;
    try {
        // The service-role key is itself a JWT with role=service_role. It is
        // required + validated at startup (lib/supabaseServer.ts throws if unset),
        // so no fallback literal — only set auth when the real key is present.
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (serviceKey) void supabase.realtime.setAuth(serviceKey);
    } catch (e) {
        log.warn('failed to set server realtime auth', { err: e });
        serverRealtimeAuthSet = false;
    }
}

/** Remove a channel from the pool and tear down its subscription. Idempotent. */
async function dropChannel(channelName: string): Promise<void> {
    const entry = channelPool.get(channelName);
    if (!entry || entry.evicting) return;
    entry.evicting = true;
    channelPool.delete(channelName);
    try {
        // AWAITED, unlike before. removeChannel returns a promise; firing it and dropping the
        // map entry in the same tick left the unsubscribe in flight with nothing watching it,
        // so a failure to tear down was invisible and the socket topic could survive the
        // "eviction" entirely.
        await supabase.removeChannel(entry.channel);
    } catch (e) {
        log.warn('channel removal failed', { channelName, err: e });
    }
}

/** Shed least-recently-used dynamic channels until the pool is back under its cap. */
function evictIfOverCap(justAcquired: string): void {
    // Counts the DYNAMIC TOTAL, not the evictable subset. Comparing only the evictable
    // entries means a pool where many channels happen to be mid-send sheds nothing and keeps
    // growing — which is exactly the unbounded behaviour this function exists to remove.
    let dynamicTotal = 0;
    for (const name of channelPool.keys()) if (!PINNED_CHANNELS.has(name)) dynamicTotal++;
    let over = dynamicTotal - MAX_DYNAMIC_CHANNELS;
    if (over <= 0) return;

    const victims = [...channelPool.entries()]
        .filter(([name, e]) => !PINNED_CHANNELS.has(name) && name !== justAcquired && e.inFlight === 0 && !e.evicting)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [name] of victims) {
        if (over-- <= 0) break;
        void dropChannel(name);
    }
    // If every candidate is mid-send there is nothing safe to drop and the pool stays over
    // cap until the next broadcast. That residue is bounded by CONCURRENCY, not by history,
    // which is the whole point — the old pool was bounded by neither.
}

/**
 * Fetch (or create) the pooled channel for a topic and mark it busy.
 *
 * The caller MUST decrement `inFlight` in a `finally`. The increment happens HERE, before
 * returning, and that placement is load-bearing: the caller's first `await` yields to the
 * microtask queue, and a concurrent broadcast resuming inside that window would see
 * `inFlight === 0` and could evict the very channel this caller is about to send on.
 */
function acquireChannel(channelName: string): PoolEntry {
    let entry = channelPool.get(channelName);

    if (!entry) {
        ensureServerRealtimeAuth();
        const channel = supabase.channel(channelName, { config: { private: true } });
        const ready = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 5000); // Don't block forever
            channel.subscribe((status: string) => {
                if (status === 'SUBSCRIBED') {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
        entry = { channel, ready, lastUsed: ++channelUseSeq, inFlight: 0, evicting: false };
        channelPool.set(channelName, entry);
    }

    entry.lastUsed = ++channelUseSeq;
    entry.inFlight++;
    evictIfOverCap(channelName);
    return entry;
}

/** Test seam: the live pool shape. Never used in production code. */
export function __channelPoolStateForTest(): { size: number; dynamic: number; names: string[] } {
    let dynamic = 0;
    for (const name of channelPool.keys()) if (!PINNED_CHANNELS.has(name)) dynamic++;
    return { size: channelPool.size, dynamic, names: [...channelPool.keys()] };
}

/** Test seam: drop everything so one suite's channels cannot leak into the next. */
export async function __resetChannelPoolForTest(): Promise<void> {
    await Promise.all([...channelPool.keys()].map((n) => dropChannel(n)));
    channelPool.clear();
}

export const __MAX_DYNAMIC_CHANNELS_FOR_TEST = MAX_DYNAMIC_CHANNELS;

/**
 * Broadcasts an event to a named Supabase Realtime channel.
 * Reuses persistent channels — no subscribe/unsubscribe churn.
 */
export async function broadcastToChannel(channelName: string, event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const entry = acquireChannel(channelName);
    try {
        await entry.ready;
        // AWAITED for sequencing, and the return value is deliberately IGNORED.
        //
        // RealtimeChannel resolves 'ok' immediately for any channel created without
        // `broadcast: { ack: true }`, and this pool does not set it — enabling it would add a
        // server round-trip to every one of the ~141 broadcast call sites. So a non-'ok'
        // status is only reachable on the deprecated REST-fallback branch, and branching on it
        // would pin behaviour production never takes. Do not add a status check here and do
        // not claim broadcast failures are visible: they are not, on the websocket path.
        //
        // What awaiting DOES buy is that the catch below is actually reachable — previously
        // the send was fire-and-forget, so a synchronous throw was the only thing it caught.
        await entry.channel.send({ type: 'broadcast', event, payload });
    } catch (e) {
        log.warn('broadcast send failed', { event, channelName, err: e });
        // Drop the stale channel so it reconnects on next use.
        await dropChannel(channelName);
    } finally {
        entry.inFlight = Math.max(0, entry.inFlight - 1);
    }
}

/**
 * System Role Lookup — resolves the 4 seeded roles by NAME within the is_system set.
 *
 * NOT positional and NOT a bare case-insensitive name match. `roles.name` is
 * operator-supplied free text under a CASE-SENSITIVE unique constraint
 * (schema.sql roles_name_key), so 'admin' and ' Admin ' can both exist alongside
 * 'Admin'; and electing the 4th role by id order hands the org's apex identity to
 * whatever custom role happens to sort there. This resolver now backs the
 * Admin-identity gates (lib/db/adminIdentity.ts), so either shortcut would GRANT
 * authority rather than merely mis-label a display tier. An unresolvable slot is
 * returned as `undefined` — the deny answer at every consumer.
 *
 * `is_system` is written only by the seeder and repairDatabase, and updateRole
 * refuses to rename an is_system role, so a name matched INSIDE that set cannot be
 * forged through addRole.
 */
export interface SystemRoles {
    client?: { id: number; name: string };
    member?: { id: number; name: string };
    dispatcher?: { id: number; name: string };
    admin?: { id: number; name: string };
}

// Canonical seeded names, byte-exact as lib/db/seeder.ts writes them.
const SYSTEM_ROLE_NAMES = { client: 'Client', member: 'Member', dispatcher: 'Dispatcher', admin: 'Admin' } as const;

type RoleNameRow = { id: number; name: string };

/**
 * Resolve ONE canonical slot out of a candidate row set.
 *
 * Byte-exact first: roles_name_key is case-sensitive, so at most one row can ever
 * be literally 'Admin' — that makes the exact match immune to a decoy named
 * 'admin' or ' Admin '. Only when no exact row exists do we accept a
 * case-insensitive match, and then only when it is UNAMBIGUOUS; two candidates
 * resolve to undefined rather than to the lower id.
 */
function pickSystemRole(rows: RoleNameRow[], canonical: string): RoleNameRow | undefined {
    const exact = rows.filter(r => r.name === canonical);
    if (exact.length === 1) return exact[0];
    const key = canonical.toLowerCase();
    const ci = rows.filter(r => String(r.name ?? '').trim().toLowerCase() === key);
    return ci.length === 1 ? ci[0] : undefined;
}

const resolveSlots = (rows: RoleNameRow[]): SystemRoles => ({
    client: pickSystemRole(rows, SYSTEM_ROLE_NAMES.client),
    member: pickSystemRole(rows, SYSTEM_ROLE_NAMES.member),
    dispatcher: pickSystemRole(rows, SYSTEM_ROLE_NAMES.dispatcher),
    admin: pickSystemRole(rows, SYSTEM_ROLE_NAMES.admin),
});

const slotsComplete = (r: SystemRoles): boolean => !!(r.client && r.member && r.dispatcher && r.admin);

async function loadSystemRoles(): Promise<SystemRoles> {
    // Primary: the is_system set (reliable for all orgs that have been seeded/repaired).
    const { data: systemRoles } = await supabase.from('roles')
        .select('id, name, is_system')
        .eq('is_system', true)
        .order('id', { ascending: true });

    const flagged = (systemRoles || []) as RoleNameRow[];
    if (flagged.length > 0) {
        const result = resolveSlots(flagged);
        if (slotsComplete(result)) return result;
    }

    // Fallback for orgs that predate the is_system column: the same name resolution
    // over every role. Still no positional election — a pre-migration org that
    // cannot be identified by name is reported as unresolved so its apex gates hold
    // rather than electing an arbitrary role into the Admin slot.
    const { data: allRoles } = await supabase.from('roles')
        .select('id, name')
        .order('id', { ascending: true });

    return resolveSlots((allRoles || []) as RoleNameRow[]);
}

export async function getSystemRoles(): Promise<SystemRoles> {
    const cacheKey = 'system_roles';
    const cached = cache.get<SystemRoles>(cacheKey);
    if (cached) return cached;

    const result = await loadSystemRoles();
    // Only cache when all four slots resolved; caching an incomplete result
    // (e.g. called mid-seed before roles committed) would persist for the full TTL.
    if (slotsComplete(result)) cache.set(cacheKey, result, TTL.SYSTEM_ROLES);
    return result;
}

/**
 * Cache-free twin. The 5-minute memo is fine for routine lookups but WRONG for the
 * platform's recovery controls: lib/db/importer.ts deletes and re-inserts the whole
 * roles table (SEEDED_PRECLEAR) and server.ts mints a fresh session for the
 * re-anchored admin mid-stream, so a cached answer can point at deleted role ids —
 * denying the genuine admin the very repair/maintenance controls that fix that, or
 * (on an imported-id collision) granting them to a stranger. Apex gates re-resolve
 * through this. Does NOT populate the cache.
 */
export async function getSystemRolesUncached(): Promise<SystemRoles> {
    return loadSystemRoles();
}


export async function safeFetch<T>(query: PromiseLike<{ data: T | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>, fallback: T, errorMessage: string): Promise<T> {
    try {
        const { data, error } = await query;
        if (error) {
            // Include PGRST201 (Ambiguous Join) in safe fallback to prevent dashboard crashes.
            // PGRST204 is the schema-cache "column not found" error — surfaces when a
            // freshly-added column hasn't been picked up by PostgREST yet.
            if (error.code === 'PGRST205' || error.code === 'PGRST204' || error.code === 'PGRST200' || error.code === 'PGRST201' || error.code === '42P01') {
                log.warn('safeFetch returning fallback', {
                    target: errorMessage,
                    code: error.code,
                    errMessage: error.message,
                    hint: error.hint || '',
                    details: error.details || '',
                });
                return fallback;
            }
            // Surface the full error shape so silent fallbacks aren't a black box —
            // the previous "message-only" log made it impossible to tell why ops
            // were coming back empty after a migration.
            log.error('safeFetch DB error', {
                target: errorMessage,
                code: error.code,
                errMessage: error.message,
                hint: error.hint || '',
                details: error.details || '',
            });
            handleSupabaseError({ error, message: errorMessage });
        }
        return data as T;
    } catch (err) {
        log.error('safeFetch fatal', { target: errorMessage, err });
        return fallback;
    }
}
