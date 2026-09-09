
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import * as db from '../lib/db.js';
import { verifyToken, isSessionForceLoggedOut, isSessionRevokedByWatermark } from '../lib/auth.js';
import { buildOAuthStateCookie, clearOAuthStateCookie, readOAuthStateCookie, nonceMatches, isValidNonceShape } from '../lib/oauthStateCookie.js';
import { isOpaqueServerError, isSecurityDenial } from '../lib/errors.js';
import { getClientIp } from '../lib/clientIp.js';
import { checkAuthRateLimit } from '../lib/authRateLimit.js';
import { permissionSatisfied } from '../lib/permissionImplications.js';
import { CLIENT_DENIED_NAMESPACES, CLIENT_DENIED_MESSAGE } from '../lib/clientNamespaces.js';
import { log as baseLog } from '../lib/log.js';

const log = baseLog.child({ module: 'services' });

// Import Action Modules
import { authActions } from './actions/auth.js';
import { adminActions } from './actions/admin.js';
import { hrActions } from './actions/hr.js';
import { operationActions } from './actions/operations.js';
import { requestActions } from './actions/requests.js';
import { intelActions } from './actions/intel.js';
import { systemActions } from './actions/system.js';
import { userActions } from './actions/user.js';
import { wikiActions } from './actions/wiki.js';
import { fleetActions } from './actions/fleet.js';
import { governmentActions } from './actions/government.js';
import { financesActions } from './actions/finances.js';
import { quartermasterActions } from './actions/quartermaster.js';
import { warehouseActions } from './actions/warehouse.js';
import { marketplaceActions } from './actions/marketplace.js';
import { catalogActions } from './actions/catalog.js';
import { allianceActions } from './actions/alliances.js';
import { operationsFederationActions } from './actions/operations-federation.js';
import { notificationActions } from './actions/notifications.js';
import { academyActions } from './actions/academy.js';
import { blueprintActions } from './actions/blueprints.js';
import { banActions } from './actions/bans.js';
import { credentialFromRequest, SESSION_COOKIE_IS_SECURE, buildSessionCookie, clearSessionCookie , appendSetCookie } from '../lib/sessionCookie.js';
import { checkUserRateLimit } from '../lib/userRateLimit.js';
import { TOKEN_LIFETIME_MS } from '../lib/auth.js';

type ActionHandler = (payload: any, token?: string) => Promise<unknown>;

// Public actions are dispatched without auth/permission checks. They short-circuit
// at the public-action handler before the protected-prefix BOLA gate runs.
export const PUBLIC_ACTIONS: readonly string[] = ['auth:begin_oauth', 'auth:discord_callback', 'auth:finalize_setup', 'auth:redeem_setup_code', 'system:get_push_config', 'system:preflight'];

/**
 * The ONLY actions a banned member may still reach.
 *
 * Everything else is refused by the ban gate below. These three are what makes a
 * ban accountable rather than a silent wall: the member can see WHY they were
 * banned, appeal it once, and log out. Keep this list minimal — every entry is a
 * surface reachable by someone the org has deliberately locked out.
 */
const BAN_EXEMPT_ACTIONS: readonly string[] = ['user:logout', 'ban:my_notice', 'ban:submit_appeal'];

// Action prefixes that require a permission entry in fullPermissionMap. Any
// authenticated request to an action with one of these prefixes is gated by
// the BOLA/permission check below. 'user:' is included so the self-service user
// actions are gated explicitly (each maps to the user:manage:self pseudo-permission,
// i.e. any authenticated caller) rather than being implicitly open — that closes the
// fail-open trap where a map entry on a user:* action would silently do nothing.
export const PROTECTED_PREFIXES: readonly string[] = ['admin:', 'hr:', 'intel:', 'warrant:', 'unit:', 'operation:', 'request:', 'broadcast:', 'api:', 'wiki:', 'fleet:', 'gov:', 'radio:', 'warehouse:', 'finance:', 'qm:', 'system:', 'discord:', 'org:', 'catalog:', 'alliance:', 'mirror:', 'marketplace:', 'user:', 'notifications:', 'academy:', 'ban:', 'blueprint:'];

// Optional-feature namespaces: action prefixes whose WHOLE namespace fails closed
// server-side when the module is toggled OFF (Admin → Optional Features) — not just
// hidden in the Sidebar nav. Mirrors the read-path SUBSET_REQUIRED_FEATURE gate in
// api/query.ts. Each maps a prefix → its feature key + source of truth + a UI label
// for the 403; `exempt` lists actions that stay reachable while the module is OFF.
//   - source 'features'   → the orgFeatures JSONB blob (all default-OFF).
//   - source 'government' → the separate governmentsConfig settings key (default-OFF).
// Government is the ONLY module whose on/off toggle lives inside its own namespace
// (gov:update_feature_config), so that action MUST be exempt or disabling government
// would be irreversible. Every other module toggles via admin:update_features (the
// admin: namespace, never itself feature-gated) → no self-lockout. Runtime resolves
// enable-state via db.isOptionalFeatureEnabled(feature); `source` documents where the
// flag lives and is pinned by tests/featureGateParity.test.ts.
export const OPTIONAL_FEATURE_NAMESPACES: Readonly<Record<string, {
    feature: string;
    source: 'features' | 'government';
    label: string;
    exempt?: readonly string[];
}>> = {
    'marketplace:': { feature: 'marketplace',   source: 'features',   label: 'Marketplace' },
    'warehouse:':   { feature: 'warehouse',     source: 'features',   label: 'Warehouse' },
    'academy:':     { feature: 'academy',       source: 'features',   label: 'Academy' },
    'blueprint:':   { feature: 'blueprints',    source: 'features',   label: 'Blueprint Manager' },
    'finance:':     { feature: 'finances',      source: 'features',   label: 'Finances' },
    'qm:':          { feature: 'quartermaster', source: 'features',   label: 'Quartermaster' },
    'gov:':         { feature: 'government',     source: 'government', label: 'Government', exempt: ['gov:update_feature_config'] },
};

// The op-owner bypass (isOpOwner) lets an op's owner satisfy the operations:manage
// gate for owner-appropriate edit/lifecycle actions on their own op. It must NOT
// extend to finance/payout/alert/participant-mutation/status actions: those carry
// org-wide financial or command-and-control authority and ALWAYS require the real
// operations:manage permission, even for the owner. (The owner editing their own
// op's basic details is separately clamped at the db layer.)
export const OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS: ReadonlySet<string> = new Set([
    'operation:add_uec',
    'operation:add_cost',
    'operation:set_payout_mode',
    'operation:set_payout_splits',
    'operation:toggle_payout_paid',
    'operation:reset_readiness',
    'operation:add_participant',
    'operation:update_participant',
    // Seating and approving-into-a-seat both write member state on someone else's
    // behalf, so they sit beside add/update_participant rather than with the slot
    // CRUD above. An owner holding only operations:create + operations:view may
    // DESIGN ships and seats on their own operation and may not SEAT anyone in them
    // — a deliberate split, and the reason assignSlot requires the target to
    // already be a participant rather than enrolling them.
    // remove_slot_assignment is deliberately NOT here. With decideSlotApplication
    // now restricted to rows whose status is 'applied', denying an application and
    // un-seating a member are genuinely different acts: the first admits someone,
    // the second only clears a row on the owner's own operation and notifies nobody
    // — the same shape as delete_task, which is bypassable.
    'operation:assign_slot',
    'operation:decide_slot_application',
    // Posts a bot message to a channel the CALLER names. Without this an op owner
    // holding only operations:create could aim the org's announcement — and, on the
    // create path, its role ping — at any channel the bot can see. The handler also
    // shape-checks the id; this is the other half.
    'operation:repost_announcement',
    'operation:broadcast_alert',
    'operation:update_status',
    // Federation diplomacy: inviting/revoking an allied peer shares the op (and its
    // participants' identities) across an org boundary. That is alliance authority,
    // not something an op's creator may do off the back of operations:create — it
    // always needs the real operations:manage permission.
    'operation:invite_ally',
    'operation:revoke_ally',
]);

export const fullPermissionMap: Record<string, string> = {
    // Admin User Management
    'admin:update_user': 'admin:user:update',
    'admin:update_user_clearance': 'admin:user:manage_clearance',
    'admin:bulk_update_user_clearances': 'admin:user:manage_clearance',
    'admin:bulk_demote_to_client': 'admin:user:update_role',
    'admin:bulk_promote_users': 'admin:user:update_role',
    'admin:bulk_set_affiliate': 'admin:user:update',
    'admin:bulk_set_vip': 'admin:user:update',
    'admin:bulk_assign_unit': 'admin:user:update',
    'admin:bulk_assign_rank': 'admin:user:update',
    'admin:bulk_assign_position': 'admin:user:update',
    'admin:bulk_grant_certification': 'admin:award:certification',
    'admin:bulk_grant_commendation': 'admin:award:commendation',
    'admin:adjust_rep': 'admin:user:adjust_reputation',
    'admin:promote_user': 'admin:user:update_role',
    'admin:get_rep_history': 'admin:user:view_history',
    'admin:get_rating_history': 'admin:user:view_history',
    'admin:toggle_duty': 'admin:user:update',
    'admin:toggle_affiliate': 'admin:user:update',
    'admin:toggle_vip': 'admin:user:update',

    // Org Config
    'admin:add_unit': 'admin:config:units',
    'admin:update_unit': 'admin:config:units',
    'admin:delete_unit': 'admin:config:units',
    'admin:add_rank': 'admin:config:ranks',
    'admin:update_rank': 'admin:config:ranks',
    'admin:delete_rank': 'admin:config:ranks',
    'admin:add_role': 'admin:config:roles',
    'admin:update_role': 'admin:config:roles',
    'admin:delete_role': 'admin:config:roles',
    'admin:get_role_details': 'admin:config:roles',
    'admin:update_role_permissions': 'admin:config:roles',
    'admin:add_location': 'admin:config:locations',
    'admin:update_location': 'admin:config:locations',
    'admin:delete_location': 'admin:config:locations',
    'admin:seed_default_locations': 'admin:config:locations',
    'admin:update_clearance': 'admin:config:clearance',
    'admin:add_marker': 'admin:config:clearance',
    'admin:update_marker': 'admin:config:clearance',
    'admin:delete_marker': 'admin:config:clearance',

    // Recognition
    'admin:add_specialization': 'admin:config:specializations',
    'admin:update_specialization': 'admin:config:specializations',
    'admin:delete_specialization': 'admin:config:specializations',
    'admin:add_certification': 'admin:config:certifications',
    'admin:update_certification': 'admin:config:certifications',
    'admin:delete_certification': 'admin:config:certifications',
    'admin:award_certification': 'admin:award:certification',
    'admin:revoke_certification': 'admin:revoke:certification',
    'admin:add_commendation': 'admin:config:commendations',
    'admin:update_commendation': 'admin:config:commendations',
    'admin:delete_commendation': 'admin:config:commendations',
    'admin:award_commendation': 'admin:award:commendation',
    'admin:revoke_commendation': 'admin:revoke:commendation',
    'admin:preview_specializations_import': 'admin:config:specializations',
    'admin:bulk_import_specializations': 'admin:config:specializations',
    'admin:preview_certifications_import': 'admin:config:certifications',
    'admin:bulk_import_certifications': 'admin:config:certifications',
    'admin:preview_commendations_import': 'admin:config:commendations',
    'admin:bulk_import_commendations': 'admin:config:commendations',

    // Comms & Notices
    'admin:add_announcement': 'admin:config:notices',
    'admin:update_announcement': 'admin:config:notices',
    'admin:delete_announcement': 'admin:config:notices',
    'broadcast:eam': 'admin:broadcast:eam',
    'broadcast:alert': 'admin:broadcast:eam',
    // Any authenticated user may CALL it; the handler enforces the
    // staff-or-user:receive:eam audience (mirrors the client UI gate).
    'broadcast:get_active_eam': 'user:manage:self',

    // Settings & Integrations
    'admin:update_discord_config': 'admin:config:discord',
    'admin:sync_discord_roles': 'admin:config:discord',
    'admin:sync_all_member_roles': 'admin:config:discord',
    'admin:sync_user_roles': 'admin:config:discord',
    'admin:update_rank_mapping': 'admin:config:discord',
    'admin:update_branding_config': 'admin:config:branding',
    'admin:update_theme_config': 'admin:config:theme',
    'admin:update_public_page_config': 'admin:config:branding',
    'admin:list_testimonial_candidates': 'admin:config:branding',
    'admin:update_intel_sharing_config': 'admin:config:api',
    'admin:update_hr_config': 'hr:admin',
    'admin:get_intel_sharing_config': 'admin:config:api',
    // Voice-server (LiveKit) credentials — url/apiKey/apiSecret. These are
    // secret-bearing voice INFRASTRUCTURE, not branding. Gate under the dedicated
    // voice permission (same bar as add/update/delete_radio_channel + radio:reboot)
    // so delegating admin:config:branding (a comms/PR role) cannot overwrite the
    // org's voice URL + API key/secret. Mirrors the per-credential siloing of
    // Discord (admin:config:discord) and Gemini (admin:config:ai).
    'admin:update_radio_config': 'radio:manage',
    'admin:update_hero_config': 'admin:config:branding',
    'admin:update_opengraph_config': 'admin:config:metadata',
    'admin:update_ai_config': 'admin:config:ai',
    'admin:update_wiki_home_config': 'wiki:edit_page',
    'admin:add_radio_channel': 'radio:manage',
    'admin:update_radio_channel': 'radio:manage',
    'admin:delete_radio_channel': 'radio:manage',
    'radio:reboot': 'radio:manage',
    'radio:auth': 'user:manage:self',
    'radio:op_auth': 'user:manage:self',
    'radio:status': 'user:manage:self',
    'system:search_locations': 'user:manage:self',
    // 'system:get_clearances' / 'system:get_markers' entries REMOVED together with their
    // handlers in api/actions/system.ts (Phase 3 item 5, owner decision D3). Both were
    // gated 'user:manage:self' — any authenticated session, an external customer
    // included — and served the org's whole classification ladder and its limiting-marker
    // codeword list, with ZERO callers repo-wide.
    // BOTH HALVES GO IN ONE COMMIT: tests/permissionMapCoverage.test.ts pins
    // actions ⊆ map AND map ⊆ actions, so deleting either half alone is red — and
    // deleting the map entry alone would hard-403 the still-registered action for EVERY
    // caller including the seeded Admin ('system:' is a PROTECTED_PREFIXES entry).
    // THIS DOES NOT CLOSE THE TAXONOMY: the `authenticated` PostgREST grant
    // (schema.sql private.rt_client_tables) still serves security_clearances and
    // security_limiting_markers to any session holding a realtime token. Phase 3 item 7
    // owns that. Do not re-add either action.
    // org:claim: any authenticated user can attempt; the claim code itself is
    // the privilege guard (validateClaimCode TTL + rate limit).
    'org:claim': 'user:manage:self',

    // Finances (org treasury / bank ledger)
    'finance:list_accounts':            'finance:view',
    'finance:list_ledger':              'finance:view',
    'finance:get_entry':                'finance:view',
    'finance:get_account':              'finance:view',
    'finance:get_overview':             'finance:view',
    'finance:export_csv':               'finance:view',
    'finance:submit_deposit':           'finance:deposit',
    'finance:submit_withdrawal':        'finance:withdraw_request',
    'finance:approve_entry':            'finance:approve',
    'finance:reject_entry':             'finance:approve',
    'finance:reverse_entry':            'finance:manage',
    'finance:record_adjustment':        'finance:manage',
    'finance:create_account':           'finance:manage',
    'finance:update_account':           'finance:manage',
    'finance:archive_account':          'finance:manage',
    'finance:reconcile':                'finance:manage',

    // Quartermaster (org inventory / armoury)
    'qm:list_catalog':                  'qm:view',
    'qm:get_catalog_item':              'qm:view',
    'qm:search_catalog':                'qm:view',
    'qm:list_locations':                'qm:view',
    'qm:get_location':                  'qm:view',
    'qm:list_inventory':                'qm:view',
    'qm:list_inventory_facets':         'qm:view',
    'qm:count_inventory':               'qm:view',
    'qm:list_issuances':                'qm:view',
    'qm:get_issuance':                  'qm:view',
    'qm:list_member_records':           'qm:view',
    'qm:list_overdue':                  'qm:view',
    'qm:get_overview':                  'qm:view',
    'qm:list_low_stock':                'qm:view',
    'qm:export_csv':                    'qm:view',
    'qm:request_issuance':              'qm:request',
    'qm:create_inventory':              'qm:manage',
    'qm:update_inventory':              'qm:manage',
    'qm:adjust_inventory':              'qm:manage',
    'qm:set_inventory_total':           'qm:manage',
    'qm:fulfil_issuance':               'qm:manage',
    'qm:issue_direct':                  'qm:manage',
    'qm:issue_bulk':                    'qm:manage',
    'qm:return_issuance':               'qm:manage',
    'qm:return_bulk':                   'qm:manage',
    'qm:write_off_issuance':            'qm:manage',
    'qm:create_location':               'qm:manage',
    'qm:update_location':               'qm:manage',
    'qm:delete_location':               'qm:manage',
    'qm:create_catalog_item':           'qm:admin',
    'qm:update_catalog_item':           'qm:admin',
    'qm:delete_catalog_item':           'qm:admin',

    // Warehouse — bulk fungible commodities
    'warehouse:list_catalog':           'warehouse:view',
    'warehouse:search_catalog':         'warehouse:view',
    'warehouse:list_locations':         'warehouse:view',
    'warehouse:list_stock':             'warehouse:view',
    'warehouse:count_stock':            'warehouse:view',
    'warehouse:list_movements':         'warehouse:view',
    'warehouse:list_withdrawals':       'warehouse:view',
    'warehouse:get_overview':           'warehouse:view',
    'warehouse:export_csv':             'warehouse:view',
    'warehouse:request_withdrawal':     'warehouse:request',
    'warehouse:cancel_withdrawal':      'warehouse:request',
    'warehouse:create_stock':           'warehouse:manage',
    'warehouse:delete_stock':           'warehouse:manage',
    'warehouse:adjust_stock':           'warehouse:manage',
    'warehouse:set_stock_total':        'warehouse:manage',
    'warehouse:transfer_stock':         'warehouse:manage',
    'warehouse:approve_withdrawal':     'warehouse:manage',
    'warehouse:deny_withdrawal':        'warehouse:manage',
    'warehouse:fulfil_withdrawal':      'warehouse:manage',
    'warehouse:create_location':        'warehouse:manage',
    'warehouse:update_location':        'warehouse:manage',
    'warehouse:delete_location':        'warehouse:manage',
    'warehouse:create_catalog_item':    'warehouse:admin',
    'warehouse:update_catalog_item':    'warehouse:admin',
    'warehouse:archive_catalog_item':   'warehouse:admin',
    'warehouse:delete_catalog_item':    'warehouse:admin',
    'warehouse:export_catalog':         'warehouse:view',
    'warehouse:preview_import_catalog': 'warehouse:admin',
    'warehouse:import_catalog':         'warehouse:admin',

    // External Tools & API
    'admin:add_tool': 'admin:config:tools',
    'admin:update_tool': 'admin:config:tools',
    'admin:delete_tool': 'admin:config:tools',
    'admin:reorder_tool': 'admin:config:tools',
    'api:create_key': 'admin:config:api',
    'api:delete_key': 'admin:config:api',
    'api:list_keys': 'admin:config:api',

    // Service Types
    'admin:add_service_type': 'admin:config:servicetypes',
    'admin:update_service_type': 'admin:config:servicetypes',
    'admin:delete_service_type': 'admin:config:servicetypes',

    // Warrants
    'warrant:create': 'warrant:create',
    'warrant:update': 'warrant:manage',
    'warrant:delete': 'warrant:manage',
    'warrant:generate_report': 'intel:create',
    // Notes: read for anyone who can view warrants, post for managers.
    'warrant:add_note': 'warrant:manage',
    'warrant:get_notes': 'warrant:view',

    // Intel
    'intel:get_reports': 'intel:view',
    'intel:get_recent': 'intel:view',
    'intel:list': 'intel:view',
    'intel:hub_stats': 'intel:view',
    'intel:get_dossier': 'intel:view',
    'intel:search': 'intel:view',
    'intel:get_stats': 'intel:view',
    'intel:create_report': 'intel:create',
    // Authoring a bulletin (org-wide push + Discord fan-out) is a WRITE —
    // gate it like report authoring, not at the read permission.
    'intel:create_bulletin': 'intel:create',
    'intel:delete_bulletin': 'intel:manage',
    'intel:get_bulletins': 'intel:view',
    'intel:update_report': 'intel:manage',
    'intel:delete_report': 'intel:manage',
    'intel:update_affiliation': 'intel:manage',
    'intel:bulk_update_affiliation': 'intel:manage',
    'intel:bulk_add_tags': 'intel:manage',
    'intel:bulk_delete_reports': 'intel:manage',
    // Generation writes the global per-target summary cache that only
    // intel:manage holders can read back — gate generation to the same
    // population so a non-manager can't forge or trigger it.
    'intel:generate_summary': 'intel:manage',
    'intel:sync_feeds': 'intel:manage', // Feed Ingest stays in the Intel tab
    // Receive-only feed CRUD moved to the Alliances tab (feeds are alliance_peers rows).
    'admin:get_trusted_feeds': 'alliance:manage',
    'admin:add_trusted_feed': 'alliance:manage',
    'admin:update_trusted_feed': 'alliance:manage',
    'admin:delete_trusted_feed': 'alliance:manage',
    'admin:sync_warrants_to_reports': 'intel:manage',
    'admin:deduplicate_warrants': 'intel:manage',
    'admin:deduplicate_intel': 'intel:manage',

    // Conduct
    'admin:add_conduct_entry': 'user:manage:conduct_record',
    'admin:delete_conduct_entry': 'user:manage:conduct_record',
    'admin:delete_request': 'request:delete',

    // Database maintenance family. These are NOT scoped reads — admin:db:repair
    // re-seeds RBAC / promotes an Admin, admin:db:prune issues raw mass DELETEs,
    // and admin:db:check is a count oracle over read-gated domains (intel/hr).
    // bare admin:access is seeded to the non-Admin Dispatcher, so gate the whole
    // family at the high-bar admin:db:destroy perm (NOT seeded to Dispatcher) and
    // additionally assert the genuine Admin role in each handler, mirroring the
    // danger-zone (full_reset/full_wipe) and platform-lifecycle pattern.
    'admin:security:list_events': 'admin:security:view_audit',
    'admin:db:check': 'admin:db:destroy',
    'admin:db:repair': 'admin:db:destroy',
    'admin:db:prune': 'admin:db:destroy',
    'admin:db:rotate_secrets': 'admin:db:destroy',
    // Domain-scoped destructive resets (raw mass DELETEs over the treasury ledger /
    // accounts and every quartermaster table). Gated at the same high bar as the
    // rest of the family, NOT at the domain perm: 'admin:' is not one of
    // OPTIONAL_FEATURE_NAMESPACES' prefixes, so the module-off gate above never
    // fires for these — this map entry is the only gate the dispatcher applies, and
    // a domain perm here let any delegated finance:manage / qm:manage holder (a
    // custom "Treasurer" role, say) wipe a module that was never enabled. The
    // domain-competence bar it used to carry ("a finance-blind dashboard user must
    // not erase the treasury") is NOT retired: the handlers assert the genuine Admin
    // role AND that same domain perm (assertDomainResetPerm, api/actions/admin.ts).
    'admin:db:reset_finances': 'admin:db:destroy',
    'admin:db:reset_quartermaster': 'admin:db:destroy',
    // Catastrophic full-DB destruction: a dedicated high-bar perm (NOT seeded to
    // Dispatcher). The handler additionally requires the genuine Admin role + a
    // server-validated confirmation phrase.
    'admin:db:full_reset': 'admin:db:destroy',
    'admin:db:full_wipe': 'admin:db:destroy',
    'admin:import_org': 'admin:access',
    'system:complete_setup': 'admin:access',
    'admin:get_platform_settings': 'admin:access',
    // Platform-lifecycle controls. Enabling maintenance mode (which locks out every
    // non-Admin, including the actor, irreversibly without a true Admin) or advancing
    // the force-logout watermark (which kills EVERY live session platform-wide) are
    // apex actions: gate them at the high-bar admin:db:destroy perm (NOT seeded to
    // Dispatcher) so the BOLA gate denies before the handler. The handlers ALSO assert
    // the genuine Admin role (assertAdminRole), mirroring the assertDangerZone pattern.
    'admin:update_platform_settings': 'admin:db:destroy',
    'admin:force_logout_all': 'admin:db:destroy',
    'admin:revoke_user_sessions': 'admin:user:update_role',
    'admin:update_features': 'admin:config:features',

    // ── Org bans ──
    // place / lift / list / review are ONE permission on purpose: splitting them
    // would let an org grant "can ban" without "can lift", which is exactly the
    // unrecoverable state the recoverability guard in ban:place exists to prevent.
    'ban:place': 'admin:user:ban',
    'ban:lift': 'admin:user:ban',
    'ban:list': 'admin:user:ban',
    'ban:list_appeals': 'admin:user:ban',
    'ban:review_appeal': 'admin:user:ban',
    // The self side, reachable WHILE BANNED (see BAN_EXEMPT_ACTIONS). Both are
    // dispatcher-scoped to the actor's own id and take no target.
    'ban:my_notice': 'user:manage:self',
    'ban:submit_appeal': 'user:manage:self',

    // Global Catalog Management (ships / items / commodities / locations)
    'catalog:list_ships': 'admin:config:catalog',
    'catalog:sync_ships': 'admin:config:catalog',
    'catalog:repair_ships': 'admin:config:catalog',
    'catalog:update_ship': 'admin:config:catalog',
    'catalog:delete_ship': 'admin:config:catalog',
    'catalog:merge_ships': 'admin:config:catalog',
    'catalog:list_items': 'admin:config:catalog',
    'catalog:count_items': 'admin:config:catalog',
    'catalog:list_item_categories': 'admin:config:catalog',
    'catalog:update_item_category': 'admin:config:catalog',
    'catalog:delete_item_category': 'admin:config:catalog',
    'catalog:sync_items': 'admin:config:catalog',
    'catalog:sync_item_attributes': 'admin:config:catalog',
    'catalog:update_item': 'admin:config:catalog',
    'catalog:delete_item': 'admin:config:catalog',
    'catalog:list_commodities': 'admin:config:catalog',
    'catalog:count_commodities': 'admin:config:catalog',
    'catalog:list_commodity_categories': 'admin:config:catalog',
    'catalog:update_commodity_category': 'admin:config:catalog',
    'catalog:delete_commodity_category': 'admin:config:catalog',
    'catalog:sync_commodities': 'admin:config:catalog',
    'catalog:update_commodity': 'admin:config:catalog',
    'catalog:delete_commodity': 'admin:config:catalog',
    'catalog:list_locations': 'admin:config:catalog',
    'catalog:count_locations': 'admin:config:catalog',
    'catalog:sync_locations': 'admin:config:catalog',
    'catalog:update_location': 'admin:config:catalog',
    'catalog:delete_location': 'admin:config:catalog',

    // Discord directory (read-only) — used by both the Comms Plan editor
    // (manager-only context) and the operation announcement picker in the
    // create wizard (creator-level context). Channel names are not sensitive
    // (any Discord member could see them), so we gate at the lowest needed
    // permission.
    'discord:list_guild_channels': 'operations:create',
    'discord:list_channels_admin': 'admin:config:discord',

    // HR Actions
    'hr:get_state': 'hr:view',
    // Recruiter-only case-file creation (AddCaseFile / Transfer / Interview modals).
    // Members file via the THROTTLED user:submit_application; this twin hits the same
    // sink (createHRApplication + push fan-out), so it must require a real HR perm —
    // not user:manage:self, which left it open to any member as an un-throttled DoS.
    'hr:create_application': 'hr:recruiter',
    'hr:update_app_status': 'hr:recruiter',
    'hr:update_application_data': 'hr:recruiter',
    'hr:delete_application': 'hr:manager',
    'hr:assign_recruiter': 'hr:manager',
    'hr:create_interview': 'hr:recruiter',
    // Eligibility pickers for the two actions above. Each mirrors the gate of the
    // action it feeds, so the picker can never enumerate HR staff to a caller who
    // could not perform the write. Deliberately NOT 'hr:view' — that is a
    // MEMBER_DEFAULT_PERMS entry, so it would hand every member a roster of the
    // org's recruiters and case officers.
    'hr:get_eligible_interviewers': 'hr:recruiter',
    'hr:get_eligible_officers': 'hr:manager',
    'hr:update_interview': 'hr:recruiter',
    'hr:update_interview_interviewer': 'hr:manager',
    'hr:delete_interview': 'hr:manager',
    'hr:save_interview': 'hr:recruiter',
    'hr:reopen_interview': 'hr:manager',
    'hr:create_job': 'hr:manager',
    'hr:update_job': 'hr:manager',
    'hr:update_job_status': 'hr:manager',
    'hr:delete_job': 'hr:manager',
    // No member-facing caller (members use the throttled user:apply_job); gate to a
    // real HR perm so this twin can't be used to bypass the submission throttle.
    'hr:apply_job': 'hr:recruiter',
    'hr:request_transfer': 'user:manage:self',
    'hr:process_transfer': 'hr:manager',
    'hr:create_template': 'hr:admin',
    'hr:update_template': 'hr:admin',
    'hr:delete_template': 'hr:admin',
    'hr:get_template_details': 'hr:recruiter',
    'hr:get_my_interviews': 'hr:view',
    'hr:create_position': 'hr:manage:positions',
    'hr:update_position': 'hr:manage:positions',
    'hr:delete_position': 'hr:manage:positions',
    'hr:add_log': 'hr:recruiter',
    // Application logs embed recruiter-grade free text and applicant/recruiter
    // real names verbatim; getHRApplicationLogs takes no requester so it cannot
    // redact. Gate at hr:recruiter to match its siblings hr:add_log +
    // hr:get_application_data instead of the default-Member hr:view.
    'hr:get_application_logs': 'hr:recruiter',
    // Vetting data is recruiter-grade PII (matches the hr:update_application_data
    // write gate and the getHRState non-recruiter redaction).
    'hr:get_application_data': 'hr:recruiter',
    'hr:process_job_approval': 'hr:recruiter',

    // User self-service. These act on the caller's OWN record (the dispatcher forces
    // userId to the authenticated user), so the gate is simply "any signed-in user" via
    // the user:manage:self pseudo-permission — with ONE exception, user:toggle_duty,
    // immediately below. user:get_position_history does its own cross-user check inside
    // the handler. Every user:* action must appear here now that 'user:' is a protected
    // prefix (permissionMapCoverage pins it).
    'user:logout': 'user:manage:self',
    // NOT 'user:manage:self': going on duty is a STAFF capability, and this build already
    // says so everywhere else — 'user:toggle_duty' is an entry in STAFF_VIEW_PERMS
    // (lib/staffPerms.ts, "only personnel go on duty"), a Member and Dispatcher seeded
    // default (lib/roleDefaultPermissions.ts), a real permission row (schema.sql §7,
    // lib/db/system.ts GLOBAL_PERMISSIONS), and both UI entry points gate on it. The
    // pseudo-perm was the ONLY place that disagreed, which let an external customer flip
    // their own is_duty and appear in every staff duty picker that does not filter by
    // tier. Mapping the action to the permission of the same name changes nothing for
    // Member/Dispatcher/Admin and closes the Client. Toggling SOMEONE ELSE's duty is
    // 'admin:toggle_duty' -> 'admin:user:update', unchanged.
    // ACCEPTED: the BOLA gate has no isSystemAdmin bypass ("Admin role bypasses via
    // permissions"), so an Admin role stripped of this permission through the Roles UI
    // loses its own self-toggle. The seeder grants Admin every permission.
    'user:toggle_duty': 'user:toggle_duty',
    'user:heartbeat': 'user:manage:self',
    'user:initiate_rsi_update': 'user:manage:self',
    'user:verify_rsi_update': 'user:manage:self',
    'user:cancel_rsi_update': 'user:manage:self',
    'user:sync_roles': 'user:manage:self',
    'user:update_specializations': 'user:manage:self',
    'user:update_display_name': 'user:manage:self',
    'user:update_preferences': 'user:manage:self',
    'user:get_clearance_history': 'user:manage:self',
    'user:get_position_history': 'user:manage:self',
    'user:set_radio_channel': 'user:manage:self',
    'user:delete_self': 'user:manage:self',
    'user:subscribe_push': 'user:manage:self',
    'user:test_push': 'user:manage:self',
    'user:apply_job': 'user:manage:self',
    'user:submit_application': 'user:manage:self',

    // Unit Feed
    'unit:get_feed': 'user:view:roster',
    'unit:create_post': 'user:view:roster',
    'unit:delete_post': 'user:view:roster',
    'unit:update_details': 'unit:manage:own',

    // Request Actions
    'request:create': 'request:create',
    'request:create_adhoc': 'request:create_adhoc',
    'request:triage': 'request:triage',
    'request:admin_accept': 'request:dispatch',
    'request:accept': 'request:accept',
    'request:start': 'request:start',
    'request:complete': 'request:complete',
    'request:cancel': 'request:cancel',
    'request:rate': 'request:rate',
    'request:add_note': 'request:update',
    'request:update_status': 'request:update',
    'request:dispatch_members': 'request:dispatch',
    'request:add_responder': 'request:manage_responders',
    'request:remove_responder': 'request:manage_responders',
    'request:set_lead': 'request:set_lead',
    'request:add_party_member': 'request:update',
    'request:remove_party_member': 'request:update',
    'request:refuse': 'request:triage',
    'request:delete': 'request:delete',

    // Operation Actions
    'operation:create': 'operations:create',
    'operation:get_details': 'operations:view',
    'operation:delete': 'operations:manage',
    'operation:update': 'operations:manage',
    'operation:update_status': 'operations:manage',
    'operation:join': 'operations:view',
    'operation:leave': 'operations:view',
    'operation:add_participant': 'operations:manage',
    'operation:add_uec': 'operations:manage',
    'operation:add_cost': 'operations:manage',
    'operation:set_payout_mode': 'operations:manage',
    'operation:set_payout_splits': 'operations:manage',
    'operation:toggle_payout_paid': 'operations:manage',
    'operation:timeline_add': 'operations:view',
    'operation:toggle_ready': 'operations:view',
    'operation:update_participant_live_status': 'operations:view',
    'operation:reset_readiness': 'operations:manage',
    'operation:join_with_role': 'operations:view',
    'operation:update_participant': 'operations:manage',
    'operation:rsvp': 'operations:view',

    'operation:get_participant_ships': 'operations:view',

    'operation:update_live_status': 'operations:manage',

    // Operation Sub-resources (Phases, Schedule, Tasks, C2, Board, Logistics, AAR)
    'operation:add_phase': 'operations:manage',
    'operation:update_phase': 'operations:manage',
    'operation:delete_phase': 'operations:manage',
    'operation:add_schedule_entry': 'operations:manage',
    'operation:update_schedule_entry': 'operations:manage',
    'operation:delete_schedule_entry': 'operations:manage',
    'operation:add_task': 'operations:manage',
    'operation:update_task': 'operations:manage',
    'operation:delete_task': 'operations:manage',
    'operation:add_command_node': 'operations:manage',
    'operation:update_command_node': 'operations:manage',
    'operation:delete_command_node': 'operations:manage',

    // Ship slots + seats. Organiser DESIGNS and ASSIGNS under operations:manage;
    // a member applies for and withdraws from a seat under operations:view — the
    // same tier as join / rsvp / toggle_ready / fulfill_logistics.
    'operation:add_ship_slot': 'operations:manage',
    'operation:update_ship_slot': 'operations:manage',
    'operation:delete_ship_slot': 'operations:manage',
    'operation:assign_slot': 'operations:manage',
    'operation:decide_slot_application': 'operations:manage',
    'operation:remove_slot_assignment': 'operations:manage',
    'operation:apply_for_slot': 'operations:view',
    'operation:withdraw_slot': 'operations:view',
    'operation:add_board_element': 'operations:manage',
    'operation:update_board_element': 'operations:manage',
    'operation:delete_board_element': 'operations:manage',
    'operation:save_board': 'operations:manage',
    'operation:add_logistics': 'operations:manage',
    'operation:update_logistics': 'operations:manage',
    'operation:delete_logistics': 'operations:manage',
    'operation:fulfill_logistics': 'operations:view',
    'operation:add_aar_entry': 'operations:view',
    'operation:delete_aar_entry': 'operations:manage',
    'operation:submit_aar': 'operations:manage',
    'operation:reopen_aar': 'operations:manage',
    'operation:generate_aar_summary': 'operations:manage',
    // Templates: read for anyone with operations:view, mutate gated to creators.
    // operations:create is the existing perm a user needs to make a new op.
    'operation:template:list': 'operations:view',
    'operation:template:get': 'operations:view',
    'operation:template:create': 'operations:create',
    'operation:template:update': 'operations:create',
    'operation:template:delete': 'operations:create',
    'operation:template:from_operation': 'operations:create',
    'operation:template:import': 'operations:create',
    'operation:broadcast_alert': 'operations:manage',
    // Alert-content fetch for the trigger-only realtime ping; the handler
    // additionally re-applies the per-op clearance predicate.
    'operation:get_latest_alert': 'operations:view',
    'operation:repost_announcement': 'operations:manage',

    // Wiki
    'wiki:create_page': 'wiki:add_page',
    'wiki:update_page': 'wiki:edit_page',
    'wiki:delete_page': 'wiki:delete_page',
    'wiki:reorder_pages': 'wiki:edit_page',
    // Full unfiltered page dump (bypasses the clearance filter applied to the
    // wiki read path) — restrict to Admin so a clearance-limited wiki editor
    // can't export above-clearance classified pages.
    'wiki:export_pages': 'admin:access',
    'wiki:import_pages': 'admin:access',

    // Fleet Manager
    'fleet:add_ship': 'fleet:manage_own',
    'fleet:add_ships': 'fleet:manage_own',
    'fleet:update_ship': 'fleet:manage_own',
    'fleet:remove_ship': 'fleet:manage_own',
    'fleet:remove_ships': 'fleet:manage_own',
    'fleet:create_group': 'fleet:manage',
    'fleet:update_group': 'fleet:manage',
    'fleet:delete_group': 'fleet:manage',
    'fleet:assign_ship': 'fleet:manage',
    'fleet:unassign_ship': 'fleet:manage',
    'fleet:reorder_groups': 'fleet:manage',
    'fleet:reorder_group_ships': 'fleet:manage',
    'fleet:reparent_group': 'fleet:manage',
    'fleet:sync_catalog': 'admin:access',

    // Government
    'gov:update_feature_config': 'gov:admin',
    'gov:upsert_config': 'gov:admin',
    'gov:apply_template': 'gov:admin',
    'gov:get_templates': 'gov:view',
    'gov:update_constitution': 'gov:admin',
    'gov:create_branch': 'gov:admin',
    'gov:update_branch': 'gov:admin',
    'gov:delete_branch': 'gov:admin',
    'gov:reorder_branches': 'gov:admin',
    'gov:create_position': 'gov:admin',
    'gov:update_position': 'gov:admin',
    'gov:delete_position': 'gov:admin',
    'gov:reorder_positions': 'gov:admin',
    'gov:appoint_holder': 'gov:manage',
    'gov:remove_holder': 'gov:manage',
    'gov:create_election': 'gov:electoral_officer',
    'gov:update_election': 'gov:electoral_officer',
    'gov:advance_election': 'gov:electoral_officer',
    'gov:cancel_election': 'gov:electoral_officer',
    'gov:certify_results': 'gov:electoral_officer',
    'gov:call_by_election': 'gov:electoral_officer',
    'gov:declare_candidacy': 'gov:participate',
    'gov:withdraw_candidacy': 'gov:participate',
    'gov:cast_election_vote': 'gov:participate',
    'gov:create_legislation': 'gov:elected_official',
    'gov:update_legislation': 'gov:elected_official',
    'gov:propose_legislation': 'gov:elected_official',
    'gov:start_legislation_debate': 'gov:manage',
    'gov:start_legislation_vote': 'gov:manage',
    'gov:cast_legislation_vote': 'gov:elected_official',
    'gov:conclude_legislation_vote': 'gov:manage',
    'gov:veto_legislation': 'gov:elected_official',
    'gov:repeal_legislation': 'gov:manage',
    'gov:add_legislation_comment': 'gov:view',
    'gov:delete_legislation_comment': 'gov:manage',
    'gov:create_motion': 'gov:manage',
    'gov:start_motion_vote': 'gov:manage',
    'gov:cast_motion_vote': 'gov:participate',
    'gov:conclude_motion': 'gov:manage',
    'gov:cancel_motion': 'gov:manage',

    // Orders — reads open to anyone viewing gov; mutations gated by position holdership (server-side in db layer)
    'gov:list_orders': 'gov:view',
    'gov:get_order': 'gov:view',
    'gov:get_my_issuing_positions': 'gov:view',
    'gov:create_order': 'gov:issue_orders',
    'gov:update_order': 'gov:issue_orders',
    'gov:revoke_order': 'gov:issue_orders',
    'gov:delete_order': 'gov:issue_orders',

    // Alliances — mutations + the admin peer list require manage; the member
    // directory + self-profile read require view.
    'alliance:generate_code': 'alliance:manage',
    'alliance:add_peer': 'alliance:manage',
    'alliance:connect_peer': 'alliance:manage',
    'alliance:list_peers': 'alliance:manage',
    'alliance:update_peer': 'alliance:manage',
    'alliance:delete_peer': 'alliance:manage',
    'alliance:save_self_profile': 'alliance:manage',
    'alliance:get_directory': 'alliance:view',
    'alliance:get_self_profile': 'alliance:view',
    'alliance:fetch_peer_roster': 'alliance:view',
    'alliance:fetch_peer_fleet': 'alliance:view',
    'alliance:force_sync': 'alliance:manage',

    // Joint-op federation: host invite/revoke = manage operations; guest
    // accept/decline = diplomacy admin; list/get/rsvp/poll = view operations.
    'operation:invite_ally': 'operations:manage',
    'operation:revoke_ally': 'operations:manage',
    'mirror:list': 'operations:view',
    'mirror:list_pending': 'alliance:manage',
    'mirror:get': 'operations:view',
    'mirror:accept': 'alliance:manage',
    'mirror:decline': 'alliance:manage',
    'mirror:poll': 'operations:view',
    'mirror:rsvp': 'operations:view',
    'mirror:rsvp_remove': 'operations:view',

    // Marketplace — browse/read = view; posting/managing own listings = list;
    // proposing & running contracts = contract. Per-resource ownership/party
    // checks are enforced in lib/db/marketplace.ts (single-org: the per-user
    // boundary is the only authz, so the db layer carries it).
    'marketplace:get_categories': 'marketplace:view',
    'marketplace:browse': 'marketplace:view',
    'marketplace:get_listing': 'marketplace:view',
    'marketplace:get_profile': 'marketplace:view',
    'marketplace:get_contract_ratings': 'marketplace:view',
    'marketplace:report': 'marketplace:view',
    'marketplace:create_listing': 'marketplace:list',
    'marketplace:update_listing': 'marketplace:list',
    'marketplace:delete_listing': 'marketplace:list',
    'marketplace:propose': 'marketplace:contract',
    'marketplace:accept': 'marketplace:contract',
    'marketplace:mark_delivered': 'marketplace:contract',
    'marketplace:confirm_received': 'marketplace:contract',
    'marketplace:cancel': 'marketplace:contract',
    'marketplace:rate': 'marketplace:contract',
    'marketplace:my_contracts': 'marketplace:contract',
    'marketplace:get_milestones': 'marketplace:contract',
    'marketplace:toggle_milestone': 'marketplace:contract',
    'marketplace:delete_milestone': 'marketplace:contract',
    // Category administration + report moderation — single 'marketplace:admin' bar.
    'marketplace:admin:list_categories': 'marketplace:admin',
    'marketplace:admin:create_category': 'marketplace:admin',
    'marketplace:admin:update_category': 'marketplace:admin',
    'marketplace:admin:delete_category': 'marketplace:admin',
    'marketplace:admin:seed_categories': 'marketplace:admin',
    'marketplace:admin:list_reports': 'marketplace:admin',
    'marketplace:admin:review_report': 'marketplace:admin',

    // Notification Center — the caller's OWN inbox. Self-scoped by user_id in the
    // db layer (BOLA-asserted), so any authenticated session may call these
    // (user:manage:self); there is no role permission for a personal inbox.
    'notifications:mark_read': 'user:manage:self',
    'notifications:mark_all_read': 'user:manage:self',
    'notifications:delete': 'user:manage:self',

    // Academy (LMS). Instructor curriculum/session authoring → academy:instruct;
    // Learning-Admin lifecycle/certify → academy:manage. set_course_certification
    // + certify_and_complete additionally require admin:award:certification (the
    // cert-award escalation gate), asserted in the db layer. Student self-service
    // (self_enroll / mark_lesson / withdraw own / get own enrolment / catalog) →
    // user:manage:self, BOLA-scoped in the db. The whole namespace is also
    // feature-gated in the dispatcher (403 when Academy is OFF).
    'academy:create_course': 'academy:instruct',
    'academy:update_course': 'academy:instruct',
    'academy:delete_course': 'academy:instruct',
    'academy:submit_course': 'academy:instruct',
    'academy:set_course_certification': 'academy:manage',
    'academy:approve_course': 'academy:manage',
    'academy:reject_course': 'academy:manage',
    'academy:set_course_archived': 'academy:manage',
    'academy:set_course_access': 'academy:manage',
    'academy:add_course_instructor': 'academy:instruct',
    'academy:add_course_instructors': 'academy:instruct',
    'academy:withdraw_enrollments_bulk': 'academy:instruct',
    'academy:recommend_enrollments_bulk': 'academy:instruct',
    'academy:remove_course_instructor': 'academy:instruct',
    'academy:create_module': 'academy:instruct',
    'academy:update_module': 'academy:instruct',
    'academy:delete_module': 'academy:instruct',
    'academy:create_lesson': 'academy:instruct',
    'academy:update_lesson': 'academy:instruct',
    'academy:delete_lesson': 'academy:instruct',
    'academy:create_outcome': 'academy:instruct',
    'academy:update_outcome': 'academy:instruct',
    'academy:delete_outcome': 'academy:instruct',
    'academy:reorder_modules': 'academy:instruct',
    'academy:reorder_lessons': 'academy:instruct',
    'academy:reorder_outcomes': 'academy:instruct',
    'academy:create_session': 'academy:instruct',
    'academy:update_session': 'academy:instruct',
    'academy:set_session_status': 'academy:instruct',
    'academy:add_session_instructor': 'academy:instruct',
    'academy:remove_session_instructor': 'academy:instruct',
    'academy:assign_students': 'academy:instruct',
    'academy:assess_outcome': 'academy:instruct',
    'academy:recommend_certification': 'academy:instruct',
    'academy:certify_and_complete': 'academy:manage',
    'academy:self_enroll': 'user:manage:self',
    'academy:withdraw_enrollment': 'user:manage:self',
    // Asking for a seat is a self-service act — the gate that matters is on the
    // DECISION, not the ask. Withdraw is self-scoped inside the db layer (the row's
    // student_id must equal the caller), so user:manage:self is the whole control.
    'academy:request_enrollment': 'user:manage:self',
    'academy:withdraw_enrollment_request': 'user:manage:self',
    'academy:list_my_enrollment_requests': 'user:manage:self',
    'academy:decide_enrollment_request': 'academy:instruct',
    'academy:list_enrollment_requests': 'academy:instruct',
    'academy:mark_lesson': 'user:manage:self',
    'academy:get_enrollment': 'user:manage:self',
    'academy:get_catalog_course': 'user:manage:self',
    'academy:get_course': 'academy:view',
    'academy:list_course_reviews': 'academy:instruct',
    'academy:get_session': 'academy:view',
    'academy:list_recommended': 'academy:manage',
    'academy:report_completions': 'academy:manage',
    'academy:report_course_activity': 'academy:manage',
    'academy:report_cert_holders': 'academy:manage',
    'academy:report_member_transcript': 'academy:manage',

    // ── Blueprints ────────────────────────────────────────────────────────────
    // Five permissions, four rungs. `:view` is the read tier for BOTH registry
    // reads — the craftable list is a de-duplicated item picker, not a second,
    // lower boundary (see lib/db/blueprints.ts). `:register` covers the caller's
    // OWN registry rows and is where the ownership guards live; `:request` is the
    // asking side; `:craft` is the fulfilling side and is what puts the open board
    // in reach; `:manage` moderates other members' rows — and even it cannot set
    // someone else's offers_crafting, because that flag is consent.
    //
    // confirm_received is deliberately on `:request`, not `:craft`: only the
    // member who raised the ask may say they received it, and the db layer refuses
    // a manage bypass there too.
    'blueprint:list_registry': 'blueprint:view',
    'blueprint:list_craftable': 'blueprint:view',
    'blueprint:list_requests': 'blueprint:view',
    'blueprint:register': 'blueprint:register',
    'blueprint:update': 'blueprint:register',
    'blueprint:delete': 'blueprint:register',
    'blueprint:create_request': 'blueprint:request',
    'blueprint:confirm_received': 'blueprint:request',
    'blueprint:cancel_request': 'blueprint:request',
    'blueprint:claim_request': 'blueprint:craft',
    'blueprint:release_request': 'blueprint:craft',
    'blueprint:mark_ready': 'blueprint:craft',
    'blueprint:mark_delivered': 'blueprint:craft',
};

export const actions: Record<string, ActionHandler> = {
    ...authActions,
    ...adminActions,
    ...hrActions,
    ...operationActions,
    ...requestActions,
    ...intelActions,
    ...systemActions,
    ...userActions,
    ...wikiActions,
    ...fleetActions,
    ...governmentActions,
    ...financesActions,
    ...quartermasterActions,
    ...warehouseActions,
    ...marketplaceActions,
    ...catalogActions,
    ...allianceActions,
    ...operationsFederationActions,
    ...notificationActions,
    ...academyActions,
    ...blueprintActions,
    ...banActions,
};

// Validate permission-map coverage against the actions registry.
// - `missing`: protected, non-public actions with no fullPermissionMap entry.
//   These silently 403 in prod (the dispatcher denies any unmappable protected action).
// - `stale`: map entries with no registered action — dead config from a
//   rename/delete; harmless but indicates drift.
// Called once at boot; results are logged so drift shows in deploy logs.
// Actor-identity fields the dispatcher overrides with the authenticated user's
// id (see "IDENTITY SPOOFING MITIGATION" in the handler below). At module scope
// so the same list drives both the dispatcher mutation and stripActorFields.
// Target-identity fields (targetUserId, memberId, recruiterId, allyOrgId, etc.)
// are intentionally NOT here — admin actions legitimately act on other users.
export const ACTOR_ID_FIELDS: readonly string[] = [
    'userId',
    'adminId',
    'creatorId',
    'createdById',
    'authorId',
    'issuedById',
    'issuerId',
    'reporterId',
    'senderId',
    'requesterId',
    'actorId',
    'performedById',
    'appointedById',
];

// Plumbing fields the dispatcher injects on every authenticated request: the
// populated user object + `interviewerId`. Combined with ACTOR_ID_FIELDS, this
// is what stripActorFields() removes when a handler wants only the user-supplied
// payload data (e.g. a config blob written to the DB verbatim). interviewerId is
// stripped because config handlers never want it and it's only injected for
// hr:save_interview (which doesn't use stripActorFields).
const PLUMBING_FIELDS: readonly string[] = ['user', 'interviewerId'];
const STRIPPABLE_FIELDS = new Set<string>([...ACTOR_ID_FIELDS, ...PLUMBING_FIELDS]);

/**
 * Return a shallow copy of `payload` with all actor-identity + dispatcher
 * plumbing fields removed. Used by handlers (notably admin config-update
 * endpoints) to derive a clean data blob before passing it to the DB layer.
 * Does not mutate the input. Does NOT strip `organizationId` — handlers usually
 * pass that as a separate argument.
 */
export function stripActorFields<T extends Record<string, any>>(payload: T): Partial<T> {
    const out: Record<string, any> = {};
    for (const key of Object.keys(payload)) {
        if (STRIPPABLE_FIELDS.has(key)) continue;
        out[key] = payload[key];
    }
    return out as Partial<T>;
}

export function validatePermissionMap(): { missing: string[]; stale: string[] } {
    const publicSet = new Set(PUBLIC_ACTIONS);
    const missing = Object.keys(actions).filter(a =>
        !publicSet.has(a) &&
        PROTECTED_PREFIXES.some(p => a.startsWith(p)) &&
        !(a in fullPermissionMap)
    );
    const stale = Object.keys(fullPermissionMap).filter(k => !(k in actions));
    return { missing, stale };
}

// Denials go to BOTH sinks from one place so the two cannot drift. log.warn keeps the
// operational signal in stdout for whoever is tailing it; recordSecurityEvent makes the
// same event answerable months later, once the container that held that stdout is gone.
// "Which account tried to reset the treasury, and when?" is not a question you can
// answer by grepping a redeployed container.
//
// FIRE-AND-FORGET ON PURPOSE. recordSecurityEvent never rejects, and an audit write must
// never be able to turn a 403 into a 500: a denial that fails loudly because its audit
// row could not be written is a worse outcome than a missing row, and a 500 is retried
// or handled more permissively than a 403 on several paths. Losing the audit row is bad;
// losing the denial is worse.
function auditDenial(event: string, ctx: {
    action?: string | null;
    user?: { id?: number; rsiHandle?: string } | null;
    ip?: string | null;
    details?: Record<string, unknown>;
}): void {
    const userId = ctx.user?.id;
    log.warn(event, { userId, action: ctx.action ?? undefined, ...(ctx.details || {}) });
    // recordSecurityEvent is contracted never to REJECT, but it can still be ABSENT or
    // throw synchronously — a partial test double, a barrel that failed to load, a future
    // refactor. `void` does not catch either of those, so the contract has to be made
    // structural here or it is only aspirational: an undefined emitter would turn every
    // 403 in this file into a 500, which is precisely the inversion the comment above
    // says must not happen.
    try {
        void db.recordSecurityEvent({
            event,
            action: ctx.action ?? null,
            actorUserId: typeof userId === 'number' ? userId : null,
            // The handle is kept so the row still identifies someone after the account is
            // deleted and actor_user_id goes NULL. It is not a secret: it is the public
            // RSI handle already shown on every roster row.
            actorLabel: ctx.user?.rsiHandle ?? null,
            actorIp: ctx.ip ?? null,
            details: ctx.details,
        });
    } catch (err) {
        log.warn('security event emit threw', { err });
    }
}

export default async function handler(req: Request, res: Response) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed' });
    }

    const { action, payload } = req.body;

    // Hoisted to handler scope: every denial path below records it on the audit row,
    // so an operator can see WHERE a probe came from and not just that it happened.
    const ip = getClientIp(req);

    // --- AUTH RATE LIMITING ---
    // Per-IP cap on `auth:*` actions (10/min/IP), applied before context
    // resolution so rejected requests short-circuit the DB lookups. The global
    // 100 req/min/IP limit alone left too much room for OAuth probing.
    if (typeof action === 'string' && action.startsWith('auth:')) {
        const check = checkAuthRateLimit(ip);
        if (!check.ok) {
            // Log the trip so an operator can spot credential probing / OAuth
            // hammering, matching the permission-denied and blackhole logs. IP and
            // action only — no credential data.
            auditDenial('auth.rate_limited', { action, ip, details: { retryAfter: check.retryAfter } });
            res.setHeader('Retry-After', String(check.retryAfter));
            return res.status(429).json({
                success: false,
                message: 'Too many authentication attempts. Please try again shortly.',
                code: 'AUTH_RATE_LIMITED',
                retryAfter: check.retryAfter,
            });
        }
    }

    // Single-org: no subdomain/tenant resolution. There is exactly one org and
    // no organization_id column, so nothing is injected into the payload here.

    // DUAL-ACCEPT: the session credential may arrive as an HttpOnly cookie (preferred) or, for a session issued before the cookie existed, the Authorization header. A hard cutover would log out every live session on deploy.
    const token = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
    const publicActions = PUBLIC_ACTIONS;

    // --- MAINTENANCE MODE + FORCE LOGOUT ENFORCEMENT ---
    // Force-logout bypass is NARROWER than maintenance bypass: only the pre-login
    // auth bootstrap actions skip force-logout. user:heartbeat skips maintenance
    // but is still subject to force-logout, so a revoked session can't keep
    // heart-beating indefinitely.
    const forceLogoutBypass = ['auth:begin_oauth', 'auth:discord_callback', 'auth:finalize_setup', 'auth:redeem_setup_code', 'system:get_push_config', 'system:preflight'];
    const maintenanceBypass = ['user:heartbeat', ...forceLogoutBypass];
    if (!forceLogoutBypass.includes(action) || !maintenanceBypass.includes(action)) {
        try {
            const platformSettings = await db.getPlatformSettings();
            const isMaintenanceActive = platformSettings?.maintenance_mode === true;

            // Force logout: enforce regardless of maintenance state. The platform
            // admin needs to revoke compromised sessions without taking the whole
            // platform offline. Tokens issued before force_logout_timestamp 401.
            if (!forceLogoutBypass.includes(action) && platformSettings?.force_logout_timestamp && token) {
                const decoded = verifyToken(token);
                if (decoded && isSessionForceLoggedOut(decoded, platformSettings.force_logout_timestamp)) {
                    appendSetCookie(res, clearSessionCookie(SESSION_COOKIE_IS_SECURE)); return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
                }
            }

            if (isMaintenanceActive && !maintenanceBypass.includes(action)) {
                // Allow the org Admin through — check the session JWT if present.
                let isAdmin = false;
                if (token) {
                    const decoded = verifyToken(token);
                    if (decoded) {
                        // Own try/catch: getUserById is fail-closed and THROWS on a
                        // read fault. The outer catch below only warns, and the 503
                        // return lives inside it — so letting the throw escape here
                        // would skip the maintenance gate entirely and open the
                        // platform to everyone on a DB blip. Unknown ⇒ not Admin.
                        let adminUser: Awaited<ReturnType<typeof db.getUserById>> = null;
                        try { adminUser = await db.getUserById(decoded.userId); }
                        catch (err) { log.warn('maintenance admin check failed; treating as non-admin', { err }); }
                        // Role IDENTITY (stamped by getUserById). Deliberately NOT
                        // admin:access: the seeded Dispatcher holds it, and handing a
                        // Dispatcher the maintenance bypass would defeat the window the
                        // operator declared. On the DENY path only, re-resolve
                        // cache-free — the stamp reads a 5-minute memo that an org
                        // import leaves pointing at deleted role ids, and lifting
                        // maintenance is the escape hatch with no other in-app exit.
                        // resolveIsSystemAdminFresh never throws. Unknown ⇒ not Admin.
                        if (adminUser?.isSystemAdmin === true) isAdmin = true;
                        else if (adminUser) isAdmin = await db.resolveIsSystemAdminFresh(adminUser.roleId);
                    }
                }
                if (!isAdmin) {
                    return res.status(503).json({ message: 'The platform is currently undergoing maintenance. Please try again later.' });
                }
            }
        } catch (e) {
            log.warn('maintenance check failed', { err: e });
        }
    }

    // --- OAUTH STATE-COOKIE BINDING (server half of login-CSRF defense) ---
    // begin_oauth mints an HttpOnly nonce cookie before the redirect; the callback
    // refuses to exchange the code unless the state nonce echoed back matches that
    // cookie (constant-time). Derive Secure from the forwarded proto (TLS is
    // terminated upstream by the Coolify/Nixpacks deploy).
    {
        const reqSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        if (action === 'auth:begin_oauth') {
            const nonce = (payload as { nonce?: unknown } | null)?.nonce;
            if (!isValidNonceShape(nonce)) {
                return res.status(400).json({ success: false, message: 'Invalid OAuth nonce.' });
            }
            res.setHeader('Set-Cookie', buildOAuthStateCookie(nonce, reqSecure));
            return res.status(200).json({ success: true, data: { ok: true } });
        }
        if (action === 'auth:discord_callback') {
            const cookieNonce = readOAuthStateCookie(req.headers['cookie'], reqSecure);
            // The nonce is the last ':'-segment of state (login:<nonce> /
            // admin_setup:<key>:<nonce>) — reuse it rather than a separate field.
            const state = (payload as { state?: unknown } | null)?.state;
            const sentNonce = typeof state === 'string' ? (state.split(':').pop() || null) : null;
            if (!nonceMatches(sentNonce, cookieNonce)) {
                // Fail closed BEFORE the code is exchanged. Clear the cookie so a
                // retry starts a fresh begin_oauth round.
                res.setHeader('Set-Cookie', clearOAuthStateCookie(reqSecure));
                auditDenial('auth.oauth_state.denied', { action, ip, details: { hasCookie: !!cookieNonce, hasNonce: typeof sentNonce === 'string' } });
                return res.status(403).json({ success: false, message: 'OAuth state validation failed. Please try signing in again.', code: 'OAUTH_STATE_INVALID' });
            }
            // One-time use: clear the cookie now that it has been consumed.
            res.setHeader('Set-Cookie', clearOAuthStateCookie(reqSecure));
        }
    }

    // --- PUBLIC ACTION HANDLER ---
    if (publicActions.includes(action)) {
        // Own-property check, NOT truthiness: `actions` is a plain object literal so
        // inherited Object.prototype members ("constructor", "valueOf", "toString",
        // "hasOwnProperty", …) resolve to truthy functions. Dispatching one of those
        // skips the BOLA/permission gate (none carry a protected prefix) and, for
        // "constructor", returns the injected payload (incl. the caller's full user
        // record) verbatim. Only ever dispatch a genuinely-registered action.
        if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action)) {
            log.error('invalid action', { action });
            return res.status(400).json({ message: `Invalid action: ${action}` });
        }
        try {
            const result = await actions[action](payload, token ?? undefined);
            // MINT THE SESSION COOKIE. The two login actions (auth:discord_callback,
            // auth:finalize_setup) sign the token inside their handlers, and a handler has no
            //  — so the cookie is set here, where the result is still in hand. The token
            // stays in the JSON body as well: dual-accept means a client that cannot use the
            // cookie (an operator on plain HTTP whose browser refused it) is not locked out.
            const issued = (result as { token?: unknown } | null)?.token;
            if (typeof issued === 'string' && issued) {
                appendSetCookie(res, buildSessionCookie(issued, SESSION_COOKIE_IS_SECURE, TOKEN_LIFETIME_MS / 1000));
            }
            return res.status(200).json({ success: true, data: result });
        } catch (error: any) {
            if (isSecurityDenial(error)) {
                // BOLA/authz denial: audit-log the event + diagnostic fields
                // server-side; only the safe, generic message crosses the wire.
                auditDenial(error.auditEvent || 'authz.denied', { action, ip, details: error.fields });
                return res.status(error.status || 403).json({ success: false, message: error.message });
            }
            const requestId = randomUUID();
            log.error('error executing public action', { requestId, action, err: error });
            const message = isOpaqueServerError(error)
                ? 'An internal server error occurred.'
                : (error?.message || 'An internal server error occurred.');
            return res.status(500).json({ success: false, message, requestId });
        }
    }

    // --- AUTHENTICATED ACTION HANDLER ---
    if (!token) {
        return res.status(401).json({ message: 'Unauthorized: Missing token' });
    }

    // We only ever issue our own signed session tokens, so verify that token and
    // load the user by its id. (An older fallback accepted any token Supabase Auth
    // recognised — including the realtime token sent to the browser — and skipped
    // the revocation checks below, so it was removed.) Reject anything that doesn't
    // verify.
    const decodedUser = verifyToken(token);
    if (!decodedUser) {
        return res.status(401).json({ message: 'Unauthorized: Invalid token signature' });
    }

    const user = await db.getUserById(decodedUser.userId);
    if (!user) {
        return res.status(401).json({ message: 'Unauthorized: User account not found.' });
    }

    const fullUser = user;

    // Reject a token issued before this user's tokens_valid_from cutoff (set when an
    // admin revokes the user's sessions, or bans/deletes them). Same check the read
    // paths use, so the two can't drift. Returns force_logout for the client to act on.
    if (isSessionRevokedByWatermark(decodedUser, fullUser.tokensValidFrom)) {
        appendSetCookie(res, clearSessionCookie(SESSION_COOKIE_IS_SECURE)); return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
    }

    // ───────────────────────── ORG BAN GATE ─────────────────────────
    // FIRST gate on this path, above the client-tier denial and the permission gate.
    //
    // It MUST sit above the permission gate, because 'user:' maps to the
    // user:manage:self pseudo-permission — which stops nobody. Without this a banned
    // member could still call user:heartbeat (staying on the duty roster),
    // user:toggle_duty, user:apply_job, user:submit_application, user:subscribe_push
    // and user:delete_self.
    //
    // It sits immediately BELOW the watermark check on purpose, and ban:place
    // deliberately does NOT stamp tokens_valid_from — see the long note there. If it
    // did, a banned member would be 401'd above this line and could never reach the
    // two exempt actions, killing the appeal flow.
    //
    // FAILS CLOSED, but never INTO a ban screen: a read fault is a retryable 503, not
    // an accusation. Telling an innocent member they are banned because a query
    // failed is its own kind of incident.
    let activeBan;
    try {
        activeBan = await db.findActiveBan({ userId: fullUser.id, discordId: fullUser.discordId });
    } catch (e) {
        // Not a bare catch: a TypeError in the gate ITSELF would otherwise become a
        // permanent, silent 503 for every user on every request — fail-closed, but a
        // full outage nobody can see. BanCheckUnavailable is the expected shape.
        // Checked by NAME, not instanceof. The class crosses a barrel re-export, and an
        // instanceof there is fragile in exactly the situation this branch exists for — a
        // partially-loaded module. The name is set in the constructor and survives.
        if ((e as Error)?.name !== 'BanCheckUnavailable') {
            log.error('ban gate failed unexpectedly', { action, userId: fullUser.id, err: e });
        }
        return res.status(503).json({
            success: false, code: 'BAN_CHECK_UNAVAILABLE',
            message: 'Unable to verify account status. Please try again.',
        });
    }
    if (activeBan && !BAN_EXEMPT_ACTIONS.includes(action)) {
        auditDenial('authz.org_ban.denied', {
            action, user: fullUser, ip,
            details: { banId: activeBan.id },
        });
        return res.status(403).json({
            success: false, code: 'ORG_BANNED',
            message: 'Your access to this organization has been suspended.',
        });
    }

    // --- PAYLOAD INJECTION ---
    if (payload && typeof payload === 'object') {
        if (fullUser) {
            payload.userId = fullUser.id;
            payload.user = fullUser;
        }
    }
    // Single-org: no cross-org isolation check — there is exactly one org.

    // --- IDENTITY SPOOFING MITIGATION ---
    // Force every actor-identity field in the payload to the authenticated user's
    // id, so handlers that destructure creatorId/authorId/etc can't be tricked
    // by a crafted request.
    if (payload && user) {
        for (const field of ACTOR_ID_FIELDS) {
            if (field in payload) payload[field] = user.id;
        }
        // Always inject userId even if caller omitted it — many handlers rely on its presence.
        payload.userId = user.id;
        // interviewerId: only override for actions where the current user IS the interviewer
        // (e.g. saving interview results). Do NOT override for schedule/update where admins
        // select a different interviewer from a dropdown.
        if (payload.interviewerId && !payload.newInterviewerId && action === 'hr:save_interview') {
            payload.interviewerId = user.id;
        }
    }

    // Own-property check, NOT truthiness (see public-branch note above): a
    // prototype-inherited name like "constructor" would otherwise resolve to a
    // truthy function, slip past this existence guard AND the prefix-based BOLA gate
    // below (no protected prefix), and echo the caller's injected full user record.
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action)) {
        log.error('invalid action', { action });
        return res.status(400).json({ message: `Invalid action: ${action}` });
    }

    // CLIENT-TIER NAMESPACE DENIAL. An org's external customers (accounts on the seeded
    // system Client role) are not members of the org's internal product surfaces.
    // Registry: lib/clientNamespaces.ts. Predicate: db.isClientCaller
    // (lib/db/clientRoleLock.ts) — a ROLE-SLOT test, deliberately not a permission test.
    //
    // SECOND-HIGHEST GATE ON THIS PATH — below the ORG BAN GATE above, and above
    // everything below. api/query.ts puts the same registry in the same position on the
    // read path, so the two surfaces still carry ONE ordering invariant instead of two.
    // (It was the highest until org bans landed. A ban outranks a tier because it is the
    // one denial that must survive the member's row being deleted, and because the two
    // ban-exempt actions have to be reachable by someone every other gate refuses.)
    // Concretely:
    //   · ABOVE the permission gate, because the permission gate is exactly what fails
    //     here: academy:self_enroll and its siblings map to the 'user:manage:self'
    //     pseudo-permission, so "any authenticated session" is the entire gate today.
    //     Running above it also means a stray staff grant on the Client role cannot buy
    //     past the denial — assertRoleIsNotClient stops the Roles UI writing one, but the
    //     seeder, repairDatabase, the org importer and hand-run SQL are four writers it
    //     does not cover.
    //   · ABOVE the optional-feature gate, so a customer gets ONE refusal for a denied
    //     namespace whatever the module's state, and the tier answer never depends on an
    //     unrelated settings read.
    // This is NOT a module-state non-disclosure control and nothing here may claim it is:
    // getMainState ships orgMeta.features to EVERY caller (lib/db.ts says so in as many
    // words) and the raw 'orgFeatures' settings key rides the same `main` bundle, so a
    // Client already has every module's enable state at boot. Phase 3 item 8
    // (settings-projection) owns that.
    //
    // BELOW the own-property existence check above, so an unknown action still 400s and
    // `action` is known to be a string here. isClientCaller is resolved only once a prefix
    // has matched, so the common path adds no work — and getSystemRoles is memoised for
    // five minutes besides.
    const clientDeniedPrefix = CLIENT_DENIED_NAMESPACES.find(p => action.startsWith(p));
    if (clientDeniedPrefix && await db.isClientCaller(user)) {
        auditDenial('authz.client_namespace.denied', { action, user, ip, details: { prefix: clientDeniedPrefix } });
        return res.status(403).json({ success: false, message: CLIENT_DENIED_MESSAGE });
    }

    // Optional-feature gate: when a module is toggled OFF, its whole action
    // namespace fails closed HERE — before the permission gate, so a disabled
    // feature is denied regardless of role (including the permission-LESS academy
    // student surface and the member-reachable marketplace/government namespaces).
    // `exempt` actions (a module's own re-enable path, e.g. gov:update_feature_config)
    // always pass so a disabled module can be switched back on. Mirrors the read-path
    // gate in api/query.ts. Prefixes are mutually exclusive — at most one matches.
    for (const [prefix, gate] of Object.entries(OPTIONAL_FEATURE_NAMESPACES)) {
        if (!action.startsWith(prefix) || gate.exempt?.includes(action)) continue;
        if (!(await db.isOptionalFeatureEnabled(gate.feature))) {
            return res.status(403).json({ success: false, message: `The ${gate.label} feature is not enabled.` });
        }
        break;
    }

    // BOLA MITIGATION & Permission Verification
    if (PROTECTED_PREFIXES.some(p => action.startsWith(p))) {
        const isOrgOwner = false; // single-org: no owner-subdomain bypass; Admin role bypasses via permissions

        if (!isOrgOwner) {
            // Determine the required permission string based on the action map
            const requiredPerm = fullPermissionMap[action];

            if (requiredPerm) {
                // 'user:manage:self' is a pseudo-permission meaning "any authenticated user".
                // Actions using it (e.g. hr:request_transfer, the user:* self-service set) just need a valid session.
                if (requiredPerm === 'user:manage:self') {
                    // Allowed — skip further permission checks
                } else {
                // permissionSatisfied applies the shared implication table
                // (lib/permissionImplications.ts): intel:view:clearance satisfies
                // intel:view, and manage ⊇ instruct ⊇ view on the Academy ladder.
                // Ladders only climb, so nothing here lets a weaker permission
                // satisfy a stronger gate. The intel synonym used to be an inline
                // compare HERE and a second one in api/query.ts — two copies of one
                // rule, which is how a gate that permits a write but refuses the
                // read-back gets built.
                const hasPerm = permissionSatisfied(user?.permissions, requiredPerm);

                // Op-owner bypass: an op's owner satisfies operations:manage for
                // owner-appropriate edit/lifecycle actions on their OWN op. Only
                // consulted when the caller lacks the required permission, so the
                // expensive getFullOperationDetails fetch is skipped on the common
                // path. Excluded for finance/payout/alert/participant/status
                // actions, which always require the real operations:manage perm.
                // operation:update is owner-bypassable for ordinary edits
                // (name/description/schedule), but a STATUS change carries the same
                // command-and-control authority as operation:update_status — which is
                // deliberately owner-bypass-EXCLUDED so it always needs the real
                // operations:manage perm. Don't let a status change smuggled through
                // operation:update ride the owner bypass; force it onto the manage path.
                const isStatusChangingUpdate = action === 'operation:update'
                    && payload?.updates && typeof payload.updates === 'object'
                    && (payload.updates as { status?: unknown }).status !== undefined;
                let isOpOwner = false;
                if (!hasPerm
                    && action.startsWith('operation:')
                    && !OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS.has(action)
                    && !isStatusChangingUpdate
                    && payload.operationId) {
                    isOpOwner = (await db.getFullOperationDetails(payload.operationId))?.ownerId === user?.id;
                }

                const isUnitLeader = action === 'unit:update_details' && payload.unitId && user?.unit?.id === payload.unitId && user?.unit?.leaderId === user.id;

                // Bulletin authors can delete their own bulletins
                let isBulletinAuthor = false;
                if (action === 'intel:delete_bulletin' && payload.bulletinId && user?.id) {
                    const { data: bulletin } = await db.supabase.from('intel_bulletins').select('created_by_id').eq('id', payload.bulletinId).single();
                    isBulletinAuthor = bulletin?.created_by_id === user.id;
                }

                // Lead responder can manage their request's team
                let isRequestLead = false;
                if ((action === 'request:add_responder' || action === 'request:remove_responder') && payload.requestId && user?.id) {
                    const { data: req } = await db.supabase.from('service_requests').select('lead_responder_id').eq('id', payload.requestId).single();
                    isRequestLead = req?.lead_responder_id === user.id;
                }

                if (!hasPerm && !isOpOwner && !isUnitLeader && !isBulletinAuthor && !isRequestLead) {
                    auditDenial('authz.permission.denied', { action, user, ip, details: { requiredPerm } });
                    return res.status(403).json({ message: 'Insufficient permissions' });
                }
                }
            } else {
                auditDenial('authz.unmapped_action.denied', { action, user, ip });
                return res.status(403).json({ message: 'Insufficient permissions' });
            }
        }

        // warrant:generate_report authors an intel report (intel:create gate above)
        // FROM a warrant's caution-note text. Reading that warrant content is
        // warrant:view-gated everywhere else (the warrants/warrant_slice read subsets,
        // the intel dossier, getIntelStats). Require warrant:view in
        // ADDITION to intel:create, so an intel:create-only holder can't launder
        // warrant:view-gated caution text into a classification-0 report using a
        // warrant id obtained from the id-only realtime broadcast.
        if (action === 'warrant:generate_report') {
            // Permission only — no role-name bypass (see lib/db/intel.ts getIntelStats).
            const canViewWarrants = Array.isArray(user?.permissions) && user.permissions.includes('warrant:view');
            if (!canViewWarrants) {
                auditDenial('authz.permission.denied', { action, user, ip, details: { requiredPerm: 'warrant:view' } });
                return res.status(403).json({ message: 'Insufficient permissions' });
            }
        }

        // admin:list_testimonial_candidates is a SEARCHABLE listing of the free-text
        // service_requests.client_feedback column (getTestimonialCandidates ilikes over it
        // and returns the quote plus the INTERNAL request id). That column is redacted
        // per-viewer on every OTHER read path by redactRequestFeedbackForViewer
        // (lib/db/requests.ts), gated on request:view:feedback. admin:config:branding is a
        // delegatable comms/PR bucket the seeded Dispatcher does NOT hold alongside feedback
        // access, so branding alone would be a second, searchable route around that boundary.
        // Require request:view:feedback in ADDITION to the mapped branding perm;
        // the predicate matches redactRequestFeedbackForViewer's maySee exactly so the list
        // route and the redaction route cannot drift. (The handler asserts it again, so a
        // future in-process caller can't reach the listing ungated.)
        if (action === 'admin:list_testimonial_candidates') {
            // Permission only — matches redactRequestFeedbackForViewer's maySee (no
            // role-name bypass) so the redaction and listing routes cannot drift.
            const canReadFeedback = Array.isArray(user?.permissions) && user.permissions.includes('request:view:feedback');
            if (!canReadFeedback) {
                log.warn('permission denied', { userId: user?.id, action, requiredPerm: 'request:view:feedback' });
                return res.status(403).json({ message: 'Insufficient permissions' });
            }
        }

        // Publishing a testimonial makes its free-text client_feedback readable off the
        // UNAUTHENTICATED public page (api/public.ts -> getPublicFeaturedTestimonials), so
        // ADDING an id to featuredTestimonialIds is an indirect READ of feedback the caller
        // may not hold request:view:feedback for. The ids are no obstacle: canSeeAllRequests
        // admits every request:accept holder, so a plain Member already has every rated
        // request id with clientFeedback nulled. Gate only the ADD — reorder/remove of
        // already-published ids, and the clear (a missing/non-array value), need no feedback
        // read and stay available to admin:config:branding.
        if (action === 'admin:update_public_page_config' && Array.isArray(payload?.featuredTestimonialIds)) {
            // Permission only — matches redactRequestFeedbackForViewer's maySee (no
            // role-name bypass) so the redaction and listing routes cannot drift.
            const canReadFeedback = Array.isArray(user?.permissions) && user.permissions.includes('request:view:feedback');
            const incoming = (payload.featuredTestimonialIds as unknown[]).filter((x): x is string => typeof x === 'string');
            if (incoming.length > 0 && !canReadFeedback) {
                // Distinct from the generic denial above: the caller already cleared the
                // branding gate and can read their own permission list client-side, so this
                // leaks nothing — while a bare 'Insufficient permissions' on a whole-config
                // save that merely carried a stale featured list would be undiagnosable.
                const denial = 'Publishing a new testimonial requires the View Client Feedback permission.';
                // The baseline read is confined to this deny-candidate branch, so an Admin's
                // save costs no extra round-trip. getPublicSettings THROWS on any error other
                // than 42P01, so catch and DENY: an unreadable baseline must never be treated
                // as "already contains these ids", and a 403 is fail-closed AND diagnosable
                // where an escaped throw would surface as an opaque 500.
                let current: Set<string>;
                try {
                    const currentIds = (await db.getPublicSettings()).publicPageConfig?.featuredTestimonialIds;
                    current = new Set(Array.isArray(currentIds) ? currentIds : []);
                } catch (err) {
                    log.warn('permission denied — featured testimonial baseline unreadable', { userId: user?.id, action, err });
                    return res.status(403).json({ message: denial });
                }
                const addedIds = incoming.filter(id => !current.has(id));
                if (addedIds.length > 0) {
                    // Count only — the ids are per-request identifiers, not log material.
                    log.warn('permission denied', { userId: user?.id, action, requiredPerm: 'request:view:feedback', addedCount: addedIds.length });
                    return res.status(403).json({ message: denial });
                }
            }
        }
    }

    // PER-IDENTITY THROTTLE. A fifth sibling of the four per-action cost controls that already
    // exist (AI, submissions, radio, uploads) — deliberately NOT a consolidation of them. Those
    // bound the cost of specific expensive actions; this is an abuse floor across every
    // mutation, so it is looser than all of them. Keyed on the authenticated user id, which the
    // dispatcher injected above and the client cannot influence.
    if (typeof user?.id === 'number') {
        const userLimit = checkUserRateLimit(user.id);
        if (!userLimit.ok) {
            auditDenial('auth.user_rate_limited', { action, user, ip, details: { retryAfter: userLimit.retryAfter } });
            res.setHeader('Retry-After', String(userLimit.retryAfter));
            return res.status(429).json({ success: false, message: 'Too many requests. Please slow down and try again shortly.' });
        }
    }

    // Clearing the cookie belongs HERE, not in the handler: handlers receive (payload, token)
    // and have no `res`. BEFORE dispatch, not after, and deliberately so: the client can only
    // remove its localStorage copy, never the HttpOnly cookie, so if this sat in the success
    // branch a failing `user:logout` (offline, or revokeUserSessions throwing) would show the
    // user a logout, land them on `/`, and leave a live 24-hour cookie that signs them straight
    // back in on the next page load. On a shared machine that is a real exposure — and a
    // regression, because removing the localStorage token alone used to be sufficient.
    // res.append rather than setHeader so an OAuth-state Set-Cookie is not clobbered.
    if (action === 'user:logout') {
        appendSetCookie(res, clearSessionCookie(SESSION_COOKIE_IS_SECURE));
    }

    try {
        const result = await actions[action](payload, token ?? undefined);
        return res.status(200).json({ success: true, data: result });
    } catch (error: any) {
        if (isSecurityDenial(error)) {
            // BOLA/authz denial: audit-log the event + diagnostic fields (ids,
            // clearance) server-side; only the safe, generic message is returned.
            auditDenial(error.auditEvent || 'authz.denied', { action, user, ip, details: error.fields });
            return res.status(error.status || 403).json({ success: false, message: error.message });
        }
        const requestId = randomUUID();
        log.error('error executing action', { requestId, action, err: error });
        const message = isOpaqueServerError(error)
            ? 'An internal server error occurred.'
            : (error?.message || 'An internal server error occurred.');
        return res.status(500).json({ success: false, message, requestId });
    }
}
