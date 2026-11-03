import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

// The government client surfaces changed alongside the server fixes:
//
//   * Applying a template now DELETES every position server-side (the cascade takes their
//     holders, the elections for those seats and the legislation votes cast from them).
//     Both places a template can be applied — the admin Government tab and the
//     Restructure wizard — must say so before anyone agrees. The wizard used to apply over
//     an existing government with no confirmation at all.
//   * gov:cast_legislation_vote / gov:cast_motion_vote store the ballot FIRST, then
//     refresh the cached tally; when only the refresh fails they reject with "Your vote
//     was recorded, but the … tally could not be recounted/saved". The UI shows that
//     message as-is, refetches, and stops offering the vote — a retry can only answer
//     "already voted".

const h = vi.hoisted(() => ({
    rpc: [] as Array<{ action: string; payload: Record<string, unknown> }>,
    rpcError: null as Error | null,
    toasts: [] as Array<{ title: string; description?: string }>,
    confirms: [] as Array<Record<string, unknown>>,
    confirmAnswer: true,
    refreshes: 0,
    perms: new Set<string>(),
    gov: {} as Record<string, unknown>,
}));

vi.mock('../services/apiService', () => ({ default: { getStateSubset: async () => ({}), rpc: async () => ({}) } }));
vi.mock('../components/layout/WindowFrame', () => ({
    default: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) => <div>{children}{footer}</div>,
}));
vi.mock('../components/views/wiki/WikiEditor', () => ({ default: () => <div data-testid="wiki-editor" /> }));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ currentUser: { id: 7 }, hasPermission: (p: string) => h.perms.has(p) }),
    useFormatDate: () => () => 'date',
}));
vi.mock('../contexts/DataContext', () => ({
    useData: () => ({
        rpcAction: async (action: string, payload: Record<string, unknown>) => {
            h.rpc.push({ action, payload });
            if (h.rpcError) throw h.rpcError;
            return null;
        },
    }),
}));
vi.mock('../contexts/GovernmentContext', () => ({ useGovernment: () => h.gov }));
vi.mock('../contexts/MembersContext', () => ({ useMembers: () => ({ allUsers: [] }) }));
vi.mock('../contexts/NotificationContext', () => ({
    useNotification: () => ({
        addToast: (title: string, _icon: unknown, _cls: string, opts?: { description?: string }) => { h.toasts.push({ title, description: opts?.description }); },
        confirm: async (opts: Record<string, unknown>) => { h.confirms.push(opts); return h.confirmAnswer; },
    }),
}));

import MotionsTab from '../components/views/government/MotionsTab';
import LegislationDetailView from '../components/views/government/LegislationDetailView';
import GovernmentSetupWizard from '../components/views/government/GovernmentSetupWizard';
import GovernmentSettingsTab from '../components/views/admin/GovernmentSettingsTab';
import { TEMPLATE_APPLY_WARNING, classifyVoteFailure } from '../components/views/government/governmentUiRules';
import type { GovernmentLegislation, GovernmentMotion } from '../types';

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(b => (b.textContent || '').trim() === label) as HTMLButtonElement | undefined;
}

beforeEach(() => {
    h.rpc = []; h.rpcError = null; h.toasts = []; h.confirms = []; h.confirmAnswer = true; h.refreshes = 0;
    h.perms = new Set();
    h.gov = {
        governmentMotions: [], governmentPositions: [], governmentPositionHolders: [], governmentBranches: [],
        governmentsFeatureConfig: { enabled: true }, governmentConfig: null,
        refreshGovernment: async () => { h.refreshes++; },
    };
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('governmentUiRules', () => {
    it('the template warning names everything applying deletes', () => {
        for (const phrase of ['Every current position is deleted', 'every position holder', 'every election for those positions', 'every legislation vote', 'cannot be undone', 'executive order']) {
            expect(TEMPLATE_APPLY_WARNING).toContain(phrase);
        }
    });

    it.each([
        ['Your vote was recorded, but the legislation tally could not be recounted', 'recorded'],
        ['Your vote was recorded, but the motion tally could not be saved', 'recorded'],
        ['You have already voted on this motion.', 'already-voted'],
        ['You have already voted on this legislation.', 'already-voted'],
        ['Motion is not in voting phase', 'failed'],
        ['', 'failed'],
        [undefined, 'failed'],
        [42, 'failed'],
    ])('%j → %s', (message, kind) => {
        expect(classifyVoteFailure(message)).toBe(kind);
    });
});

// ---------------------------------------------------------------------------
// Motions
// ---------------------------------------------------------------------------

function votingMotion(over: Partial<GovernmentMotion> = {}): GovernmentMotion {
    return {
        id: 21, title: 'Adjourn', status: 'Voting', createdById: 1, votesFor: 0, votesAgainst: 0, votesAbstain: 0,
        isSecretBallot: false, createdAt: 't', updatedAt: 't', ...over,
    } as unknown as GovernmentMotion;
}

describe('MotionsTab — casting a vote', () => {
    beforeEach(() => {
        h.perms = new Set(['gov:participate']);
        h.gov.governmentMotions = [votingMotion()];
    });

    it('a ballot stored but not tallied: the server message as-is, a refetch, and no vote buttons to retry', async () => {
        const msg = 'Your vote was recorded, but the motion tally could not be saved';
        h.rpcError = new Error(msg);
        const { container } = render(<MotionsTab />);
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(h.toasts).toHaveLength(1));
        expect(h.rpc).toEqual([{ action: 'gov:cast_motion_vote', payload: { motionId: 21, vote: 'for' } }]);
        expect(h.toasts[0]).toEqual({ title: 'Vote Recorded', description: msg });
        await waitFor(() => expect(h.refreshes).toBe(1));
        expect(button(container, 'For')).toBeUndefined();
        expect(button(container, 'Against')).toBeUndefined();
        expect(container.textContent).toContain('Voted "for"');
    });

    it('"already voted" is handled the same way: no retry offered', async () => {
        h.rpcError = new Error('You have already voted on this motion.');
        const { container } = render(<MotionsTab />);
        fireEvent.click(button(container, 'Against')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Already Voted', description: 'You have already voted on this motion.' }]));
        await waitFor(() => expect(h.refreshes).toBe(1));
        expect(button(container, 'Against')).toBeUndefined();
        // The stored vote is not known here, so none is claimed.
        expect(container.textContent).toContain('Voted');
        expect(container.textContent).not.toContain('Voted "');
    });

    it('an ordinary failure stored nothing: "Vote Failed", no refetch, the vote is still offered', async () => {
        h.rpcError = new Error('Motion is not in voting phase');
        const { container } = render(<MotionsTab />);
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Vote Failed', description: 'Motion is not in voting phase' }]));
        expect(h.refreshes).toBe(0);
        await waitFor(() => expect(button(container, 'For')!.disabled).toBe(false));
    });

    it('a failure with no message falls back to a generic one', async () => {
        h.rpcError = new Error('');
        const { container } = render(<MotionsTab />);
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Vote Failed', description: 'Failed to cast vote.' }]));
    });

    it('a successful vote is not offered again either (the subset carries no per-viewer hasVoted)', async () => {
        const { container } = render(<MotionsTab />);
        fireEvent.click(button(container, 'Abstain')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Vote Cast', description: undefined }]));
        await waitFor(() => expect(button(container, 'Abstain')).toBeUndefined());
        expect(container.textContent).toContain('Voted "abstain"');
    });

    it('a secret ballot never echoes the vote back', async () => {
        h.gov.governmentMotions = [votingMotion({ isSecretBallot: true })];
        const { container } = render(<MotionsTab />);
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(button(container, 'For')).toBeUndefined());
        expect(container.textContent).toContain('Voted');
        expect(container.textContent).not.toContain('"for"');
    });
});

// ---------------------------------------------------------------------------
// Legislation
// ---------------------------------------------------------------------------

function votingBill(over: Partial<GovernmentLegislation> = {}): GovernmentLegislation {
    return {
        id: 4, title: 'Act', body: '', status: 'Voting', authorId: 1, isConstitutionalAmendment: false,
        votesFor: 0, votesAgainst: 0, votesAbstain: 0, votes: [], comments: [], createdAt: 't', updatedAt: 't', ...over,
    } as unknown as GovernmentLegislation;
}

describe('LegislationDetailView — casting a vote', () => {
    beforeEach(() => {
        h.perms = new Set(['gov:elected_official']);
        h.gov.governmentPositions = [{ id: 5, name: 'Senator', canVoteLegislation: true }];
        h.gov.governmentPositionHolders = [{ id: 50, positionId: 5, userId: 7 }];
    });

    it('a ballot stored but not tallied: the server message as-is, a refetch, and no vote buttons to retry', async () => {
        const msg = 'Your vote was recorded, but the legislation tally could not be recounted';
        h.rpcError = new Error(msg);
        const { container } = render(<LegislationDetailView legislation={votingBill()} onBack={() => {}} />);
        fireEvent.click(button(container, 'Against')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Vote Recorded', description: msg }]));
        expect(h.rpc).toEqual([{ action: 'gov:cast_legislation_vote', payload: { legislationId: 4, positionId: 5, vote: 'against' } }]);
        await waitFor(() => expect(h.refreshes).toBe(1));
        expect(button(container, 'For')).toBeUndefined();
        expect(container.textContent).toContain('You voted "against" on this bill.');
    });

    it('"already voted": no retry offered, and no vote claimed that is not known', async () => {
        h.rpcError = new Error('You have already voted on this legislation.');
        const { container } = render(<LegislationDetailView legislation={votingBill()} onBack={() => {}} />);
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Already Voted', description: 'You have already voted on this legislation.' }]));
        await waitFor(() => expect(button(container, 'For')).toBeUndefined());
        expect(container.textContent).toContain('You have voted on this bill.');
    });

    it('an ordinary failure stored nothing: "Vote Failed", no refetch, the vote is still offered', async () => {
        h.rpcError = new Error('Legislation is not in voting phase');
        const { container } = render(<LegislationDetailView legislation={votingBill()} onBack={() => {}} />);
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Vote Failed', description: 'Legislation is not in voting phase' }]));
        expect(h.refreshes).toBe(0);
        await waitFor(() => expect(button(container, 'For')!.disabled).toBe(false));
        h.toasts = [];
        h.rpcError = new Error('');
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(h.toasts).toEqual([{ title: 'Vote Failed', description: 'Failed to cast vote.' }]));
    });

    it('a recorded vote on one bill does not hide the buttons on another', async () => {
        h.rpcError = new Error('Your vote was recorded, but the legislation tally could not be saved');
        const { container, rerender } = render(<LegislationDetailView legislation={votingBill()} onBack={() => {}} />);
        fireEvent.click(button(container, 'For')!);
        await waitFor(() => expect(button(container, 'For')).toBeUndefined());
        rerender(<LegislationDetailView legislation={votingBill({ id: 99 })} onBack={() => {}} />);
        expect(button(container, 'For')).toBeDefined();
    });

    it('a successful vote, and a vote already on the record, both show as cast', async () => {
        const { container, rerender } = render(<LegislationDetailView legislation={votingBill()} onBack={() => {}} />);
        fireEvent.click(button(container, 'Abstain')!);
        await waitFor(() => expect(container.textContent).toContain('You voted "abstain" on this bill.'));
        rerender(<LegislationDetailView legislation={votingBill({ id: 5, votes: [{ id: 1, legislationId: 5, userId: 7, positionId: 5, vote: 'for', castAt: 't' }] })} onBack={() => {}} />);
        expect(button(container, 'For')).toBeUndefined();
        expect(container.textContent).toContain('You voted "for" on this bill.');
    });
});

// ---------------------------------------------------------------------------
// Template apply
// ---------------------------------------------------------------------------

describe('applying a template warns what it deletes', () => {
    it('the admin Government tab confirms with the full warning before applying', async () => {
        const { container } = render(<GovernmentSettingsTab />);
        fireEvent.click(button(container, 'Westminster')!);
        await waitFor(() => expect(h.rpc.some(r => r.action === 'gov:apply_template')).toBe(true));
        expect(h.confirms).toEqual([{ title: 'Apply Template', message: TEMPLATE_APPLY_WARNING, confirmText: 'Apply Template', variant: 'danger' }]);
        expect(h.rpc.filter(r => r.action === 'gov:apply_template')).toEqual([{ action: 'gov:apply_template', payload: { templateType: 'westminster' } }]);
    });

    it('declining applies nothing', async () => {
        h.confirmAnswer = false;
        const { container } = render(<GovernmentSettingsTab />);
        fireEvent.click(button(container, 'Westminster')!);
        await waitFor(() => expect(h.confirms).toHaveLength(1));
        expect(h.rpc.filter(r => r.action === 'gov:apply_template')).toEqual([]);
    });

    it('the Restructure wizard confirms the same way over an existing government', async () => {
        h.gov.governmentPositions = [{ id: 5, name: 'Senator' }];
        const { container } = render(<GovernmentSetupWizard onComplete={() => {}} />);
        fireEvent.click([...container.querySelectorAll('button')].find(b => b.textContent?.includes('Westminster Parliament'))!);
        fireEvent.click(button(container, 'Establish Government')!);
        await waitFor(() => expect(h.rpc).toHaveLength(1));
        expect(h.confirms).toEqual([{ title: 'Apply Template', message: TEMPLATE_APPLY_WARNING, confirmText: 'Apply Template', variant: 'danger' }]);
        expect(h.rpc).toEqual([{ action: 'gov:apply_template', payload: { templateType: 'westminster' } }]);
    });

    it('declining in the wizard applies nothing; branches alone count as an existing structure', async () => {
        h.confirmAnswer = false;
        h.gov.governmentBranches = [{ id: 1, name: 'Senate' }];
        const { container } = render(<GovernmentSetupWizard onComplete={() => {}} />);
        fireEvent.click([...container.querySelectorAll('button')].find(b => b.textContent?.includes('Pirate Code'))!);
        fireEvent.click(button(container, 'Establish Government')!);
        await waitFor(() => expect(h.confirms).toHaveLength(1));
        expect(h.rpc).toEqual([]);
    });

    it('a first-time setup (nothing to lose) and a Custom restructure (config only) need no confirmation', async () => {
        const first = render(<GovernmentSetupWizard onComplete={() => {}} />);
        fireEvent.click([...first.container.querySelectorAll('button')].find(b => b.textContent?.includes('Pirate Code'))!);
        fireEvent.click(button(first.container, 'Establish Government')!);
        await waitFor(() => expect(h.rpc).toEqual([{ action: 'gov:apply_template', payload: { templateType: 'pirate_code' } }]));
        first.unmount();

        h.rpc = [];
        h.gov.governmentPositions = [{ id: 5, name: 'Senator' }];
        const custom = render(<GovernmentSetupWizard onComplete={() => {}} />);
        fireEvent.click([...custom.container.querySelectorAll('button')].find(b => b.textContent?.includes('Custom'))!);
        fireEvent.click(button(custom.container, 'Establish Government')!);
        await waitFor(() => expect(h.rpc.map(r => r.action)).toEqual(['gov:upsert_config']));
        expect(h.confirms).toEqual([]);
    });
});
