// The marker the org importer stamps on a ballot whose per-voter linkage did NOT
// survive the export (see SYNTHESIZED_NOT_NULL in ./importer.ts).
//
// It lives in its own dependency-free module because BOTH ends need it — the
// importer that writes it and the ranked-choice tally in ./government/internal.ts
// that must refuse to run on it — and neither of those should pull the other's
// module graph in for one string literal. Duplicating the literal instead would
// let the two halves drift and silently un-mark every imported ballot.

/** Prefix of a synthesised voter_hash. Never produced by computeVoterHash (a
 *  64-char lowercase hex HMAC), so the two forms are distinguishable by prefix
 *  alone and a real ballot can never be mistaken for an imported one. */
export const IMPORTED_BALLOT_HASH_PREFIX = 'imported:';
