import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/hr.ts — the INTERVIEW / JOB-BOARD side: interview reads (incl. the panel side
// table that may not be migrated yet), interview scheduling / updates / reassignment /
// results / reopen / delete, interview templates, job postings and personnel positions.
//
// Pins the exact queries and write payloads, the "missing table vs transient error"
// distinction on the panel read (only the former is cached), the fail-closed read
// fallbacks, the push fan-out to interviewers, the audit-log lines, and the
// discriminator-only hr_update broadcasts (Security rule 4).
//
// CHECKED WRITES: every child write (panel, questions, responses, audit log, template
// delete) throws on its error and never broadcasts after one. Child-set replacements
// are new-rows-first — insert, then delete the parent's rows whose id is BELOW the
// lowest new id, unwinding the new rows if that delete fails — so a fault leaves the
// OLD set in place. On an interview the child set is replaced BEFORE the interview row
// is patched, so a child fault leaves the whole interview untouched.
// (tests/cov3-hr-child-replace-concurrency.test.ts runs two overlapping saves against
// a stateful fake to pin why the delete is id-bounded rather than an exclusion.)

type Call = { method: string; args: unknown[] };
type Q = { table: string; op: string; calls: Call[]; terminal: string };
type Res = { data?: unknown; error?: unknown; count?: number | null };
type Rule = { table: string; op?: string; when?: (q: Q) => boolean; res: Res | ((q: Q) => Res); once?: boolean };

const h = vi.hoisted(() => ({
    queries: [] as Q[],
    rules: [] as Rule[],
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    pushes: [] as Array<{ userIds: number[]; payload: Record<string, unknown> }>,
    warns: [] as unknown[][],
    errors: [] as unknown[][],
    resolve(q: Q): Res {
        const i = this.rules.findIndex(r => r.table === q.table && (!r.op || r.op === q.op) && (!r.when || r.when(q)));
        // Unscripted list reads answer [] (what PostgREST returns for no rows).
        if (i < 0) return { data: q.terminal === 'then' && q.op === 'select' ? [] : null, error: null };
        const rule = this.rules[i];
        if (rule.once) this.rules.splice(i, 1);
        return typeof rule.res === 'function' ? rule.res(q) : rule.res;
    },
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {},
        error: (...args: unknown[]) => { h.errors.push(args); },
        warn: (...args: unknown[]) => { h.warns.push(args); },
        child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/db/common', () => {
    const WRITE_OPS = ['insert', 'update', 'delete', 'upsert'];
    function builder(table: string) {
        const q: Q = { table, op: 'select', calls: [], terminal: '' };
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'gt', 'gte',
            'lt', 'lte', 'ilike', ...WRITE_OPS]) {
            b[m] = (...args: unknown[]) => {
                q.calls.push({ method: m, args });
                if (WRITE_OPS.includes(m) && q.op === 'select') q.op = m;
                return b;
            };
        }
        const settle = (terminal: string) => {
            q.terminal = terminal;
            h.queries.push(q);
            try { return Promise.resolve(h.resolve(q)); } catch (e) { return Promise.reject(e); }
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('maybeSingle');
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('then').then(res, rej);
        return b;
    }
    const handleSupabaseError = ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); };
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError,
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); return Promise.resolve(); },
        getSystemRoles: async () => ({}),
        // Same contract as the real safeFetch: any error (or a throw) yields the fallback.
        safeFetch: async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown, message: string) => {
            try {
                const { data, error } = await query;
                if (error) handleSupabaseError({ error, message });
                return data;
            } catch { return fallback; }
        },
    };
});

vi.mock('../lib/push', () => ({
    sendPushToUsers: async (userIds: number[], payload: Record<string, unknown>) => { h.pushes.push({ userIds, payload }); },
}));
vi.mock('../lib/db/notifications', () => ({ createNotification: async () => null }));
vi.mock('../lib/db/users', () => ({ logHrPositionChange: async () => {}, promoteUserToMember: async () => {} }));

import {
    getAllHRInterviews, getMyInterviews, createHRInterview, updateHRInterview, updateInterviewInterviewer,
    deleteHRInterview, saveInterviewResults, reopenHRInterview,
    getHRInterviewTemplates, getHRInterviewTemplateDetails, createInterviewTemplate, updateInterviewTemplate,
    deleteInterviewTemplate, getJobPostings, createJobPosting, updateJobPosting, updateJobPostingStatus,
    deleteJobPosting, getPersonnelPositions, createPersonnelPosition, updatePersonnelPosition, deletePersonnelPosition,
} from '../lib/db/hr';

// ---- fake-supabase helpers -------------------------------------------------

const on = (table: string, res: Rule['res'], opts: { op?: string; when?: (q: Q) => boolean; once?: boolean } = {}) => {
    h.rules.push({ table, res, ...opts });
};
const queriesOf = (table: string, op?: string) => h.queries.filter(q => q.table === table && (!op || q.op === op));
const argsOf = (q: Q | undefined, method: string) => q?.calls.find(c => c.method === method)?.args;
const allArgs = (q: Q | undefined, method: string) => (q?.calls ?? []).filter(c => c.method === method).map(c => c.args);
const selectOf = (q: Q | undefined) => String(argsOf(q, 'select')?.[0] ?? '');
const selecting = (cols: string) => (q: Q) => selectOf(q) === cols;
/** Position of a settled query in the global order (for write-ordering pins). */
const seq = (q: Q | undefined) => (q ? h.queries.indexOf(q) : -1);
/** A child-row delete that removes rows BY ID (the unwind of a half-done write). */
const byIdDelete = (q: Q) => q.op === 'delete' && argsOf(q, 'in')?.[0] === 'id';
/** A child-row delete scoped to the parent (the superseded-set delete, or a clear). */
const byParentDelete = (q: Q) => q.op === 'delete' && !byIdDelete(q);
const DB_ERR = { code: '23503', message: 'fk violation' };

const INTERVIEW_COLS = 'id, application_id, template_id, interviewer_id, scheduled_at, completed_at, overall_notes, final_score, status, is_recommended';
const PANEL_SELECT = 'interview_id, user:users(id, name, avatar_url, role_id, rsi_handle)';

const interviewRow = (id: string, over: Record<string, unknown> = {}) => ({
    id, application_id: 'app-1', template_id: 1, interviewer_id: 40, scheduled_at: '2026-04-02T10:00:00Z',
    completed_at: null, overall_notes: null, final_score: null, status: 'Scheduled', is_recommended: null,
    template: { id: 1, name: 'Std', description: 'standard' },
    interviewer: { id: 40, name: 'Lead Rec', avatar_url: null, role_id: 2, rsi_handle: 'lead' },
    responses: [{ question_id: 3, response_body: 'answer', score: 4 }],
    application: { applicant_name: 'Jane Recruit' },
    ...over,
});

const panelRow = (interview_id: string, id: number, name: string) => ({
    interview_id, user: { id, name, avatar_url: null, role_id: 2, rsi_handle: name.toLowerCase() },
});

/** A fresh hr module — the panel "table missing" verdict is module-level state. */
const freshHr = async () => { vi.resetModules(); return import('../lib/db/hr'); };

beforeEach(() => {
    h.queries = [];
    h.rules = [];
    h.broadcasts = [];
    h.pushes = [];
    h.warns = [];
    h.errors = [];
});

// ---------------------------------------------------------------------------
// Interview reads
// ---------------------------------------------------------------------------

describe('getAllHRInterviews', () => {
    it('selects explicit columns + joins, earliest first with an id tie-break, capped at 100, and attaches panels', async () => {
        on('hr_interviews', { data: [interviewRow('i1'), interviewRow('i2', { application: null })], error: null });
        on('hr_interview_panel', { data: [panelRow('i1', 50, 'Panel A'), panelRow('i1', 51, 'Panel B')], error: null });
        const out = await getAllHRInterviews();

        const q = queriesOf('hr_interviews')[0];
        const sel = selectOf(q);
        expect(sel).not.toContain('*');
        expect(sel).toContain(INTERVIEW_COLS);
        expect(sel).toContain('template:hr_interview_templates!hr_interviews_template_id_fkey(id, name, description)');
        expect(sel).toContain('interviewer:users!hr_interviews_interviewer_id_fkey(id, name, avatar_url, role_id, rsi_handle)');
        expect(sel).toContain('responses:hr_interview_responses(question_id, response_body, score)');
        expect(sel).toContain('application:hr_applications!hr_interviews_application_id_fkey(applicant_name)');
        expect(allArgs(q, 'order')).toEqual([['scheduled_at', { ascending: true }], ['id', { ascending: true }]]);
        expect(argsOf(q, 'limit')).toEqual([100]);

        const panel = queriesOf('hr_interview_panel')[0];
        expect(selectOf(panel)).toBe(PANEL_SELECT);
        expect(argsOf(panel, 'in')).toEqual(['interview_id', ['i1', 'i2']]);

        expect(out[0]).toMatchObject({
            id: 'i1', applicationId: 'app-1', templateId: 1, interviewerId: 40, applicantName: 'Jane Recruit',
            template: { id: 1, name: 'Std' }, interviewer: { id: 40, name: 'Lead Rec' },
            responses: [{ questionId: 3, responseBody: 'answer', score: 4 }],
        });
        expect(out[0].panelMembers.map(p => p.name)).toEqual(['Panel A', 'Panel B']);
        expect(out[1].panelMembers).toEqual([]);
        expect(out[1].applicantName).toBe('Unknown');
    });

    it('issues no panel read when there are no interviews', async () => {
        on('hr_interviews', { data: [], error: null });
        expect(await getAllHRInterviews()).toEqual([]);
        expect(queriesOf('hr_interview_panel')).toHaveLength(0);
    });

    it('fails closed to [] on an interview read error', async () => {
        on('hr_interviews', { data: null, error: { code: '08006', message: 'x' } });
        expect(await getAllHRInterviews()).toEqual([]);
        expect(queriesOf('hr_interview_panel')).toHaveLength(0);
    });
});

describe('panel side-table resilience', () => {
    it.each([
        ['42P01', { code: '42P01', message: 'x' }],
        ['PGRST205', { code: 'PGRST205', message: 'x' }],
        ['"relation does not exist" message', { message: 'relation "hr_interview_panel" does not exist' }],
        ['"Could not find the table" message', { message: 'Could not find the table public.hr_interview_panel' }],
    ])('a MISSING table (%s) is cached: interviews still load, the panel read is never retried, one warning', async (_l, error) => {
        const hr = await freshHr();
        on('hr_interviews', { data: [interviewRow('i1')], error: null });
        on('hr_interview_panel', { data: null, error });
        const first = await hr.getAllHRInterviews();
        const second = await hr.getAllHRInterviews();
        expect(first[0].panelMembers).toEqual([]);
        expect(second).toHaveLength(1);
        expect(queriesOf('hr_interview_panel')).toHaveLength(1);
        expect(h.warns.filter(w => /panel members table not available/.test(String(w[0])))).toHaveLength(1);
    });

    it('a missing table reported via a THROWN nested error is cached too', async () => {
        const hr = await freshHr();
        on('hr_interviews', { data: [interviewRow('i1')], error: null });
        on('hr_interview_panel', () => { throw { error: { code: '42P01', message: 'missing' } }; });
        await hr.getAllHRInterviews();
        await hr.getAllHRInterviews();
        expect(queriesOf('hr_interview_panel')).toHaveLength(1);
    });

    it('a TRANSIENT error is not cached: logged, and the next call retries the panel read', async () => {
        const hr = await freshHr();
        on('hr_interviews', { data: [interviewRow('i1')], error: null });
        on('hr_interview_panel', { data: null, error: { code: '08006', message: 'connection reset' } }, { once: true });
        on('hr_interview_panel', () => { throw 'socket hang up'; }, { once: true });
        on('hr_interview_panel', { data: [panelRow('i1', 50, 'Panel A')], error: null });
        const first = await hr.getAllHRInterviews();
        const second = await hr.getAllHRInterviews();
        const third = await hr.getAllHRInterviews();
        expect(first[0].panelMembers).toEqual([]);
        expect(second[0].panelMembers).toEqual([]);
        expect(third[0].panelMembers.map(p => p.name)).toEqual(['Panel A']);
        expect(queriesOf('hr_interview_panel')).toHaveLength(3);
        const transient = h.warns.filter(w => w[0] === 'panel members fetch failed (transient)');
        expect(transient.map(w => (w[1] as Record<string, unknown>).message)).toEqual(['connection reset', 'socket hang up']);
    });

    it('an errorless null panel payload yields empty panels', async () => {
        on('hr_interviews', { data: [interviewRow('i1')], error: null });
        on('hr_interview_panel', { data: null, error: null });
        expect((await getAllHRInterviews())[0].panelMembers).toEqual([]);
    });
});

describe('getMyInterviews', () => {
    it('merges lead + panel interviews (deduped), sorted by time, with panels attached', async () => {
        on('hr_interviews', { data: [interviewRow('lead-late', { scheduled_at: '2026-05-01T00:00:00Z' }), interviewRow('both', { scheduled_at: '2026-04-01T00:00:00Z' })], error: null },
            { when: q => argsOf(q, 'eq')?.[0] === 'interviewer_id' });
        on('hr_interview_panel', { data: [{ interview_id: 'both' }, { interview_id: 'panel-only' }], error: null }, { when: selecting('interview_id') });
        on('hr_interviews', { data: [interviewRow('both'), interviewRow('panel-only', { scheduled_at: null, application: null })], error: null },
            { when: q => argsOf(q, 'in')?.[0] === 'id' });
        on('hr_interview_panel', { data: [panelRow('panel-only', 40, 'Me')], error: null }, { when: selecting(PANEL_SELECT) });

        const out = await getMyInterviews(40);

        const [lead, panelInterviews] = queriesOf('hr_interviews');
        expect(allArgs(lead, 'eq')).toEqual([['interviewer_id', 40]]);
        expect(argsOf(lead, 'order')).toEqual(['scheduled_at', { ascending: true }]);
        expect(selectOf(lead)).not.toContain('*');
        const ids = queriesOf('hr_interview_panel').find(selecting('interview_id'));
        expect(allArgs(ids, 'eq')).toEqual([['user_id', 40]]);
        expect(argsOf(panelInterviews, 'in')).toEqual(['id', ['both', 'panel-only']]);

        // A null schedule sorts first (epoch); 'both' appears once.
        expect(out.map(i => i.id)).toEqual(['panel-only', 'both', 'lead-late']);
        expect(out[0].applicantName).toBe('Unknown');
        expect(out[0].panelMembers.map(p => p.name)).toEqual(['Me']);
        expect(argsOf(queriesOf('hr_interview_panel').find(selecting(PANEL_SELECT)), 'in')).toEqual(['interview_id', ['panel-only', 'both', 'lead-late']]);
    });

    it('a failed panel-membership lookup (error OR throw) degrades to lead interviews only', async () => {
        on('hr_interviews', { data: [interviewRow('lead')], error: null });
        on('hr_interview_panel', { data: null, error: { code: '42P01', message: 'missing' } }, { when: selecting('interview_id'), once: true });
        expect((await getMyInterviews(40)).map(i => i.id)).toEqual(['lead']);
        expect(queriesOf('hr_interviews')).toHaveLength(1);

        h.queries = [];
        on('hr_interview_panel', () => { throw new Error('relation missing'); }, { when: selecting('interview_id'), once: true });
        expect((await getMyInterviews(40)).map(i => i.id)).toEqual(['lead']);
        expect(queriesOf('hr_interviews')).toHaveLength(1);
    });

    it('a null membership payload means no panel interviews', async () => {
        on('hr_interviews', { data: [], error: null });
        on('hr_interview_panel', { data: null, error: null }, { when: selecting('interview_id') });
        expect(await getMyInterviews(40)).toEqual([]);
        expect(queriesOf('hr_interviews')).toHaveLength(1);
    });

    it('fails closed per query: a lead read error still shows panel interviews, and vice versa', async () => {
        on('hr_interviews', { data: null, error: { code: '08006', message: 'x' } }, { when: q => argsOf(q, 'eq')?.[0] === 'interviewer_id' });
        on('hr_interview_panel', { data: [{ interview_id: 'p1' }], error: null }, { when: selecting('interview_id') });
        on('hr_interviews', { data: [interviewRow('p1')], error: null }, { when: q => argsOf(q, 'in')?.[0] === 'id', once: true });
        expect((await getMyInterviews(40)).map(i => i.id)).toEqual(['p1']);

        h.rules = [];
        on('hr_interviews', { data: [interviewRow('lead')], error: null }, { when: q => argsOf(q, 'eq')?.[0] === 'interviewer_id' });
        on('hr_interview_panel', { data: [{ interview_id: 'p1' }], error: null }, { when: selecting('interview_id') });
        on('hr_interviews', { data: null, error: { code: '08006', message: 'x' } }, { when: q => argsOf(q, 'in')?.[0] === 'id' });
        expect((await getMyInterviews(40)).map(i => i.id)).toEqual(['lead']);
    });
});

// ---------------------------------------------------------------------------
// Interview writes
// ---------------------------------------------------------------------------

describe('createHRInterview', () => {
    const payload = { applicationId: 'app-1', templateId: 1, interviewerId: 40, scheduledAt: '2026-04-02T10:00:00Z' };

    it('refuses to schedule against an application that does not exist', async () => {
        on('hr_applications', { data: null, error: null, count: 0 });
        await expect(createHRInterview(payload)).rejects.toThrow('Application not found or access denied.');
        const q = queriesOf('hr_applications')[0];
        expect(argsOf(q, 'select')).toEqual(['id', { count: 'exact', head: true }]);
        expect(allArgs(q, 'eq')).toEqual([['id', 'app-1']]);
        expect(queriesOf('hr_interviews')).toHaveLength(0);
    });

    it('inserts the interview + panel, logs it, pushes lead + panel, broadcasts the slice, returns the mapped row', async () => {
        on('hr_applications', { data: null, error: null, count: 1 });
        on('hr_interviews', { data: { id: 'int-9', application_id: 'app-1', template_id: 1, interviewer_id: 40, scheduled_at: payload.scheduledAt, status: 'Scheduled', secret_col: 'x' }, error: null }, { op: 'insert' });
        const out = await createHRInterview({ ...payload, panelMemberIds: [50, 51], userId: 40 });

        const ins = queriesOf('hr_interviews', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual({ application_id: 'app-1', template_id: 1, interviewer_id: 40, scheduled_at: payload.scheduledAt });
        expect(selectOf(ins)).toBe(INTERVIEW_COLS);
        expect(argsOf(queriesOf('hr_interview_panel', 'insert')[0], 'insert')?.[0]).toEqual([
            { interview_id: 'int-9', user_id: 50 }, { interview_id: 'int-9', user_id: 51 },
        ]);
        expect(argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0]).toEqual({
            application_id: 'app-1', user_id: 40, action_type: 'INTERVIEW', message: 'Interview scheduled.',
        });
        expect(h.pushes).toHaveLength(1);
        expect(h.pushes[0].userIds).toEqual([40, 50, 51]);
        expect(h.pushes[0].payload).toMatchObject({ title: 'Interview Scheduled', tag: 'interview', data: { url: '/hr', interviewId: 'int-9' } });
        expect(String(h.pushes[0].payload.body)).toMatch(/^You have a new interview scheduled for /);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['interviews'] } }]);
        expect(out).toMatchObject({ id: 'int-9', applicationId: 'app-1', interviewerId: 40, status: 'Scheduled' });
        expect(out).not.toHaveProperty('secret_col');
    });

    it('no panel, no acting user → no panel insert and no log; no interviewer at all → no push', async () => {
        on('hr_applications', { data: null, error: null, count: 1 });
        on('hr_interviews', { data: { id: 'int-1' }, error: null }, { op: 'insert' });
        await createHRInterview({ ...payload, interviewerId: 0 });
        expect(queriesOf('hr_interview_panel')).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(1);
    });

    it('throws on an insert error before panel / log / push / broadcast', async () => {
        on('hr_applications', { data: null, error: null, count: 1 });
        on('hr_interviews', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert' });
        await expect(createHRInterview({ ...payload, panelMemberIds: [50], userId: 40 })).rejects.toThrow('Failed to create interview');
        expect(queriesOf('hr_interview_panel')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed PANEL insert unwinds the new interview and throws — no log, no push, no broadcast', async () => {
        on('hr_applications', { data: null, error: null, count: 1 });
        on('hr_interviews', { data: { id: 'int-9' }, error: null }, { op: 'insert' });
        on('hr_interview_panel', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(createHRInterview({ ...payload, panelMemberIds: [50], userId: 40 })).rejects.toThrow('Failed to assign interview panel');
        const unwind = queriesOf('hr_interviews', 'delete');
        expect(unwind).toHaveLength(1);
        expect(allArgs(unwind[0], 'in')).toEqual([['id', ['int-9']]]);
        expect(seq(unwind[0])).toBeGreaterThan(seq(queriesOf('hr_interview_panel', 'insert')[0]));
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
        expect(h.errors).toHaveLength(0);
    });

    it('a failed unwind is logged and the panel error still surfaces', async () => {
        on('hr_applications', { data: null, error: null, count: 1 });
        on('hr_interviews', { data: { id: 'int-9' }, error: null }, { op: 'insert' });
        on('hr_interviews', { data: null, error: { code: '08006', message: 'reset' } }, { op: 'delete' });
        on('hr_interview_panel', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(createHRInterview({ ...payload, panelMemberIds: [50], userId: 40 })).rejects.toThrow('Failed to assign interview panel');
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0][0]).toBe('unwinding a failed HR write left rows behind');
        expect(h.errors[0][1]).toMatchObject({ table: 'hr_interviews', applicationId: 'app-1' });
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed audit-log write throws before the push and the broadcast', async () => {
        on('hr_applications', { data: null, error: null, count: 1 });
        on('hr_interviews', { data: { id: 'int-9' }, error: null }, { op: 'insert' });
        on('hr_application_logs', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(createHRInterview({ ...payload, userId: 40 })).rejects.toThrow('Failed to write application log');
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('an errorless empty insert skips the panel insert and returns null', async () => {
        on('hr_applications', { data: null, error: null, count: 1 });
        on('hr_interviews', { data: null, error: null }, { op: 'insert' });
        expect(await createHRInterview({ ...payload, panelMemberIds: [50] })).toBeNull();
        expect(queriesOf('hr_interview_panel')).toHaveLength(0);
        expect(h.pushes[0].payload.data).toEqual({ url: '/hr', interviewId: undefined });
    });
});

describe('updateHRInterview', () => {
    const existing = (row: unknown = { application_id: 'app-1', interviewer_id: 40 }) =>
        on('hr_interviews', { data: row, error: null }, { op: 'select' });

    it('throws when the interview does not exist', async () => {
        existing(null);
        await expect(updateHRInterview('int-1', { scheduledAt: 'x' }, 40)).rejects.toThrow('Interview not found.');
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
    });

    it('replaces the panel (new rows FIRST) BEFORE patching only the supplied fields, logs every change, pushes the NEW lead', async () => {
        existing();
        // Ids come back out of order: the bound is the LOWEST id written, not the first.
        on('hr_interview_panel', { data: [{ id: 902 }, { id: 900 }], error: null }, { op: 'insert' });
        await updateHRInterview('int-1', { templateId: 2, interviewerId: 41, scheduledAt: '2026-05-05T00:00:00Z', panelMemberIds: [50, 51] }, 40);
        const sel = queriesOf('hr_interviews', 'select')[0];
        expect(selectOf(sel)).toBe('application_id, interviewer_id');
        expect(allArgs(sel, 'eq')).toEqual([['id', 'int-1']]);
        const upd = queriesOf('hr_interviews', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ template_id: 2, interviewer_id: 41, scheduled_at: '2026-05-05T00:00:00Z' });
        expect(allArgs(upd, 'eq')).toEqual([['id', 'int-1']]);
        const ins = queriesOf('hr_interview_panel', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual([{ interview_id: 'int-1', user_id: 50 }, { interview_id: 'int-1', user_id: 51 }]);
        expect(selectOf(ins)).toBe('id');
        // The superseded panel is every row of this interview BELOW the lowest id just
        // written — never an exclusion list, which also matched a concurrent save's rows.
        const del = queriesOf('hr_interview_panel', 'delete');
        expect(del).toHaveLength(1);
        expect(allArgs(del[0], 'eq')).toEqual([['interview_id', 'int-1']]);
        expect(allArgs(del[0], 'lt')).toEqual([['id', 900]]);
        expect(allArgs(del[0], 'not')).toEqual([]);
        // Child set first, then the interview row: insert → delete superseded → update.
        expect(seq(del[0])).toBeGreaterThan(seq(ins));
        expect(seq(upd)).toBeGreaterThan(seq(del[0]));
        expect(argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0]).toEqual({
            application_id: 'app-1', user_id: 40, action_type: 'INTERVIEW',
            message: 'Interview updated: rescheduled, lead interviewer reassigned, protocol changed, panel updated.',
        });
        expect(h.pushes).toEqual([{ userIds: [41], payload: {
            title: 'Interview Assigned', body: 'An interview has been rescheduled and assigned to you.', tag: 'interview', data: { url: '/hr', interviewId: 'int-1' },
        } }]);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['interviews'] } }]);
    });

    it('a reassignment without a reschedule says just "assigned"', async () => {
        existing();
        await updateHRInterview('int-1', { interviewerId: 41 }, 40);
        expect(h.pushes[0].payload.body).toBe('An interview has been assigned to you.');
        expect(queriesOf('hr_interview_panel')).toHaveLength(0);
    });

    it('same lead → no reassignment line, no push; an empty panel list clears without inserting', async () => {
        existing();
        await updateHRInterview('int-1', { interviewerId: 40, panelMemberIds: [] }, 40);
        expect(argsOf(queriesOf('hr_interviews', 'update')[0], 'update')?.[0]).toEqual({ interviewer_id: 40 });
        expect(queriesOf('hr_interview_panel', 'delete')).toHaveLength(1);
        expect(allArgs(queriesOf('hr_interview_panel', 'delete')[0], 'eq')).toEqual([['interview_id', 'int-1']]);
        // A requested-empty panel clears the whole parent: no id bound, no exclusion.
        expect(allArgs(queriesOf('hr_interview_panel', 'delete')[0], 'lt')).toEqual([]);
        expect(allArgs(queriesOf('hr_interview_panel', 'delete')[0], 'not')).toEqual([]);
        expect(seq(queriesOf('hr_interviews', 'update')[0])).toBeGreaterThan(seq(queriesOf('hr_interview_panel', 'delete')[0]));
        expect(queriesOf('hr_interview_panel', 'insert')).toHaveLength(0);
        expect((argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).message).toBe('Interview updated: panel updated.');
        expect(h.pushes).toHaveLength(0);
    });

    it('no effective change → no log line (and none without an acting user)', async () => {
        existing();
        await updateHRInterview('int-1', {}, 40);
        await updateHRInterview('int-1', { scheduledAt: 'x' }, 0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(2);
    });

    it('an interview UPDATE error after the panel replacement throws — no log, push or broadcast', async () => {
        // The panel is replaced first (child-first), so by the time the interview row is
        // patched the new panel is in place; the update error still surfaces and nothing
        // after it runs.
        existing();
        on('hr_interview_panel', { data: [{ id: 900 }], error: null }, { op: 'insert' });
        on('hr_interviews', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update' });
        await expect(updateHRInterview('int-1', { interviewerId: 41, panelMemberIds: [1] }, 40)).rejects.toThrow('Failed to update interview');
        const del = queriesOf('hr_interview_panel', 'delete');
        expect(del).toHaveLength(1);
        expect(seq(queriesOf('hr_interviews', 'update')[0])).toBeGreaterThan(seq(del[0]));
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed panel INSERT leaves the existing panel AND the interview row alone and throws — no log, push or broadcast', async () => {
        existing();
        on('hr_interview_panel', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(updateHRInterview('int-1', { interviewerId: 41, scheduledAt: '2026-06-01T00:00:00Z', panelMemberIds: [50, 51] }, 40)).rejects.toThrow('Failed to update interview panel');
        expect(queriesOf('hr_interview_panel', 'delete')).toHaveLength(0);
        // Child-first: the reschedule / reassignment was never written next to the old panel.
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
        // Reported as the insert's OWN error (handleSupabaseError), not misdiagnosed by
        // the short-insert guard (which logs expected/returned instead of the DB error).
        expect(h.errors).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed superseded-panel DELETE unwinds the new rows by id and throws', async () => {
        existing();
        on('hr_interview_panel', { data: [{ id: 900 }, { id: 901 }], error: null }, { op: 'insert' });
        on('hr_interview_panel', { data: null, error: DB_ERR }, { op: 'delete', when: byParentDelete });
        await expect(updateHRInterview('int-1', { panelMemberIds: [50, 51] }, 40)).rejects.toThrow('Failed to update interview panel');
        const unwind = queriesOf('hr_interview_panel').filter(byIdDelete);
        expect(unwind).toHaveLength(1);
        expect(allArgs(unwind[0], 'in')).toEqual([['id', [900, 901]]]);
        expect(allArgs(unwind[0], 'eq')).toEqual([]);
        expect(seq(unwind[0])).toBeGreaterThan(seq(queriesOf('hr_interview_panel').find(byParentDelete)));
        expect(h.errors).toHaveLength(0);
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed unwind is logged, and the original error still surfaces', async () => {
        existing();
        on('hr_interview_panel', { data: [{ id: 900 }], error: null }, { op: 'insert' });
        on('hr_interview_panel', { data: null, error: DB_ERR }, { op: 'delete' });
        await expect(updateHRInterview('int-1', { panelMemberIds: [50] }, 40)).rejects.toThrow('Failed to update interview panel');
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0][0]).toBe('unwinding a failed HR write left rows behind');
        expect(h.errors[0][1]).toMatchObject({ table: 'hr_interview_panel', parentColumn: 'interview_id', parentId: 'int-1' });
        expect(h.broadcasts).toHaveLength(0);
    });

    it('an insert that returns fewer ids than rows is refused BEFORE any superseded delete', async () => {
        // A short id list could put the bound above a written row whose id was not
        // returned (deleting it); an EMPTY one has no bound at all (Math.min() = Infinity).
        existing();
        on('hr_interview_panel', { data: [{ id: 900 }], error: null }, { op: 'insert', once: true });
        await expect(updateHRInterview('int-1', { panelMemberIds: [50, 51] }, 40)).rejects.toThrow('Failed to update interview panel');
        expect(queriesOf('hr_interview_panel').filter(byParentDelete)).toHaveLength(0);
        expect(allArgs(queriesOf('hr_interview_panel').find(byIdDelete), 'in')).toEqual([['id', [900]]]);
        expect(h.errors.at(-1)?.[1]).toMatchObject({ expected: 2, returned: 1 });
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);

        h.queries = [];
        on('hr_interview_panel', { data: null, error: null }, { op: 'insert', once: true });
        await expect(updateHRInterview('int-1', { panelMemberIds: [50] }, 40)).rejects.toThrow('Failed to update interview panel');
        expect(queriesOf('hr_interview_panel', 'delete')).toHaveLength(0);
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed panel CLEAR (empty list) throws without patching the interview, logging or broadcasting', async () => {
        existing();
        on('hr_interview_panel', { data: null, error: DB_ERR }, { op: 'delete' });
        await expect(updateHRInterview('int-1', { panelMemberIds: [] }, 40)).rejects.toThrow('Failed to update interview panel');
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
        expect(queriesOf('hr_interview_panel', 'insert')).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed audit-log write throws before the push and the broadcast', async () => {
        existing();
        on('hr_application_logs', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(updateHRInterview('int-1', { interviewerId: 41 }, 40)).rejects.toThrow('Failed to write application log');
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('updateInterviewInterviewer', () => {
    it('reassigns, logs by the new interviewer\'s name, pushes them, and broadcasts the interviews slice (ids only)', async () => {
        on('hr_interviews', { data: { application_id: 'app-1' }, error: null }, { op: 'select' });
        on('users', { data: { name: 'New Lead' }, error: null });
        await updateInterviewInterviewer('int-1', 41, 40);
        const upd = queriesOf('hr_interviews', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ interviewer_id: 41 });
        expect(allArgs(upd, 'eq')).toEqual([['id', 'int-1']]);
        expect(allArgs(queriesOf('users')[0], 'eq')).toEqual([['id', 41]]);
        expect((argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).message).toBe('Interview reassigned to New Lead');
        expect(h.pushes).toEqual([{ userIds: [41], payload: { title: 'Interview Assigned', body: 'An interview has been reassigned to you.', tag: 'interview', data: { url: '/hr', interviewId: 'int-1' } } }]);
        // Same discriminator-only signal as updateHRInterview — no name, no ids of people.
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['interviews'] } }]);
    });

    it('a missing interview (or no actor) still writes the reassignment and broadcasts, but logs/pushes nothing', async () => {
        on('hr_interviews', { data: null, error: null }, { op: 'select' });
        await updateInterviewInterviewer('int-1', 41, 40);
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(1);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['interviews'] } }]);
    });

    it('throws on the update error without pushing or broadcasting', async () => {
        on('hr_interviews', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update' });
        await expect(updateInterviewInterviewer('int-1', 41, 40)).rejects.toThrow('Failed to reassign interview');
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed audit-log write throws before the push and the broadcast', async () => {
        on('hr_interviews', { data: { application_id: 'app-1' }, error: null }, { op: 'select' });
        on('users', { data: { name: 'New Lead' }, error: null });
        on('hr_application_logs', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(updateInterviewInterviewer('int-1', 41, 40)).rejects.toThrow('Failed to write application log');
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('deleteHRInterview / reopenHRInterview', () => {
    it('delete: removes by id, logs the cancellation, broadcasts the slice', async () => {
        on('hr_interviews', { data: { application_id: 'app-1' }, error: null }, { op: 'select' });
        await deleteHRInterview('int-1', 40);
        expect(allArgs(queriesOf('hr_interviews', 'delete')[0], 'eq')).toEqual([['id', 'int-1']]);
        expect((argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).message).toBe('Interview cancelled/deleted.');
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['interviews'] } }]);
    });

    it('delete: no log for an unknown interview; an error throws without broadcasting', async () => {
        await deleteHRInterview('int-1', 40);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        h.broadcasts = [];
        on('hr_interviews', { data: null, error: { code: 'x', message: 'x' } }, { op: 'delete' });
        await expect(deleteHRInterview('int-1', 40)).rejects.toThrow('Failed to delete interview');
        expect(h.broadcasts).toHaveLength(0);
    });

    it('reopen: back to Scheduled with completed_at cleared, logged, broadcast', async () => {
        on('hr_interviews', { data: { application_id: 'app-1' }, error: null }, { op: 'select' });
        await reopenHRInterview('int-1', 40);
        const upd = queriesOf('hr_interviews', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ status: 'Scheduled', completed_at: null });
        expect(allArgs(upd, 'eq')).toEqual([['id', 'int-1']]);
        expect((argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).message).toBe('Interview reopened for editing.');
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['interviews'] } }]);
    });

    it('reopen: no log for an unknown interview; an error throws without broadcasting', async () => {
        await reopenHRInterview('int-1', 40);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        h.broadcasts = [];
        on('hr_interviews', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update' });
        await expect(reopenHRInterview('int-1', 40)).rejects.toThrow('Failed to reopen interview');
        expect(h.broadcasts).toHaveLength(0);
    });

    it('delete: a failed audit-log write rejects AFTER the delete and never broadcasts', async () => {
        // The case-file timeline entry is checked, not best-effort: the scheduler is told
        // the call failed rather than every HR client being told the interview is gone
        // with no trace of who removed it.
        on('hr_interviews', { data: { application_id: 'app-1' }, error: null }, { op: 'select' });
        on('hr_application_logs', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(deleteHRInterview('int-1', 40)).rejects.toThrow('Failed to write application log');
        const del = queriesOf('hr_interviews', 'delete');
        expect(del).toHaveLength(1);
        const log = queriesOf('hr_application_logs', 'insert');
        expect(argsOf(log[0], 'insert')?.[0]).toEqual({
            application_id: 'app-1', user_id: 40, action_type: 'INTERVIEW', message: 'Interview cancelled/deleted.',
        });
        expect(seq(log[0])).toBeGreaterThan(seq(del[0]));
        expect(h.broadcasts).toHaveLength(0);
    });

    it('reopen: a failed audit-log write rejects AFTER the reopen and never broadcasts', async () => {
        on('hr_interviews', { data: { application_id: 'app-1' }, error: null }, { op: 'select' });
        on('hr_application_logs', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(reopenHRInterview('int-1', 40)).rejects.toThrow('Failed to write application log');
        const upd = queriesOf('hr_interviews', 'update');
        expect(upd).toHaveLength(1);
        const log = queriesOf('hr_application_logs', 'insert');
        expect(argsOf(log[0], 'insert')?.[0]).toEqual({
            application_id: 'app-1', user_id: 40, action_type: 'INTERVIEW', message: 'Interview reopened for editing.',
        });
        expect(seq(log[0])).toBeGreaterThan(seq(upd[0]));
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('saveInterviewResults', () => {
    const RESPONSES = [{ questionId: 1, text: 'a1', score: 4 }, { questionId: 2, text: 'a2', score: 5 }];
    const found = () => on('hr_interviews', { data: { application_id: 'app-1' }, error: null }, { op: 'select' });

    it('replaces the responses (new rows FIRST) BEFORE completing the interview, logs score + recommendation, broadcasts', async () => {
        found();
        on('hr_interview_responses', { data: [{ id: 71 }, { id: 72 }], error: null }, { op: 'insert' });
        await saveInterviewResults('int-1', { notes: 'solid', finalScore: 8, isRecommended: true, interviewerId: 40, responses: RESPONSES });
        const upd = queriesOf('hr_interviews', 'update')[0];
        const patch = argsOf(upd, 'update')?.[0] as Record<string, unknown>;
        expect(patch).toMatchObject({ overall_notes: 'solid', final_score: 8, status: 'Completed', is_recommended: true });
        expect(Number.isNaN(Date.parse(String(patch.completed_at)))).toBe(false);
        expect(allArgs(upd, 'eq')).toEqual([['id', 'int-1']]);
        const ins = queriesOf('hr_interview_responses', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual([
            { interview_id: 'int-1', question_id: 1, response_body: 'a1', score: 4 },
            { interview_id: 'int-1', question_id: 2, response_body: 'a2', score: 5 },
        ]);
        expect(selectOf(ins)).toBe('id');
        const del = queriesOf('hr_interview_responses', 'delete');
        expect(del).toHaveLength(1);
        expect(allArgs(del[0], 'eq')).toEqual([['interview_id', 'int-1']]);
        expect(allArgs(del[0], 'lt')).toEqual([['id', 71]]);
        expect(allArgs(del[0], 'not')).toEqual([]);
        // insert new → delete superseded → THEN complete the interview row
        expect(seq(ins)).toBeLessThan(seq(del[0]));
        expect(seq(del[0])).toBeLessThan(seq(upd));
        expect(argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0]).toEqual({
            application_id: 'app-1', user_id: 40, action_type: 'INTERVIEW', message: 'Interview completed. Score: 8. Recommended: Yes',
        });
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['interviews'] } }]);
    });

    it('without responses (absent or empty) it only clears them; "No" recommendation; no log without an interviewer', async () => {
        found();
        await saveInterviewResults('int-1', { finalScore: 2, isRecommended: false });
        expect(queriesOf('hr_interview_responses', 'delete')).toHaveLength(1);
        expect(allArgs(queriesOf('hr_interview_responses', 'delete')[0], 'eq')).toEqual([['interview_id', 'int-1']]);
        expect(allArgs(queriesOf('hr_interview_responses', 'delete')[0], 'lt')).toEqual([]);
        expect(allArgs(queriesOf('hr_interview_responses', 'delete')[0], 'not')).toEqual([]);
        expect(seq(queriesOf('hr_interviews', 'update')[0])).toBeGreaterThan(seq(queriesOf('hr_interview_responses', 'delete')[0]));
        expect(queriesOf('hr_interview_responses', 'insert')).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        await saveInterviewResults('int-1', { finalScore: 2, isRecommended: false, interviewerId: 40, responses: [] });
        expect(queriesOf('hr_interview_responses', 'insert')).toHaveLength(0);
        expect((argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).message).toBe('Interview completed. Score: 2. Recommended: No');
    });

    it('a failed interview UPDATE after the responses are replaced throws — no log, no broadcast', async () => {
        // The answers are in place before the parent is touched; the parent fault leaves
        // the interview's status unchanged (still open), so the conduct action can retry.
        found();
        on('hr_interview_responses', { data: [{ id: 71 }, { id: 72 }], error: null }, { op: 'insert' });
        on('hr_interviews', { data: null, error: DB_ERR }, { op: 'update' });
        await expect(saveInterviewResults('int-1', { finalScore: 8, interviewerId: 40, responses: RESPONSES })).rejects.toThrow('Failed to save interview results');
        const del = queriesOf('hr_interview_responses', 'delete');
        expect(del).toHaveLength(1);
        expect(seq(queriesOf('hr_interviews', 'update')[0])).toBeGreaterThan(seq(del[0]));
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed response INSERT keeps the recorded answers AND the interview row (never Completed) and throws — no log, no broadcast', async () => {
        // The old delete-then-insert wiped the answers here and still answered success; the
        // old parent-first order then left a 'Completed' interview with the NEW score next
        // to the OLD answers, with no conduct action left to retry from.
        found();
        on('hr_interview_responses', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(saveInterviewResults('int-1', { finalScore: 8, interviewerId: 40, responses: RESPONSES })).rejects.toThrow('Failed to save interview responses');
        expect(queriesOf('hr_interview_responses', 'delete')).toHaveLength(0);
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
        expect(h.errors).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed superseded-response DELETE unwinds the new rows by id and throws, the interview never completed', async () => {
        found();
        on('hr_interview_responses', { data: [{ id: 71 }, { id: 72 }], error: null }, { op: 'insert' });
        on('hr_interview_responses', { data: null, error: DB_ERR }, { op: 'delete', when: byParentDelete });
        await expect(saveInterviewResults('int-1', { finalScore: 8, interviewerId: 40, responses: RESPONSES })).rejects.toThrow('Failed to save interview responses');
        const unwind = queriesOf('hr_interview_responses').filter(byIdDelete);
        expect(unwind).toHaveLength(1);
        expect(allArgs(unwind[0], 'in')).toEqual([['id', [71, 72]]]);
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed CLEAR throws without completing the interview, logging or broadcasting', async () => {
        found();
        on('hr_interview_responses', { data: null, error: DB_ERR }, { op: 'delete' });
        await expect(saveInterviewResults('int-1', { finalScore: 2, interviewerId: 40 })).rejects.toThrow('Failed to save interview responses');
        expect(queriesOf('hr_interviews', 'update')).toHaveLength(0);
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed audit-log write throws before the broadcast', async () => {
        found();
        on('hr_application_logs', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(saveInterviewResults('int-1', { finalScore: 2, interviewerId: 40 })).rejects.toThrow('Failed to write application log');
        expect(h.broadcasts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe('interview templates', () => {
    it('list: id/name/description only, questions left for the detail read', async () => {
        on('hr_interview_templates', { data: [{ id: 1, name: 'Std', description: 'd' }], error: null });
        expect(await getHRInterviewTemplates()).toEqual([{ id: 1, name: 'Std', description: 'd', questions: [] }]);
        expect(selectOf(queriesOf('hr_interview_templates')[0])).toBe('id, name, description');
    });

    it('list: [] before migration (42P01) or on a null payload; throws on any other error', async () => {
        on('hr_interview_templates', { data: null, error: { code: '42P01', message: 'x' } }, { once: true });
        expect(await getHRInterviewTemplates()).toEqual([]);
        on('hr_interview_templates', { data: null, error: null }, { once: true });
        expect(await getHRInterviewTemplates()).toEqual([]);
        on('hr_interview_templates', { data: null, error: { code: '08006', message: 'x' } }, { once: true });
        await expect(getHRInterviewTemplates()).rejects.toThrow('Failed to get templates');
    });

    it('detail: one template with its questions, mapped', async () => {
        on('hr_interview_templates', { data: { id: 1, name: 'Std', description: 'd', questions: [{ id: 7, template_id: 1, question_text: 'Why?', order_index: 1 }] }, error: null });
        const out = await getHRInterviewTemplateDetails(1);
        const q = queriesOf('hr_interview_templates')[0];
        expect(selectOf(q)).toBe('id, name, description, questions:hr_interview_questions(id, template_id, question_text, order_index)');
        expect(allArgs(q, 'eq')).toEqual([['id', 1]]);
        expect(out).toEqual({ id: 1, name: 'Std', description: 'd', questions: [{ id: 7, templateId: 1, questionText: 'Why?', orderIndex: 1 }] });
    });

    it('detail: throws on a read error', async () => {
        on('hr_interview_templates', { data: null, error: { code: 'PGRST116', message: 'no rows' } });
        await expect(getHRInterviewTemplateDetails(1)).rejects.toThrow('Failed to get template details');
    });

    it('create: inserts the template, then its ordered questions, broadcasts, returns the mapped template', async () => {
        on('hr_interview_templates', { data: { id: 5, name: 'Pilot', description: 'flight' }, error: null }, { op: 'insert' });
        const out = await createInterviewTemplate({ name: 'Pilot', description: 'flight', questions: ['Q1', 'Q2'] });
        const ins = queriesOf('hr_interview_templates', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual({ name: 'Pilot', description: 'flight' });
        expect(selectOf(ins)).toBe('id, name, description');
        expect(argsOf(queriesOf('hr_interview_questions', 'insert')[0], 'insert')?.[0]).toEqual([
            { template_id: 5, question_text: 'Q1', order_index: 1 }, { template_id: 5, question_text: 'Q2', order_index: 2 },
        ]);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['templates'] } }]);
        expect(out).toEqual({ id: 5, name: 'Pilot', description: 'flight', questions: [
            { id: 0, templateId: 5, questionText: 'Q1', orderIndex: 1 }, { id: 1, templateId: 5, questionText: 'Q2', orderIndex: 2 },
        ] });
    });

    it('create: a template with NO questions field succeeds instead of crashing after the insert', async () => {
        // Regression: the return path used `payload.questions!.map`, so a create without
        // questions committed the row + broadcast and then threw a TypeError (500).
        on('hr_interview_templates', { data: { id: 6, name: 'Blank', description: null }, error: null }, { op: 'insert' });
        await expect(createInterviewTemplate({ name: 'Blank' })).resolves.toEqual({ id: 6, name: 'Blank', description: null, questions: [] });
        expect(queriesOf('hr_interview_questions')).toHaveLength(0);
        await createInterviewTemplate({ name: 'Blank', questions: [] });
        expect(queriesOf('hr_interview_questions')).toHaveLength(0);
    });

    it('create: throws on an insert error or an empty insert, writing no questions', async () => {
        on('hr_interview_templates', { data: null, error: { code: 'x', message: 'x' } }, { op: 'insert', once: true });
        await expect(createInterviewTemplate({ name: 'x', questions: ['q'] })).rejects.toThrow('Failed to create template');
        on('hr_interview_templates', { data: null, error: null }, { op: 'insert', once: true });
        await expect(createInterviewTemplate({ name: 'x', questions: ['q'] })).rejects.toThrow('Failed to create template');
        expect(queriesOf('hr_interview_questions')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('create: a failed QUESTIONS insert unwinds the new template and throws without broadcasting', async () => {
        on('hr_interview_templates', { data: { id: 5, name: 'Pilot', description: 'flight' }, error: null }, { op: 'insert' });
        on('hr_interview_questions', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(createInterviewTemplate({ name: 'Pilot', questions: ['Q1'] })).rejects.toThrow('Failed to save template questions');
        const unwind = queriesOf('hr_interview_templates', 'delete');
        expect(unwind).toHaveLength(1);
        expect(allArgs(unwind[0], 'in')).toEqual([['id', [5]]]);
        expect(h.errors).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);

        // …and a failed unwind is logged, the questions error still surfacing.
        h.queries = [];
        on('hr_interview_templates', { data: null, error: { code: '08006', message: 'reset' } }, { op: 'delete' });
        await expect(createInterviewTemplate({ name: 'Pilot', questions: ['Q1'] })).rejects.toThrow('Failed to save template questions');
        expect(h.errors.map(e => (e[1] as Record<string, unknown>).table)).toEqual(['hr_interview_templates']);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('update: verifies existence, updates, replaces the questions (new rows FIRST), broadcasts', async () => {
        on('hr_interview_templates', { data: null, error: null, count: 1 }, { op: 'select' });
        on('hr_interview_questions', { data: [{ id: 31 }], error: null }, { op: 'insert' });
        await updateInterviewTemplate({ id: 5, name: 'Pilot v2', description: 'd2', questions: ['A'] });
        const exists = queriesOf('hr_interview_templates', 'select')[0];
        expect(argsOf(exists, 'select')).toEqual(['id', { count: 'exact', head: true }]);
        expect(allArgs(exists, 'eq')).toEqual([['id', 5]]);
        const upd = queriesOf('hr_interview_templates', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ name: 'Pilot v2', description: 'd2' });
        expect(allArgs(upd, 'eq')).toEqual([['id', 5]]);
        const ins = queriesOf('hr_interview_questions', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual([{ template_id: 5, question_text: 'A', order_index: 1 }]);
        expect(selectOf(ins)).toBe('id');
        const del = queriesOf('hr_interview_questions', 'delete');
        expect(del).toHaveLength(1);
        expect(allArgs(del[0], 'eq')).toEqual([['template_id', 5]]);
        expect(allArgs(del[0], 'lt')).toEqual([['id', 31]]);
        expect(allArgs(del[0], 'not')).toEqual([]);
        expect(seq(ins)).toBeLessThan(seq(del[0]));
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['templates'] } }]);
    });

    it('update: no questions → cleared, none inserted', async () => {
        on('hr_interview_templates', { data: null, error: null, count: 1 }, { op: 'select' });
        await updateInterviewTemplate({ id: 5, name: 'n' });
        expect(queriesOf('hr_interview_questions', 'delete')).toHaveLength(1);
        expect(allArgs(queriesOf('hr_interview_questions', 'delete')[0], 'eq')).toEqual([['template_id', 5]]);
        expect(allArgs(queriesOf('hr_interview_questions', 'delete')[0], 'lt')).toEqual([]);
        expect(allArgs(queriesOf('hr_interview_questions', 'delete')[0], 'not')).toEqual([]);
        expect(queriesOf('hr_interview_questions', 'insert')).toHaveLength(0);
    });

    it('update: a failed questions INSERT keeps the old questions (no delete) and throws without broadcasting', async () => {
        on('hr_interview_templates', { data: null, error: null, count: 1 }, { op: 'select' });
        on('hr_interview_questions', { data: null, error: DB_ERR }, { op: 'insert' });
        await expect(updateInterviewTemplate({ id: 5, name: 'n', questions: ['A', 'B'] })).rejects.toThrow('Failed to save template questions');
        expect(queriesOf('hr_interview_questions', 'delete')).toHaveLength(0);
        expect(h.errors).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('update: a failed superseded-questions DELETE unwinds the new rows by id and throws', async () => {
        on('hr_interview_templates', { data: null, error: null, count: 1 }, { op: 'select' });
        on('hr_interview_questions', { data: [{ id: 31 }, { id: 32 }], error: null }, { op: 'insert' });
        on('hr_interview_questions', { data: null, error: DB_ERR }, { op: 'delete', when: byParentDelete });
        await expect(updateInterviewTemplate({ id: 5, name: 'n', questions: ['A', 'B'] })).rejects.toThrow('Failed to save template questions');
        expect(allArgs(queriesOf('hr_interview_questions').find(byIdDelete), 'in')).toEqual([['id', [31, 32]]]);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('update: a failed CLEAR throws without broadcasting', async () => {
        on('hr_interview_templates', { data: null, error: null, count: 1 }, { op: 'select' });
        on('hr_interview_questions', { data: null, error: DB_ERR }, { op: 'delete' });
        await expect(updateInterviewTemplate({ id: 5, name: 'n' })).rejects.toThrow('Failed to save template questions');
        expect(h.broadcasts).toHaveLength(0);
    });

    it('update: a missing template is refused before any write; an update error throws before the questions', async () => {
        on('hr_interview_templates', { data: null, error: null, count: 0 }, { op: 'select', once: true });
        await expect(updateInterviewTemplate({ id: 5, name: 'n', questions: ['A'] })).rejects.toThrow('Template not found');
        expect(queriesOf('hr_interview_templates', 'update')).toHaveLength(0);
        on('hr_interview_templates', { data: null, error: null, count: 1 }, { op: 'select' });
        on('hr_interview_templates', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update' });
        await expect(updateInterviewTemplate({ id: 5, name: 'n', questions: ['A'] })).rejects.toThrow('Failed to update template');
        expect(queriesOf('hr_interview_questions')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('delete: removes by id and broadcasts the templates slice', async () => {
        await deleteInterviewTemplate(5);
        expect(allArgs(queriesOf('hr_interview_templates', 'delete')[0], 'eq')).toEqual([['id', 5]]);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['templates'] } }]);
    });

    it('delete: a blocked delete (e.g. a foreign key) throws and does NOT broadcast a template that still exists', async () => {
        on('hr_interview_templates', { data: null, error: DB_ERR }, { op: 'delete' });
        await expect(deleteInterviewTemplate(5)).rejects.toThrow('Failed to delete template');
        expect(h.broadcasts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Job postings
// ---------------------------------------------------------------------------

describe('job postings', () => {
    const JOB_SELECT = 'id, title, department, description, requirements, status, created_at, position_id, position:personnel_positions(id, name, description, icon, department)';

    it('list: explicit columns + position embed, newest first, mapped', async () => {
        on('hr_job_postings', { data: [{ id: 'j1', title: 'Medic', department: 'Med', description: 'd', requirements: ['r'], status: 'Open', created_at: 'c', position_id: 9, position: { id: 9, name: 'Medic' } }], error: null });
        const out = await getJobPostings();
        const q = queriesOf('hr_job_postings')[0];
        expect(selectOf(q)).toBe(JOB_SELECT);
        expect(argsOf(q, 'order')).toEqual(['created_at', { ascending: false }]);
        expect(out).toEqual([{ id: 'j1', title: 'Medic', department: 'Med', description: 'd', requirements: ['r'], status: 'Open', createdAt: 'c', positionId: 9,
            position: { id: 9, name: 'Medic', description: undefined, icon: undefined, department: undefined } }]);
    });

    it('list: fails closed to [] on a read error', async () => {
        on('hr_job_postings', { data: null, error: { code: '08006', message: 'x' } });
        expect(await getJobPostings()).toEqual([]);
    });

    it('create: inserts with Open as the default status and the creator, returns the mapped posting', async () => {
        on('hr_job_postings', { data: { id: 'j2', title: 'Pilot', status: 'Open', position_id: 3 }, error: null }, { op: 'insert' });
        const out = await createJobPosting({ title: 'Pilot', department: 'Air', description: 'fly', requirements: ['A'], userId: 40, positionId: 3 });
        const ins = queriesOf('hr_job_postings', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual({ title: 'Pilot', department: 'Air', description: 'fly', requirements: ['A'], status: 'Open', created_by_id: 40, position_id: 3 });
        expect(selectOf(ins)).toBe(JOB_SELECT);
        expect(out).toMatchObject({ id: 'j2', title: 'Pilot', status: 'Open', positionId: 3 });
        h.queries = [];
        await createJobPosting({ title: 'Pilot', status: 'Closed' });
        expect((argsOf(queriesOf('hr_job_postings', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).status).toBe('Closed');
    });

    it('create: throws on an insert error', async () => {
        on('hr_job_postings', { data: null, error: { code: 'x', message: 'x' } }, { op: 'insert' });
        await expect(createJobPosting({ title: 'x' })).rejects.toThrow('Failed to create job posting');
    });

    it('update / status / delete: scoped to the id, each throws on its error', async () => {
        await updateJobPosting({ id: 'j1', title: 'T', department: 'D', description: 'Ds', requirements: [], status: 'Open', positionId: 2 });
        const upd = queriesOf('hr_job_postings', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ title: 'T', department: 'D', description: 'Ds', requirements: [], status: 'Open', position_id: 2 });
        expect(allArgs(upd, 'eq')).toEqual([['id', 'j1']]);

        await updateJobPostingStatus({ id: 'j1', status: 'Closed' });
        const st = queriesOf('hr_job_postings', 'update')[1];
        expect(argsOf(st, 'update')?.[0]).toEqual({ status: 'Closed' });
        expect(allArgs(st, 'eq')).toEqual([['id', 'j1']]);

        await deleteJobPosting('j1');
        expect(allArgs(queriesOf('hr_job_postings', 'delete')[0], 'eq')).toEqual([['id', 'j1']]);

        on('hr_job_postings', { data: null, error: { code: 'x', message: 'x' } });
        await expect(updateJobPosting({ id: 'j1' })).rejects.toThrow('Failed to update job posting');
        await expect(updateJobPostingStatus({ id: 'j1', status: 'Open' })).rejects.toThrow('Failed to update job status');
        await expect(deleteJobPosting('j1')).rejects.toThrow('Failed to delete job posting');
    });
});

// ---------------------------------------------------------------------------
// Personnel positions
// ---------------------------------------------------------------------------

describe('personnel positions', () => {
    const POS_COLS = 'id, name, description, icon, department, created_at';

    it('list: explicit columns ordered by name, mapped', async () => {
        on('personnel_positions', { data: [{ id: 2, name: 'Medic', description: 'heals', icon: 'fa-kit', department: 'Med' }], error: null });
        expect(await getPersonnelPositions()).toEqual([{ id: 2, name: 'Medic', description: 'heals', icon: 'fa-kit', department: 'Med' }]);
        const q = queriesOf('personnel_positions')[0];
        expect(selectOf(q)).toBe(POS_COLS);
        expect(argsOf(q, 'order')).toEqual(['name']);
    });

    it('list: [] before migration or on a null payload; throws on any other error', async () => {
        on('personnel_positions', { data: null, error: { code: '42P01', message: 'x' } }, { once: true });
        expect(await getPersonnelPositions()).toEqual([]);
        on('personnel_positions', { data: null, error: null }, { once: true });
        expect(await getPersonnelPositions()).toEqual([]);
        on('personnel_positions', { data: null, error: { code: '08006', message: 'x' } }, { once: true });
        await expect(getPersonnelPositions()).rejects.toThrow('Failed to get positions');
    });

    it('create: inserts name/description/icon only and returns the mapped row', async () => {
        on('personnel_positions', { data: { id: 3, name: 'Scout', description: 'd', icon: 'i', department: null }, error: null }, { op: 'insert' });
        const out = await createPersonnelPosition({ name: 'Scout', description: 'd', icon: 'i' });
        const ins = queriesOf('personnel_positions', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual({ name: 'Scout', description: 'd', icon: 'i' });
        expect(selectOf(ins)).toBe(POS_COLS);
        expect(out).toMatchObject({ id: 3, name: 'Scout' });
    });

    it('create: throws on an insert error', async () => {
        on('personnel_positions', { data: null, error: { code: 'x', message: 'x' } }, { op: 'insert' });
        await expect(createPersonnelPosition({ name: 'x' })).rejects.toThrow('Failed to create position');
    });

    it('update / delete: scoped to the id, each throws on its error', async () => {
        await updatePersonnelPosition({ id: 3, name: 'Scout II', description: 'd', icon: 'i' });
        const upd = queriesOf('personnel_positions', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ name: 'Scout II', description: 'd', icon: 'i' });
        expect(allArgs(upd, 'eq')).toEqual([['id', 3]]);
        await deletePersonnelPosition(3);
        expect(allArgs(queriesOf('personnel_positions', 'delete')[0], 'eq')).toEqual([['id', 3]]);

        on('personnel_positions', { data: null, error: { code: 'x', message: 'x' } });
        await expect(updatePersonnelPosition({ id: 3, name: 'x' })).rejects.toThrow('Failed to update position');
        await expect(deletePersonnelPosition(3)).rejects.toThrow('Failed to delete position');
    });
});
