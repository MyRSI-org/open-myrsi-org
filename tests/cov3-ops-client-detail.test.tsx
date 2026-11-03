import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// OperationDetailView — the client half of the owner-approved rule that a FORMER participant
// of a special operation keeps READ access.
//
// The server's read term (hasOpReadParticipation: any roster row) already hands a former
// participant the detail; the view used to gate its own access screen on the ACT term
// (timeLeft === null), so that member got "Restricted Access" over a detail they had been
// sent. Writes stay active-only, so the action term the view hands its tabs must NOT widen.
//
// Every child tab is replaced with a prop-capturing stub: the assertions are about what this
// view decides (access screen, action term, displayed roster, allied-ship lookup), not about
// the tabs' own rendering, which tests/cov3-ops-client-rosterViews.test.tsx covers.

const h = vi.hoisted(() => {
    const state = {
        me: { id: 7, name: 'Viewer' } as { id: number; name: string } | null,
        perms: new Set<string>(),
        rpc: [] as Array<{ action: string; payload: Record<string, unknown> }>,
        shipsResult: [] as unknown[],
        situation: null as null | Record<string, unknown>,
        liveStatus: null as null | Record<string, unknown>,
    };
    const noop = () => {};
    const asyncNoop = async () => {};
    // STABLE references: the view lists rpcAction as an effect dependency, so a fresh
    // function per render would re-run the allied-ship effect on every render.
    const rpcAction = async (action: string, payload: Record<string, unknown>) => {
        state.rpc.push({ action, payload });
        if (action === 'operation:get_participant_ships') return state.shipsResult;
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

vi.mock('../components/views/operations/tabs/OpSituationTab', () => ({
    default: (props: Record<string, unknown>) => { h.state.situation = props; return <div data-testid="situation-tab" />; },
}));
vi.mock('../components/views/operations/tabs/OpLiveMyStatusTab', () => ({
    default: (props: Record<string, unknown>) => { h.state.liveStatus = props; return <div data-testid="live-status-tab" />; },
}));
vi.mock('../components/views/operations/tabs/OpMissionTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpExecutionTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpAdminLogisticsTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpCommandSignalsTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpAARTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpAdministerTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpLiveOverviewTab', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpLiveCommandTab', () => ({ default: () => null }));
vi.mock('../components/modals/AddUecModal', () => ({ default: () => null }));
vi.mock('../components/modals/AddCostModal', () => ({ default: () => null }));
vi.mock('../components/modals/AddParticipantModal', () => ({ default: () => null }));
vi.mock('../components/modals/ManageParticipantModal', () => ({ default: () => null }));

import OperationDetailView from '../components/views/operations/OperationDetailView';
import { OperationStatus, OperationType, type HydratedOperation } from '../types';

const OP_ID = 'op-1111-2222';
const OWNER = 1;
const STAMP = '2026-11-01T10:00:00.000Z';

type Row = HydratedOperation['participants'][number];
const row = (userId: number, timeLeft: string | null): Row =>
    ({ userId, user: { id: userId, name: `Member ${userId}` }, timeJoined: '2026-10-30T10:00:00.000Z', timeLeft, isReady: false }) as unknown as Row;
const active = (userId: number) => row(userId, null);
const former = (userId: number) => row(userId, STAMP);

function op(over: Partial<HydratedOperation> = {}): HydratedOperation {
    return {
        id: OP_ID, name: 'Night Raid', ownerId: OWNER, owner: { id: OWNER, name: 'Owner' },
        status: OperationStatus.Concluded, type: OperationType.PvE, description: '',
        isSpecial: true, isJoint: false, clearanceLevel: 0, limitingMarkers: [], commsPlan: [], log: [],
        participants: [],
        ...over,
    } as unknown as HydratedOperation;
}

function view(operation: HydratedOperation) {
    return render(<OperationDetailView operation={operation} onBack={() => {}} />);
}

const situation = () => h.state.situation as { isParticipant: boolean; rosterParticipants: Row[] } | null;
const rosterIds = () => situation()!.rosterParticipants.map(p => [p.userId, p.timeLeft]);
const restricted = (c: HTMLElement) => (c.textContent || '').includes('Restricted Access');
const shipCalls = () => h.state.rpc.filter(c => c.action === 'operation:get_participant_ships');

beforeEach(() => {
    h.state.me = { id: 7, name: 'Viewer' };
    h.state.perms = new Set();
    h.state.rpc = [];
    h.state.shipsResult = [];
    h.state.situation = null;
    h.state.liveStatus = null;
});

afterEach(() => {
    // activeSection persists per op in localStorage; never let it leak between tests.
    localStorage.clear();
});

describe('access screen — the READ term (any roster row)', () => {
    it('a FORMER participant opening a concluded special op gets the detail, not Restricted Access', () => {
        const { container } = view(op({ participants: [former(7), former(8)] }));
        expect(restricted(container)).toBe(false);
        expect(container.querySelector('[data-testid="situation-tab"]')).not.toBeNull();
    });

    it('…but is NOT a participant for actions: the tabs get isParticipant=false', () => {
        view(op({ participants: [former(7), former(8)] }));
        expect(situation()!.isParticipant).toBe(false);
    });

    it('a non-participant on a concluded special op still gets Restricted Access and no tab', () => {
        const { container } = view(op({ participants: [former(8)] }));
        expect(restricted(container)).toBe(true);
        expect(container.textContent).toContain('Authorization code required.');
        expect(h.state.situation).toBeNull();
    });

    it('a non-participant on a LIVE special op still gets Restricted Access', () => {
        const { container } = view(op({ status: OperationStatus.Planning, participants: [active(8)] }));
        expect(restricted(container)).toBe(true);
        expect(h.state.situation).toBeNull();
    });

    it('a member whose row was DELETED (left / removed) is refused like any non-participant', () => {
        // Leaving deletes the row, so there is nothing to match on — only the concluded
        // stamp keeps read access.
        const { container } = view(op({ participants: [] }));
        expect(restricted(container)).toBe(true);
    });

    it('the owner bypasses the gate on a special op they are not on', () => {
        h.state.me = { id: OWNER, name: 'Owner' };
        const { container } = view(op({ participants: [former(8)] }));
        expect(restricted(container)).toBe(false);
        expect(situation()!.isParticipant).toBe(false);
    });

    it('an operations:manage holder bypasses the gate', () => {
        h.state.perms = new Set(['operations:manage']);
        const { container } = view(op({ participants: [former(8)] }));
        expect(restricted(container)).toBe(false);
    });

    it('a non-special op is open to a non-participant', () => {
        const { container } = view(op({ isSpecial: false, participants: [former(8)] }));
        expect(restricted(container)).toBe(false);
        expect(situation()!.isParticipant).toBe(false);
    });

    it('an ACTIVE participant on a special op gets the detail AND the action term', () => {
        const { container } = view(op({ status: OperationStatus.Planning, participants: [active(7), active(8)] }));
        expect(restricted(container)).toBe(false);
        expect(situation()!.isParticipant).toBe(true);
    });

    it('a stamped row on a REACTIVATED special op still reads, but does not act', () => {
        // Concluded → Active leaves every stamp in place. The server's read term accepts the
        // row; the write term does not.
        localStorage.setItem(`op_section_${OP_ID}`, 'situation');
        const { container } = view(op({ status: OperationStatus.Active, participants: [former(7), active(8)] }));
        expect(restricted(container)).toBe(false);
        expect(situation()!.isParticipant).toBe(false);
    });

    it('renders nothing without a signed-in user', () => {
        h.state.me = null;
        const { container } = view(op({ isSpecial: false }));
        expect(container.innerHTML).toBe('');
    });
});

describe('the roster the Situation tab lists and counts', () => {
    it('a concluded op hands over the WHOLE roster — former rows and anyone added after', () => {
        view(op({ participants: [former(7), former(8), active(9)] }));
        expect(rosterIds()).toEqual([[7, STAMP], [8, STAMP], [9, null]]);
    });

    it('a non-concluded op hands over active rows only', () => {
        view(op({ status: OperationStatus.Planning, isSpecial: false, participants: [former(7), active(8), active(9)] }));
        expect(rosterIds()).toEqual([[8, null], [9, null]]);
    });

    it('the live My Status tab gets the ACT term on an active op', () => {
        // Default section for an Active op is live-status.
        view(op({ status: OperationStatus.Active, isSpecial: false, participants: [former(7), active(8)] }));
        expect((h.state.liveStatus as { isParticipant: boolean }).isParticipant).toBe(false);
    });
});

describe('allied-ship lookup for joint operations', () => {
    it('a concluded joint op asks for the ships of the WHOLE roster, sorted', async () => {
        h.state.shipsResult = [{ id: 1 }];
        view(op({ isJoint: true, isSpecial: false, participants: [former(5), former(3), active(4)] }));
        await waitFor(() => expect(shipCalls()).toHaveLength(1));
        expect(shipCalls()[0].payload).toEqual({ operationId: OP_ID, userIds: [3, 4, 5] });
    });

    it('a live joint op asks for active rows only', async () => {
        view(op({ isJoint: true, isSpecial: false, status: OperationStatus.Scheduled, participants: [former(5), active(4), active(3)] }));
        await waitFor(() => expect(shipCalls()).toHaveLength(1));
        expect(shipCalls()[0].payload).toEqual({ operationId: OP_ID, userIds: [3, 4] });
    });

    it('a live joint op whose only rows are stamped asks for nothing', async () => {
        view(op({ isJoint: true, isSpecial: false, status: OperationStatus.Scheduled, participants: [former(5)] }));
        await waitFor(() => expect(h.state.rpc.some(c => c.action === 'operation:get_details')).toBe(true));
        expect(shipCalls()).toHaveLength(0);
    });

    it('a non-joint op never asks', async () => {
        view(op({ isJoint: false, isSpecial: false, participants: [former(5), active(4)] }));
        await waitFor(() => expect(h.state.rpc.some(c => c.action === 'operation:get_details')).toBe(true));
        expect(shipCalls()).toHaveLength(0);
    });
});
