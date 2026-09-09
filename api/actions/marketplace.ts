// api/actions/marketplace.ts — RPC handlers for the single-org marketplace.
// userId is injected server-side by services.ts (the authenticated actor — never
// client-trusted). Permission gating is in services.ts fullPermissionMap;
// per-resource ownership/party checks live in lib/db/marketplace.ts. Reads about
// ANOTHER member (rep/profile) take a `targetUserId` — a target-identity field
// the dispatcher does NOT overwrite (unlike the actor's `userId`).

import * as db from '../../lib/db.js';
import type { MarketplaceListingType, MarketplaceConsiderationInput } from '../../types.js';

// `user` is the dispatcher-injected authenticated actor (full User). Used for
// warehouse-stock authorization on the listing/delivery paths.
interface Actor { userId: number; user?: { role?: string; permissions?: string[] } }
interface BrowsePayload { kind?: string; listingType?: string; categoryId?: number; search?: string }
interface ListingIdPayload { id: string }
interface ContractIdPayload { id: string }
interface CreateListingPayload extends Actor {
    kind: 'item' | 'service'; listingType: MarketplaceListingType; categoryId?: number | null;
    title: string; description?: string; quantity?: number | null; priceUec?: number | null;
    priceType?: string; location?: string; tags?: string[]; expiresAt?: string | null; warehouseStockId?: number | null;
}
interface UpdateListingPayload extends Actor { id: string; updates: Record<string, unknown> }
interface ProposePayload extends Actor { listingId: string; quantity?: number | null; agreedPriceUec?: number | null; termsNote?: string; milestones?: { title: string; description?: string }[]; considerations?: MarketplaceConsiderationInput[] | null }
interface CancelPayload extends Actor { id: string; reason?: string }
interface RatePayload extends Actor { id: string; stars: number; feedback?: string }
interface MilestoneIdPayload extends Actor { milestoneId: number }
interface TargetUserPayload { targetUserId: number }
interface ReportPayload extends Actor { listingId?: string; contractId?: string; reasonCategory: string; details?: string }
interface CategoryAdminPayload {
    name: string; parentId?: number | null; listingKind?: string; icon?: string | null; sortOrder?: number; active?: boolean;
}
interface UpdateCategoryPayload { id: number; updates: Partial<CategoryAdminPayload> }
interface ReviewReportPayload extends Actor { id: number; decision: 'actioned' | 'dismissed' }

export const marketplaceActions = {
    // Browse / read (marketplace:view)
    'marketplace:get_categories': () => db.getMarketplaceCategories(),
    'marketplace:browse': (p: BrowsePayload) => db.browseMarketplaceListings({ kind: p?.kind, listingType: p?.listingType, categoryId: p?.categoryId, search: p?.search }),
    'marketplace:get_listing': ({ id, userId }: ListingIdPayload & Actor) => db.getMarketplaceListing(id, userId),
    // `userId` is the dispatcher-forced actor (ACTOR_ID_FIELDS), never payload input —
    // it decides only whether the caller is looking at their OWN profile.
    'marketplace:get_profile': ({ targetUserId, userId }: TargetUserPayload & Actor) => db.getMarketplaceTraderProfile(targetUserId, userId),
    'marketplace:get_contract_ratings': ({ id, userId }: ContractIdPayload & Actor) => db.getContractRatings(id, userId),
    'marketplace:report': ({ listingId, contractId, reasonCategory, details, userId }: ReportPayload) =>
        db.reportMarketplace({ listingId, contractId, reasonCategory, details }, userId),

    // Listings (marketplace:list — owner-only mutations enforced in the db layer)
    'marketplace:create_listing': (p: CreateListingPayload) => db.createMarketplaceListing(p, p.userId, p.user),
    'marketplace:update_listing': ({ id, updates, userId }: UpdateListingPayload) => db.updateMarketplaceListing(id, updates, userId),
    'marketplace:delete_listing': ({ id, userId }: UpdateListingPayload) => db.deleteMarketplaceListing(id, userId),

    // Contracts (marketplace:contract — party-scoped in the db layer)
    // Field-by-field on purpose (it is the actor-forced boundary), which means a new
    // input field has to be added HERE too or it is silently dropped — the create and
    // update paths take the whole object, so this is the one that can drift.
    'marketplace:propose': (p: ProposePayload) => db.proposeMarketplaceContract({ listingId: p.listingId, quantity: p.quantity, agreedPriceUec: p.agreedPriceUec, termsNote: p.termsNote, milestones: p.milestones, considerations: p.considerations }, p.userId),
    'marketplace:accept': ({ id, userId }: ContractIdPayload & Actor) => db.acceptMarketplaceContract(id, userId),
    'marketplace:mark_delivered': ({ id, userId, user }: ContractIdPayload & Actor) => db.markMarketplaceDelivered(id, userId, user),
    'marketplace:confirm_received': ({ id, userId }: ContractIdPayload & Actor) => db.confirmMarketplaceReceived(id, userId),
    // user (actor) forwarded so the db layer can re-check warehouse:manage before
    // a cancel-after-delivery fires the compensating stock reversal.
    'marketplace:cancel': ({ id, reason, userId, user }: CancelPayload) => db.cancelMarketplaceContract(id, userId, reason, user),
    'marketplace:rate': ({ id, stars, feedback, userId }: RatePayload) => db.rateMarketplaceContract(id, { stars, feedback }, userId),
    'marketplace:my_contracts': ({ userId }: Actor) => db.getMyMarketplaceContracts(userId),
    'marketplace:get_milestones': ({ id, userId }: ContractIdPayload & Actor) => db.getMarketplaceMilestones(id, userId),
    'marketplace:toggle_milestone': ({ milestoneId, userId }: MilestoneIdPayload) => db.toggleMarketplaceMilestone(milestoneId, userId),
    'marketplace:delete_milestone': ({ milestoneId, userId }: MilestoneIdPayload) => db.deleteMarketplaceMilestone(milestoneId, userId),

    // Admin: categories + report moderation (marketplace:admin)
    'marketplace:admin:list_categories': () => db.listAllMarketplaceCategories(),
    'marketplace:admin:create_category': (p: CategoryAdminPayload) => db.createMarketplaceCategory(p),
    'marketplace:admin:update_category': ({ id, updates }: UpdateCategoryPayload) => db.updateMarketplaceCategory(id, updates),
    'marketplace:admin:delete_category': ({ id }: { id: number }) => db.deleteMarketplaceCategory(id),
    // Restore the default taxonomy (idempotent by slug) — for orgs that upgraded
    // past first-boot. Returns the refreshed full list for the admin table.
    'marketplace:admin:seed_categories': async () => { await db.seedMarketplaceCategories(); return db.listAllMarketplaceCategories(); },
    'marketplace:admin:list_reports': ({ status }: { status?: string }) => db.listMarketplaceReports(status),
    'marketplace:admin:review_report': ({ id, decision, userId }: ReviewReportPayload) => db.reviewMarketplaceReport(id, decision, userId),
};
