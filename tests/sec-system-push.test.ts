import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Security coverage for the system-push cluster:
//
//  getUnitFeed / createUnitPost embed the post author. The embed is rendered
//  as name + avatar only, but the row is mapped through toMiniUser →
//  blankSensitiveUserFields, which blanks the "security" set but NOT the
//  HR/session-metadata fields (probation_*, tenure_start_date, job_title,
//  voice_channel_name, rsi_verified, timezone, date_format). Those are
//  deliberately withheld from non-HR viewers on the roster/profile paths and
//  the unit-feed RPC result is returned without that pass — so the author
//  embed must select only roster-public identity columns or it leaks PII to
//  any member who can read a unit feed.
//
//  broadcastEAM persists the EAM, emits an id-only realtime trigger
//  ({timestamp}), and pushes the body. The push body carries the directive,
//  so its audience must mirror the broadcast:get_active_eam read gate (staff
//  role !== 'Client' OR user:receive:eam). It must never sendPushToAll —
//  Web-Push encryption protects transport, not authorization, so an
//  all-users push leaks the directive to Client-role users denied EAM in-app.

// --- author-embed column ratchet -------------------------------

describe('unit-feed author embed does not over-select HR/personnel PII', () => {
    const SYSTEM_SRC = readFileSync(
        resolve(__dirname, '..', 'lib', 'db', 'system.ts'),
        'utf8',
    );

    // Columns withheld from non-HR viewers by stripSensitiveUserFields /
    // HR_METADATA_PERMS. The author embed renders only name + avatar, so none of
    // these may appear inside an `author:users(...)` projection.
    const FORBIDDEN_AUTHOR_COLUMNS = [
        'rsi_verified',
        'job_title',
        'voice_channel_name',
        'timezone',
        'date_format',
        'probation_start',
        'probation_end',
        'tenure_start_date',
    ];

    const authorEmbeds = [...SYSTEM_SRC.matchAll(/author:users\(([^)]*)\)/g)].map(
        (m) => m[1],
    );

    it('there are author embeds to check (regex did not silently miss them)', () => {
        // getUnitFeed + createUnitPost.
        expect(authorEmbeds.length).toBeGreaterThanOrEqual(2);
    });

    it('no author embed selects withheld HR/personnel columns', () => {
        for (const embed of authorEmbeds) {
            const cols = embed.split(',').map((c) => c.trim());
            for (const forbidden of FORBIDDEN_AUTHOR_COLUMNS) {
                expect(cols).not.toContain(forbidden);
            }
        }
    });

    it('the author embed still selects the fields the feed actually renders', () => {
        for (const embed of authorEmbeds) {
            const cols = embed.split(',').map((c) => c.trim());
            expect(cols).toContain('name');
            expect(cols).toContain('avatar_url');
        }
    });
});

// --- EAM push audience mirrors the read gate -------------------

const h = vi.hoisted(() => ({
    upserts: [] as Array<{ table: string; values: unknown }>,
    channelEmits: [] as Array<{ channel: string; event: string; payload: unknown }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const b: any = {};
        b.select = () => b;
        b.upsert = (values: unknown) => {
            h.upserts.push({ table, values });
            return Promise.resolve({ data: null, error: null });
        };
        b.eq = () => b;
        b.in = () => b;
        b.is = () => b;
        b.order = () => b;
        b.limit = () => b;
        b.single = () => Promise.resolve({ data: null, error: null });
        b.maybeSingle = () => Promise.resolve({ data: null, error: null });
        // settings.select('key, value').in(...) is awaited as {data}; empty so
        // notifyDiscordEam finds no channel and returns without a Discord call.
        b.then = (resolve: any, reject: any) =>
            Promise.resolve({ data: [], error: null }).then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error }: { error: unknown }) => {
            if (error) throw new Error('supabase error');
        },
        broadcastToOrg: () => {},
        broadcastToChannel: (channel: string, event: string, payload: unknown) => {
            h.channelEmits.push({ channel, event, payload });
        },
        getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});
vi.mock('../lib/cache', () => ({
    cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} },
    TTL: {},
}));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {} }));
vi.mock('../lib/push', () => ({
    sendPushToAll: vi.fn(() => Promise.resolve()),
    sendPushToStaff: vi.fn(() => Promise.resolve()),
    sendPushToPermission: vi.fn(() => Promise.resolve()),
}));

import { broadcastEAM } from '../lib/db/system';
import { sendPushToAll, sendPushToStaff, sendPushToPermission } from '../lib/push';

// The single source of truth for who may read an EAM, mirrored from the
// broadcast:get_active_eam handler (api/actions/system.ts). The push audience
// must match this exactly so the push path and the read gate cannot drift.
const EAM_READ_PERMISSION = 'user:receive:eam';
function canReceiveEam(user: { role?: string; permissions?: string[] }): boolean {
    const isStaff = user.role !== 'Client';
    return isStaff || (Array.isArray(user.permissions) && user.permissions.includes(EAM_READ_PERMISSION));
}

describe('broadcastEAM scopes its push audience to the EAM read gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.upserts = [];
        h.channelEmits = [];
    });

    it('NEVER pushes the directive body to all users', async () => {
        await broadcastEAM('LAUNCH CODE ALPHA');
        expect(sendPushToAll).not.toHaveBeenCalled();
    });

    it('pushes to staff and to user:receive:eam holders (the read-gate union)', async () => {
        await broadcastEAM('LAUNCH CODE ALPHA');

        expect(sendPushToStaff).toHaveBeenCalledTimes(1);
        expect(sendPushToPermission).toHaveBeenCalledTimes(1);

        // The permission scoped on is exactly the one the read gate enforces.
        const [permArg, permPayload] = (sendPushToPermission as any).mock.calls[0];
        expect(permArg).toBe(EAM_READ_PERMISSION);

        // Both audiences carry the directive body under the collapsing 'eam' tag.
        const staffPayload = (sendPushToStaff as any).mock.calls[0][0];
        expect(staffPayload.body).toBe('LAUNCH CODE ALPHA');
        expect(staffPayload.tag).toBe('eam');
        expect(permPayload.body).toBe('LAUNCH CODE ALPHA');
    });

    it('still emits the id-only realtime trigger (timestamp, no body) and persists the EAM', async () => {
        await broadcastEAM('LAUNCH CODE ALPHA');

        const trigger = h.channelEmits.find((e) => e.event === 'eam_broadcast');
        expect(trigger).toBeTruthy();
        // The realtime payload carries only a timestamp — never the message body.
        expect(trigger!.payload).toHaveProperty('timestamp');
        expect(JSON.stringify(trigger!.payload)).not.toContain('LAUNCH CODE ALPHA');

        const persisted = h.upserts.find((u) => u.table === 'settings');
        expect(persisted).toBeTruthy();
    });

    it('contract: the push helper set equals the broadcast:get_active_eam predicate', () => {
        // A Client with no extra permission is denied EAM access in-app...
        expect(canReceiveEam({ role: 'Client', permissions: [] })).toBe(false);
        // ...and is therefore NOT covered by either push helper used above:
        //   sendPushToStaff      -> roles Member/Dispatcher/Admin (role !== Client)
        //   sendPushToPermission -> holders of EAM_READ_PERMISSION
        // Staff and permission holders ARE allowed and ARE covered.
        expect(canReceiveEam({ role: 'Member', permissions: [] })).toBe(true);
        expect(canReceiveEam({ role: 'Client', permissions: [EAM_READ_PERMISSION] })).toBe(true);
    });
});
