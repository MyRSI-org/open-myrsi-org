import type { MarketplaceConsiderationInput, MarketplaceConsideration } from '../../../types';

// Pure helpers for the barter builder. Kept out of the component file so
// react-refresh stays happy — a component file must export only components.
//
// EVERY BOUND HERE IS COSMETIC. The server re-validates and re-sanitises in
// buildConsiderationRows (lib/db/marketplace.ts); these exist so the form can say
// "no" before a round-trip, not because anything trusts them.

export interface ConsiderationDraft {
    /** Stable React list key. Never sent — draftsToInput rebuilds each leg from its fields. */
    _key: string;
    componentType: 'want' | 'offer';
    label: string;
    quantity: number;
    notes: string;
}

export const MAX_CONSIDERATIONS = 10;
export const MAX_LABEL_LEN = 120;
export const MAX_NOTES_LEN = 200;
export const MAX_LEG_QTY = 1_000_000_000;

export const newConsiderationKey = (): string => `c${Math.random().toString(36).slice(2, 9)}`;

export const emptyConsideration = (): ConsiderationDraft => ({
    _key: newConsiderationKey(), componentType: 'want', label: '', quantity: 1, notes: '',
});

/** Server legs → editable drafts, for the edit path. */
export const considerationsToDrafts = (legs: MarketplaceConsideration[] | undefined): ConsiderationDraft[] =>
    (legs || []).map((l) => ({
        _key: newConsiderationKey(),
        componentType: l.componentType,
        label: l.label,
        quantity: l.quantity,
        notes: l.notes || '',
    }));

/** Drop empty rows and rebuild the payload. Label and a positive quantity are required. */
export const draftsToInput = (drafts: ConsiderationDraft[]): MarketplaceConsiderationInput[] =>
    drafts
        .filter((d) => d.label.trim() && d.quantity >= 1)
        .map((d) => ({
            componentType: d.componentType,
            label: d.label.trim().slice(0, MAX_LABEL_LEN),
            quantity: Math.max(1, Math.min(MAX_LEG_QTY, Math.floor(d.quantity) || 1)),
            notes: d.notes.trim().slice(0, MAX_NOTES_LEN) || null,
        }));
