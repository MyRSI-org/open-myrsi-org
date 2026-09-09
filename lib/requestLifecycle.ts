import { ServiceRequestStatus } from '../types.js';

/**
 * The service-request lifecycle preconditions, in ONE place that both tiers import.
 *
 * Every one of these existed only in React. Two copies each, in fact — RequestCard and
 * ServiceRequestDetailView both re-derived them — while the server checked ownership and
 * nothing else. A permission gate answers "may this caller act on requests?"; it does not
 * answer "may this request be cancelled RIGHT NOW?", and that second question was being
 * asked exclusively by a button's `disabled` attribute.
 *
 * Dependency-free on purpose so it compiles under BOTH tsconfigs (the `lib/sliceMerge.ts` /
 * `lib/unitTree.ts` pattern), and named so the ESLint client/server boundary permits it —
 * client code may import this, and MUST, because a second copy of a rule is how the first
 * one drifts.
 */

/** A client may cancel only a request nobody has picked up yet. Duty holders are exempt. */
export const CANCELLABLE_BY_CLIENT: readonly ServiceRequestStatus[] = [ServiceRequestStatus.Submitted];

/**
 * A finished request cannot be restarted or re-completed BY ANYONE, duty included.
 *
 * This is not tidiness. `completeRequest` applies `report.clientReputationChange` through the
 * admin-only reputation RPC and is idempotency-free, so re-completing a Success row walks a
 * client's reputation down once per call — and with the standing floor below now enforced on
 * the server, that is a route to locking a member out of raising requests at all. It also
 * closes the resurrection: `updateRequestStatus` never reads the current status, so an
 * assigned responder could drive a Cancelled or Success row back to In-Progress.
 */
export const TERMINAL_REQUEST_STATUSES: readonly ServiceRequestStatus[] = [
    ServiceRequestStatus.Success,
    ServiceRequestStatus.Failed,
    ServiceRequestStatus.Cancelled,
    ServiceRequestStatus.Refused,
    ServiceRequestStatus.Aborted,
    ServiceRequestStatus.GameError,
];

/** Only a completed request is rateable — what the public stats actually count. */
export const RATEABLE_STATUSES: readonly ServiceRequestStatus[] = [ServiceRequestStatus.Success];

/**
 * Reputation at or below 10 is restricted; the admin console states this to operators in as
 * many words ("Low reputation clients (below 10) are restricted from initiating new service
 * requests"). The sanction was the org's only anti-abuse lever short of deleting an account,
 * and until this it did nothing at all on the server.
 */
export const MIN_REQUEST_REPUTATION = 11;

const isStatus = (s: unknown): s is ServiceRequestStatus =>
    typeof s === 'string' && (Object.values(ServiceRequestStatus) as string[]).includes(s);

export function isCancellableByClient(status: unknown): boolean {
    return isStatus(status) && CANCELLABLE_BY_CLIENT.includes(status);
}

export function isTerminalRequestStatus(status: unknown): boolean {
    return isStatus(status) && TERMINAL_REQUEST_STATUSES.includes(status);
}

export function isRateableStatus(status: unknown): boolean {
    return isStatus(status) && RATEABLE_STATUSES.includes(status);
}

/**
 * Fail-closed on a missing or non-finite reputation: "I could not establish this caller's
 * standing" must block, not admit. Safe for the client too — `types.ts` declares
 * `reputation: number` and the mapper coerces a missing column to 0, so a real user always
 * carries a number and this agrees with the old inline `reputation <= 10` check exactly.
 */
export function mayRaiseRequest(reputation: unknown): boolean {
    return typeof reputation === 'number' && Number.isFinite(reputation) && reputation >= MIN_REQUEST_REPUTATION;
}

/**
 * A rating is single-shot. `rated` is `boolean DEFAULT false` and NULLABLE, and
 * `service_requests` is written ROW-WISE by the org importer rather than through
 * createServiceRequest — so a migrated row can arrive carrying `client_rating = 5` with
 * `rated IS NULL`. Checking `rated === true` alone would permit overwriting exactly that
 * row: an imported rating, on the dataset that feeds the public scoreboard.
 */
export function isAlreadyRated(row: { rated?: unknown; client_rating?: unknown }): boolean {
    return row.rated === true || (row.client_rating !== null && row.client_rating !== undefined);
}
