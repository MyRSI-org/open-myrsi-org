
import * as db from '../../lib/db.js';
import { hasAnyStaffViewPerm } from '../../lib/staffPerms.js';
import type { PlatformLocationKind } from '../../types.js';

interface SearchLocationsPayload {
    query?: string | number;
    kind?: PlatformLocationKind;
    starSystemId?: number | string;
    limit?: number;
}

interface CreateApiKeyPayload {
    label: string;
    /** Which key-authenticated surfaces this key may reach. Absent = feed only. */
    scopes?: string[];
    /** ISO timestamp, or absent/null for "never expires". */
    expiresAt?: string | null;
}

interface DeleteApiKeyPayload {
    keyId: string;
    reason?: string;
    /** Injected by the dispatcher's actor-id overwrite (ACTOR_ID_FIELDS) — never trusted
     *  from the client. */
    user?: { id?: number };
}

interface BroadcastPayload {
    message: string;
    /**
     * How loudly to ping Discord: none | here | role. Validated in lib/db/system.ts
     * against a THREE-VALUE set — it is a loudness choice, never a role id, so no
     * caller-chosen mention target ever reaches Discord.
     */
    pingTarget?: string;
}

export const systemActions = {
    'system:get_push_config': async () => ({ publicKey: process.env.VAPID_PUBLIC_KEY }),
    // 'system:get_clearances' / 'system:get_markers' removed (Phase 3 item 5, owner
    // decision D3) — zero callers repo-wide, and both served the org's entire
    // classification ladder and limiting-marker codeword list to any authenticated
    // session, an external customer included, behind the 'user:manage:self'
    // pseudo-permission. The taxonomy still reaches staff through the permission-gated
    // `main` bundle (lib/db.ts getStaffMainState), which is where it belongs; the db
    // functions themselves stay. The matching fullPermissionMap entries went with them —
    // see the removal note there. Same shape as the 'system:global_search' note below.
    // 'system:global_search' removed — it called a non-existent Postgres RPC
    // (global_search), had no client caller (the search UI uses intel:search),
    // and was gated only by 'user:manage:self'. A dead action behind a
    // near-public gate is a latent hole if the RPC is ever added.

    // Tenant-readable platform location search — backs the location autocomplete
    // on the service request modals. Returns reference data (UEX-sourced), so
    // any authenticated user can call it; gated as 'user:manage:self' in
    // services.ts.
    'system:search_locations': ({ query, kind, starSystemId, limit }: SearchLocationsPayload) =>
        db.searchPlatformLocations({
            query: String(query || ''),
            kind: kind || undefined,
            starSystemId: starSystemId ? Number(starSystemId) : undefined,
            limit: typeof limit === 'number' ? limit : undefined,
        }),

    // --- API KEYS ---
    'api:create_key': ({ label, scopes, expiresAt }: CreateApiKeyPayload) => db.createApiKey(label, scopes, expiresAt),
    // Named `delete_key` for continuity — the action key is pinned bidirectionally by
    // tests/permissionMapCoverage.test.ts and renaming it buys nothing — but the behaviour is a
    // SOFT revoke: the row survives as the record, and the credential is refused by verifyApiKey
    // from the moment revoked_at is stamped. The confirm dialog has always said "Revoke".
    'api:delete_key': ({ keyId, reason, user }: DeleteApiKeyPayload) => db.deleteApiKey(keyId, user?.id ?? null, reason ?? 'operator'),
    'api:list_keys': () => db.listApiKeys(),

    // --- BROADCASTS ---
    'broadcast:eam': ({ message, pingTarget }: BroadcastPayload) => db.broadcastEAM(message, pingTarget as db.EamPingTarget | undefined),
    'broadcast:alert': ({ message }: BroadcastPayload) => db.broadcastSystemAlert(message),
    // Gated EAM-body fetch (the realtime eam_broadcast carries a timestamp
    // trigger only). Map entry is 'user:manage:self' (any authenticated), so this
    // handler is the whole gate: "staff" as a PERMISSION set, not `role !== 'Client'`.
    // The tier is NAME-derived, so a permissionless custom role passed the old test
    // simply by not being called Client. hasAnyStaffViewPerm is the same predicate
    // lib/radio.ts uses for the base voice nets and is pinned disjoint from
    // CLIENT_DEFAULT_PERMS (tests/radioRoomAuthz.test.ts) — and it covers every
    // permission the old tier ladder used to reach a staff tier with, so no real
    // staff member loses the EAM.
    'broadcast:get_active_eam': ({ user }: { user?: { permissions?: string[] } }) => {
        const perms = Array.isArray(user?.permissions) ? user!.permissions! : [];
        const canReceive = perms.includes('user:receive:eam') || hasAnyStaffViewPerm(perms);
        if (!canReceive) throw new Error('Forbidden: EAM access requires a staff capability or user:receive:eam.');
        return db.getActiveEam();
    },

    // --- FIRST-RUN SETUP ---
    // Pre-auth preflight: booleans ONLY (never values). Public (PUBLIC_ACTIONS) so
    // the onboarding wizard can show env/config status + tips before login.
    'system:preflight': () => db.getPreflightStatus(),
    // Mark first-run onboarding complete (final wizard screen dismissed). Gated to
    // an admin perm in services.ts — the freshly-created admin calls it.
    'system:complete_setup': () => db.setSetupCompleted(),
};
