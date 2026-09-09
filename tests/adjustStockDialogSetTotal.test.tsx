import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

// The stale-delta defect lived HERE, in the dialogs — not in the db layer, and not in SQL.
// tests/stockSetTotalIntegrity.test.ts proves db.setInventoryTotal forwards an absolute
// target, and tests/schemaStockGuards.test.ts proves the proc subtracts under the row
// lock. Neither would notice a dialog that went back to computing (target - staleOnHand)
// and posting it through the ADJUST action, which is precisely what both dialogs did.
//
// So these render the real components against a deliberately STALE snapshot and assert on
// the wire payload: in "Set new total" mode the action must be the set-total one and the
// payload must carry targetTotal and no delta.

const h = vi.hoisted(() => ({
    calls: [] as Array<{ action: string; payload: Record<string, unknown> }>,
    confirmResult: true,
}));

vi.mock('../contexts/DataContext', () => ({
    useData: () => ({
        rpcAction: async (action: string, payload: Record<string, unknown>) => {
            h.calls.push({ action, payload });
            return { ok: true };
        },
    }),
}));

vi.mock('../contexts/NotificationContext', () => ({
    useNotification: () => ({
        addToast: () => {},
        confirm: async () => h.confirmResult,
    }),
}));

// WindowFrame is a presentational shell; render its children directly so the warehouse
// dialog's controls are queryable without pulling in the layout tree.
vi.mock('../components/layout/WindowFrame', () => ({
    default: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) => (
        <div>{children}{footer}</div>
    ),
}));

import AdjustStockDialog from '../components/views/quartermaster/AdjustStockDialog';
import WhAdjustStockDialog from '../components/views/warehouse/modals/WhAdjustStockDialog';
import type { QmInventoryItem, WarehouseStock } from '../types';

// The snapshot both dialogs freeze on open. Real on-hand may have moved since.
const STALE_QTY = 10;

const INVENTORY = {
    id: 42,
    quantityOnHand: STALE_QTY,
    catalog: { name: 'Ballistic Cannon' },
    location: { name: 'Port Olisar' },
} as unknown as QmInventoryItem;

const STOCK = {
    id: 9,
    quantityOnHand: STALE_QTY,
    catalog: { name: 'Titanium', unit: 'SCU', qualityLabel: null },
    location: { name: 'Area18' },
} as unknown as WarehouseStock;

beforeEach(() => { h.calls = []; h.confirmResult = true; });

function numberInput(container: HTMLElement): HTMLInputElement {
    const el = container.querySelector('input[type="number"]');
    if (!el) throw new Error('no number input rendered');
    return el as HTMLInputElement;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const el = [...container.querySelectorAll('button')].find(
        (b) => (b.textContent || '').toLowerCase().includes(label.toLowerCase()),
    );
    if (!el) throw new Error(`no button matching "${label}"`);
    return el as HTMLButtonElement;
}

describe('AdjustStockDialog (quartermaster) — set-total sends a target, not a delta', () => {
    function open() {
        return render(
            <AdjustStockDialog isOpen inventory={INVENTORY} onClose={() => {}} onSubmitted={() => {}} />,
        );
    }

    it('THE REGRESSION: correcting 10 -> 8 posts targetTotal 8, never delta -2', async () => {
        const { container } = open();
        fireEvent.click(button(container, 'Set new total'));
        fireEvent.change(numberInput(container), { target: { value: '8' } });
        fireEvent.click(button(container, 'Apply'));

        await waitFor(() => expect(h.calls).toHaveLength(1));
        expect(h.calls[0].action).toBe('qm:set_inventory_total');
        expect(h.calls[0].payload.targetTotal).toBe(8);
        expect(h.calls[0].payload.inventoryId).toBe(42);
        // The defect, stated as an assertion: no client-computed change may cross the wire.
        expect(h.calls[0].payload).not.toHaveProperty('delta');
    });

    it('delta mode is untouched and still posts an absolute +/-n through adjust_inventory', async () => {
        const { container } = open();
        fireEvent.change(numberInput(container), { target: { value: '5' } });
        fireEvent.click(button(container, 'Apply'));

        await waitFor(() => expect(h.calls).toHaveLength(1));
        expect(h.calls[0].action).toBe('qm:adjust_inventory');
        expect(h.calls[0].payload.delta).toBe(5);
        expect(h.calls[0].payload).not.toHaveProperty('targetTotal');
    });

    it('submits a target EQUAL to the stale snapshot — the correction a zero-check would eat', async () => {
        // Snapshot says 10; real on-hand may be 8. Typing 10 is a legitimate correction and
        // the server decides whether it is a no-op. The old code computed delta 0 and showed
        // "Delta must be non-zero", refusing to send the one write that could fix the row.
        const { container } = open();
        fireEvent.click(button(container, 'Set new total'));
        fireEvent.change(numberInput(container), { target: { value: String(STALE_QTY) } });

        const apply = button(container, 'Apply');
        expect(apply.disabled).toBe(false);
        fireEvent.click(apply);
        await waitFor(() => expect(h.calls).toHaveLength(1));
        expect(h.calls[0].payload.targetTotal).toBe(STALE_QTY);
    });

    it('still refuses a negative target, client-side, before any request', async () => {
        const { container } = open();
        fireEvent.click(button(container, 'Set new total'));
        fireEvent.change(numberInput(container), { target: { value: '-5' } });
        expect(button(container, 'Apply').disabled).toBe(true);
        expect(h.calls).toEqual([]);
    });
});

describe('WhAdjustStockDialog (warehouse) — the same contract, the same twin defect', () => {
    function open() {
        return render(
            <WhAdjustStockDialog isOpen stock={STOCK} onClose={() => {}} onSubmitted={() => {}} />,
        );
    }

    it('THE REGRESSION: correcting 10 -> 8 posts targetTotal 8, never delta -2', async () => {
        const { container } = open();
        fireEvent.click(button(container, 'Set new total'));
        fireEvent.change(numberInput(container), { target: { value: '8' } });
        fireEvent.click(button(container, 'Apply'));

        await waitFor(() => expect(h.calls).toHaveLength(1));
        expect(h.calls[0].action).toBe('warehouse:set_stock_total');
        expect(h.calls[0].payload.targetTotal).toBe(8);
        expect(h.calls[0].payload.stockId).toBe(9);
        expect(h.calls[0].payload).not.toHaveProperty('delta');
    });

    it('delta mode is untouched and still posts through adjust_stock', async () => {
        const { container } = open();
        fireEvent.change(numberInput(container), { target: { value: '5' } });
        fireEvent.click(button(container, 'Apply'));

        await waitFor(() => expect(h.calls).toHaveLength(1));
        expect(h.calls[0].action).toBe('warehouse:adjust_stock');
        expect(h.calls[0].payload.delta).toBe(5);
        expect(h.calls[0].payload).not.toHaveProperty('targetTotal');
    });

    it('still refuses a negative target, client-side, before any request', async () => {
        const { container } = open();
        fireEvent.click(button(container, 'Set new total'));
        fireEvent.change(numberInput(container), { target: { value: '-5' } });
        expect(button(container, 'Apply').disabled).toBe(true);
        expect(h.calls).toEqual([]);
    });
});
