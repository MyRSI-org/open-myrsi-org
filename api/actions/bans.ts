import * as db from '../../lib/db.js';
import { createNotification } from '../../lib/db/notifications.js';
import { evictUserFromAllRooms } from '../../lib/radio.js';
import { SecurityDenial } from '../../lib/errors.js';
import { log as baseLog } from '../../lib/log.js';
import type { OrgBan, BanAppeal, BanNotice } from '../../types.js';

const log = baseLog.child({ module: 'actions.bans' });

// ---------------------------------------------------------------------------
// Org bans — the authorization rules live HERE; lib/db/bans.ts does the writes.
// ---------------------------------------------------------------------------
// A ban refusal message is deliberately GENERIC and identical across every branch.
// lib/errors.ts states the SecurityDenial contract: keep the message OPAQUE across
// not-found vs not-authorised so it cannot be used as an existence oracle — and
// api/services.ts returns error.message verbatim to the caller. Distinguishable
// messages keyed on a caller-chosen targetUserId would turn ban:place into an
// enumeration primitive for "does user N hold admin:user:ban" and "does user N
// exist". The auditEvent slugs stay distinct, because the SECURITY TRAIL is where
// that detail belongs — it is written to a service-role table, not returned.
const BAN_REFUSED = 'That member cannot be banned.';

interface ActorPayload {
    userId: number;
    user?: { id: number; discordId?: string | null; permissions?: string[] };
}
interface PlaceBanPayload extends ActorPayload {
    targetUserId: number;
    reason: unknown;
    expiresAt?: unknown;
}
interface LiftBanPayload extends ActorPayload { banId: number; liftReason?: unknown }
interface ListBansPayload extends ActorPayload { includeLifted?: boolean; limit?: number }
interface SubmitAppealPayload extends ActorPayload { statement: unknown }
interface ReviewAppealPayload extends ActorPayload {
    appealId: number;
    verdict: 'accepted' | 'rejected';
    note?: unknown;
    /**
     * Accepting an appeal LIFTS the ban. This survives as an explicit opt-OUT
     * rather than an opt-in, so the default matches what "accepted" means — pass
     * false only for the deliberate, unusual case of recording that the appeal was
     * well made while the ban stands.
     */
    liftBan?: boolean;
}
interface ListAppealsPayload extends ActorPayload { status?: string; limit?: number }

/** Fire-and-forget audit. Structurally guarded so a logging fault cannot fail the act. */
function audit(event: string, actorUserId: number, details: Record<string, unknown>): void {
    try {
        void db.recordSecurityEvent({ event, action: event, actorUserId, outcome: 'allowed', details })
            .catch(() => { /* best-effort */ });
    } catch { /* never let the audit emitter break the action it records */ }
}

export const banActions = {
    /**
     * Place a ban. `targetUserId` is a TARGET-identity field, so the dispatcher does
     * NOT force it — every guard below runs against the RESOLVED row, never against
     * anything the caller asserted.
     */
    'ban:place': async ({ userId, targetUserId, reason, expiresAt }: PlaceBanPayload): Promise<OrgBan> => {
        const target = await db.loadBanTarget(targetUserId);

        // Self-ban would lock the actor out of the very action that undoes it.
        if (target.id === userId) {
            throw new SecurityDenial(BAN_REFUSED, {
                auditEvent: 'authz.org_ban.self_denied',
                fields: { targetUserId: target.id },
            });
        }

        const lifters = await db.getBanPermissionHolderIds();

        // PEERS DO NOT BAN PEERS. Anyone holding admin:user:ban is out of reach of
        // this action — you cannot ban someone who could ban you back.
        //
        // Without it the rule is "first mover wins": two admins in a disagreement
        // race each other, and whoever clicks first silently wins, because the loser
        // is instantly locked out of the action that would undo it.
        //
        // This is ALSO what protects the org's own administrators. Hosted reached for
        // that with an owner check comparing users.auth_user_id to a portal identity;
        // this build has no portal tier, so the rule falls out of role identity
        // instead: getBanPermissionHolderIds lists the system Admin role UNCONDITIONALLY
        // (its arm 2), not merely when role_permissions happens to carry the grant.
        // The permissions-only reading of this rule was false on every upgraded install
        // — a permission reaches a role only via seedInstall or a Repair click, so
        // admin:user:ban existed in the catalogue while the Admin role held no row for
        // it, and a delegated holder could ban the Admin out of their own org.
        if (lifters.includes(target.id)) {
            throw new SecurityDenial(BAN_REFUSED, {
                auditEvent: 'authz.org_ban.peer_denied',
                fields: { targetUserId: target.id },
            });
        }

        // RECOVERABILITY BACKSTOP. The peer rule makes this unreachable in the normal
        // case, but state can predate it: someone banned BEFORE they were granted the
        // permission, or a role change handing the permission to a role whose members
        // are already banned. If every holder is locked out, nobody can reach ban:lift
        // and the org is stuck.
        //
        // Fails closed at both ends: getBanPermissionHolderIds and filterActivelyBanned
        // both THROW BanCheckUnavailable rather than return an empty set on a read
        // fault, so "I could not determine who can lift" never reads as "nobody can".
        const alreadyBanned = await db.filterActivelyBanned(lifters);
        const remaining = lifters.filter((id) => !alreadyBanned.has(id));
        if (remaining.length === 0) {
            throw new SecurityDenial(BAN_REFUSED, {
                auditEvent: 'authz.org_ban.last_lifter_denied',
                fields: { targetUserId: target.id, holders: lifters.length },
            });
        }

        const ban = await db.createBan(
            { userId: target.id, discordId: target.discordId, reason, expiresAt },
            userId,
        );

        // NO SESSION REVOCATION HERE, DELIBERATELY — and this is not an oversight.
        //
        // Stamping tokens_valid_from looks like it makes the ban immediate. It does
        // not: the ban gate reads organization_bans on EVERY request with no caching,
        // so the lockout is already immediate. What revocation would actually do is
        // BREAK THE APPEAL FLOW. The dispatcher's watermark check (api/services.ts,
        // immediately above the ban gate) 401s unconditionally with no exemption list,
        // and every token a banned member holds predates their ban by definition — so
        // they would be 401'd before ever reaching the gate that consults
        // BAN_EXEMPT_ACTIONS, making ban:my_notice and ban:submit_appeal unreachable.
        //
        // The ban row is the boundary. Leave their token alone so the two actions they
        // are still entitled to actually work.

        // The two channels the ban gate CANNOT reach, because neither is a request we
        // get to refuse. Both best-effort: the ban stands regardless.
        try {
            await db.dropPushSubscriptions(target.id);
        } catch (err) {
            log.error('failed to drop push subscriptions after ban', { targetUserId: target.id, err });
        }
        try {
            // Live voice. A LiveKit room token is already issued and valid for hours,
            // so without this a banned member keeps hearing operational comms — a
            // strictly worse leak than the push notifications above.
            const rooms = await evictUserFromAllRooms(target.id);
            if (rooms > 0) log.info('evicted banned member from voice', { targetUserId: target.id, rooms });
        } catch (err) {
            log.error('failed to evict banned member from voice', { targetUserId: target.id, err });
        }

        audit('authz.org_ban.placed', userId, {
            targetUserId: target.id,
            banId: ban.id,
            temporary: ban.expiresAt != null,
        });
        return ban;
    },

    'ban:lift': async ({ userId, banId, liftReason }: LiftBanPayload): Promise<OrgBan> => {
        const ban = await db.liftBan(banId, userId, liftReason);
        audit('authz.org_ban.lifted', userId, { targetUserId: ban.userId, banId: ban.id });
        return ban;
    },

    'ban:list': ({ includeLifted, limit }: ListBansPayload): Promise<OrgBan[]> =>
        db.listBans({ includeLifted, limit }),

    'ban:list_appeals': ({ status, limit }: ListAppealsPayload): Promise<BanAppeal[]> =>
        db.listBanAppeals({ status, limit }),

    // ── Self-scoped: reachable WHILE BANNED (BAN_EXEMPT_ACTIONS) ──────────────

    /**
     * The banned member's own notice. Takes no target: `userId` is dispatcher-forced,
     * so it cannot be aimed at anyone else. Returns null for a caller who is not
     * banned — the honest answer, and not a leak, since the only thing it reveals is
     * the caller's own status.
     */
    'ban:my_notice': ({ userId, user }: ActorPayload): Promise<BanNotice | null> =>
        db.getBanNotice(userId, user?.discordId),

    /**
     * One appeal per ban — the unique index on (ban_id) is the real guarantee, so a
     * double-submit race resolves to a clean message rather than two rows.
     *
     * The ban is resolved from the ACTOR's own active ban, never from a
     * client-supplied banId: this action is reachable by someone the org has locked
     * out, so it must not be usable to write onto another person's ban.
     */
    'ban:submit_appeal': async ({ userId, user, statement }: SubmitAppealPayload): Promise<BanAppeal> => {
        const notice = await db.getBanNotice(userId, user?.discordId);
        if (!notice) throw new Error('You are not currently banned.');
        if (!notice.canAppeal) throw new Error('You have already appealed this ban.');

        const appeal = await db.createBanAppeal(notice.banId, statement);

        try {
            await notifyBanReviewers(appeal.id);
        } catch (err) {
            log.error('ban appeal notification failed', { appealId: appeal.id, err });
        }
        return appeal;
    },

    /**
     * Resolve an appeal.
     *
     * ACCEPTING LIFTS THE BAN. The alternative — "accept, keep ban" — produces a state
     * nobody wants: the appellant is told their appeal succeeded and stays locked out,
     * with no record of why the org accepted an argument it then declined to act on.
     * A reviewer who wants the ban to stand declines it. The flag survives as an
     * explicit opt-OUT so the default matches what "accepted" means, and the lift is
     * audited as its own event so the two never diverge silently in the trail.
     */
    'ban:review_appeal': async ({ userId, appealId, verdict, note, liftBan }: ReviewAppealPayload): Promise<BanAppeal> => {
        const decision = verdict === 'accepted' ? 'accepted' : 'rejected';
        const appeal = await db.reviewBanAppeal(appealId, decision, userId, note);
        audit('authz.org_ban.appeal_reviewed', userId, {
            appealId: appeal.id, banId: appeal.banId, verdict: decision,
        });

        if (decision === 'accepted' && liftBan !== false) {
            // The appeal decision is ALREADY COMMITTED. liftBan matches only rows with
            // lifted_at IS NULL and cannot distinguish "no such ban" from "already
            // lifted or superseded", so letting its SecurityDenial escape here would
            // roll nothing back — it would leave the appeal resolved, the caller seeing
            // a failure, and a FALSE denial in the security trail for what is really a
            // benign race (someone lifted it first, or a re-ban superseded the row).
            // Swallow that specific case; the appeal verdict stands either way.
            try {
                const lifted = await db.liftBan(appeal.banId, userId, note ?? 'Appeal accepted');
                audit('authz.org_ban.lifted', userId, { targetUserId: lifted.userId, banId: lifted.id });
            } catch (err) {
                log.warn('appeal accepted but the ban was no longer active to lift', {
                    appealId: appeal.id, banId: appeal.banId, err,
                });
            }
        }
        return appeal;
    },
};

/**
 * Notify everyone who can action a ban appeal. Best-effort by contract — the appeal
 * is already persisted and visible in the console queue, so a failed notification
 * must never fail the submission.
 */
async function notifyBanReviewers(appealId: number): Promise<void> {
    const reviewers = await db.getBanPermissionHolderIds();
    await Promise.all(reviewers.map((uid) => createNotification(uid, {
        type: 'ban_appeal',
        title: 'Ban appeal submitted',
        // Data minimisation: no statement text, no identity — a generic summary plus
        // a route key. The reviewer opens the console to see who and what.
        body: 'A banned member has submitted an appeal for review.',
        link: 'admin',
        metadata: { appealId },
    }).catch(() => { /* best-effort per recipient */ })));
}
