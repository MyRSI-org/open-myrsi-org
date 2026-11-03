import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Who may add an After Action Review entry — the one participant action that only exists
// AFTER an operation concludes.
//
// The AAR tab is offered only on a Concluded op, and concluding stamps time_left on every
// active row. Once lib/db/mappers.ts mapped the real time_left (it used to hardcode null),
// gating "Add Entry" on the view's active-only isParticipant hid it from everyone who took
// part: only the owner, operations:manage holders and rows added after conclusion still saw
// it. The tab now uses canAddAarEntry, which mirrors the server gate on
// operation:add_aar_entry, which takes the READ term (owner decision, 15.7.1): any roster
// row, current or former, is offered the button on a special op or not; the server still
// enforces clearance and limiting markers.
//
// The REAL OperationDetailView and the REAL OpAARTab render here (the other tabs are stubs),
// so the wiring — the view computes canManage (owner / operations:manage) and hands the tab
// the operation with its roster intact — is exercised end to end.

const h = vi.hoisted(() => {
    const state = {
        me: { id: 7, name: 'Viewer' } as { id: number; name: string } | null,
        perms: new Set<string>(),
        rpc: [] as Array<{ action: string; payload: Record<string, unknown> }>,
    };
    const noop = () => {};
    const asyncNoop = async () => {};
    // STABLE references: the view lists rpcAction as an effect dependency.
    const rpcAction = async (action: string, payload: Record<string, unknown>) => {
        state.rpc.push({ action, payload });
        return null;
    };
    const hasPermission = (p: string) => state.perms.has(p);
    const data = { isFetching: {}, refreshOperations: asyncNoop, rpcAction };
    const ops = { operations: [] as unknown[], joinOperationWithShip: asyncNoop, deleteOperation: asyncNoop, removeOperationParticipant: asyncNoop };
    const config = { radioConfig: { configured: false } };
    const notification = { confirm: async () => false, addToast: noop };
    const opRadio = {
        isConnected: false, isConnecting: false, isTransmitting: false, activeSpeakers: [], participants: [], error: null,
        volume: 50, setVolume: noop, isMuted: false, toggleMute: noop, handlePTT: noop, connect: noop, disconnect: noop, localAudioLevel: 0,
    };
    const radio = { isEnabled: false, setIsEnabled: noop, disconnect: noop };
    return { state, hasPermission, data, ops, config, notification, opRadio, radio };
});

vi.mock('../services/apiService', () => ({ default: { getStateSubset: async () => ({}), rpc: async () => ({}) } }));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ currentUser: h.state.me, hasPermission: h.hasPermission }),
    useFormatDate: () => Object.assign(() => 'date', { date: () => 'date', time: () => 'time', prefs: {} }),
}));
vi.mock('../contexts/DataContext', () => ({ useData: () => h.data }));
vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => h.config }));
vi.mock('../contexts/OperationsContext', () => ({ useOperations: () => h.ops }));
vi.mock('../contexts/NotificationContext', () => ({ useNotification: () => h.notification }));
vi.mock('../contexts/RadioContext', () => ({ useRadio: () => h.radio }));
vi.mock('../hooks/useOpRadio', () => ({ useOpRadio: () => h.opRadio }));

// Every tab EXCEPT OpAARTab is stubbed.
vi.mock('../components/views/operations/tabs/OpSituationTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpLiveMyStatusTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpMissionTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpExecutionTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpAdminLogisticsTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpCommandSignalsTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpAdministerTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpLiveOverviewTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpLiveCommandTab', () => ({ default: () => null }));
vi.mock('../components/modals/AddUecModal', () => ({ default: () => null }));
vi.mock('../components/modals/AddCostModal', () => ({ default: () => null }));
vi.mock('../components/modals/AddParticipantModal', () => ({ default: () => null }));
vi.mock('../components/modals/ManageParticipantModal', () => ({ default: () => null }));

import OperationDetailView from '../components/views/operations/OperationDetailView';
import { AARCategory, OperationStatus, OperationType, type HydratedOperation } from '../types';

const OP_ID = 'op-aar-3333';
const OWNER = 1;
const ME = 7;
const STAMP = '2026-11-01T10:00:00.000Z';

type Row = HydratedOperation['participants'][number];
const row = (userId: number, timeLeft: string | null): Row =>
    ({ userId, user: { id: userId, name: `Member ${userId}` }, timeJoined: '2026-10-30T10:00:00.000Z', timeLeft, isReady: false }) as unknown as Row;
const active = (userId: number) => row(userId, null);
const former = (userId: number) => row(userId, STAMP);

const ENTRY = {
    id: 41, operationId: OP_ID, authorId: 8, author: { id: 8, name: 'Member 8' },
    category: AARCategory.Sustain, content: 'Escort spacing held', upvotes: 0, createdAt: STAMP,
};

function op(over: Partial<HydratedOperation> = {}): HydratedOperation {
    return {
        id: OP_ID, name: 'Convoy Run', ownerId: OWNER, owner: { id: OWNER, name: 'Owner' },
        status: OperationStatus.Concluded, type: OperationType.PvE, description: '',
        isSpecial: false, isJoint: false, clearanceLevel: 0, limitingMarkers: [], commsPlan: [], log: [],
        participants: [], aarEntries: [],
        ...over,
    } as unknown as HydratedOperation;
}

function openAar(operation: HydratedOperation) {
    localStorage.setItem(`op_section_${OP_ID}`, 'aar');
    return render(<OperationDetailView operation={operation} onBack={() => {}} />);
}

const addEntryButton = () => screen.queryByRole('button', { name: 'Add Entry' });
const emptyState = () => screen.queryByText('No AAR entries submitted yet.');
const rpcCalls = (action: string) => h.state.rpc.filter(c => c.action === action);

beforeEach(() => {
    h.state.me = { id: ME, name: 'Viewer' };
    h.state.perms = new Set();
    h.state.rpc = [];
});

afterEach(() => {
    localStorage.clear();
});

describe('Add Entry on a concluded NON-special op — the roster term', () => {
    it('a FORMER participant (stamped at conclusion) is offered Add Entry', () => {
        openAar(op({ participants: [former(ME), former(8)] }));
        expect(screen.getByText('After Action Review')).toBeTruthy();
        expect(addEntryButton()).not.toBeNull();
        expect(emptyState()).toBeNull();
    });

    it('…and the entry posts operation:add_aar_entry with the trimmed content, then refreshes', async () => {
        openAar(op({ participants: [former(ME), former(8)] }));
        await waitFor(() => expect(rpcCalls('operation:get_details').length).toBeGreaterThan(0));
        const detailsBefore = rpcCalls('operation:get_details').length;

        fireEvent.click(addEntryButton()!);
        fireEvent.change(screen.getByPlaceholderText('Share your feedback...'), { target: { value: '  Comms discipline held  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit Entry' }));

        await waitFor(() => expect(rpcCalls('operation:add_aar_entry')).toHaveLength(1));
        expect(rpcCalls('operation:add_aar_entry')[0].payload).toEqual({
            operationId: OP_ID,
            data: { content: 'Comms discipline held', category: AARCategory.Observation },
        });
        await waitFor(() => expect(rpcCalls('operation:get_details').length).toBeGreaterThan(detailsBefore));
        await waitFor(() => expect(screen.queryByPlaceholderText('Share your feedback...')).toBeNull());
    });

    it('a member NOT on the roster is not offered it (unchanged: participants and managers only)', () => {
        openAar(op({ participants: [former(8), active(9)] }));
        expect(addEntryButton()).toBeNull();
        expect(emptyState()).not.toBeNull();
    });

    it('a member whose row was DELETED (left before conclusion) is not offered it', () => {
        openAar(op({ participants: [] }));
        expect(addEntryButton()).toBeNull();
    });

    it('nobody is offered it once the AAR is submitted', () => {
        openAar(op({ participants: [former(ME)], aarSubmittedAt: STAMP } as Partial<HydratedOperation>));
        expect(addEntryButton()).toBeNull();
    });
});

describe('Add Entry on a concluded SPECIAL op — mirrors the server read term', () => {
    it('a FORMER participant reads the AAR AND is offered Add Entry', () => {
        openAar(op({ isSpecial: true, participants: [former(ME), former(8)], aarEntries: [ENTRY] } as Partial<HydratedOperation>));
        expect(screen.getByText('Escort spacing held')).toBeTruthy();
        expect(addEntryButton()).not.toBeNull();
    });

    it('a member who is not on the roster is not offered it', () => {
        openAar(op({ isSpecial: true, participants: [former(8)], aarEntries: [ENTRY] } as Partial<HydratedOperation>));
        expect(addEntryButton()).toBeNull();
    });

    it('with no entries, that former participant is offered the first entry, not the empty state', () => {
        openAar(op({ isSpecial: true, participants: [former(ME)] }));
        expect(addEntryButton()).not.toBeNull();
        expect(emptyState()).toBeNull();
    });

    it('an ACTIVE row (added after conclusion) is offered it', () => {
        openAar(op({ isSpecial: true, participants: [former(8), active(ME)] }));
        expect(addEntryButton()).not.toBeNull();
    });

    it('the owner, not on the roster, is offered it', () => {
        h.state.me = { id: OWNER, name: 'Owner' };
        openAar(op({ isSpecial: true, participants: [former(8)] }));
        expect(addEntryButton()).not.toBeNull();
    });

    it('an operations:manage holder, not on the roster, is offered it', () => {
        h.state.perms = new Set(['operations:manage']);
        openAar(op({ isSpecial: true, participants: [former(8)] }));
        expect(addEntryButton()).not.toBeNull();
    });
});

describe('deleting an entry stays manager-only (the server maps it to operations:manage)', () => {
    const deleteButtonOf = (text: string) => screen.getByText(text).closest('.group')!.querySelector('button');

    it('a contributing former participant sees the entry but no delete control', () => {
        openAar(op({ participants: [former(ME)], aarEntries: [ENTRY] } as Partial<HydratedOperation>));
        expect(addEntryButton()).not.toBeNull();
        expect(deleteButtonOf('Escort spacing held')).toBeNull();
    });

    it('an operations:manage holder gets the delete control, which posts the entry and op ids', async () => {
        h.state.perms = new Set(['operations:manage']);
        openAar(op({ participants: [former(8)], aarEntries: [ENTRY] } as Partial<HydratedOperation>));
        fireEvent.click(deleteButtonOf('Escort spacing held')!);
        await waitFor(() => expect(rpcCalls('operation:delete_aar_entry')).toHaveLength(1));
        expect(rpcCalls('operation:delete_aar_entry')[0].payload).toEqual({ entryId: 41, operationId: OP_ID });
    });
});
