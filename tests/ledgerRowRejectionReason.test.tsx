import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// The ledger row is where an approver reads an officer's rejection reason. The server
// is the boundary — lib/db/finances.ts sends rejectionReason only to finance:approve
// holders (tests/financeRejectionReason.test.ts) — so the row's job is simply to show
// the field when it arrived and render nothing extra when it did not.

vi.mock('../contexts/AuthContext', () => ({ useFormatDate: () => ({ prefs: undefined }) }));

import LedgerRow from '../components/views/finances/LedgerRow';
import type { LedgerEntry } from '../types';

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: 'e1', accountId: 1, entryType: 'withdrawal', amount: -100, status: 'rejected',
    memo: null, counterpartyUserId: 7, counterpartyText: 'Jane', operationId: null,
    relatedInventoryId: null, relatedEntryId: null, transferGroupId: null,
    createdByUserId: 7, approvedByUserId: 9, approvedAt: '2026-06-02T00:00:00Z',
    notes: 'fuel for the Carrack', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z',
    ...over,
});

describe('LedgerRow — rejection reason', () => {
    it('shows the reason when the server sent one (approver response)', () => {
        const { container } = render(<LedgerRow entry={entry({ rejectionReason: 'duplicate claim' })} />);
        expect(container.textContent).toContain('Rejected:');
        expect(container.textContent).toContain('duplicate claim');
        expect(container.textContent).toContain('fuel for the Carrack');
    });

    it('renders no reason line when the field is absent (non-approver response)', () => {
        const { container } = render(<LedgerRow entry={entry()} />);
        expect(container.textContent).not.toContain('Rejected:');
        expect(container.textContent).toContain('fuel for the Carrack');
    });
});
