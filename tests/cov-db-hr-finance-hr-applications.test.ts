import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/hr.ts — the APPLICATION side of the ATS: case files, their logs and vetting
// data, the hire cascade (Client→Member promotion, probation), the delete cascade, the
// recruiter assignment, job applications, job-approval position moves, transfers, and
// the getHRState bundle's per-viewer redaction.
//
// Complements tests/hrViewerRedaction.test.ts (pure redaction helpers),
// tests/hrVettingBulkMinimization.test.ts (vetting off the bulk list) and
// tests/hrEligibleOfficers.test.ts (picker RPCs). What this file pins: the exact
// queries and write payloads, the self-scope gate on filing (a non-recruiter can only
// file — and so only ever receives the Discord id — for their OWN handle), the
// fail-closed read fallbacks, the id/discriminator-only broadcasts (Security rule 4),
// and the push / inbox side effects.

type Call = { method: string; args: unknown[] };
type Q = { table: string; op: string; calls: Call[]; terminal: string };
type Res = { data?: unknown; error?: unknown; count?: number | null };
type Rule = { table: string; op?: string; when?: (q: Q) => boolean; res: Res | ((q: Q) => Res); once?: boolean };

const h = vi.hoisted(() => ({
    queries: [] as Q[],
    rules: [] as Rule[],
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    pushes: [] as Array<{ userIds: number[]; payload: Record<string, unknown> }>,
    notifications: [] as Array<{ userId: number; n: Record<string, unknown> }>,
    notificationError: null as null | Error,
    promoted: [] as number[],
    promoteError: null as null | Error,
    positionLogs: [] as unknown[][],
    warns: [] as unknown[][],
    errors: [] as unknown[][],
    sysRoles: {} as Record<string, { id: number } | undefined>,
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
        getSystemRoles: async () => h.sysRoles,
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

vi.mock('../lib/db/notifications', () => ({
    createNotification: async (userId: number, n: Record<string, unknown>) => {
        if (h.notificationError) throw h.notificationError;
        h.notifications.push({ userId, n });
        return null;
    },
}));

vi.mock('../lib/db/users', () => ({
    logHrPositionChange: async (...args: unknown[]) => { h.positionLogs.push(args); },
    promoteUserToMember: async (userId: number) => {
        if (h.promoteError) throw h.promoteError;
        h.promoted.push(userId);
    },
}));

import {
    getHRApplications, getHRApplicationLogs, getApplicationVettingData, createHRApplication,
    updateApplicationStatus, updateApplicationData, deleteHRApplication, assignRecruiter,
    addApplicationLog, applyForJob, processJobApproval, processTransferRequest,
    getTransferRequests, getHRState, isHrStaff, isHrRecruiter, getEligibleHROfficers,
} from '../lib/db/hr';
import { ApplicationStatus } from '../types';
import { SecurityDenial } from '../lib/errors';

// ---- fake-supabase helpers -------------------------------------------------

const on = (table: string, res: Rule['res'], opts: { op?: string; when?: (q: Q) => boolean; once?: boolean } = {}) => {
    h.rules.push({ table, res, ...opts });
};
const queriesOf = (table: string, op?: string) => h.queries.filter(q => q.table === table && (!op || q.op === op));
const argsOf = (q: Q | undefined, method: string) => q?.calls.find(c => c.method === method)?.args;
const allArgs = (q: Q | undefined, method: string) => (q?.calls ?? []).filter(c => c.method === method).map(c => c.args);
const selectOf = (q: Q | undefined) => String(argsOf(q, 'select')?.[0] ?? '');
const selecting = (cols: string) => (q: Q) => selectOf(q) === cols;

const APP_COLS = 'id, applicant_name, applicant_discord_id, rsi_handle, status, referral_source, notes, assigned_recruiter_id, linked_user_id, created_at, vetting_data';

const appRow = (over: Record<string, unknown> = {}) => ({
    id: 'aaaa1111-2222-3333-4444-555566667777', applicant_name: 'Jane Recruit', applicant_discord_id: 'discord-123',
    rsi_handle: 'Jane_R', status: 'Applied', referral_source: 'WEBSITE_APPLICATION', notes: 'I fly Hornets',
    assigned_recruiter_id: 40, linked_user_id: 12, created_at: '2026-03-01T00:00:00Z',
    vetting_data: { verdict: 'clean' },
    ...over,
});

const RECRUITER = { id: 40, permissions: ['hr:view', 'hr:recruiter'], rsiHandle: 'Recruiter_40' };
const MEMBER = { id: 12, permissions: ['hr:view'], rsiHandle: 'Jane_R' };

/** Wires the notifyHRStaff fan-out: these role ids hold an HR perm; these users hold those roles. */
const seedHrStaff = (roleIds: number[], userIds: number[]) => {
    on('role_permissions', { data: roleIds.map(role_id => ({ role_id, permission: [{ name: 'hr:recruiter' }] })), error: null });
    on('users', { data: userIds.map(id => ({ id })), error: null }, { when: selecting('id') });
};

beforeEach(() => {
    h.queries = [];
    h.rules = [];
    h.broadcasts = [];
    h.pushes = [];
    h.notifications = [];
    h.notificationError = null;
    h.promoted = [];
    h.promoteError = null;
    h.positionLogs = [];
    h.warns = [];
    h.errors = [];
    h.sysRoles = {};
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('getHRApplications (bulk list)', () => {
    it('selects explicit columns + the recruiter embed, newest first with an id tie-break, capped at 200', async () => {
        on('hr_applications', { data: [], error: null });
        await getHRApplications();
        const q = queriesOf('hr_applications')[0];
        const sel = selectOf(q);
        expect(sel).not.toContain('*');
        expect(sel).toContain('assignedRecruiter:users!hr_applications_assigned_recruiter_id_fkey(id, name, avatar_url, role_id, rsi_handle)');
        expect(allArgs(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argsOf(q, 'limit')).toEqual([200]);
    });

    it('maps every row and blanks vettingData on all of them', async () => {
        on('hr_applications', {
            data: [appRow({ assignedRecruiter: { id: 40, name: 'Rec', avatar_url: null, role_id: 2, rsi_handle: 'rec' } }), appRow({ id: 'b', vetting_data: null })],
            error: null,
        });
        const out = await getHRApplications();
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({
            id: appRow().id, applicantName: 'Jane Recruit', applicantDiscordId: 'discord-123', rsiHandle: 'Jane_R',
            status: 'Applied', referralSource: 'WEBSITE_APPLICATION', assignedRecruiterId: 40, linkedUserId: 12,
            assignedRecruiter: { id: 40, name: 'Rec' }, interviews: [], logs: [],
        });
        expect(out.every(a => a.vettingData === undefined)).toBe(true);
    });

    it('fails closed to an empty list on a read error', async () => {
        on('hr_applications', { data: null, error: { code: '08006', message: 'reset' } });
        expect(await getHRApplications()).toEqual([]);
    });
});

describe('getHRApplicationLogs', () => {
    it('reads one application\'s logs newest-first and maps them with a minimised author', async () => {
        on('hr_application_logs', {
            data: [
                { id: 1, application_id: 'app-1', user_id: 40, action_type: 'NOTE', message: 'called them', created_at: 't1',
                    user: { id: 40, name: 'Rec', avatar_url: null, role_id: 2, rsi_handle: 'rec', discord_id: 'secret-discord' } },
                { id: 2, application_id: 'app-1', user_id: null, action_type: 'STATUS_CHANGE', message: 'm', created_at: 't0', user: null },
            ],
            error: null,
        });
        const out = await getHRApplicationLogs('app-1');
        const q = queriesOf('hr_application_logs')[0];
        expect(selectOf(q)).toBe('id, application_id, user_id, action_type, message, created_at, user:users(id, name, avatar_url, role_id, rsi_handle)');
        expect(allArgs(q, 'eq')).toEqual([['application_id', 'app-1']]);
        expect(argsOf(q, 'order')).toEqual(['created_at', { ascending: false }]);
        expect(out[0]).toMatchObject({ id: 1, applicationId: 'app-1', userId: 40, actionType: 'NOTE', message: 'called them', createdAt: 't1' });
        expect(out[0].user).toMatchObject({ id: 40, name: 'Rec' });
        // The embedded author is a minimised projection — no Discord id rides along.
        expect(JSON.stringify(out[0].user)).not.toContain('secret-discord');
        expect(out[1].user).toBeUndefined();
    });

    it('fails closed to [] on a read error', async () => {
        on('hr_application_logs', { data: null, error: { code: '42501', message: 'denied' } });
        expect(await getHRApplicationLogs('app-1')).toEqual([]);
    });
});

describe('getApplicationVettingData', () => {
    it('reads ONLY vetting_data for one id', async () => {
        on('hr_applications', { data: { vetting_data: { verdict: 'clean' } }, error: null });
        expect(await getApplicationVettingData('app-1')).toEqual({ verdict: 'clean' });
        const q = queriesOf('hr_applications')[0];
        expect(selectOf(q)).toBe('vetting_data');
        expect(allArgs(q, 'eq')).toEqual([['id', 'app-1']]);
        expect(q.terminal).toBe('maybeSingle');
    });

    it('returns null for an absent application and throws on a read error', async () => {
        on('hr_applications', { data: null, error: null }, { once: true });
        expect(await getApplicationVettingData('missing')).toBeNull();
        on('hr_applications', { data: null, error: { code: '08006', message: 'x' } });
        await expect(getApplicationVettingData('app-1')).rejects.toThrow('Failed to get application vetting data');
    });
});

// ---------------------------------------------------------------------------
// createHRApplication — validation, self-scope, filing, notify
// ---------------------------------------------------------------------------

describe('createHRApplication — input validation runs before any query', () => {
    it('rejects an over-long statement', async () => {
        await expect(createHRApplication({ rsiHandle: 'Jane_R', notes: 'x'.repeat(5001), user: RECRUITER }))
            .rejects.toThrow('Statement is too long.');
        expect(h.queries).toHaveLength(0);
    });

    it('accepts a statement at exactly the cap', async () => {
        on('hr_applications', { data: appRow(), error: null }, { op: 'insert' });
        await expect(createHRApplication({ rsiHandle: 'Jane_R', notes: 'x'.repeat(5000), user: RECRUITER })).resolves.toBeTruthy();
    });

    it('rejects a handle carrying LIKE metacharacters / spaces / nothing', async () => {
        for (const rsiHandle of ['jane%', 'jane r', '', 'a*b', undefined as unknown as string]) {
            await expect(createHRApplication({ rsiHandle, user: RECRUITER })).rejects.toThrow('That is not a valid RSI handle.');
        }
        expect(h.queries).toHaveLength(0);
    });
});

describe('createHRApplication — SELF-SCOPE for non-recruiters', () => {
    it('denies a non-recruiter filing for someone else\'s handle with an audited SecurityDenial', async () => {
        const err = await createHRApplication({ rsiHandle: 'Victim_Handle', userId: 12, user: MEMBER }).catch(e => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('You can only file an application for your own RSI handle.');
        expect(err.auditEvent).toBe('authz.self_scope.denied');
        expect(err.fields).toEqual({ userId: 12 });
        expect(err.status).toBe(403);
        expect(h.queries).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('denies a caller with no handle of their own, and a missing actor, before any lookup', async () => {
        await expect(createHRApplication({ rsiHandle: 'Jane_R', user: { permissions: ['hr:view'] } })).rejects.toBeInstanceOf(SecurityDenial);
        await expect(createHRApplication({ rsiHandle: 'Jane_R', user: { permissions: ['hr:view'], rsiHandle: 'bad handle' } })).rejects.toBeInstanceOf(SecurityDenial);
        await expect(createHRApplication({ rsiHandle: 'Jane_R' })).rejects.toBeInstanceOf(SecurityDenial);
        // A role NAME is not a permission.
        await expect(createHRApplication({ rsiHandle: 'Jane_R', user: { role: 'Admin', rsiHandle: 'Someone' } })).rejects.toBeInstanceOf(SecurityDenial);
        expect(h.queries).toHaveLength(0);
    });

    it('lets a non-recruiter file for their OWN handle (case/whitespace-insensitive) — the Discord id returned is their own', async () => {
        on('users', { data: { id: 12, discord_id: 'discord-self', name: 'Jane' }, error: null }, { when: selecting('id, discord_id, name') });
        on('hr_applications', { data: appRow({ applicant_discord_id: 'discord-self', linked_user_id: 12 }), error: null }, { op: 'insert' });
        const out = await createHRApplication({ rsiHandle: 'JANE_R', userId: 12, user: { ...MEMBER, rsiHandle: ' jane_r ' } });
        const lookup = queriesOf('users').find(selecting('id, discord_id, name'));
        expect(argsOf(lookup, 'ilike')).toEqual(['rsi_handle', 'JANE\\_R']);
        expect(out?.applicantDiscordId).toBe('discord-self');
        expect(out?.linkedUserId).toBe(12);
    });

    it('a PADDED own handle passes self-scope AND is looked up + stored trimmed (it links to the filer)', async () => {
        on('users', { data: { id: 12, discord_id: 'discord-self', name: 'Jane' }, error: null }, { when: selecting('id, discord_id, name') });
        on('hr_applications', { data: appRow(), error: null }, { op: 'insert' });
        await createHRApplication({ rsiHandle: '  Jane_R ', userId: 12, user: MEMBER });
        expect(argsOf(queriesOf('users').find(selecting('id, discord_id, name')), 'ilike')).toEqual(['rsi_handle', 'Jane\\_R']);
        expect(argsOf(queriesOf('hr_applications', 'insert')[0], 'insert')?.[0]).toMatchObject({ rsi_handle: 'Jane_R', linked_user_id: 12 });
    });
});

describe('createHRApplication — filing', () => {
    it('recruiter filing for a REGISTERED handle: links the user, takes their profile name + discord id, escapes the LIKE lookup', async () => {
        on('users', { data: { id: 77, discord_id: 'discord-77', name: 'Profile Name' }, error: null }, { when: selecting('id, discord_id, name') });
        on('hr_applications', { data: appRow({ id: 'new-app', secret_future_column: 'must not ship' }), error: null }, { op: 'insert' });
        seedHrStaff([2], [40, 41]);
        h.sysRoles = { admin: { id: 1 } };

        const out = await createHRApplication({
            rsiHandle: 'Ace_Pilot', name: 'Typed Name', discordId: 'typed-discord', referral: 'WEBSITE_APPLICATION',
            notes: 'statement', userId: 40, user: RECRUITER,
        });

        const lookup = queriesOf('users').find(selecting('id, discord_id, name'));
        expect(argsOf(lookup, 'ilike')).toEqual(['rsi_handle', 'Ace\\_Pilot']);
        expect(lookup?.terminal).toBe('maybeSingle');

        const ins = queriesOf('hr_applications', 'insert')[0];
        expect(argsOf(ins, 'insert')?.[0]).toEqual({
            applicant_name: 'Profile Name', applicant_discord_id: 'discord-77', rsi_handle: 'Ace_Pilot',
            referral_source: 'WEBSITE_APPLICATION', notes: 'statement', linked_user_id: 77,
            // No explicit case officer → the filer.
            assigned_recruiter_id: 40,
        });
        expect(selectOf(ins)).toBe(APP_COLS);

        // Creation log, attributed to the filer.
        expect(argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0]).toEqual({
            application_id: 'new-app', user_id: 40, action_type: 'STATUS_CHANGE', message: 'Application received.',
        });

        // HR staff fan-out: HR-perm roles + the Admin role, live users only.
        const rp = queriesOf('role_permissions')[0];
        expect(selectOf(rp)).toBe('role_id, permission:permissions!inner(name)');
        expect(argsOf(rp, 'in')).toEqual(['permission.name', ['hr:recruiter', 'hr:manager', 'hr:admin']]);
        const staff = queriesOf('users').find(selecting('id'));
        expect(argsOf(staff, 'in')).toEqual(['role_id', [2, 1]]);
        expect(argsOf(staff, 'is')).toEqual(['deleted_at', null]);
        expect(h.pushes).toEqual([{
            userIds: [40, 41],
            payload: { title: 'New Case File', body: 'Application to Join filed for Profile Name', tag: 'hr-alert', data: { url: '/hr', applicationId: 'new-app' } },
        }]);

        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants'] } }]);

        // Allow-list mapped: no raw row columns, vetting blanked.
        expect(out).not.toHaveProperty('secret_future_column');
        expect(out).not.toHaveProperty('applicant_discord_id');
        expect(out?.vettingData).toBeUndefined();
        expect(out?.id).toBe('new-app');
    });

    it('a recruiter-filed PADDED handle is trimmed for the ilike lookup and the stored rsi_handle', async () => {
        on('users', { data: { id: 77, discord_id: 'discord-77', name: 'Profile Name' }, error: null }, { when: selecting('id, discord_id, name') });
        on('hr_applications', { data: appRow(), error: null }, { op: 'insert' });
        await createHRApplication({ rsiHandle: ' Ace_Pilot  ', userId: 40, user: RECRUITER });
        expect(argsOf(queriesOf('users').find(selecting('id, discord_id, name')), 'ilike')).toEqual(['rsi_handle', 'Ace\\_Pilot']);
        expect(argsOf(queriesOf('hr_applications', 'insert')[0], 'insert')?.[0]).toMatchObject({ rsi_handle: 'Ace_Pilot', linked_user_id: 77 });
    });

    it('a failed creation-log write UNWINDS the just-filed case file by id and rethrows — no HR fan-out, no broadcast', async () => {
        // The caller is told the filing failed, so the case file must not survive it: a
        // retry would otherwise file a duplicate next to the unlogged original.
        on('hr_applications', { data: appRow({ id: 'new-app' }), error: null }, { op: 'insert' });
        on('hr_application_logs', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert' });
        seedHrStaff([2], [40]);
        await expect(createHRApplication({ rsiHandle: 'Outsider', userId: 40, user: RECRUITER })).rejects.toThrow('Failed to write application log');
        const unwind = queriesOf('hr_applications', 'delete');
        expect(unwind).toHaveLength(1);
        // Exactly the row just inserted, by id — never a handle/linked-user scoped delete.
        expect(allArgs(unwind[0], 'in')).toEqual([['id', ['new-app']]]);
        expect(allArgs(unwind[0], 'eq')).toEqual([]);
        expect(h.queries.indexOf(unwind[0])).toBeGreaterThan(h.queries.indexOf(queriesOf('hr_application_logs', 'insert')[0]));
        expect(h.errors).toHaveLength(0);
        expect(queriesOf('role_permissions')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed UNWIND of the case file is logged (by application id, no applicant PII) and the log error still surfaces', async () => {
        on('hr_applications', { data: appRow({ id: 'new-app' }), error: null }, { op: 'insert' });
        on('hr_applications', { data: null, error: { code: '08006', message: 'connection reset' } }, { op: 'delete' });
        on('hr_application_logs', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert' });
        seedHrStaff([2], [40]);
        await expect(createHRApplication({ rsiHandle: 'Outsider', name: 'Out Sider', discordId: 'd-secret', userId: 40, user: RECRUITER }))
            .rejects.toThrow('Failed to write application log');
        expect(queriesOf('hr_applications', 'delete')).toHaveLength(1);
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0][0]).toBe('unwinding a failed HR write left rows behind');
        expect(h.errors[0][1]).toEqual({
            table: 'hr_applications', applicationId: 'new-app', err: { code: '08006', message: 'connection reset' },
        });
        expect(JSON.stringify(h.errors)).not.toMatch(/Outsider|Out Sider|d-secret/);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('an unattributed filing writes no log, so there is nothing to unwind', async () => {
        on('hr_applications', { data: appRow({ id: 'new-app' }), error: null }, { op: 'insert' });
        await createHRApplication({ rsiHandle: 'Outsider', user: RECRUITER });
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(queriesOf('hr_applications', 'delete')).toHaveLength(0);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants'] } }]);
    });

    it('UNREGISTERED handle: payload name, payload discord id (or "Unknown"), unlinked, explicit null case officer kept, no log without a filer id', async () => {
        on('users', { data: null, error: null }, { when: selecting('id, discord_id, name') });
        on('hr_applications', { data: appRow({ linked_user_id: null }), error: null }, { op: 'insert' });
        await createHRApplication({ rsiHandle: 'Outsider', name: 'Out Sider', assignedRecruiterId: null, user: RECRUITER });
        expect(argsOf(queriesOf('hr_applications', 'insert')[0], 'insert')?.[0]).toMatchObject({
            applicant_name: 'Out Sider', applicant_discord_id: 'Unknown', linked_user_id: null, assigned_recruiter_id: null,
        });
        expect(queriesOf('hr_application_logs')).toHaveLength(0);

        h.queries = [];
        await createHRApplication({ rsiHandle: 'Outsider', name: 'Out Sider', discordId: 'd-9', assignedRecruiterId: 41, userId: 40, user: RECRUITER });
        expect(argsOf(queriesOf('hr_applications', 'insert')[0], 'insert')?.[0]).toMatchObject({
            applicant_discord_id: 'd-9', assigned_recruiter_id: 41,
        });
    });

    it('notify: no HR roles and no Admin role → no member lookup, no push', async () => {
        on('role_permissions', { data: [], error: null });
        on('hr_applications', { data: appRow(), error: null }, { op: 'insert' });
        await createHRApplication({ rsiHandle: 'Outsider', user: RECRUITER });
        expect(queriesOf('users').some(selecting('id'))).toBe(false);
        expect(h.pushes).toHaveLength(0);
    });

    it('notify: a failed role lookup still reaches the Admin role; no live members → no push', async () => {
        on('role_permissions', { data: null, error: { code: '08006', message: 'x' } });
        on('users', { data: [], error: null }, { when: selecting('id') });
        h.sysRoles = { admin: { id: 1 } };
        on('hr_applications', { data: appRow(), error: null }, { op: 'insert' });
        await createHRApplication({ rsiHandle: 'Outsider', referral: 'Some_Thing', user: RECRUITER });
        expect(argsOf(queriesOf('users').find(selecting('id')), 'in')).toEqual(['role_id', [1]]);
        expect(h.pushes).toHaveLength(0);
    });

    it('notify: a null member payload means nobody to push to', async () => {
        on('role_permissions', { data: [{ role_id: 2 }], error: null });
        on('users', { data: null, error: null }, { when: selecting('id') });
        on('hr_applications', { data: appRow(), error: null }, { op: 'insert' });
        await createHRApplication({ rsiHandle: 'Outsider', user: RECRUITER });
        expect(h.pushes).toHaveLength(0);
    });

    it('throws on an insert error with no log, no push and no broadcast', async () => {
        on('hr_applications', { data: null, error: { code: '23502', message: 'null value' } }, { op: 'insert' });
        seedHrStaff([2], [40]);
        await expect(createHRApplication({ rsiHandle: 'Outsider', userId: 40, user: RECRUITER })).rejects.toThrow('Failed to file application');
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('an errorless empty insert returns null, skips log + notify, still broadcasts the slice', async () => {
        on('hr_applications', { data: null, error: null }, { op: 'insert' });
        seedHrStaff([2], [40]);
        expect(await createHRApplication({ rsiHandle: 'Outsider', userId: 40, user: RECRUITER })).toBeNull();
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants'] } }]);
    });
});

// ---------------------------------------------------------------------------
// updateApplicationStatus — log shapes + the hire cascade
// ---------------------------------------------------------------------------

describe('updateApplicationStatus — status flip and the decision log', () => {
    it('updates ONLY status + updated_at (never the initial-statement column) and logs status + rationale together', async () => {
        await updateApplicationStatus('app-1', ApplicationStatus.Screening, '  looks promising  ', 40);
        const upd = queriesOf('hr_applications', 'update')[0];
        const patch = argsOf(upd, 'update')?.[0] as Record<string, unknown>;
        expect(Object.keys(patch).sort()).toEqual(['status', 'updated_at']);
        expect(patch.status).toBe('Screening');
        expect(allArgs(upd, 'eq')).toEqual([['id', 'app-1']]);
        expect(argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0]).toEqual({
            application_id: 'app-1', user_id: 40, action_type: 'STATUS_CHANGE', message: 'Status updated to Screening — looks promising',
        });
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants'] } }]);
    });

    it('truncates a long rationale to 277 chars + ellipsis', async () => {
        await updateApplicationStatus('app-1', ApplicationStatus.OnHold, 'y'.repeat(400), 40);
        const msg = String((argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).message);
        expect(msg).toBe(`Status updated to On Hold — ${'y'.repeat(277)}...`);
    });

    it('logs the bare status when the rationale is blank or not a string', async () => {
        await updateApplicationStatus('app-1', ApplicationStatus.Rejected, '   ', 40);
        await updateApplicationStatus('app-1', ApplicationStatus.Rejected, undefined, 40);
        const msgs = queriesOf('hr_application_logs', 'insert').map(q => (argsOf(q, 'insert')?.[0] as Record<string, unknown>).message);
        expect(msgs).toEqual(['Status updated to Rejected', 'Status updated to Rejected']);
    });

    it('logs a recruiter NOTE when there is no status, and nothing for an empty note', async () => {
        await updateApplicationStatus('app-1', '' as ApplicationStatus, 'phoned applicant', 40);
        await updateApplicationStatus('app-1', '' as ApplicationStatus, '', 40);
        const logs = queriesOf('hr_application_logs', 'insert').map(q => argsOf(q, 'insert')?.[0]);
        expect(logs).toEqual([{ application_id: 'app-1', user_id: 40, action_type: 'NOTE', message: 'Recruiter note: phoned applicant' }]);
    });

    it('writes no log without an acting user', async () => {
        await updateApplicationStatus('app-1', ApplicationStatus.Screening, 'why');
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
    });

    it('throws on an update error with no log and no broadcast', async () => {
        on('hr_applications', { data: null, error: { code: '42501', message: 'denied' } }, { op: 'update' });
        await expect(updateApplicationStatus('app-1', ApplicationStatus.Screening, 'n', 40)).rejects.toThrow('Failed to update application');
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed decision-log write throws instead of broadcasting a silent success', async () => {
        on('hr_application_logs', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert' });
        await expect(updateApplicationStatus('app-1', ApplicationStatus.Screening, 'n', 40)).rejects.toThrow('Failed to write application log');
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('updateApplicationStatus — the HIRE cascade', () => {
    const CLIENT = 5, MEMBER_ROLE = 6;
    const hireWith = (opts: { linked?: number | null; roleId?: number; probationDays?: number | null; probErr?: boolean }) => {
        h.sysRoles = { client: { id: CLIENT }, member: { id: MEMBER_ROLE }, admin: { id: 1 } };
        on('hr_applications', { data: { linked_user_id: opts.linked ?? null, referral_source: 'NEW_USER' }, error: null },
            { op: 'select', when: selecting('linked_user_id, referral_source') });
        on('users', { data: { role_id: opts.roleId ?? CLIENT }, error: null }, { op: 'select', when: selecting('role_id') });
        on('settings', { data: opts.probationDays === null ? null : { value: { probationDays: opts.probationDays } }, error: null });
        if (opts.probErr) on('users', { data: null, error: { message: 'probation write failed' } }, { op: 'update' });
    };

    it('promotes a linked Client to Member, applies the configured probation window, broadcasts the hired user id', async () => {
        hireWith({ linked: 12, roleId: CLIENT, probationDays: 30 });
        await updateApplicationStatus('app-1', ApplicationStatus.Hired, 'welcome', 40);

        const appLookup = queriesOf('hr_applications', 'select')[0];
        expect(allArgs(appLookup, 'eq')).toEqual([['id', 'app-1']]);
        expect(allArgs(queriesOf('users', 'select').find(selecting('role_id')), 'eq')).toEqual([['id', 12]]);
        expect(h.promoted).toEqual([12]);

        const settings = queriesOf('settings')[0];
        expect(selectOf(settings)).toBe('value');
        expect(allArgs(settings, 'eq')).toEqual([['key', 'hrConfig']]);

        const prob = queriesOf('users', 'update')[0];
        const patch = argsOf(prob, 'update')?.[0] as { probation_start: string; probation_end: string };
        expect(allArgs(prob, 'eq')).toEqual([['id', 12]]);
        const days = (Date.parse(patch.probation_end) - Date.parse(patch.probation_start)) / 86_400_000;
        expect(Math.round(days)).toBe(30);

        expect(h.broadcasts).toEqual([
            { event: 'hr_update', payload: { slices: ['applicants'] } },
            { event: 'user_update', payload: { userId: 12 } },
        ]);
    });

    it('does not re-promote a user who is already above Client', async () => {
        hireWith({ linked: 12, roleId: MEMBER_ROLE, probationDays: 0 });
        await updateApplicationStatus('app-1', ApplicationStatus.Hired, undefined, 40);
        expect(h.promoted).toEqual([]);
        // probationDays 0 → no probation write.
        expect(queriesOf('users', 'update')).toHaveLength(0);
    });

    it('skips the promotion lookup entirely when the system roles are not resolved', async () => {
        hireWith({ linked: 12, probationDays: null });
        h.sysRoles = {};
        await updateApplicationStatus('app-1', ApplicationStatus.Hired, undefined, 40);
        expect(queriesOf('users', 'select').some(selecting('role_id'))).toBe(false);
        expect(h.promoted).toEqual([]);
        expect(queriesOf('users', 'update')).toHaveLength(0);
    });

    it('a failed auto-promotion is logged and the hire still completes (probation + broadcast)', async () => {
        hireWith({ linked: 12, roleId: CLIENT, probationDays: 14 });
        h.promoteError = new Error('promote blew up');
        await updateApplicationStatus('app-1', ApplicationStatus.Hired, undefined, 40);
        expect(h.warns.some(w => w[0] === 'hire auto-promote to member failed' && (w[1] as Record<string, unknown>).userId === 12)).toBe(true);
        expect(queriesOf('users', 'update')).toHaveLength(1);
        expect(h.broadcasts.at(-1)).toEqual({ event: 'user_update', payload: { userId: 12 } });
    });

    it('a failed probation write is logged, not thrown', async () => {
        hireWith({ linked: 12, roleId: MEMBER_ROLE, probationDays: 7, probErr: true });
        await expect(updateApplicationStatus('app-1', ApplicationStatus.Hired, undefined, 40)).resolves.toBeUndefined();
        expect(h.warns.some(w => w[0] === 'failed to set probation on user'
            && (w[1] as Record<string, unknown>).message === 'probation write failed')).toBe(true);
    });

    it('a hire with NO linked user warns that probation could not be applied, and broadcasts a full user refresh', async () => {
        hireWith({ linked: null, probationDays: 30 });
        await updateApplicationStatus('app-1', ApplicationStatus.Hired, undefined, 40);
        expect(h.promoted).toEqual([]);
        expect(queriesOf('users')).toHaveLength(0);
        expect(h.warns.some(w => /linked_user_id is null/.test(String(w[0])) && (w[1] as Record<string, unknown>).probationDays === 30)).toBe(true);
        expect(h.broadcasts).toEqual([
            { event: 'hr_update', payload: { slices: ['applicants'] } },
            { event: 'user_update', payload: {} },
        ]);
    });

    it('a hire with no linked user and no probation configured stays quiet', async () => {
        hireWith({ linked: null, probationDays: null });
        await updateApplicationStatus('app-1', ApplicationStatus.Hired, undefined, 40);
        expect(h.warns).toHaveLength(0);
    });
});

describe('updateApplicationData (vetting write)', () => {
    it('writes vetting_data only, scoped to the id, and broadcasts the applicants slice', async () => {
        await updateApplicationData('app-1', { verdict: 'flagged' });
        const q = queriesOf('hr_applications', 'update')[0];
        expect(argsOf(q, 'update')?.[0]).toEqual({ vetting_data: { verdict: 'flagged' } });
        expect(allArgs(q, 'eq')).toEqual([['id', 'app-1']]);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants'] } }]);
    });

    it('throws on an update error without broadcasting', async () => {
        on('hr_applications', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update' });
        await expect(updateApplicationData('app-1', {})).rejects.toThrow('Failed to update application data');
        expect(h.broadcasts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// deleteHRApplication — cascade scoping
// ---------------------------------------------------------------------------

describe('deleteHRApplication', () => {
    const appLookup = (app: Record<string, unknown> | null, error: unknown = null) =>
        on('hr_applications', { data: app, error }, { op: 'select' });

    it('refuses (no deletes) when the application is missing or the lookup errors', async () => {
        appLookup(null);
        await expect(deleteHRApplication('gone')).rejects.toThrow('Application not found or access denied.');
        h.rules = [];
        appLookup({ linked_user_id: 12, referral_source: 'INTERNAL_TRANSFER' }, { code: 'x', message: 'x' });
        await expect(deleteHRApplication('gone')).rejects.toThrow('Application not found or access denied.');
        expect(h.queries.filter(q => q.op === 'delete')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('INTERNAL_TRANSFER: deletes only the linked user\'s PENDING transfers, then the application', async () => {
        appLookup({ linked_user_id: 12, referral_source: 'INTERNAL_TRANSFER' });
        await deleteHRApplication('app-1');
        expect(selectOf(queriesOf('hr_applications', 'select')[0])).toBe('linked_user_id, referral_source');
        const tr = queriesOf('hr_transfer_requests', 'delete');
        expect(tr).toHaveLength(1);
        expect(allArgs(tr[0], 'eq')).toEqual([['user_id', 12], ['status', 'Pending']]);
        expect(queriesOf('hr_job_applications')).toHaveLength(0);
        expect(allArgs(queriesOf('hr_applications', 'delete')[0], 'eq')).toEqual([['id', 'app-1']]);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants', 'transfers'] } }]);
    });

    it.each(['INTERNAL_JOB', 'Internal Application: Pilot', 'Job: Medic'])(
        'job-sourced (%s): deletes only the linked user\'s PENDING job applications', async (referral_source) => {
            appLookup({ linked_user_id: 12, referral_source });
            await deleteHRApplication('app-1');
            const ja = queriesOf('hr_job_applications', 'delete');
            expect(ja).toHaveLength(1);
            expect(allArgs(ja[0], 'eq')).toEqual([['applicant_id', 12], ['status', 'Pending']]);
            expect(queriesOf('hr_transfer_requests')).toHaveLength(0);
        });

    it('no cascade for other referral sources, or for an application with no linked user', async () => {
        appLookup({ linked_user_id: 12, referral_source: 'WEBSITE_APPLICATION' }, null);
        await deleteHRApplication('app-1');
        h.rules = [];
        appLookup({ linked_user_id: 12, referral_source: null });
        await deleteHRApplication('app-1');
        h.rules = [];
        appLookup({ linked_user_id: null, referral_source: 'INTERNAL_TRANSFER' });
        await deleteHRApplication('app-1');
        expect(queriesOf('hr_transfer_requests')).toHaveLength(0);
        expect(queriesOf('hr_job_applications')).toHaveLength(0);
        expect(queriesOf('hr_applications', 'delete')).toHaveLength(3);
    });

    it('throws on a delete error without broadcasting', async () => {
        appLookup({ linked_user_id: null, referral_source: null });
        on('hr_applications', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'delete' });
        await expect(deleteHRApplication('app-1')).rejects.toThrow('Failed to delete application');
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed TRANSFER cascade throws and keeps the case file (no application delete, no broadcast)', async () => {
        appLookup({ linked_user_id: 12, referral_source: 'INTERNAL_TRANSFER' });
        on('hr_transfer_requests', { data: null, error: { code: '42501', message: 'denied' } }, { op: 'delete' });
        await expect(deleteHRApplication('app-1')).rejects.toThrow('Failed to clean up linked transfer requests');
        expect(queriesOf('hr_applications', 'delete')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed JOB-APPLICATION cascade throws and keeps the case file (no application delete, no broadcast)', async () => {
        appLookup({ linked_user_id: 12, referral_source: 'Job: Medic' });
        on('hr_job_applications', { data: null, error: { code: '42501', message: 'denied' } }, { op: 'delete' });
        await expect(deleteHRApplication('app-1')).rejects.toThrow('Failed to clean up linked job applications');
        expect(queriesOf('hr_applications', 'delete')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// assignRecruiter / addApplicationLog
// ---------------------------------------------------------------------------

describe('assignRecruiter', () => {
    const APP_ID = 'abcd1234-0000-0000-0000-000000000000';

    it('sets the case officer, logs it by name, sends an inbox notification (no raw push), broadcasts the slice', async () => {
        on('users', { data: { name: 'Officer Kay' }, error: null }, { when: selecting('name') });
        await assignRecruiter(APP_ID, 41, 40);
        const upd = queriesOf('hr_applications', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ assigned_recruiter_id: 41 });
        expect(allArgs(upd, 'eq')).toEqual([['id', APP_ID]]);
        expect(allArgs(queriesOf('users')[0], 'eq')).toEqual([['id', 41]]);
        expect(argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0]).toEqual({
            application_id: APP_ID, user_id: 40, action_type: 'ASSIGNMENT', message: 'Assigned to Officer Kay',
        });
        expect(h.notifications).toEqual([{
            userId: 41,
            n: { type: 'hr_assignment', title: 'Case Assignment', body: 'You have been assigned to Case File ABCD1234.', link: 'hr', metadata: { applicationId: APP_ID } },
        }]);
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants'] } }]);
    });

    it('falls back to "recruiter" when the officer lookup finds nobody, and survives a failed notification', async () => {
        h.notificationError = new Error('inbox down');
        await assignRecruiter(APP_ID, 41, 40);
        expect((argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0] as Record<string, unknown>).message).toBe('Assigned to recruiter');
        expect(h.broadcasts).toHaveLength(1);
    });

    it('throws on an update error before logging or notifying', async () => {
        on('hr_applications', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update' });
        await expect(assignRecruiter(APP_ID, 41, 40)).rejects.toThrow('Failed to assign recruiter');
        expect(queriesOf('hr_application_logs')).toHaveLength(0);
        expect(h.notifications).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('a failed assignment-log write throws before the inbox notification and the broadcast', async () => {
        on('hr_application_logs', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert' });
        await expect(assignRecruiter(APP_ID, 41, 40)).rejects.toThrow('Failed to write application log');
        expect(h.notifications).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('addApplicationLog', () => {
    it('inserts an attributed log row', async () => {
        await addApplicationLog('app-1', 'NOTE', 'hello', 40);
        expect(argsOf(queriesOf('hr_application_logs', 'insert')[0], 'insert')?.[0]).toEqual({
            application_id: 'app-1', user_id: 40, action_type: 'NOTE', message: 'hello',
        });
    });

    it('throws on an insert error instead of silently dropping the timeline entry', async () => {
        on('hr_application_logs', { data: null, error: { code: '23503', message: 'fk' } }, { op: 'insert' });
        await expect(addApplicationLog('app-1', 'NOTE', 'hello', 40)).rejects.toThrow('Failed to write application log');
    });

    it('writes nothing for an unattributed log', async () => {
        await addApplicationLog('app-1', 'NOTE', 'hello', null);
        await addApplicationLog('app-1', 'NOTE', 'hello', 0);
        expect(h.queries).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// applyForJob / processJobApproval
// ---------------------------------------------------------------------------

describe('applyForJob', () => {
    const seedJob = () => {
        on('hr_job_postings', { data: { title: 'Medic', position_id: 9 }, error: null });
        on('users', { data: { id: 12, name: 'Jane', discord_id: 'discord-12', rsi_handle: 'Jane_R' }, error: null },
            { when: selecting('id, name, discord_id, rsi_handle') });
    };

    it('rejects an over-long statement before any query', async () => {
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: 's'.repeat(5001) })).rejects.toThrow('Statement is too long.');
        expect(h.queries).toHaveLength(0);
    });

    it('throws "Job not found" on a missing posting or a lookup error', async () => {
        on('hr_job_postings', { data: null, error: null }, { once: true });
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: '' })).rejects.toThrow('Job not found');
        on('hr_job_postings', { data: { title: 'x' }, error: { code: 'x', message: 'x' } }, { once: true });
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: '' })).rejects.toThrow('Job not found');
        expect(queriesOf('hr_job_applications')).toHaveLength(0);
    });

    it('throws on a missing applicant or an applicant lookup error', async () => {
        on('hr_job_postings', { data: { title: 'Medic', position_id: 9 }, error: null });
        on('users', { data: null, error: null }, { once: true });
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: '' })).rejects.toThrow('User not found or access denied');
        on('users', { data: { id: 12 }, error: { code: 'x', message: 'x' } }, { once: true });
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: '' })).rejects.toThrow('User not found or access denied');
        const lookup = queriesOf('users')[0];
        expect(selectOf(lookup)).toBe('id, name, discord_id, rsi_handle');
        expect(allArgs(lookup, 'eq')).toEqual([['id', 12]]);
        expect(queriesOf('hr_job_applications')).toHaveLength(0);
    });

    it('a duplicate application maps to a friendly error; any other insert error is generic', async () => {
        seedJob();
        on('hr_job_applications', { data: null, error: { code: '23505', message: 'dup' } }, { once: true });
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: 'pick me' })).rejects.toThrow('You have already applied to this job.');
        on('hr_job_applications', { data: null, error: { code: '23503', message: 'fk' } }, { once: true });
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: 'pick me' })).rejects.toThrow('Failed to submit job application');
        expect(queriesOf('hr_applications')).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('records the job application, files the linked ATS case, notifies HR staff, broadcasts the applicants slice', async () => {
        seedJob();
        on('hr_applications', { data: { id: 'ats-1' }, error: null }, { op: 'insert' });
        seedHrStaff([2], [40]);
        await applyForJob({ jobId: 'j1', userId: 12, statement: 'pick me' });

        expect(allArgs(queriesOf('hr_job_postings')[0], 'eq')).toEqual([['id', 'j1']]);
        expect(selectOf(queriesOf('hr_job_postings')[0])).toBe('title, position_id');
        expect(argsOf(queriesOf('hr_job_applications', 'insert')[0], 'insert')?.[0]).toEqual({ job_id: 'j1', applicant_id: 12, statement: 'pick me' });
        const ats = queriesOf('hr_applications', 'insert')[0];
        expect(argsOf(ats, 'insert')?.[0]).toEqual({
            applicant_name: 'Jane', applicant_discord_id: 'discord-12', rsi_handle: 'Jane_R', status: 'Applied',
            referral_source: 'Internal Application: Medic', notes: 'pick me', linked_user_id: 12,
        });
        expect(selectOf(ats)).toBe('id');
        expect(h.pushes).toEqual([{
            userIds: [40],
            payload: { title: 'Job Application', body: 'Jane applied for Medic.', tag: 'hr-alert', data: { url: '/hr', applicationId: 'ats-1' } },
        }]);
        expect(h.broadcasts).toEqual([{ event: 'hr_update', payload: { slices: ['applicants'] } }]);
    });

    it('throws when the ATS record cannot be created, before notifying', async () => {
        seedJob();
        on('hr_applications', { data: null, error: { code: 'x', message: 'x' } }, { op: 'insert' });
        seedHrStaff([2], [40]);
        await expect(applyForJob({ jobId: 'j1', userId: 12, statement: 'pick me' })).rejects.toThrow('Failed to create ATS record');
        expect(h.pushes).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });
});

describe('processJobApproval', () => {
    const seed = (o: { app?: unknown; appErr?: unknown; jobApp?: unknown; jobAppErr?: unknown; job?: unknown; jobErr?: unknown; prior?: unknown; updErr?: unknown } = {}) => {
        on('hr_applications', { data: 'app' in o ? o.app : { linked_user_id: 12 }, error: o.appErr ?? null });
        on('hr_job_applications', { data: 'jobApp' in o ? o.jobApp : { job_id: 'j1' }, error: o.jobAppErr ?? null });
        on('hr_job_postings', { data: 'job' in o ? o.job : { position_id: 9 }, error: o.jobErr ?? null });
        on('users', { data: 'prior' in o ? o.prior : { position_id: 3 }, error: null }, { op: 'select' });
        on('users', { data: null, error: o.updErr ?? null }, { op: 'update' });
    };

    it('moves the linked user to the job\'s position, logs old→new, broadcasts their id', async () => {
        seed();
        await processJobApproval('app-1');
        expect(allArgs(queriesOf('hr_applications')[0], 'eq')).toEqual([['id', 'app-1']]);
        const ja = queriesOf('hr_job_applications')[0];
        expect(selectOf(ja)).toBe('job_id');
        expect(allArgs(ja, 'eq')).toEqual([['applicant_id', 12]]);
        expect(argsOf(ja, 'order')).toEqual(['created_at', { ascending: false }]);
        expect(argsOf(ja, 'limit')).toEqual([1]);
        expect(allArgs(queriesOf('hr_job_postings')[0], 'eq')).toEqual([['id', 'j1']]);
        const upd = queriesOf('users', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ position_id: 9 });
        expect(allArgs(upd, 'eq')).toEqual([['id', 12]]);
        expect(h.positionLogs).toEqual([[12, 3, 9]]);
        expect(h.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 12 } }]);
    });

    it('logs a null prior position when the user had none', async () => {
        seed({ prior: null });
        await processJobApproval('app-1');
        expect(h.positionLogs).toEqual([[12, null, 9]]);
    });

    it.each([
        ['missing application', { app: null }, 'Application not found or no linked user.'],
        ['application lookup error', { appErr: { code: 'x' } }, 'Application not found or no linked user.'],
        ['unlinked application', { app: { linked_user_id: null } }, 'Application not found or no linked user.'],
        ['no job application', { jobApp: null }, 'No linked job application found.'],
        ['job application error', { jobAppErr: { code: 'x' } }, 'No linked job application found.'],
        ['missing posting', { job: null }, 'Job posting not found or has no linked position.'],
        ['posting error', { jobErr: { code: 'x' } }, 'Job posting not found or has no linked position.'],
        ['posting without a position', { job: { position_id: null } }, 'Job posting not found or has no linked position.'],
    ])('refuses on %s without moving anyone', async (_label, o, msg) => {
        seed(o as Record<string, unknown>);
        await expect(processJobApproval('app-1')).rejects.toThrow(msg);
        expect(queriesOf('users', 'update')).toHaveLength(0);
        expect(h.positionLogs).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });

    it('throws on the position write error without logging history or broadcasting', async () => {
        seed({ updErr: { code: 'x', message: 'x' } });
        await expect(processJobApproval('app-1')).rejects.toThrow('Failed to update user position');
        expect(h.positionLogs).toHaveLength(0);
        expect(h.broadcasts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

describe('processTransferRequest', () => {
    it('records the decision; a non-approval moves nobody', async () => {
        await processTransferRequest('t1', 'Rejected', 'not now');
        const upd = queriesOf('hr_transfer_requests', 'update')[0];
        const patch = argsOf(upd, 'update')?.[0] as Record<string, unknown>;
        expect(patch).toMatchObject({ status: 'Rejected', admin_notes: 'not now' });
        expect(Object.keys(patch).sort()).toEqual(['admin_notes', 'status', 'updated_at']);
        expect(allArgs(upd, 'eq')).toEqual([['id', 't1']]);
        expect(queriesOf('users')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
    });

    it('an approval moves ONLY unit_id (never position) and pushes the member', async () => {
        on('hr_transfer_requests', { data: { user_id: 12, target_unit_id: 4 }, error: null }, { op: 'select' });
        await processTransferRequest('t1', 'Approved');
        const lookup = queriesOf('hr_transfer_requests', 'select')[0];
        expect(selectOf(lookup)).toBe('user_id, target_unit_id');
        expect(allArgs(lookup, 'eq')).toEqual([['id', 't1']]);
        const upd = queriesOf('users', 'update')[0];
        expect(argsOf(upd, 'update')?.[0]).toEqual({ unit_id: 4 });
        expect(allArgs(upd, 'eq')).toEqual([['id', 12]]);
        expect(h.pushes).toEqual([{ userIds: [12], payload: { title: 'Transfer Approved', body: 'Your transfer request has been approved.', tag: 'transfer-update' } }]);
    });

    it('an approval whose request vanished moves nobody', async () => {
        on('hr_transfer_requests', { data: null, error: null }, { op: 'select' });
        await processTransferRequest('t1', 'Approved');
        expect(queriesOf('users')).toHaveLength(0);
        expect(h.pushes).toHaveLength(0);
    });

    it('throws on the status write error, and on the unit write error (no push)', async () => {
        on('hr_transfer_requests', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update', once: true });
        await expect(processTransferRequest('t1', 'Approved')).rejects.toThrow('Failed to update transfer status');
        expect(queriesOf('users')).toHaveLength(0);
        on('hr_transfer_requests', { data: { user_id: 12, target_unit_id: 4 }, error: null }, { op: 'select' });
        on('users', { data: null, error: { code: 'x', message: 'x' } }, { op: 'update' });
        await expect(processTransferRequest('t1', 'Approved')).rejects.toThrow('Failed to update user unit assignment');
        expect(h.pushes).toHaveLength(0);
    });
});

describe('getTransferRequests', () => {
    it('selects explicit columns + user/unit embeds, newest first, capped at 100, and maps', async () => {
        on('hr_transfer_requests', {
            data: [{ id: 't1', user_id: 12, current_unit_id: 2, target_unit_id: 4, reason: 'closer to friends', status: 'Pending',
                admin_notes: 'officer note', created_at: 'c', updated_at: 'u',
                user: { id: 12, name: 'Jane', avatar_url: null, role_id: 6, rsi_handle: 'Jane_R' },
                targetUnit: { id: 4, name: 'Bravo', sort_order: 1 } }],
            error: null,
        });
        const out = await getTransferRequests();
        const q = queriesOf('hr_transfer_requests')[0];
        const sel = selectOf(q);
        expect(sel).not.toContain('*');
        expect(sel).toContain('user:users!hr_transfer_requests_user_id_fkey(id, name, avatar_url, role_id, rsi_handle)');
        expect(sel).toContain('targetUnit:units!hr_transfer_requests_target_unit_id_fkey(');
        expect(allArgs(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argsOf(q, 'limit')).toEqual([100]);
        expect(out[0]).toMatchObject({ id: 't1', userId: 12, currentUnitId: 2, targetUnitId: 4, reason: 'closer to friends',
            status: 'Pending', adminNotes: 'officer note', user: { id: 12, name: 'Jane' }, targetUnit: { id: 4, name: 'Bravo' } });
    });

    it('fails closed to [] on a read error', async () => {
        on('hr_transfer_requests', { data: null, error: { code: '08006', message: 'x' } });
        expect(await getTransferRequests()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// isHrStaff + the getHRState bundle
// ---------------------------------------------------------------------------

describe('isHrStaff', () => {
    it('is any of hr:recruiter / hr:manager / hr:admin — and nothing else', () => {
        expect(isHrStaff({ permissions: ['hr:manager'] })).toBe(true);
        expect(isHrStaff({ permissions: ['hr:admin'] })).toBe(true);
        expect(isHrStaff({ permissions: ['hr:recruiter'] })).toBe(true);
        expect(isHrStaff({ permissions: ['hr:view', 'hr:viewer'] })).toBe(false);
        expect(isHrStaff(null)).toBe(false);
        expect(isHrStaff(undefined)).toBe(false);
        expect(isHrStaff({ permissions: 'hr:admin' as unknown as string[] })).toBe(false);
        // hr:manager is staff but NOT a recruiter.
        expect(isHrRecruiter({ permissions: ['hr:manager'] })).toBe(false);
    });
});

describe('getEligibleHROfficers — scan cap', () => {
    it('warns when the member scan hits its 1000-row cap, still returning only { id, name, avatarUrl }', async () => {
        on('role_permissions', { data: [{ role_id: 2 }, { role_id: 2 }, { role_id: 3 }], error: null });
        on('users', { data: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `M${i}`, display_name: null, avatar_url: null, discord_id: 'x' })), error: null });
        const out = await getEligibleHROfficers();
        expect(out).toHaveLength(1000);
        expect(Object.keys(out[0]).sort()).toEqual(['avatarUrl', 'id', 'name']);
        expect(argsOf(queriesOf('users')[0], 'in')).toEqual(['role_id', [2, 3]]);
        expect(argsOf(queriesOf('users')[0], 'limit')).toEqual([1000]);
        expect(h.warns.some(w => /hit the scan cap/.test(String(w[0])) && (w[1] as Record<string, unknown>).cap === 1000)).toBe(true);
    });

    it('stays quiet below the cap', async () => {
        on('role_permissions', { data: [{ role_id: 2 }], error: null });
        on('users', { data: [{ id: 1, name: 'A', display_name: '  Shown  ', avatar_url: 'a.png' }], error: null });
        expect(await getEligibleHROfficers()).toEqual([{ id: 1, name: 'Shown', avatarUrl: 'a.png' }]);
        expect(h.warns).toHaveLength(0);
    });
});

describe('getHRState — per-viewer redaction of the bundle', () => {
    const seedBundle = () => {
        on('hr_applications', { data: [appRow()], error: null });
        on('hr_interviews', {
            data: [{ id: 'i1', application_id: appRow().id, template_id: 1, interviewer_id: 40, scheduled_at: '2026-04-01T10:00:00Z',
                completed_at: null, overall_notes: 'strong', final_score: 9, status: 'Completed', is_recommended: true,
                interviewer: { id: 40, name: 'Rec' }, responses: [{ question_id: 1, response_body: 'ans', score: 9 }],
                application: { applicant_name: 'Jane Recruit' } }],
            error: null,
        });
        on('hr_interview_panel', { data: [], error: null });
        on('hr_interview_templates', { data: [{ id: 1, name: 'Std', description: 'd' }], error: null });
        on('hr_job_postings', { data: [{ id: 'j1', title: 'Medic', status: 'Open', created_at: 'c' }], error: null });
        on('personnel_positions', { data: [{ id: 9, name: 'Medic' }], error: null });
        on('hr_transfer_requests', {
            data: [
                { id: 't-own', user_id: 12, target_unit_id: 4, reason: 'mine', status: 'Pending', admin_notes: 'private officer note', created_at: 'c', updated_at: 'u' },
                { id: 't-other', user_id: 99, target_unit_id: 5, reason: 'theirs', status: 'Approved', admin_notes: 'n', created_at: 'c', updated_at: 'u' },
            ],
            error: null,
        });
    };

    it('a recruiter gets the full case files (incl. applicant Discord id), interviews and every transfer', async () => {
        seedBundle();
        const { hr } = await getHRState(RECRUITER);
        expect(hr.applicants[0]).toMatchObject({ applicantName: 'Jane Recruit', applicantDiscordId: 'discord-123', rsiHandle: 'Jane_R', linkedUserId: 12 });
        expect(hr.applicants[0].vettingData).toBeUndefined();
        expect(hr.interviews[0]).toMatchObject({ applicantName: 'Jane Recruit', finalScore: 9, overallNotes: 'strong' });
        expect(hr.transfers.map(t => t.id)).toEqual(['t-own', 't-other']);
        expect(hr.templates).toEqual([{ id: 1, name: 'Std', description: 'd', questions: [] }]);
        expect(hr.jobs.map(j => j.id)).toEqual(['j1']);
        expect(hr.positions.map(p => p.id)).toEqual([9]);
    });

    it('a plain hr:view member gets NO applicant identity (Discord id included), redacted interviews, and only their own transfer minus the officer note', async () => {
        seedBundle();
        const { hr } = await getHRState(MEMBER);
        const json = JSON.stringify(hr.applicants) + JSON.stringify(hr.interviews);
        expect(json).not.toContain('discord-123');
        expect(json).not.toContain('Jane Recruit');
        expect(json).not.toContain('Jane_R');
        expect(hr.applicants[0]).toMatchObject({ applicantDiscordId: '', rsiHandle: '', applicantName: '' });
        expect(hr.applicants[0].linkedUserId).toBeUndefined();
        expect(hr.interviews[0]).toMatchObject({ applicantName: '', interviewerId: 0, responses: [] });
        expect(hr.interviews[0].finalScore).toBeUndefined();
        expect(hr.transfers).toHaveLength(1);
        expect(hr.transfers[0]).toMatchObject({ id: 't-own', reason: 'mine' });
        expect(hr.transfers[0].adminNotes).toBeUndefined();
        // The job board stays visible at hr:view.
        expect(hr.jobs).toHaveLength(1);
    });

    it('an hr:manager (staff, not recruiter) sees every transfer but still no applicant identity', async () => {
        seedBundle();
        const { hr } = await getHRState({ id: 50, permissions: ['hr:view', 'hr:manager'] });
        expect(hr.transfers.map(t => t.id)).toEqual(['t-own', 't-other']);
        expect(hr.applicants[0].applicantDiscordId).toBe('');
    });

    it('an unidentified requester gets the deny direction everywhere', async () => {
        seedBundle();
        const { hr } = await getHRState(null);
        expect(hr.transfers).toEqual([]);
        expect(hr.applicants[0].applicantDiscordId).toBe('');
    });
});
