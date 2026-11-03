import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/hr.ts replaceChildRows — the CONCURRENCY property, against a stateful fake.
//
// The unit pins in tests/cov-db-hr-finance-hr-interviews.test.ts fix the exact query
// shape (insert → delete `.eq(parent).lt('id', min(newIds))`). This file runs the
// three real entry points (interview panel, template questions, interview responses)
// against an in-memory table with identity ids and makes two saves on the SAME parent
// overlap: both inserts land, then both superseded-deletes run. It pins what the
// docstring promises:
//   - an overlap never leaves the parent with ZERO rows while both saves report
//     success (the exclusion delete it replaced — `.not('id','in',newIds)` — did:
//     each save's delete matched the other's new rows);
//   - the worst an overlap leaves is SURPLUS rows (interleaved id draws), which the
//     next save on that parent clears;
//   - ids below MAX(id) (an importer sequence reset that failed) leave surplus, never
//     a loss.

type Call = { method: string; args: unknown[] };

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    nextId: {} as Record<string, number>,
    /** Scripted id draws: the Nth insert into a table takes idPlan[table][N]. */
    idPlan: {} as Record<string, number[][]>,
    /** Hold superseded-deletes on `table` until `size` are waiting, then run them in arrival order. */
    gate: null as null | { table: string; size: number; held: Array<() => void> },
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    errors: [] as unknown[][],
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {}, warn: () => {},
        error: (...args: unknown[]) => { h.errors.push(args); },
        child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/db/common', () => {
    const matches = (row: Record<string, unknown>, filters: Call[]) => filters.every(({ method, args }) => {
        const [col, a, b] = args as [string, unknown, unknown];
        const v = row[col];
        if (method === 'eq') return v === a;
        if (method === 'lt') return typeof v === 'number' && typeof a === 'number' && v < a;
        if (method === 'in') return (a as unknown[]).includes(v);
        if (method === 'not' && a === 'in') {
            // PostgREST list literal "(1,2,3)" — evaluated so an exclusion delete can be
            // run against this fake too (the shape the id bound replaced).
            const list = String(b).replace(/^\(|\)$/g, '').split(',').filter(Boolean);
            return !list.includes(String(v));
        }
        throw new Error(`fake: unsupported filter ${method}`);
    });

    function execute(table: string, op: string, calls: Call[], terminal: string) {
        const rows = (h.tables[table] ??= []);
        const filters = calls.filter(c => ['eq', 'lt', 'in', 'not'].includes(c.method));
        const selectCall = calls.find(c => c.method === 'select');
        if (op === 'insert') {
            const input = calls.find(c => c.method === 'insert')!.args[0];
            const list = (Array.isArray(input) ? input : [input]) as Array<Record<string, unknown>>;
            const plan = h.idPlan[table]?.shift();
            h.nextId[table] ??= 1;
            const inserted = list.map((r, i) => {
                const id = plan ? plan[i] : h.nextId[table]++;
                const row = { ...r, id };
                rows.push(row);
                return row;
            });
            return { data: selectCall ? inserted.map(r => ({ id: r.id })) : null, error: null };
        }
        if (op === 'delete') {
            h.tables[table] = rows.filter(r => !matches(r, filters));
            return { data: null, error: null };
        }
        if (op === 'update') {
            const patch = calls.find(c => c.method === 'update')!.args[0] as Record<string, unknown>;
            for (const r of rows) if (matches(r, filters)) Object.assign(r, patch);
            return { data: null, error: null };
        }
        const hit = rows.filter(r => matches(r, filters));
        const opts = selectCall?.args[1] as { head?: boolean } | undefined;
        if (opts?.head) return { data: null, count: hit.length, error: null };
        const cols = String(selectCall?.args[0] ?? '').split(',').map(s => s.trim()).filter(Boolean);
        const project = (r: Record<string, unknown>) => Object.fromEntries(cols.map(c => [c, r[c]]));
        if (terminal === 'single') {
            return hit[0] ? { data: project(hit[0]), error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        }
        return { data: hit.map(project), error: null };
    }

    function builder(table: string) {
        let op = 'select';
        const calls: Call[] = [];
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'lt', 'in', 'not', 'insert', 'update', 'delete']) {
            b[m] = (...args: unknown[]) => {
                calls.push({ method: m, args });
                if (['insert', 'update', 'delete'].includes(m)) op = m;
                return b;
            };
        }
        const settle = (terminal: string) => {
            const run = () => execute(table, op, calls, terminal);
            const gate = h.gate;
            const supersededDelete = op === 'delete' && !calls.some(c => c.method === 'in');
            if (gate && gate.table === table && supersededDelete) {
                return new Promise((resolve) => {
                    gate.held.push(() => resolve(run()));
                    if (gate.held.length === gate.size) for (const release of gate.held.splice(0)) release();
                });
            }
            return Promise.resolve(run());
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('maybeSingle');
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('then').then(res, rej);
        return b;
    }

    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); return Promise.resolve(); },
        getSystemRoles: async () => ({}),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : data; } catch { return fallback; }
        },
    };
});

vi.mock('../lib/push', () => ({ sendPushToUsers: async () => {} }));
vi.mock('../lib/db/notifications', () => ({ createNotification: async () => null }));
vi.mock('../lib/db/users', () => ({ logHrPositionChange: async () => {}, promoteUserToMember: async () => {} }));

import { updateHRInterview, updateInterviewTemplate, saveInterviewResults } from '../lib/db/hr';

// ---- the three replaceChildRows entry points, as one table-driven shape ------

interface Target {
    name: string;
    table: 'hr_interview_panel' | 'hr_interview_questions' | 'hr_interview_responses';
    parentColumn: 'interview_id' | 'template_id';
    parentId: string | number;
    /** The column that tells one save's rows from another's. */
    marker: string;
    /** Run one save whose rows carry these marker values. */
    save: (values: Array<string | number>) => Promise<unknown>;
}

const TARGETS: Target[] = [
    {
        name: 'interview panel (updateHRInterview)',
        table: 'hr_interview_panel', parentColumn: 'interview_id', parentId: 'int-1', marker: 'user_id',
        save: (v) => updateHRInterview('int-1', { panelMemberIds: v as number[] }, 40),
    },
    {
        name: 'template questions (updateInterviewTemplate)',
        table: 'hr_interview_questions', parentColumn: 'template_id', parentId: 5, marker: 'question_text',
        save: (v) => updateInterviewTemplate({ id: 5, name: 'Std', questions: v as string[] }),
    },
    {
        name: 'interview responses (saveInterviewResults)',
        table: 'hr_interview_responses', parentColumn: 'interview_id', parentId: 'int-1', marker: 'response_body',
        save: (v) => saveInterviewResults('int-1', {
            finalScore: 7, isRecommended: true, interviewerId: 40,
            responses: (v as string[]).map((text, i) => ({ questionId: i + 1, text, score: 3 })),
        }),
    },
];

const SET_A: Record<string, Array<string | number>> = { user_id: [101, 102], question_text: ['A1', 'A2'], response_body: ['A1', 'A2'] };
const SET_B: Record<string, Array<string | number>> = { user_id: [201, 202], question_text: ['B1', 'B2'], response_body: ['B1', 'B2'] };
const SET_C: Record<string, Array<string | number>> = { user_id: [301, 302], question_text: ['C1', 'C2'], response_body: ['C1', 'C2'] };

/** Seed the parents plus two pre-existing child rows (ids 1, 2) on the target parent,
 *  and a row on ANOTHER parent that no save may touch. Sequence continues at 10. */
function seed(t: Target) {
    h.tables = {
        hr_interviews: [{ id: 'int-1', application_id: 'app-1', interviewer_id: 40, status: 'Scheduled' }],
        hr_interview_templates: [{ id: 5, name: 'Std', description: null }],
        hr_application_logs: [],
        [t.table]: [
            { id: 1, [t.parentColumn]: t.parentId, [t.marker]: 'old-1' },
            { id: 2, [t.parentColumn]: t.parentId, [t.marker]: 'old-2' },
            { id: 3, [t.parentColumn]: t.parentColumn === 'template_id' ? 6 : 'int-2', [t.marker]: 'other-parent' },
        ],
    };
    h.nextId = { [t.table]: 10, hr_application_logs: 1 };
}

const childRows = (t: Target) => (h.tables[t.table] ?? [])
    .filter(r => r[t.parentColumn] === t.parentId)
    .map(r => ({ id: r.id as number, value: r[t.marker] }))
    .sort((a, b) => a.id - b.id);
const markersOf = (t: Target) => childRows(t).map(r => r.value);

beforeEach(() => {
    h.tables = {};
    h.nextId = {};
    h.idPlan = {};
    h.gate = null;
    h.broadcasts = [];
    h.errors = [];
});

describe.each(TARGETS)('replaceChildRows under overlap — $name', (t) => {
    it('a single save replaces exactly the old set, leaving other parents alone', async () => {
        seed(t);
        await t.save(SET_A[t.marker]);
        expect(childRows(t)).toEqual([{ id: 10, value: SET_A[t.marker][0] }, { id: 11, value: SET_A[t.marker][1] }]);
        expect(h.tables[t.table].find(r => r.id === 3)?.[t.marker]).toBe('other-parent');
    });

    it('two overlapping saves BOTH succeed and the parent keeps one COMPLETE set — never zero rows', async () => {
        seed(t);
        // Both inserts land before either superseded-delete runs.
        h.gate = { table: t.table, size: 2, held: [] };
        const results = await Promise.allSettled([t.save(SET_A[t.marker]), t.save(SET_B[t.marker])]);
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);

        const rows = childRows(t);
        // The save whose insert drew the higher ids keeps its whole set; the old rows and
        // the other save's rows are gone. (Under the exclusion delete this was [].)
        expect(rows.map(r => r.id)).toEqual([12, 13]);
        const survivors = rows.map(r => r.value);
        expect([SET_A[t.marker], SET_B[t.marker]]).toContainEqual(survivors);
        expect(survivors).not.toContain('old-1');
        expect(h.tables[t.table].find(r => r.id === 3)?.[t.marker]).toBe('other-parent');
        expect(h.errors).toEqual([]);
        // Both saves reported success to their clients, each with its id-only signal.
        expect(h.broadcasts).toHaveLength(2);
        for (const b of h.broadcasts) expect(b.event).toBe('hr_update');
    });

    it('interleaved id draws leave SURPLUS rows (never an empty set), which the next save clears', async () => {
        seed(t);
        // The two multi-row inserts' identity draws interleave: first save gets 10 and 12,
        // second gets 11 and 13.
        h.idPlan = { [t.table]: [[10, 12], [11, 13]] };
        h.gate = { table: t.table, size: 2, held: [] };
        const results = await Promise.allSettled([t.save(SET_A[t.marker]), t.save(SET_B[t.marker])]);
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);

        // First save deleted < 10 (the old rows); second deleted < 11 (also row 10).
        // Rows 11 and 13 are the second save's complete set; row 12 is surplus.
        const rows = childRows(t);
        expect(rows.map(r => r.id)).toEqual([11, 12, 13]);
        const byId = Object.fromEntries(rows.map(r => [r.id, r.value]));
        const secondSet = [byId[11], byId[13]];
        expect([SET_A[t.marker], SET_B[t.marker]]).toContainEqual(secondSet);
        expect(markersOf(t)).not.toContain('old-1');

        // The next save on this parent clears the surplus and leaves exactly its own set.
        h.gate = null;
        h.nextId[t.table] = 14;
        await t.save(SET_C[t.marker]);
        expect(childRows(t)).toEqual([{ id: 14, value: SET_C[t.marker][0] }, { id: 15, value: SET_C[t.marker][1] }]);
    });

    it('rows ABOVE the sequence (an importer sequence reset that failed) survive as surplus — never a loss', async () => {
        seed(t);
        // Explicit-id rows from an import, above where the sequence still stands.
        h.tables[t.table].push(
            { id: 500, [t.parentColumn]: t.parentId, [t.marker]: 'imported-500' },
        );
        await t.save(SET_A[t.marker]);
        // The new set is complete; the imported row is surplus (above the bound), and the
        // pre-existing rows below the bound are gone.
        expect(childRows(t)).toEqual([
            { id: 10, value: SET_A[t.marker][0] }, { id: 11, value: SET_A[t.marker][1] }, { id: 500, value: 'imported-500' },
        ]);
    });
});

describe('the overlap still honours a requested-EMPTY set', () => {
    it('a clear that runs after a non-empty save\'s insert empties the parent — the serial outcome "save, then clear"', async () => {
        const t = TARGETS[0];
        seed(t);
        // The clear (`.eq(parent)` only, no id bound) is held by the gate like a
        // superseded-delete, so the non-empty save's insert lands first and both deletes
        // then run. The only empty outcome is the one a caller asked for.
        h.gate = { table: t.table, size: 2, held: [] };
        const results = await Promise.allSettled([t.save(SET_A[t.marker]), t.save([])]);
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(markersOf(t)).toEqual([]);
        expect(h.tables[t.table].find(r => r.id === 3)?.[t.marker]).toBe('other-parent');
    });
});
