import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, within } from '@testing-library/react';

// The operations DISPLAY surfaces after lib/db/mappers.ts started mapping the real
// operation_participants.time_left (it used to hardcode null, so every row looked active).
//
// time_left is stamped ONLY when an op concludes; leaving / removal deletes the row. So:
//   * a CONCLUDED op must list and count its whole roster (everyone who was on it at
//     conclusion) — otherwise it reads as having had zero participants;
//   * any other op lists and counts its ACTIVE rows (a stamp there is left over from an
//     earlier conclusion of a reactivated op);
//   * former participants are marked where a roster list is rendered;
//   * ACTION controls (ORBAT node assignment here) still offer active rows only;
//   * the Add Personnel modal must not offer anyone already on the roster, former included;
//   * the Administer save failure shows the server's (sanitised) message.

const h = vi.hoisted(() => {
    const state = {
        me: { id: 7, name: 'Viewer' } as { id: number; name: string } | null,
        perms: new Set<string>(),
        operations: [] as unknown[],
        members: [] as unknown[],
        rpc: [] as Array<{ action: string; payload: Record<string, unknown> }>,
        toasts: [] as Array<{ title: string; description?: string }>,
        added: [] as Array<[string, number]>,
        refreshes: 0,
        closes: 0,
        updates: [] as Array<[string, Record<string, unknown>]>,
        updateError: null as unknown,
        hasUpdateError: false,
    };
    const noop = () => {};
    const asyncNoop = async () => {};
    // Every function a component lists as a hook dependency is a STABLE reference — a fresh
    // one per render would re-run effects that setState (OperationsCenterView's mirror load).
    const rpcAction = async (action: string, payload: Record<string, unknown>) => {
        state.rpc.push({ action, payload });
        if (action === 'mirror:list' || action === 'mirror:list_pending') return [];
        return null;
    };
    const hasPermission = (p: string) => state.perms.has(p);
    const refreshOperations = async () => { state.refreshes++; };
    const data = { isFetching: {}, refreshOperations, rpcAction };
    const formatDate = Object.assign(() => 'date', { date: () => 'date', time: () => 'time', prefs: {} });
    const notification = {
        addToast: (title: string, _icon: unknown, _cls: string, opts?: { description?: string }) => { state.toasts.push({ title, description: opts?.description }); },
        confirm: async () => true,
    };
    const ops = {
        get operations() { return state.operations; },
        operationTemplates: [],
        toggleParticipantReady: asyncNoop, leaveOperation: asyncNoop, joinOperationWithShip: asyncNoop, rsvpOperation: asyncNoop,
        updateOperationStatus: asyncNoop, extractTemplateFromOperation: asyncNoop, createOperationTemplate: asyncNoop,
        addOperationParticipant: async (opId: string, userId: number) => { state.added.push([opId, userId]); },
        updateOperationDetails: async (id: string, updates: Record<string, unknown>) => {
            state.updates.push([id, updates]);
            if (state.hasUpdateError) throw state.updateError;
            return {};
        },
    };
    const members = {
        get members() { return state.members; },
        securityClearances: [], limitingMarkers: [], units: [],
    };
    const navigation = { viewOperationDetails: noop, viewMirroredOperation: noop };
    const modals = { openCreateOperationModal: noop, openOperationTemplatesModal: noop };
    const config = { locations: [], discordConfig: null };
    const fleet = { userShips: [], refreshFleet: noop };
    return { state, hasPermission, data, formatDate, notification, ops, members, navigation, modals, config, fleet };
});

vi.mock('../services/apiService', () => ({ default: { getStateSubset: async () => ({}), rpc: async () => ({}) } }));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ currentUser: h.state.me, hasPermission: h.hasPermission }),
    useFormatDate: () => h.formatDate,
}));
vi.mock('../contexts/DataContext', () => ({ useData: () => h.data }));
vi.mock('../contexts/OperationsContext', () => ({ useOperations: () => h.ops }));
vi.mock('../contexts/NotificationContext', () => ({ useNotification: () => h.notification }));
vi.mock('../contexts/MembersContext', () => ({ useMembers: () => h.members }));
vi.mock('../contexts/NavigationContext', () => ({ useNavigation: () => h.navigation }));
vi.mock('../contexts/ModalRegistryContext', () => ({ useModalRegistry: () => h.modals }));
vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => h.config }));
vi.mock('../contexts/FleetContext', () => ({ useFleet: () => h.fleet }));
vi.mock('../components/layout/WindowFrame', () => ({
    default: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) => <div>{children}{footer}</div>,
}));
vi.mock('../components/views/fleet/ShipPickerDropdown', () => ({ default: () => null }));
vi.mock('../components/views/operations/tabs/OpOrbatNodeGraph', () => ({ default: () => <div data-testid="node-graph" /> }));
vi.mock('../components/views/operations/tabs/OpShipSeatsPanel', () => ({ default: () => null }));

import OpSituationTab from '../components/views/operations/tabs/OpSituationTab';
import OpOrbatTab from '../components/views/operations/tabs/OpOrbatTab';
import OperationCard from '../components/views/operations/operations/OperationCard';
import OperationsCalendarView from '../components/views/operations/OperationsCalendarView';
import OperationsCenterView from '../components/views/operations/OperationsCenterView';
import AddParticipantModal from '../components/modals/AddParticipantModal';
import OpAdministerTab from '../components/views/operations/tabs/OpAdministerTab';
import { FORMER_PARTICIPANT_LABEL, FORMER_PARTICIPANT_TITLE } from '../components/views/operations/participantRoster';
import { OperationStatus, OperationType, RSVPStatus, type HydratedOperation } from '../types';

const STAMP = '2026-11-01T10:00:00.000Z';
const OWNER = 1;

type Row = HydratedOperation['participants'][number];
function row(userId: number, timeLeft: string | null, over: Partial<Row> = {}): Row {
    return {
        userId, user: { id: userId, name: `Member ${userId}`, avatarUrl: '' },
        timeJoined: '2026-10-30T10:00:00.000Z', timeLeft, isReady: false, ...over,
    } as unknown as Row;
}
const active = (userId: number, over: Partial<Row> = {}) => row(userId, null, over);
const former = (userId: number, over: Partial<Row> = {}) => row(userId, STAMP, over);

let seq = 0;
function op(over: Partial<HydratedOperation> = {}): HydratedOperation {
    seq++;
    return {
        id: `op-${seq}-x`, name: `Op ${seq}`, ownerId: OWNER, owner: { id: OWNER, name: 'Owner' },
        status: OperationStatus.Concluded, type: OperationType.PvE, description: 'brief',
        isSpecial: false, isJoint: false, isTraining: false, tracksUec: false, clearanceLevel: 0,
        limitingMarkers: [], commsPlan: [], log: [], participants: [],
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
        ...over,
    } as unknown as HydratedOperation;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const el = [...container.querySelectorAll('button')].find(b => (b.textContent || '').trim() === label);
    if (!el) throw new Error(`no button "${label}" — have: ${[...container.querySelectorAll('button')].map(b => JSON.stringify((b.textContent || '').trim())).join(', ')}`);
    return el as HTMLButtonElement;
}

/** Names that carry the former-participant marker, in render order. */
function markedNames(container: HTMLElement): string[] {
    return [...container.querySelectorAll(`[title="${FORMER_PARTICIPANT_TITLE}"]`)].map(badge => {
        expect(badge.textContent).toBe(FORMER_PARTICIPANT_LABEL);
        return (badge.parentElement?.textContent || '').replace(FORMER_PARTICIPANT_LABEL, '').trim();
    });
}

beforeEach(() => {
    h.state.me = { id: 7, name: 'Viewer' };
    h.state.perms = new Set();
    h.state.operations = [];
    h.state.members = [];
    h.state.rpc = [];
    h.state.toasts = [];
    h.state.added = [];
    h.state.refreshes = 0;
    h.state.closes = 0;
    h.state.updates = [];
    h.state.updateError = null;
    h.state.hasUpdateError = false;
});

// ---------------------------------------------------------------------------
// OpSituationTab — the participant chips and counts
// ---------------------------------------------------------------------------

function situation(operation: HydratedOperation, rosterParticipants: Row[], isParticipant = false) {
    return render(
        <OpSituationTab
            operation={operation} canManage={false} isParticipant={isParticipant}
            rosterParticipants={rosterParticipants} onRefresh={() => {}} loadingAction={null}
            onAction={async () => {}}
        />,
    );
}

describe('OpSituationTab — roster chips', () => {
    it('marks ONLY the former rows of a concluded op, and lists every row it is handed', () => {
        const o = op({ participants: [former(7), active(9), former(8)] });
        const { container } = situation(o, o.participants);
        expect(markedNames(container)).toEqual(['Member 7', 'Member 8']);
        expect(container.textContent).toContain('Member 9');
        expect(container.textContent).not.toContain('No active participants');
    });

    it('counts the rows it is handed for capacity and readiness', () => {
        const o = op({ maxParticipants: 5, participants: [former(7), former(8, { isReady: true })] });
        const { container } = situation(o, o.participants);
        expect(container.textContent).toContain('2 / 5 PAX');
        expect(container.textContent).toMatch(/Fleet Readiness\s*1\s*\/\s*2/);
    });

    it('a live op with active rows shows no marker', () => {
        const o = op({ status: OperationStatus.Planning, participants: [active(8)] });
        const { container } = situation(o, o.participants);
        expect(markedNames(container)).toEqual([]);
        expect(container.textContent).toContain('Member 8');
    });

    it('a concluded op offers no participant actions, even to an active row', () => {
        const o = op({ participants: [active(7)] });
        const { container } = situation(o, o.participants, true);
        expect(container.textContent).not.toContain('Mark Ready');
        expect(container.textContent).not.toContain('Withdraw');
    });
});

// ---------------------------------------------------------------------------
// OpOrbatTab — roster list (display) vs node assignment (action)
// ---------------------------------------------------------------------------

function orbat(operation: HydratedOperation) {
    return render(
        <OpOrbatTab operation={operation} canManage onRefresh={() => {}} onManageParticipant={() => {}} onRemoveParticipant={() => {}} />,
    );
}

/** The roster sub-view rows, by name, in render order. */
function rosterNames(container: HTMLElement): string[] {
    return [...container.querySelectorAll('p.font-bold.text-sm')].map(p => (p.textContent || '').replace(FORMER_PARTICIPANT_LABEL, '').trim());
}

describe('OpOrbatTab — roster sub-view', () => {
    it('a concluded op lists its WHOLE roster with the former rows marked, and counts them', () => {
        const o = op({ participants: [former(OWNER), former(2), active(3)] });
        const { container } = orbat(o);
        expect(rosterNames(container).sort()).toEqual(['Member 1', 'Member 2', 'Member 3']);
        expect(markedNames(container).sort()).toEqual(['Member 1', 'Member 2']);
        expect(container.textContent).toMatch(/Ready\s*0\s*\/\s*3/);
    });

    it('a live op lists and counts active rows only', () => {
        const o = op({ status: OperationStatus.Scheduled, participants: [former(2), active(3), active(4)] });
        const { container } = orbat(o);
        expect(rosterNames(container).sort()).toEqual(['Member 3', 'Member 4']);
        expect(markedNames(container)).toEqual([]);
        expect(container.textContent).toMatch(/Ready\s*0\s*\/\s*2/);
    });
});

describe('OpOrbatTab — node assignment stays ACTIVE-only', () => {
    it('the Assign Participant select offers active rows only, even on a concluded op', () => {
        const o = op({ participants: [former(OWNER), former(2), active(3)] });
        const { container } = orbat(o);
        fireEvent.click(button(container, 'Structure'));
        fireEvent.click(button(container, 'Add Node'));
        const label = [...container.querySelectorAll('label')].find(l => l.textContent === 'Assign Participant')!;
        const select = label.parentElement!.querySelector('select')!;
        expect([...select.options].map(o2 => o2.textContent)).toEqual(['- None -', 'Member 3']);
    });
});

// ---------------------------------------------------------------------------
// OperationCard — team stack and footer count
// ---------------------------------------------------------------------------

function footerCount(container: HTMLElement): string {
    const icon = container.querySelector('i.fa-users')!;
    return (icon.parentElement!.textContent || '').trim();
}

describe('OperationCard — roster count', () => {
    it('a concluded op counts and stacks its whole roster, labelled as the roster', () => {
        const o = op({ participants: [former(OWNER), former(2), active(3)] });
        const { container } = render(<OperationCard operation={o} />);
        expect(footerCount(container)).toBe('3 On roster');
        expect(container.textContent).toContain('Team · 3');
        const stackTitles = [...container.querySelectorAll('[title^="Member "]')].map(e => e.getAttribute('title'));
        expect(stackTitles).toEqual(['Member 1 · Lead', 'Member 2', 'Member 3']);
    });

    it('a live op counts its active rows only, labelled Active', () => {
        const o = op({ status: OperationStatus.Active, participants: [former(2), active(3)] });
        const { container } = render(<OperationCard operation={o} />);
        expect(footerCount(container)).toBe('1 Active');
        expect(container.textContent).toContain('Team · 1');
    });

    it('an empty concluded roster shows 0 and no team block', () => {
        const { container } = render(<OperationCard operation={op({ participants: [] })} />);
        expect(footerCount(container)).toBe('0 On roster');
        expect(container.textContent).not.toContain('Team ·');
    });
});

// ---------------------------------------------------------------------------
// OperationsCalendarView — week and day blocks
// ---------------------------------------------------------------------------

describe('OperationsCalendarView — counts per block', () => {
    // Only Date is faked: the calendar opens on "today" and buckets ops by their local
    // calendar date. Scheduling every op at the faked "now" instant puts it on today in
    // ANY time zone (AEST locally, UTC in CI).
    const NOW = new Date('2026-06-15T02:30:00.000Z');
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    const at = NOW.toISOString();

    function dayCard(container: HTMLElement, name: string): HTMLElement {
        const title = [...container.querySelectorAll('h3')].find(e => e.textContent === name)!;
        return title.closest('.relative') as HTMLElement;
    }

    it('day view: a concluded op counts PAX and RSVPs over its whole roster', () => {
        const o = op({ name: 'Done', scheduledStart: at, participants: [
            former(1, { rsvpStatus: RSVPStatus.Accepted }), former(2, { rsvpStatus: RSVPStatus.Tentative }),
            former(3, { rsvpStatus: RSVPStatus.Declined }), former(4),
        ] });
        const { container } = render(<OperationsCalendarView operations={[o]} />);
        fireEvent.click(button(container, 'day'));
        const card = dayCard(container, 'Done');
        expect(card.textContent).toContain('4 PAX');
        expect(card.querySelector('span.text-green-400')!.textContent).toBe('1');
        expect(card.querySelector('span.text-amber-400')!.textContent).toBe('1');
        expect(card.querySelector('span.text-red-400')!.textContent).toBe('1');
    });

    it('day view: a live op counts PAX and RSVPs over active rows only', () => {
        const o = op({ name: 'Live', status: OperationStatus.Scheduled, scheduledStart: at, participants: [
            active(1, { rsvpStatus: RSVPStatus.Accepted }), former(2, { rsvpStatus: RSVPStatus.Accepted }),
            active(3, { rsvpStatus: RSVPStatus.Declined }), former(4, { rsvpStatus: RSVPStatus.Tentative }),
        ] });
        const { container } = render(<OperationsCalendarView operations={[o]} />);
        fireEvent.click(button(container, 'day'));
        const card = dayCard(container, 'Live');
        expect(card.textContent).toContain('2 PAX');
        expect(card.querySelector('span.text-green-400')!.textContent).toBe('1');
        expect(card.querySelector('span.text-red-400')!.textContent).toBe('1');
        expect(card.querySelector('span.text-amber-400')).toBeNull();
    });

    it('week view: a concluded op shows its roster PAX; a live op ignores a stale stamped RSVP', () => {
        const done = op({ name: 'Done', scheduledStart: at, participants: [former(1), former(2)] });
        const live = op({ name: 'Live', status: OperationStatus.Scheduled, scheduledStart: at, participants: [
            active(1), former(2, { rsvpStatus: RSVPStatus.Accepted }),
        ] });
        const { container } = render(<OperationsCalendarView operations={[done, live]} />);
        fireEvent.click(button(container, 'week'));
        const block = (name: string) => [...container.querySelectorAll('span')].find(s => (s.textContent || '').trim().endsWith(name))!.closest('div.border') as HTMLElement;
        expect(block('Done').textContent).toContain('2 PAX');
        expect(block('Live').textContent).toContain('1 PAX');
        expect(block('Live').textContent).not.toContain('RSVP');
    });
});

// ---------------------------------------------------------------------------
// OperationsCenterView — hero stats, my deployments, history, upcoming
// ---------------------------------------------------------------------------

function heroValue(container: HTMLElement, label: string): string {
    const tile = [...container.querySelectorAll('button')].find(b => b.querySelector('span')?.textContent === label)!;
    return (tile.querySelector('div.font-mono')!.textContent || '').trim();
}

describe('OperationsCenterView', () => {
    it('Deployed counts the active rows of Active ops — not stamped rows, not concluded ops', async () => {
        h.state.operations = [
            op({ status: OperationStatus.Active, participants: [active(1), active(2), former(3)] }),
            op({ status: OperationStatus.Active, participants: [active(4)] }),
            op({ status: OperationStatus.Concluded, participants: [former(5), former(6)] }),
        ];
        const { container } = render(<OperationsCenterView />);
        await waitFor(() => expect(h.state.rpc.some(c => c.action === 'mirror:list')).toBe(true));
        expect(heroValue(container, 'Deployed')).toBe('3');
    });

    it('My Active Deployments lists Active ops where the viewer holds an ACTIVE row only', async () => {
        h.state.operations = [
            op({ name: 'Mine', status: OperationStatus.Active, participants: [active(7)] }),
            op({ name: 'Reactivated', status: OperationStatus.Active, participants: [former(7), active(8)] }),
            op({ name: 'Old', status: OperationStatus.Concluded, participants: [former(7)] }),
        ];
        const { container } = render(<OperationsCenterView />);
        await waitFor(() => expect(h.state.rpc.some(c => c.action === 'mirror:list')).toBe(true));
        const heading = [...container.querySelectorAll('h3')].find(e => e.textContent === 'My Active Deployments')!;
        const section = heading.closest('section')!;
        const listed = [...section.querySelectorAll('h3')].map(e => e.textContent).filter(t => t !== 'My Active Deployments');
        expect(listed).toEqual(['Mine']);
    });

    it('the History tab counts concluded ops the viewer was on — a former row counts', async () => {
        const mine = op({ name: 'Was on it', status: OperationStatus.Concluded, participants: [former(7)] });
        const theirs = op({ name: 'Never on it', status: OperationStatus.Concluded, participants: [former(8)] });
        h.state.operations = [mine, theirs];
        const { container } = render(<OperationsCenterView />);
        await waitFor(() => expect(h.state.rpc.some(c => c.action === 'mirror:list')).toBe(true));
        // The tab's text is its label followed by its count badge.
        fireEvent.click(button(container, 'History1'));
        const names = [...container.querySelectorAll('h3')].map(e => e.textContent);
        expect(names).toContain('Was on it');
        expect(names).not.toContain('Never on it');
    });

    it('Upcoming cards count RSVPs and PAX over active rows only', async () => {
        const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
        h.state.operations = [
            op({ name: 'With RSVP', status: OperationStatus.Scheduled, scheduledStart: future, participants: [
                active(1, { rsvpStatus: RSVPStatus.Accepted }), active(2), former(3, { rsvpStatus: RSVPStatus.Accepted }),
            ] }),
            op({ name: 'No RSVP', status: OperationStatus.Scheduled, scheduledStart: future, participants: [
                active(1), active(2), former(3),
            ] }),
        ];
        const { container } = render(<OperationsCenterView />);
        await waitFor(() => expect(h.state.rpc.some(c => c.action === 'mirror:list')).toBe(true));
        const heading = [...container.querySelectorAll('h3')].find(e => e.textContent === 'Upcoming Operations')!;
        const section = heading.closest('section')!;
        const card = (name: string) => [...section.querySelectorAll('h3')].find(e => e.textContent === name)!.parentElement as HTMLElement;
        expect(within(card('With RSVP')).getByText('1 RSVP')).toBeTruthy();
        expect(within(card('No RSVP')).getByText('2 PAX')).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// AddParticipantModal — never offer an existing roster row
// ---------------------------------------------------------------------------

describe('AddParticipantModal', () => {
    const member = (id: number) => ({ id, name: `Member ${id}`, avatarUrl: '', rank: { name: 'Rank' } });

    it('excludes the owner and EVERY roster row — active and former — and offers the rest', () => {
        h.state.members = [member(OWNER), member(2), member(3), member(4)];
        const o = op({ participants: [active(2), former(3)] });
        const { container } = render(<AddParticipantModal isOpen onClose={() => {}} operation={o} />);
        const offered = [...container.querySelectorAll('label p.font-bold')].map(p => p.textContent);
        expect(offered).toEqual(['Member 4']);
    });

    it('says so when everyone is already on the roster', () => {
        h.state.members = [member(OWNER), member(3)];
        const o = op({ participants: [former(3)] });
        const { container } = render(<AddParticipantModal isOpen onClose={() => {}} operation={o} />);
        expect(container.textContent).toContain('No available members found.');
    });

    it('adds the selected member to THIS op, refreshes, then closes', async () => {
        h.state.members = [member(OWNER), member(4)];
        const o = op({ participants: [former(3)] });
        const onClose = () => { h.state.closes++; };
        const { container } = render(<AddParticipantModal isOpen onClose={onClose} operation={o} />);
        fireEvent.click(container.querySelector('label input[type="checkbox"]')!);
        fireEvent.click(button(container, 'Add Selected'));
        await waitFor(() => expect(h.state.closes).toBe(1));
        expect(h.state.added).toEqual([[o.id, 4]]);
        expect(h.state.refreshes).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// OpAdministerTab — the save-failure toast
// ---------------------------------------------------------------------------

describe('OpAdministerTab — save failure toast', () => {
    async function failSave(error: unknown): Promise<{ title: string; description?: string }> {
        h.state.hasUpdateError = true;
        h.state.updateError = error;
        const o = op({ status: OperationStatus.Planning });
        const { container } = render(
            <OpAdministerTab operation={o} canManage onRefresh={() => {}} onDeleteOperation={() => {}} />,
        );
        fireEvent.click(button(container, 'Edit All Details'));
        fireEvent.click(button(container, 'Save Changes'));
        await waitFor(() => expect(h.state.toasts).toHaveLength(1));
        expect(h.state.updates).toHaveLength(1);
        expect(h.state.updates[0][0]).toBe(o.id);
        return h.state.toasts[0];
    }

    // The component logs the failure; keep the test output clean and restore afterwards.
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); });

    it("shows the server's message — e.g. the re-run-schema.sql instruction", async () => {
        const msg = 'Database update required — re-run schema.sql (op_replace_limiting_markers missing) (ref: r-1)';
        const toast = await failSave(new Error(msg));
        expect(toast).toEqual({ title: 'Update Failed', description: msg });
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('trims surrounding whitespace off the server message', async () => {
        const toast = await failSave(new Error('  Insufficient permissions.  '));
        expect(toast.description).toBe('Insufficient permissions.');
    });

    it.each([
        ['an empty message', new Error('')],
        ['a whitespace-only message', new Error('   ')],
        ['a non-string message (never render an object)', { message: { detail: 'raw' } }],
        ['a thrown string', 'boom'],
        ['a thrown null', null],
        ['a thrown undefined', undefined],
    ])('falls back to the generic text for %s', async (_label, error) => {
        const toast = await failSave(error);
        expect(toast).toEqual({ title: 'Update Failed', description: 'Failed to update operation settings.' });
    });

    it('a successful save still says so', async () => {
        const o = op({ status: OperationStatus.Planning });
        const { container } = render(
            <OpAdministerTab operation={o} canManage onRefresh={() => {}} onDeleteOperation={() => {}} />,
        );
        fireEvent.click(button(container, 'Edit All Details'));
        fireEvent.click(button(container, 'Save Changes'));
        await waitFor(() => expect(h.state.toasts).toHaveLength(1));
        expect(h.state.toasts[0]).toEqual({ title: 'Operation Updated', description: 'Operation settings have been saved.' });
    });
});
