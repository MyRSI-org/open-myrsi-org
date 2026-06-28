
import * as db from '../../lib/db.js';
import * as discord from '../../lib/discord.js';
import * as radio from '../../lib/radio.js';
import { signToken, signAdminSetupGrant, verifyAdminSetupGrant, signIdentityGrant, verifyIdentityGrant } from '../../lib/auth.js';
import { verifyRsiHandle, generateRsiVerificationCode } from '../../lib/rsi.js';
import { stripSensitiveUserFields } from '../../lib/db/userFilters.js';
import { adminExists } from '../../lib/firstBoot.js';
import { timingSafeEqual, createHash } from 'node:crypto';
import { log as baseLog } from '../../lib/log.js';
import type { User } from '../../types.js';

const log = baseLog.child({ module: 'actions.auth' });

// --- Payload shapes (request bodies; actor-id fields injected server-side) ---

// participantName / userId in the body are IGNORED — the dispatcher injects the
// authenticated `user`, and radio token identity/name + authorization derive
// from it. The fields remain for backward-compat with old clients.
// limitingMarkers ride along so op-voice auth can enforce compartments.
type RadioActor = { id: number; name?: string; role?: string; permissions?: string[]; clearanceLevel?: { level?: number } | null; limitingMarkers?: unknown[] };

interface RadioAuthPayload {
    roomName: string;
    participantName?: string;
    userId?: number;
    user?: RadioActor;
}

interface RadioOpAuthPayload {
    participantName?: string;
    userId?: number;
    operationId: string;
    user?: RadioActor;
}

interface DiscordCallbackPayload {
    code?: string;
    state?: string;
    redirectUri?: string;
}

interface FinalizeSetupPayload {
    discordId: string;
    name: string;
    avatarUrl: string;
    rsiHandle: string;
    // `isAdmin` is still accepted for backward-compat but is IGNORED server-side
    // (it was a client-trusted privilege flag — a privilege-escalation vector).
    // The Admin grant is derived solely from `adminSetupToken`, a server-signed
    // proof minted in auth:discord_callback after the one-time setup code was
    // validated.
    isAdmin?: boolean;
    adminSetupToken?: string;
    // Proof the discordId completed Discord OAuth, minted in auth:discord_callback.
    // Required: binds the new account to that identity so it can't be created for
    // someone else's discord id.
    identityToken?: string;
    verificationCode?: string;
    // First-run admin "verify later (offline)" bypass. Honored ONLY with a valid
    // adminSetupToken (first-admin context); regular members must verify.
    skipVerification?: boolean;
}

interface OrgClaimPayload {
    code: string;
    userId: number;
}

const CLAIM_MAX_ATTEMPTS = 10;

// Constant-time string compare for the setup code — avoids a timing
// side-channel on the `===` compare. Hashing first makes it length-independent
// (timingSafeEqual requires equal-length buffers).
export function constantTimeEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
}

/** Validate the single-org admin setup code against the DB, enforcing rate limits.
 *  On success the code is deleted (single-use). The code is printed to the server
 *  console at first boot — there is no portal. */
async function validateClaimCode(submittedCode: string): Promise<boolean> {
    const { data: setting, error: queryError } = await db.supabase.from('settings')
        .select('value')
        .eq('key', 'admin_setup_code')
        .maybeSingle();

    if (queryError) {
        log.error('claim code db query failed', { err: queryError });
        throw new Error("Failed to verify setup code. Please try again.");
    }

    if (!setting) {
        throw new Error("No admin setup code is active. Check the server console/logs for the one-time setup code, or restart the server to regenerate one.");
    }

    const stored = setting.value as { code?: string; failed_attempts?: number } | string;
    const storedCode = typeof stored === 'string' ? stored : stored?.code;
    const attempts = typeof stored === 'string' ? 0 : (stored?.failed_attempts ?? 0);

    // Rate limit: too many failed attempts — burn the code and force a restart.
    if (attempts >= CLAIM_MAX_ATTEMPTS) {
        await db.supabase.from('settings').delete().eq('key', 'admin_setup_code');
        throw new Error("Too many failed attempts. The setup code has been revoked — restart the server to generate a new one.");
    }

    if (!storedCode || !constantTimeEqual(String(storedCode), String(submittedCode))) {
        const nextValue = typeof stored === 'string'
            ? { code: stored, failed_attempts: attempts + 1 }
            : { ...stored, failed_attempts: attempts + 1 };
        await db.supabase.from('settings').update({ value: nextValue }).eq('key', 'admin_setup_code');
        throw new Error("Invalid setup code.");
    }

    // Valid — atomically consume. The DELETE returns the row only to the caller
    // that actually removed it, so two concurrent valid submissions of the same
    // code can't both win (the loser deletes 0 rows → treated as already claimed).
    // Closes the SELECT-then-DELETE TOCTOU that could otherwise mint two admins.
    const { data: consumed } = await db.supabase.from('settings')
        .delete().eq('key', 'admin_setup_code').select('key');
    if (!consumed || consumed.length === 0) {
        throw new Error("This setup code was just used. Restart the server to generate a new one if needed.");
    }
    return true;
}

export const authActions = {
    // --- RADIO AUTH ---
    // These actions proxy to the metered LiveKit API and are reachable by any
    // authenticated user. Throttle per-user (keyed on the server-injected user
    // id) to prevent a token-cost DoS, AFTER the auth check so an unauthenticated
    // caller still gets Unauthorized and the limiter keys on a real id. All
    // existing auth/clearance gates remain inside lib/radio.
    'radio:auth': ({ roomName, user }: RadioAuthPayload) => {
        if (!user) throw new Error('Unauthorized');
        radio.assertRadioRateLimit(user.id);
        return radio.generateRadioToken(user, roomName);
    },
    'radio:op_auth': ({ operationId, user }: RadioOpAuthPayload) => {
        if (!user) throw new Error('Unauthorized');
        radio.assertRadioRateLimit(user.id);
        return radio.generateOpRadioToken(user, operationId);
    },
    // Participant identities only for radio managers; others get presence counts.
    'radio:status': ({ user }: { user?: RadioActor }) => {
        radio.assertRadioRateLimit(user?.id);
        return radio.getRadioStatus({ includeParticipants: user?.role === 'Admin' || (user?.permissions || []).includes('radio:manage') });
    },
    'radio:reboot': ({ user }: { user?: RadioActor }) => {
        // Throttle per user like the other radio actions: radio:manage controls who
        // can reboot, but the limiter caps how often the LiveKit reboot can be called.
        radio.assertRadioRateLimit(user?.id);
        return radio.rebootRadioNetwork();
    },

    // --- AUTH ACTIONS ---
    'auth:discord_callback': async ({ code, state, redirectUri }: DiscordCallbackPayload) => {
        if (!code) throw new Error('Missing authorization code from Discord.');
        if (!redirectUri) throw new Error('Missing redirect URI for token exchange.');
        log.info('discord callback', { redirectUri, hasState: !!state });

        // Tag Discord credential errors with a prefix the login screen recognises so
        // it can show a helpful message instead of a silent bounce. This action is
        // public, so the message sent back stays generic — no config details, and no
        // echo of the redirect URL the caller sent. The operator-facing detail is
        // only written to the server log.
        let tokenData;
        try {
            tokenData = await discord.exchangeCodeForToken(code, redirectUri);
        } catch (err: unknown) {
            const raw = String((err instanceof Error ? err.message : err) || '');
            if (/invalid_client/i.test(raw)) {
                log.warn('discord oauth invalid_client: reset the Client Secret in the Discord Developer Portal and update the org Discord settings', { redirectUri });
                throw new Error('DISCORD_OAUTH_INVALID_CLIENT: Discord sign-in is misconfigured for this organization. Please contact your org administrator.', { cause: err });
            }
            if (/invalid_grant|redirect_uri/i.test(raw)) {
                log.warn('discord oauth redirect mismatch: add the exact redirect URL as an authorized redirect in the Discord Developer Portal', { redirectUri });
                throw new Error('DISCORD_OAUTH_REDIRECT_MISMATCH: Discord sign-in is misconfigured for this organization. Please contact your org administrator.', { cause: err });
            }
            throw err;
        }
        const discordUser = await discord.getDiscordUser(tokenData.access_token);
        // Discord ids are plain numbers. Check the shape before using the id in any
        // query — the auth_user_id update below builds a filter string from it, and a
        // value with '.' or ',' could change how that filter is read. It comes from
        // Discord, but don't trust an outside id's shape inside a query.
        if (typeof discordUser?.id !== 'string' || !/^\d{1,25}$/.test(discordUser.id)) {
            throw new Error('Discord returned an unexpected account id.');
        }
        const avatarUrl = discord.buildGlobalAvatarUrl(discordUser);

        let isAdminClaim = false;

        // Verify Admin Claim Code if present in state
        if (state && state.startsWith('admin_setup:')) {
            const claimKey = state.split(':')[1];
            if (claimKey) {
                // First-admin-only — refuse once an admin is established,
                // mirroring the org:claim / redeem_setup_code sibling paths.
                // adminExists() fails closed (returns true on a DB error), so a
                // transient failure denies the claim rather than granting Admin.
                // Checked BEFORE validateClaimCode so a lingering setup code
                // cannot self-promote a second admin.
                if (await adminExists()) throw new Error('An administrator already exists for this organization.');
                await validateClaimCode(claimKey);
                isAdminClaim = true;
            }
        }

        // includeDeleted=true so a returning member's prior soft-deleted record
        // is found and reactivated below — keeping the same user.id keeps every
        // historical FK (service requests, intel, ops) pointing at them, instead
        // of orphaning to a "Deleted User" row while a brand-new record is created.
        let user = await db.findUserByDiscordId(discordUser.id, true);

        if (user) {
            // If user was soft-deleted, reactivate them
            if ((user as User & { deletedAt?: string | null }).deletedAt) {
                user = await db.reactivateUser(user.id, {
                    name: discordUser.global_name || discordUser.username,
                    avatar_url: avatarUrl,
                });
            }

            if (!user) throw new Error("User restoration failed.");

            // First-login auth binding (importer / re-host story): if this user row
            // was created by an import/seed (or carried over from a prior Supabase
            // project) it may have a null or stale auth_user_id. Bind the Discord
            // identity now so subsequent auth_user_id lookups (getUserByAuthId) and
            // any RLS that keys on auth.uid() resolve to the same user.id — preserving
            // every historical FK. discord_id is the stable join key here.
            await db.supabase.from('users')
                .update({ auth_user_id: discordUser.id })
                .eq('discord_id', discordUser.id)
                .or('auth_user_id.is.null,auth_user_id.neq.' + discordUser.id);

            // Refresh cached avatar on every successful login. The user just told us
            // their current global avatar hash via /users/@me — catching a stale cache
            // here is free and avoids the heartbeat path having to do it later.
            if (user.avatarUrl !== avatarUrl) {
                db.refreshUserAvatar(user.id, avatarUrl).catch((err) => {
                    log.warn('post-login avatar refresh failed', { err });
                });
                user = { ...user, avatarUrl };
            }

            const token = signToken({ userId: user.id });
            // The self record returned at login must not carry admin-only fields
            // (adminNotes) or another-user's-eyes-only material. Strip with the
            // user as their own requester: personal data (personnel notes /
            // conduct / markers) is preserved for self; adminNotes is blanked
            // unless they actually hold admin:user:update.
            const safeUser = stripSensitiveUserFields(user, { id: user.id, role: user.role, permissions: user.permissions || [] });
            return { user: safeUser, token, isNewUser: false };
        }

        // New User. identityToken binds finalize_setup to this OAuth-verified
        // Discord id (so an account can't be created for someone else's id). When
        // the flow also carried a valid (now-consumed) admin setup code, an
        // adminSetupToken additionally authorizes the Admin role — the client-side
        // `isAdminSetup` flag is cosmetic (drives UI copy) and is NOT trusted.
        // Mint a server-issued RSI verification code, sign it into the identity grant
        // (so finalize_setup verifies against OUR code, not a client-chosen one), and
        // also return it for the user to paste into their RSI bio.
        const verificationCode = generateRsiVerificationCode();
        return {
            isNewUser: true,
            user: {
                discordId: discordUser.id,
                name: discordUser.global_name || discordUser.username,
                avatarUrl,
                isAdminSetup: isAdminClaim
            },
            verificationCode,
            identityToken: signIdentityGrant(discordUser.id, verificationCode),
            ...(isAdminClaim ? { adminSetupToken: signAdminSetupGrant(discordUser.id) } : {})
        };
    },
    'auth:finalize_setup': async (payload: FinalizeSetupPayload) => {
        if (!payload.rsiHandle) {
            throw new Error("An RSI handle is required.");
        }

        // Bind the new account to the Discord identity that completed OAuth. The
        // grant was minted in auth:discord_callback for the verified discordId, so
        // the submitted discordId cannot be spoofed to squat another member.
        const identity = verifyIdentityGrant(payload.identityToken);
        if (!identity || identity.discordId !== payload.discordId) {
            throw new Error("Your sign-in session has expired. Please sign in with Discord again.");
        }

        // The Admin role is granted ONLY when the caller presents a valid,
        // server-signed admin-setup grant bound to THIS discordId. The grant
        // is minted by auth:discord_callback or auth:redeem_setup_code after the
        // one-time setup code was validated + consumed. A client `isAdmin` flag is
        // never trusted.
        let isAdmin = false;
        if (payload.adminSetupToken) {
            const grant = verifyAdminSetupGrant(payload.adminSetupToken);
            if (grant && grant.discordId === payload.discordId) {
                isAdmin = true;
            } else {
                log.warn('finalize_setup: invalid or mismatched admin setup grant — creating non-admin user');
            }
        }

        // Server-side RSI handle verification. The code is the SERVER-issued one
        // carried in the signed identity grant — NOT the client payload — so a caller
        // can't pick a short string that already appears on a victim's public profile;
        // they must paste our code into the bio of the handle they're claiming.
        // The offline "verify later" bypass is honored ONLY for the first-admin setup
        // context (valid adminSetupToken) — regular members MUST verify. On bypass the
        // handle is recorded UNVERIFIED (rsi_verified=false); this does NOT block the
        // dashboard, and the admin can verify later from their profile (which flips it).
        let rsiVerified = true;
        if (payload.skipVerification && isAdmin) {
            rsiVerified = false;
        } else {
            if (!identity.vc) {
                throw new Error("Your sign-in session has expired. Please sign in with Discord again.");
            }
            const verified = await verifyRsiHandle(payload.rsiHandle, identity.vc);
            if (!verified) {
                throw new Error("Verification failed. Ensure the code is saved in your RSI bio and try again.");
            }
        }

        const user = await db.createUser({
            discordId: payload.discordId,
            name: payload.name,
            avatarUrl: payload.avatarUrl,
            rsiHandle: payload.rsiHandle,
            isAdmin,
            rsiVerified,
        });
        if (!user) throw new Error("Failed to create user.");
        const token = signToken({ userId: user.id });
        return { ...user, token };
    },
    'org:claim': async ({ code, userId }: OrgClaimPayload) => {
        // Promote a user to Admin via claim code
        const { data: user, error: userErr } = await db.supabase.from('users').select('id').eq('id', userId).single();
        if (userErr) {
            log.error('claim user lookup failed', { userId, err: userErr });
            throw new Error("Failed to verify user. Please try again.");
        }
        if (!user) throw new Error("User context invalid.");
        log.info('org:claim attempt', { userId });

        // The setup code promotes the FIRST admin only. Once an admin exists,
        // refuse self-promotion outright (additional admins are assigned by an
        // existing admin, never via a lingering setup code).
        if (await adminExists()) throw new Error('An administrator already exists for this organization.');

        // Validate code with TTL and rate limiting (also deletes on success)
        await validateClaimCode(code);

        // Success! Promote User
        // assertCanAssignRole exemption: the claim code itself (validated above
        // with TTL + rate-limiting) IS the privilege guard. The caller is by
        // definition not yet an admin — running assertCanAssignRole here would
        // reject the legitimate self-promotion flow. Bound by validateClaimCode.
        const sysRoles = await db.getSystemRoles();
        if (sysRoles.admin) {
            await db.supabase.from('users').update({ role_id: sysRoles.admin.id }).eq('id', userId);
        } else {
            log.error('admin role not found for org claim');
            throw new Error("System Configuration Error");
        }

        return { success: true };
    },
    'auth:redeem_setup_code': async ({ discordId, code, identityToken }: { discordId?: string; code?: string; identityToken?: string }) => {
        // Reorders the admin claim to AFTER Discord sign-in (first-run wizard): the
        // just-authed pending user submits the console-printed setup code here. We
        // validate + consume it (rate-limited, single-use via validateClaimCode) and
        // mint a 15-minute admin-setup grant bound to this Discord id, which
        // auth:finalize_setup consumes to assign the Admin role. The code is the
        // authorization secret (proves server-console access) — same trust model as
        // the OAuth-state claim path.
        if (!discordId || !code) throw new Error('Discord identity and setup code are required.');
        // First admin only: stop here once an admin exists, before touching the code
        // or identity, so a leftover code is never used after setup.
        if (await adminExists()) throw new Error('An administrator already exists for this organization.');
        // Require proof the caller signed in with Discord as this same id (the
        // identityToken from the callback) before issuing an admin-setup grant, so a
        // grant is never handed out for an unverified identity. finalize_setup checks
        // this again; this is the same guard, one step earlier.
        const identity = verifyIdentityGrant(identityToken);
        if (!identity || identity.discordId !== discordId) {
            throw new Error('Your sign-in session has expired. Please sign in with Discord again.');
        }
        await validateClaimCode(code);
        return { adminSetupToken: signAdminSetupGrant(discordId) };
    }
};
