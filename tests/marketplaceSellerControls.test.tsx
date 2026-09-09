import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

// The seller UI. `marketplace:update_listing` shipped with a permission-map entry, an action
// handler and a db function — and zero client callers, so a seller could only DELETE a
// listing. These render the real modal and assert the wire payloads.
//
// The read half matters as much as the writes: the modal re-reads its listing on open via
// marketplace:get_listing, because the array it was opened from is a snapshot and
// `remaining` is the number a buyer sizes their offer against.

const h = vi.hoisted(() => ({
    calls: [] as Array<{ action: string; payload: Record<string, unknown> }>,
    updates: [] as Array<Record<string, unknown>>,
    getListingResult: null as unknown,
    getProfileResult: null as unknown,
}));

vi.mock('../services/apiService', () => ({ default: { getStateSubset: async () => ({}), rpc: async () => ({}) } }));

vi.mock('../components/layout/WindowFrame', () => ({
    default: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) => (
        <div>{children}{footer}</div>
    ),
}));

import { ListingDetailModal } from '../components/views/marketplace/MarketplaceModals';
import type { MarketplaceListing } from '../types';

const SELLER = 10, BUYER = 20;

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
    return {
        id: 'L1', sellerId: SELLER, kind: 'item', listingType: 'sell', title: 'Widget',
        description: 'A widget', quantity: 10, quantityClaimed: 0, priceUec: 500,
        priceType: 'fixed', location: 'Port Olisar', tags: [], status: 'active',
        expiresAt: null, warehouseStockId: null, categoryId: null, categoryName: null,
        seller: { id: SELLER, name: 'Seller', avatarUrl: null, rsiHandle: null },
        createdAt: 't', updatedAt: 't',
        ...over,
    } as unknown as MarketplaceListing;
}

const rpcAction = async (action: string, payload: Record<string, unknown>) => {
    h.calls.push({ action, payload });
    if (action === 'marketplace:get_listing') return h.getListingResult;
    if (action === 'marketplace:get_profile') return h.getProfileResult;
    return null;
};

function open(over: Partial<MarketplaceListing> = {}, meId = SELLER) {
    return render(
        <ListingDetailModal
            listing={listing(over)} meId={meId} canContract rpcAction={rpcAction}
            onClose={() => {}}
            onPropose={async () => {}}
            onDelete={async () => {}}
            onReport={async () => {}}
            onUpdate={async (updates) => { h.updates.push(updates); return true; }}
        />,
    );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const el = [...container.querySelectorAll('button')].find(
        (b) => (b.textContent || '').trim().toLowerCase().includes(label.toLowerCase()),
    );
    if (!el) throw new Error(`no button matching "${label}" — buttons: ${[...container.querySelectorAll('button')].map((b) => JSON.stringify((b.textContent || '').trim())).join(', ')}`);
    return el as HTMLButtonElement;
}

beforeEach(() => { h.calls = []; h.updates = []; h.getListingResult = null; h.getProfileResult = null; });

describe('seller listing management (marketplace:update_listing)', () => {
    it('Pause sends status paused', async () => {
        const { container } = open({ status: 'active' });
        fireEvent.click(button(container, 'Pause'));
        await waitFor(() => expect(h.updates).toHaveLength(1));
        expect(h.updates[0]).toEqual({ status: 'paused' });
    });

    it('a PAUSED listing offers Resume, and Resume sends status active', async () => {
        // The reason My Listings has to exist: this listing is not on the board at all.
        const { container } = open({ status: 'paused' });
        fireEvent.click(button(container, 'Resume'));
        await waitFor(() => expect(h.updates).toHaveLength(1));
        expect(h.updates[0]).toEqual({ status: 'active' });
    });

    it('Close sends status closed, and a closed listing offers no Close', async () => {
        const { container } = open({ status: 'active' });
        fireEvent.click(button(container, 'Close'));
        await waitFor(() => expect(h.updates).toHaveLength(1));
        expect(h.updates[0]).toEqual({ status: 'closed' });

        const closed = open({ status: 'closed' });
        expect(() => button(closed.container, 'Close')).toThrow();
        expect(button(closed.container, 'Resume')).toBeTruthy();
    });

    it('Edit saves the four editable fields, and never sends a status it was not asked to change', async () => {
        const { container } = open({ status: 'active' });
        fireEvent.click(button(container, 'Edit'));
        const inputs = container.querySelectorAll('input, textarea');
        fireEvent.change(inputs[0], { target: { value: 'Renamed widget' } });
        fireEvent.click(button(container, 'Save Changes'));

        await waitFor(() => expect(h.updates).toHaveLength(1));
        expect(h.updates[0].title).toBe('Renamed widget');
        expect(h.updates[0].priceUec).toBe(500);
        expect(h.updates[0].location).toBe('Port Olisar');
        // A status the seller did not touch must not ride along on an edit.
        expect(h.updates[0]).not.toHaveProperty('status');
    });

    it('an empty price is sent as null (negotiable), not as 0', async () => {
        // Number('') is 0, which would silently reprice the listing to free.
        const { container } = open({ status: 'active', priceUec: 500 });
        fireEvent.click(button(container, 'Edit'));
        const price = [...container.querySelectorAll('input')].find((i) => i.type === 'number')!;
        fireEvent.change(price, { target: { value: '' } });
        fireEvent.click(button(container, 'Save Changes'));
        await waitFor(() => expect(h.updates).toHaveLength(1));
        expect(h.updates[0].priceUec).toBeNull();
    });

    it('a NON-owner gets no management controls at all', () => {
        const { container } = open({ status: 'active' }, BUYER);
        for (const label of ['Pause', 'Resume', 'Close', 'Edit']) {
            expect(() => button(container, label), `a non-owner must not see ${label}`).toThrow();
        }
        expect(button(container, 'Report')).toBeTruthy();
    });
});

describe('the modal re-reads its listing on open (marketplace:get_listing)', () => {
    it('fetches the listing by id and renders the FRESHER quantity', async () => {
        // Board snapshot says 0 claimed; another member has since claimed 7.
        h.getListingResult = listing({ quantityClaimed: 7 });
        const { container } = open({ quantityClaimed: 0 }, BUYER);

        await waitFor(() => expect(h.calls.some((c) => c.action === 'marketplace:get_listing')).toBe(true));
        expect(h.calls.find((c) => c.action === 'marketplace:get_listing')!.payload).toEqual({ id: 'L1' });
        await waitFor(() => expect(container.textContent).toContain('3 of 10 available'));
    });

    it('falls back to the copy it was given when the re-read fails', async () => {
        const failing = async (action: string, payload: Record<string, unknown>) => {
            h.calls.push({ action, payload });
            if (action === 'marketplace:get_listing') throw new Error('offline');
            return null;
        };
        const { container } = render(
            <ListingDetailModal
                listing={listing({ quantityClaimed: 2 })} meId={BUYER} canContract rpcAction={failing}
                onClose={() => {}} onPropose={async () => {}} onDelete={async () => {}}
                onReport={async () => {}} onUpdate={async () => true}
            />,
        );
        await waitFor(() => expect(h.calls.some((c) => c.action === 'marketplace:get_listing')).toBe(true));
        expect(container.textContent).toContain('8 of 10 available');
    });
});

describe('trader profile (marketplace:get_profile)', () => {
    it('opens on the seller name and asks for that seller id', async () => {
        h.getProfileResult = {
            trader: { id: SELLER, name: 'Seller', avatarUrl: null, rsiHandle: 'seller' },
            reputation: { userId: SELLER, averageStars: 4.5, ratingCount: 8, tier: 'Trusted' },
            activeListings: [],
        };
        const { container } = open({}, BUYER);
        fireEvent.click(button(container, 'Seller'));

        await waitFor(() => expect(h.calls.some((c) => c.action === 'marketplace:get_profile')).toBe(true));
        expect(h.calls.find((c) => c.action === 'marketplace:get_profile')!.payload).toEqual({ targetUserId: SELLER });
        await waitFor(() => expect(container.textContent).toContain('Trusted'));
        expect(container.textContent).toContain('4.5');
    });
});
