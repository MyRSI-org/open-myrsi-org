import * as db from '../../lib/db.js';
import * as discord from '../../lib/discord.js';
import { createNotification } from '../../lib/db/notifications.js';
import { log as baseLog } from '../../lib/log.js';
import type { BlueprintRequest, BlueprintRequestStatus } from '../../types.js';

const log = baseLog.child({ module: 'actions.blueprints' });

// ----------------------------------------------------------------------------
// Payload shapes. Every handler receives the request body with actor-id fields
// (userId, and the rest of ACTOR_ID_FIELDS) overwritten server-side by
// api/services.ts. These mirror the field reads below — narrowing the
// dispatcher's payload here is assignment-safe because the registry erases
// handler param types.
// ----------------------------------------------------------------------------

interface ActorPayload {
    userId: number;
    user?: { roleId?: number | null; permissions?: string[] };
}

interface ListRegistryPayload extends ActorPayload {
    search?: string;
    craftableOnly?: boolean;
    ownerId?: number;
    limit?: number;
}

interface ListCraftablePayload extends ActorPayload {
    category?: string;
    search?: string;
    limit?: number;
}

interface RegisterBlueprintPayload extends ActorPayload {
    qmCatalogId?: number | null;
    itemName: string;
    notes?: string | null;
    offersCrafting?: boolean;
}

interface UpdateBlueprintPayload extends ActorPayload {
    blueprintId: number;
    [key: string]: unknown;
}

interface BlueprintIdPayload extends ActorPayload {
    blueprintId: number;
}

interface ListRequestsPayload extends ActorPayload {
    status?: BlueprintRequestStatus;
    limit?: number;
}

interface CreateRequestPayload extends ActorPayload {
    qmCatalogId?: number | null;
    itemName: string;
    quantity?: number;
    materialsNote?: string | null;
    offerPriceUec?: number | null;
}

interface RequestIdPayload extends ActorPayload {
    requestId: number;
}

interface CancelRequestPayload extends RequestIdPayload {
    reason?: string;
}

/**
 * Only blueprint:manage may act on another member's row.
 *
 * A PLAIN PERMISSION TEST, deliberately — and no role-NAME test either.
 *
 * Hosted additionally hard-denies the Client tier here, because there
 * `blueprint:request`/`blueprint:view` are Client-default permissions and the
 * module's whole identity is a two-tier split. In this build there is no such
 * split: CLIENT_DEFAULT_PERMS is code-clamped to three request:* strings and
 * clientRoleLock strips anything else off the seeded Client role, so a seeded
 * Client cannot hold any blueprint:* string and the check would have no reachable
 * caller. Do NOT "restore" it as a role-name compare: `user.role` is inferred from
 * the role row's NAME (inferUserRoleTier), so a custom role merely called
 * "Commander" would sail past it while a permissionless "Recruit" would be denied.
 *
 * The residual this build accepts, in writing: an org whose real customers sit on a
 * CUSTOM role can be granted blueprint:* by hand. lib/clientNamespaces.ts documents
 * that acceptance for every namespace, and Academy carries the same one. So this
 * module is members-only BY OPERATOR CONVENTION, not by a code boundary.
 */
const canManageBlueprints = (user?: { permissions?: string[] }): boolean =>
    user?.permissions?.includes('blueprint:manage') === true;

const canCraft = (user?: { permissions?: string[] }): boolean =>
    user?.permissions?.includes('blueprint:craft') === true;

/**
 * Notify everyone party to the request EXCEPT the actor. Computed as a set rather
 * than "the other one": when a blueprint:manage third party cancels, both the
 * requester and the mid-job crafter need telling, and a two-way swap would have
 * silently notified only the requester.
 *
 * ONE call per recipient, not a push plus a row. In this build createNotification
 * already writes the durable row, emits the id-only broadcast AND sends the web
 * push — hosted's push-only helper would leave a lifecycle event that never reaches
 * the notification bell, and pairing the two would double-push.
 *
 * Both parties are already known to each other by the time either can be a target
 * (crafter_id is only ever set by that crafter's own claim), so this cannot disclose
 * an identity — and the bodies carry the item name only, never a person.
 */
async function notifyParties(
    request: Pick<BlueprintRequest, 'id' | 'requesterId' | 'crafterId'>,
    actorId: number,
    title: string,
    body: string,
) {
    const targets = [request.requesterId, request.crafterId]
        .filter((id): id is number => typeof id === 'number' && id !== actorId);
    for (const target of new Set(targets)) {
        await createNotification(target, {
            type: 'blueprint_request',
            title,
            body,
            link: 'blueprints',
            metadata: { blueprintRequestId: request.id },
        }).catch((err: unknown) => { log.warn('blueprint notification failed', { err }); });
    }
}

/**
 * Post a new crafting request to the org's Discord channel.
 *
 * Mirrors notifyDiscordNewRequest (api/actions/requests.ts) — the same settings
 * read, the same truncation helper, the same swallow-everything try/catch, because
 * the request is already persisted and visible on the board and a Discord failure
 * must never fail the submission.
 *
 * CONTENT IS DELIBERATELY NARROWER THAN THE BOARD, and deliberately WIDER than the
 * in-app notification below. Both are intentional:
 *
 *  - No requester identity. A Discord channel has no permission model, and naming
 *    the asker there turns a work board into member surveillance.
 *  - No materials note. It is 2000 characters of free text; it does not belong in
 *    an org channel.
 *  - Item, quantity and offered price DO ride. The in-app notification omits them
 *    (it is one click from the board, so it can afford to say nothing), but a
 *    Discord post nobody can evaluate is a post nobody acts on — the price is what
 *    makes a crafter open the board.
 *
 * The item name is server-resolved from the registry (resolveCraftableItemName), so
 * it cannot be attacker-chosen text.
 *
 * EMBEDS ONLY, never `content`: with no content string there is no text for a
 * mention to ride in, so nothing here can ping. There is no clearance branch to
 * apply either — blueprints carry no clearance dimension, unlike an operation
 * announcement, so the omission is a fact about the module and not an oversight.
 */
async function notifyDiscordCraftingRequest(request: BlueprintRequest) {
    try {
        // TWO PRIMARY-KEY READS, not one .in() list read. `key` IS settings' primary
        // key, so each of these is addressed exactly and needs neither a cap nor an ORDER BY
        // to be deterministic. The sibling notifyDiscordNewRequest uses the list form
        // and sits in the uncapped-read budget for it; there is no reason to spend a
        // second slot on a two-key lookup.
        const [{ data: discordRow }, { data: brandingRow }] = await Promise.all([
            db.supabase.from('settings').select('value').eq('key', 'discordConfig').maybeSingle(),
            db.supabase.from('settings').select('value').eq('key', 'brandingConfig').maybeSingle(),
        ]);
        const settings = {
            discordConfig: (discordRow as { value?: unknown } | null)?.value,
            brandingConfig: (brandingRow as { value?: unknown } | null)?.value,
        };

        const discordConfig = settings.discordConfig as { craftingRequestChannelId?: string; newRequestChannelId?: string } | undefined;
        // Falls back to the service-request channel so an org that has already
        // configured Discord gets this without touching settings again.
        const channelId = discordConfig?.craftingRequestChannelId || discordConfig?.newRequestChannelId;
        if (!channelId) return;

        const branding = (settings.brandingConfig as { name?: string; iconUrl?: string } | undefined) || {};
        const safeValue = (val: unknown, fallback: string, maxLength = 1024) => {
            if (val === null || val === undefined) return fallback;
            const str = String(val).trim();
            if (str.length === 0) return fallback;
            return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str;
        };

        const fields: { name: string; value: string; inline?: boolean }[] = [
            { name: 'Item', value: safeValue(request.itemName, 'Unspecified item', 256), inline: true },
            { name: 'Quantity', value: safeValue(request.quantity, '1', 32), inline: true },
        ];
        // Only when actually offered — a '0 aUEC' field reads as an insult rather
        // than as 'no price set'.
        if (typeof request.offerPriceUec === 'number' && request.offerPriceUec > 0) {
            fields.push({ name: 'Offered', value: `${request.offerPriceUec.toLocaleString('en-US')} aUEC`, inline: true });
        }

        const embed = {
            title: '🔧 NEW CRAFTING REQUEST',
            description: 'A new request is open on the crafting board.',
            color: 0xa855f7,
            fields,
            timestamp: new Date().toISOString(),
            footer: {
                text: `${branding.name || 'Organization'} Blueprint Manager`,
                ...(branding.iconUrl && branding.iconUrl.startsWith('http') ? { icon_url: branding.iconUrl } : {}),
            },
        };

        await discord.sendDiscordChannelMessage(channelId, { embeds: [embed] });
    } catch (err) {
        log.error('crafting request discord notification failed', { requestId: request.id, err });
    }
}

/**
 * Blueprint Manager RPC action handlers.
 *
 * The optional-module feature gate (OPTIONAL_FEATURE_NAMESPACES in
 * api/services.ts) 403s this whole namespace before any of these run when
 * Blueprints is disabled, so no handler needs its own enabled-check.
 */
export const blueprintActions = {
    // --- REGISTRY ---
    'blueprint:list_registry': async ({ search, craftableOnly, ownerId, limit }: ListRegistryPayload) =>
        db.listBlueprints({ search, craftableOnly, ownerId, limit }),

    // viewerId is the dispatcher-forced actor, so the caller cannot ask to see
    // somebody else's list. It hides the viewer's OWN offers: they cannot raise a
    // request against themselves, so showing an item only they offer would just lead
    // to a refusal.
    'blueprint:list_craftable': async ({ userId, search, limit, category }: ListCraftablePayload) =>
        db.listCraftableItems({ search, limit, category, viewerId: userId }),

    'blueprint:register': async ({ userId, qmCatalogId, itemName, notes, offersCrafting }: RegisterBlueprintPayload) =>
        db.registerBlueprint({ qmCatalogId, itemName, notes, offersCrafting }, userId),

    // The rest-spread is the PATCH. Only `blueprintId`, `userId` and `user` are
    // destructured out, so every OTHER ACTOR_ID_FIELDS key the caller sent — already
    // overwritten with their own id by the dispatcher — lands in `patch`.
    // db.updateBlueprint's explicit column allowlist is what ignores them, and it is
    // the ONLY thing that does; the test file pins that.
    'blueprint:update': async ({ blueprintId, userId, user, ...patch }: UpdateBlueprintPayload) =>
        db.updateBlueprint(blueprintId, patch, userId, canManageBlueprints(user)),

    'blueprint:delete': async ({ blueprintId, userId, user }: BlueprintIdPayload) =>
        db.deleteBlueprint(blueprintId, userId, canManageBlueprints(user)),

    // --- CRAFTING REQUESTS ---
    'blueprint:list_requests': async ({ userId, user, status, limit }: ListRequestsPayload) =>
        db.listBlueprintRequests(userId, {
            canCraft: canCraft(user),
            canManage: canManageBlueprints(user),
            status,
            limit,
        }),

    'blueprint:create_request': async ({ userId, qmCatalogId, itemName, quantity, materialsNote, offerPriceUec }: CreateRequestPayload) => {
        const request = await db.createBlueprintRequest({ qmCatalogId, itemName, quantity, materialsNote, offerPriceUec }, userId);
        // Tell the people who can actually take it. Best-effort: the request is
        // already persisted and visible on the open board, so a notification failure
        // must never fail the submission. The fan-out is bounded at BOTH ends —
        // MAX_NOTIFY_FANOUT here and MAX_OPEN_REQUESTS_PER_REQUESTER at the source.
        try {
            const crafters = await db.getCraftNotifyIds(userId);
            await Promise.all(crafters.map(uid => createNotification(uid, {
                type: 'blueprint_request',
                title: 'New crafting request',
                // Data-minimisation: no requester identity, no item name, no offered
                // price — a generic summary plus a route key, with the id in metadata.
                body: 'A new crafting request is open on the board.',
                link: 'blueprints',
                metadata: { blueprintRequestId: request.id },
            }).catch(() => { /* best-effort per recipient */ })));
        } catch (err) {
            log.error('crafting request notification failed', { requestId: request.id, err });
        }
        // Separate from the in-app fan-out above: a Discord failure must not stop
        // in-app notifications, and vice versa.
        await notifyDiscordCraftingRequest(request);
        return request;
    },

    'blueprint:claim_request': async ({ requestId, userId }: RequestIdPayload) => {
        const request = await db.claimBlueprintRequest(requestId, userId);
        await notifyParties(request, userId, 'Crafting request claimed',
            `Someone has claimed your request for "${request.itemName}".`);
        return request;
    },

    'blueprint:release_request': async ({ requestId, userId, user }: RequestIdPayload) => {
        const { releasedCrafterId, ...request } = await db.releaseBlueprintRequest(requestId, userId, canManageBlueprints(user));
        // crafterId on the returned row is already null, so the ex-crafter is
        // reinstated here purely as a notification target — this is how a
        // blueprint:manage release reaches the member whose claim was taken.
        await notifyParties({ ...request, crafterId: releasedCrafterId }, userId, 'Crafting request released',
            `The request for "${request.itemName}" is back on the open board.`);
        return request;
    },

    'blueprint:mark_ready': async ({ requestId, userId }: RequestIdPayload) => {
        const request = await db.markBlueprintRequestReady(requestId, userId);
        await notifyParties(request, userId, 'Craft ready',
            `"${request.itemName}" is ready for delivery.`);
        return request;
    },

    'blueprint:mark_delivered': async ({ requestId, userId }: RequestIdPayload) => {
        const request = await db.markBlueprintRequestDelivered(requestId, userId);
        await notifyParties(request, userId, 'Craft delivered',
            `"${request.itemName}" has been marked delivered — confirm when you have it.`);
        return request;
    },

    'blueprint:confirm_received': async ({ requestId, userId }: RequestIdPayload) => {
        const request = await db.confirmBlueprintRequestReceived(requestId, userId);
        await notifyParties(request, userId, 'Craft confirmed received',
            `The requester confirmed receipt of "${request.itemName}".`);
        return request;
    },

    'blueprint:cancel_request': async ({ requestId, userId, user, reason }: CancelRequestPayload) => {
        const request = await db.cancelBlueprintRequest(requestId, userId, canManageBlueprints(user), reason);
        await notifyParties(request, userId, 'Crafting request cancelled',
            `The request for "${request.itemName}" was cancelled.`);
        return request;
    },
};
