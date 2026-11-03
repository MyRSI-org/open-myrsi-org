import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, filters, hasCall, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/requests.ts — behaviour coverage: the standing floor + one-active cap
// on both create paths (fail-closed on read errors), ad-hoc client binding
// rules, party-member edits, the status writer's allow-list + client inbox
// notification, lead-responder CAS paths, accept/assign/dispatch notification
// dedupe, ownership/duty/terminal gates, single-shot rating, and id-only emits.
// =============================================================================

const m = vi.hoisted(() => ({
    adminAdjustUserReputation: vi.fn(),
    sendPushToStaff: vi.fn(),
    createNotification: vi.fn(),
}));

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy };
});
vi.mock('../lib/db/users.js', () => ({ adminAdjustUserReputation: m.adminAdjustUserReputation }));
vi.mock('../lib/push.js', () => ({ sendPushToStaff: m.sendPushToStaff }));
vi.mock('../lib/db/notifications.js', () => ({ createNotification: m.createNotification }));

import {
    redactRequestFeedbackForViewer, createServiceRequest, createAdHocServiceRequest, addRequestPartyMember,
    removeRequestPartyMember, updateRequestStatus, acceptRequest, adminAcceptAndAssignRequest,
    assertRequestResponderOrDuty, completeRequest, assertRequestOwnerOrDuty, rateRequest, addRequestNote,
    dispatchMembers, addResponderToRequest, removeResponderFromRequest, setLeadResponder, deleteServiceRequest,
} from '../lib/db/requests';
import { SecurityDenial } from '../lib/errors';
import { ServiceRequestStatus, UrgencyLevel } from '../types';

const DUTY = { id: 50, permissions: ['request:dispatch'] };
const MEMBER = { id: 7, permissions: ['request:accept', 'request:start'] };
const SR_COLS = 'id, client_id, unregistered_client_rsi_handle, service_type, location, description, status, urgency, threat_level, lead_responder_id, created_at, updated_at, uec_earned, medigel_consumed, client_rating, client_feedback, rated, party_info, secondary_client_handles';

const isCount = (q: FakeQuery) => q.columns === 'id' && (q.selectOptions as { head?: boolean } | undefined)?.head === true;
const srRow = (over: Record<string, unknown> = {}) => ({
    id: 'SR-AAAAAA', client_id: 7, unregistered_client_rsi_handle: null, service_type: 'Medical', location: 'Lorville',
    description: 'd', status: 'Submitted', urgency: 'High', threat_level: 'Low', lead_responder_id: null, created_at: 'c', updated_at: 'u',
    ...over,
});
const emits = (event: string) => broadcastSpy.mock.calls.filter((c) => (c as unknown[])[0] === event).map((c) => (c as unknown[])[1]);

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
    m.createNotification.mockResolvedValue(undefined);
    m.adminAdjustUserReputation.mockResolvedValue(undefined);
});
afterEach(() => assertNoWildcardSelects(fake));

// -----------------------------------------------------------------------------
describe('redactRequestFeedbackForViewer', () => {
    const req = { clientId: 7, clientFeedback: 'rude crew' };
    it('keeps feedback for holders of request:view:feedback and the authoring client only', () => {
        expect(redactRequestFeedbackForViewer(req, { permissions: ['request:view:feedback'] })).toBe(req);
        expect(redactRequestFeedbackForViewer(req, { id: 7 })).toBe(req);
        expect(redactRequestFeedbackForViewer(req, { id: 8, permissions: ['request:update'] }).clientFeedback).toBeNull();
        expect(redactRequestFeedbackForViewer(req, null).clientFeedback).toBeNull();
        expect(redactRequestFeedbackForViewer({ clientId: null, clientFeedback: 'x' }, {}).clientFeedback).toBeNull();
        const none = { clientId: 7, clientFeedback: '' };
        expect(redactRequestFeedbackForViewer(none, null)).toBe(none);
    });
});

// -----------------------------------------------------------------------------
describe('createServiceRequest', () => {
    function arm(o: { count?: unknown; rep?: unknown; insert?: unknown } = {}) {
        fake.on('service_requests', (q) => {
            if (isCount(q)) return (o.count as never) ?? { count: 0 };
            if (q.op === 'insert') return (o.insert as never) ?? { data: srRow() };
            return { data: null };
        });
        fake.on('users', (o.rep as never) ?? { data: { reputation: 50 } });
    }

    it('fails closed when the active-request count cannot be read', async () => {
        arm({ count: { count: null, error: { message: 'x' } } });
        await expect(createServiceRequest({}, 7)).rejects.toThrow('Could not verify your active requests');
        expect(fake.find('service_requests', 'insert')).toHaveLength(0);
    });

    it('blocks a second active request, counting only live statuses for this client', async () => {
        arm({ count: { count: 1 } });
        await expect(createServiceRequest({}, 7)).rejects.toThrow('already have an active service request');
        const q = fake.find('service_requests').find(isCount)!;
        expect(hasCall(q, 'eq', 'client_id', 7)).toBe(true);
        expect(hasCall(q, 'in', 'status', ['Submitted', 'Triaged', 'Accepted', 'In-Progress'])).toBe(true);
    });

    it('fails closed when standing cannot be read, and denies a sanctioned client', async () => {
        arm({ rep: { data: null, error: { message: 'x' } } });
        await expect(createServiceRequest({}, 7)).rejects.toThrow('Could not verify your standing');
        fake.reset(); arm({ rep: { data: null } });
        await expect(createServiceRequest({}, 7)).rejects.toThrow('Could not verify your standing');
        fake.reset(); arm({ rep: { data: { reputation: 10 } } });
        const err = await createServiceRequest({}, 7).catch((e) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toContain('standing is too low');
        expect(fake.find('service_requests', 'insert')).toHaveLength(0);
        expect(m.sendPushToStaff).not.toHaveBeenCalled();
    });

    it('inserts a sanitised Submitted request, logs history, pushes staff, and maps the row', async () => {
        arm();
        const out = await createServiceRequest({
            serviceType: 'Medical', location: '<b>Lorville</b>\nGate 3', description: `<script>x</script>${'d'.repeat(5000)}`,
            urgency: UrgencyLevel.Critical, threatLevel: 'Low' as never, partyInfo: 'p' as never, secondaryClientHandles: ['a'],
        }, 7);
        expect(out.id).toBe('SR-AAAAAA');
        const ins = fake.find('service_requests', 'insert')[0];
        const p = ins.payload as Record<string, unknown>;
        expect(p.id).toMatch(/^SR-[A-Z0-9]{1,6}$/);
        expect(p).toMatchObject({ client_id: 7, service_type: 'Medical', location: 'Lorville Gate 3', status: 'Submitted', urgency: 'Critical', secondary_client_handles: ['a'] });
        expect((p.description as string).length).toBeLessThanOrEqual(4000);
        expect(p.description).not.toContain('<script>');
        expect(ins.columns).toBe(SR_COLS);
        const hist = fake.find('status_history', 'insert')[0];
        expect(hist.payload).toEqual({ request_id: p.id, status: 'Submitted', updated_by: 7, note: 'Request created' });
        expect(m.sendPushToStaff).toHaveBeenCalledWith(expect.objectContaining({ title: '🔴 New Request: Medical', tag: 'new-request', data: { url: '/requests', requestId: p.id } }));
    });

    it.each([[UrgencyLevel.High, '🟠'], [UrgencyLevel.Low, '🔵']])('urgency %s → %s push icon', async (urgency, icon) => {
        arm();
        await createServiceRequest({ serviceType: 'Rescue', urgency }, 7);
        expect(m.sendPushToStaff.mock.calls[0][0].title).toBe(`${icon} New Request: Rescue`);
    });

    it('maps the unique-index race (23505) to the active-request message', async () => {
        arm({ insert: { data: null, error: { code: '23505', message: 'dup' } } });
        await expect(createServiceRequest({}, 7)).rejects.toThrow('already have an active service request');
        expect(fake.find('status_history')).toHaveLength(0);
        expect(m.sendPushToStaff).not.toHaveBeenCalled();
    });

    it('surfaces other insert errors and a null insert result', async () => {
        arm({ insert: { data: null, error: { code: '23503', message: 'fk' } } });
        await expect(createServiceRequest({}, 7)).rejects.toThrow('Failed to create request');
        expect(m.sendPushToStaff).not.toHaveBeenCalled();
        fake.reset(); arm({ insert: { data: null, error: null } });
        await expect(createServiceRequest({}, 7)).rejects.toThrow('Failed to create request');
    });
});

// -----------------------------------------------------------------------------
describe('createAdHocServiceRequest', () => {
    function arm(o: { rep?: unknown; match?: unknown; count?: unknown; insert?: unknown } = {}) {
        fake.on('users', (q) => {
            if (q.columns === 'reputation') return (o.rep as never) ?? { data: { reputation: 50 } };
            if (q.columns === 'id') return (o.match as never) ?? { data: null };
            return { data: null };
        });
        fake.on('service_requests', (q) => {
            if (isCount(q)) return (o.count as never) ?? { count: 0 };
            if (q.op === 'insert') return (o.insert as never) ?? { data: srRow({ client_id: null }) };
            return { data: null };
        });
    }

    it('applies the same standing floor (fail closed)', async () => {
        arm({ rep: { data: null, error: { message: 'x' } } });
        await expect(createAdHocServiceRequest({}, 7)).rejects.toThrow('Could not verify your standing');
        fake.reset(); arm({ rep: { data: { reputation: NaN } } });
        await expect(createAdHocServiceRequest({}, 7)).rejects.toBeInstanceOf(SecurityDenial);
        expect(fake.find('service_requests', 'insert')).toHaveLength(0);
    });

    it('looks up the handle with an escaped LIKE pattern and logs unbound when the actor may not bind', async () => {
        arm({ match: { data: { id: 99 } } });
        await createAdHocServiceRequest({ unregisteredClientRsiHandle: 'Pi_lot%', serviceType: 'Med', location: 'L' }, 7, MEMBER);
        const look = fake.find('users').find((q) => q.columns === 'id')!;
        expect(hasCall(look, 'ilike', 'rsi_handle', 'Pi\\_lot\\%')).toBe(true);
        const ins = fake.find('service_requests', 'insert')[0];
        expect((ins.payload as Record<string, unknown>).client_id).toBeUndefined();
        expect(ins.payload).toMatchObject({ unregistered_client_rsi_handle: 'Pi_lot%', status: 'Submitted' });
        // Unbound ⇒ no one's one-active slot is consulted.
        expect(fake.find('service_requests').some(isCount)).toBe(false);
        expect(fake.find('status_history', 'insert')[0].payload).toMatchObject({ note: 'Ad-hoc request logged', updated_by: 7 });
        expect(m.sendPushToStaff).toHaveBeenCalledWith(expect.objectContaining({ title: '📝 Ad-Hoc Request Logged', body: 'Med at L for Pi_lot%' }));
    });

    it('binds the matched member when the actor IS that member, or holds dispatch duty — and applies their cap', async () => {
        arm({ match: { data: { id: '7' } } });
        await createAdHocServiceRequest({ unregisteredClientRsiHandle: 'me' }, 7, MEMBER);
        expect((fake.find('service_requests', 'insert')[0].payload as Record<string, unknown>).client_id).toBe('7');
        fake.reset();
        arm({ match: { data: { id: 99 } }, count: { count: 1 } });
        await expect(createAdHocServiceRequest({ unregisteredClientRsiHandle: 'x' }, 50, DUTY)).rejects.toThrow('that client already has an active service request');
        const cnt = fake.find('service_requests').find(isCount)!;
        expect(hasCall(cnt, 'eq', 'client_id', 99)).toBe(true);
        fake.reset();
        arm({ match: { data: { id: 99 } }, count: { count: null, error: { message: 'x' } } });
        await expect(createAdHocServiceRequest({ unregisteredClientRsiHandle: 'x' }, 50, DUTY)).rejects.toThrow('Could not verify active requests');
    });

    it('surfaces insert failures without notifying staff', async () => {
        arm({ insert: { data: null, error: { message: 'x' } } });
        await expect(createAdHocServiceRequest({}, 7)).rejects.toThrow('Failed to create ad-hoc request');
        expect(m.sendPushToStaff).not.toHaveBeenCalled();
        fake.reset(); arm({ insert: { data: null } });
        await expect(createAdHocServiceRequest({}, 7)).rejects.toThrow('Failed to create ad-hoc request');
    });
});

// -----------------------------------------------------------------------------
describe('party members', () => {
    it('adds a handle case-insensitively-unique and emits the request id', async () => {
        fake.queue('service_requests', { data: { secondary_client_handles: ['Alpha'] } }, { error: null });
        await addRequestPartyMember('SR-1', 'Bravo');
        const [read, upd] = fake.find('service_requests');
        expect(read.columns).toBe('secondary_client_handles');
        expect(hasCall(read, 'eq', 'id', 'SR-1')).toBe(true);
        expect(upd.payload).toEqual({ secondary_client_handles: ['Alpha', 'Bravo'] });
        expect(hasCall(upd, 'eq', 'id', 'SR-1')).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('request_update', { requestId: 'SR-1' });
    });

    it('is a no-op for a duplicate handle (any case) and starts from an empty list', async () => {
        fake.queue('service_requests', { data: { secondary_client_handles: ['Alpha'] } });
        await addRequestPartyMember('SR-1', 'ALPHA');
        expect(fake.find('service_requests', 'update')).toHaveLength(0);
        expect(broadcastSpy).not.toHaveBeenCalled();
        fake.queue('service_requests', { data: { secondary_client_handles: null } }, { error: null });
        await addRequestPartyMember('SR-1', 'X');
        expect(fake.find('service_requests', 'update')[0].payload).toEqual({ secondary_client_handles: ['X'] });
    });

    it('rejects an unknown request and surfaces write errors', async () => {
        fake.queue('service_requests', { data: null });
        await expect(addRequestPartyMember('SR-9', 'x')).rejects.toThrow('Request not found in this organization');
        fake.queue('service_requests', { data: { secondary_client_handles: [] } }, { error: { message: 'x' } });
        await expect(addRequestPartyMember('SR-9', 'x')).rejects.toThrow('Failed to add party member');
        fake.queue('service_requests', { data: null });
        await expect(removeRequestPartyMember('SR-9', 'x')).rejects.toThrow('Request not found in this organization');
        fake.queue('service_requests', { data: { secondary_client_handles: null } }, { error: { message: 'x' } });
        await expect(removeRequestPartyMember('SR-9', 'x')).rejects.toThrow('Failed to remove party member');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('removes a handle case-insensitively and emits', async () => {
        fake.queue('service_requests', { data: { secondary_client_handles: ['Alpha', 'bravo'] } }, { error: null });
        await removeRequestPartyMember('SR-1', 'BRAVO');
        expect(fake.find('service_requests', 'update')[0].payload).toEqual({ secondary_client_handles: ['Alpha'] });
        expect(broadcastSpy).toHaveBeenCalledWith('request_update', { requestId: 'SR-1' });
    });
});

// -----------------------------------------------------------------------------
describe('updateRequestStatus', () => {
    function arm(o: { update?: unknown; client?: unknown } = {}) {
        fake.on('service_requests', (q) => {
            if (q.op === 'update') return (o.update as never) ?? { error: null };
            if (q.columns === 'client_id, service_type') return (o.client as never) ?? { data: { client_id: 7, service_type: 'Medical' } };
            return { data: null };
        });
    }

    it('writes only status + allow-listed fields (urgency, report numbers) — never a privilege-bearing extra', async () => {
        arm();
        await updateRequestStatus('SR-1', 'Triaged', 50, 'n', { uecEarned: 100, medigelConsumed: 2 }, { urgency: 'High', lead_responder_id: 666, status: 'Success' });
        const upd = fake.find('service_requests', 'update')[0];
        const p = upd.payload as Record<string, unknown>;
        expect(Object.keys(p).sort()).toEqual(['medigel_consumed', 'status', 'uec_earned', 'updated_at', 'urgency']);
        expect(p).toMatchObject({ status: 'Triaged', urgency: 'High', uec_earned: 100, medigel_consumed: 2 });
        expect(fake.find('status_history', 'insert')[0].payload).toEqual({ request_id: 'SR-1', status: 'Triaged', updated_by: 50, note: 'n' });
        // Triaged is not a client-notified transition.
        expect(m.createNotification).not.toHaveBeenCalled();
        expect(broadcastSpy).toHaveBeenCalledWith('request_update', { requestId: 'SR-1' });
    });

    it('omits absent report fields', async () => {
        arm();
        await updateRequestStatus('SR-1', 'Triaged', 1, undefined, {});
        expect(Object.keys(fake.find('service_requests', 'update')[0].payload as object).sort()).toEqual(['status', 'updated_at']);
    });

    it.each([
        [ServiceRequestStatus.Accepted, 'Request Accepted', 'A unit has been assigned to your Medical request.'],
        [ServiceRequestStatus.InProgress, 'Mission Active', 'Team is on-site/en-route for your Medical request.'],
        [ServiceRequestStatus.Success, 'Mission Complete', 'Status changed to Success.'],
        [ServiceRequestStatus.Cancelled, 'Request Update: Cancelled', 'Status changed to Cancelled.'],
        [ServiceRequestStatus.Refused, 'Request Update: Refused', 'Status changed to Refused.'],
    ])('notifies the client on %s with an id-only metadata link', async (status, title, body) => {
        arm();
        await updateRequestStatus('SR-1', status, 50);
        expect(m.createNotification).toHaveBeenCalledWith(7, { type: 'request', title, body, link: 'requests', metadata: { requestId: 'SR-1' } });
    });

    it('a failing client notification is best-effort; an unclaimed (no client) request notifies no one', async () => {
        arm();
        m.createNotification.mockRejectedValue(new Error('push down'));
        await expect(updateRequestStatus('SR-1', 'Accepted', 50)).resolves.toBeUndefined();
        fake.reset();
        m.createNotification.mockClear();
        arm({ client: { data: { client_id: null, service_type: 'x' } } });
        await updateRequestStatus('SR-1', 'Accepted', 50);
        expect(m.createNotification).not.toHaveBeenCalled();
    });

    it('surfaces a write error with no history, notification or emit', async () => {
        arm({ update: { error: { message: 'x' } } });
        await expect(updateRequestStatus('SR-1', 'Accepted', 50)).rejects.toThrow('Failed to update request status');
        expect(fake.find('status_history')).toHaveLength(0);
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
describe('acceptRequest', () => {
    function arm(o: { req?: unknown; responderInsert?: unknown; lead?: unknown } = {}) {
        fake.on('service_requests', (q) => {
            if (q.columns === 'status, client_id') return (o.req as never) ?? { data: { status: 'Submitted', client_id: 3 } };
            if (q.columns === 'lead_responder_id') return (o.lead as never) ?? { data: { lead_responder_id: null } };
            if (q.columns === 'client_id, service_type') return { data: { client_id: 3, service_type: 'Med' } };
            return { error: null };
        });
        fake.on('request_responders', (o.responderInsert as never) ?? { error: null });
    }

    it('forbids accepting for someone else without dispatch duty', async () => {
        await expect(acceptRequest('SR-1', 8, 7, MEMBER)).rejects.toThrow('only accept a request for yourself');
        expect(fake.queries).toHaveLength(0);
    });

    it('rejects unknown and no-longer-acceptable requests', async () => {
        arm({ req: { data: null } });
        await expect(acceptRequest('SR-1', 7, 7, MEMBER)).rejects.toThrow('Request not found or access denied.');
        fake.reset(); arm({ req: { data: { status: 'Success', client_id: 3 } } });
        await expect(acceptRequest('SR-1', 7, 7, MEMBER)).rejects.toThrow('Request can no longer be accepted.');
        expect(fake.find('request_responders')).toHaveLength(0);
    });

    it('blocks self-service on your own request unless you hold duty', async () => {
        arm({ req: { data: { status: 'Triaged', client_id: 7 } } });
        await expect(acceptRequest('SR-1', 7, 7, MEMBER)).rejects.toThrow('cannot respond to your own request');
        expect(fake.find('request_responders')).toHaveLength(0);
        fake.reset(); arm({ req: { data: { status: 'Triaged', client_id: 50 } } });
        await expect(acceptRequest('SR-1', 50, 50, DUTY)).resolves.toBeUndefined();
    });

    it('self-accept: responder row, Accepted status, CAS lead claim, assigned emit, no self-notification', async () => {
        arm();
        await acceptRequest('SR-1', 7, 7, MEMBER);
        expect(fake.find('request_responders', 'insert')[0].payload).toEqual({ request_id: 'SR-1', user_id: 7 });
        const statusUpd = fake.find('service_requests', 'update').find((q) => 'status' in (q.payload as object))!;
        expect(statusUpd.payload).toMatchObject({ status: 'Accepted' });
        const claim = fake.find('service_requests', 'update').find((q) => 'lead_responder_id' in (q.payload as object))!;
        expect(claim.payload).toEqual({ lead_responder_id: 7 });
        expect(hasCall(claim, 'is', 'lead_responder_id', null)).toBe(true);
        expect(emits('responder_change')).toEqual([{ requestId: 'SR-1', userId: 7, action: 'assigned' }]);
        expect(m.createNotification.mock.calls.map((c) => c[1].type)).toEqual(['request']); // client only
    });

    it('does not overwrite an existing lead, and surfaces a claim failure', async () => {
        arm({ lead: { data: { lead_responder_id: 99 } } });
        await acceptRequest('SR-1', 7, 7, MEMBER);
        expect(fake.find('service_requests', 'update').some((q) => 'lead_responder_id' in (q.payload as object))).toBe(false);
        fake.reset();
        arm();
        fake.on('service_requests', (q) => {
            if (q.columns === 'status, client_id') return { data: { status: 'Submitted', client_id: 3 } };
            if (q.columns === 'lead_responder_id') return { data: { lead_responder_id: null } };
            if (q.op === 'update' && 'lead_responder_id' in (q.payload as object)) return { error: { message: 'x' } };
            return { data: null };
        });
        await expect(acceptRequest('SR-1', 7, 7, MEMBER)).rejects.toThrow('Failed to set lead responder');
    });

    it('duty assigning another member: no lead claim, assignee notified (best-effort)', async () => {
        arm();
        m.createNotification.mockRejectedValue(new Error('x'));
        await acceptRequest('SR-1', 8, 50, DUTY);
        expect(fake.find('service_requests', 'update').some((q) => 'lead_responder_id' in (q.payload as object))).toBe(false);
        expect(m.createNotification).toHaveBeenCalledWith(8, { type: 'responder', title: 'Mission Assignment', body: 'You have been assigned to a service request.', link: 'requests', metadata: { requestId: 'SR-1' } });
    });

    it('surfaces a responder insert failure without status change', async () => {
        arm({ responderInsert: { error: { message: 'dup' } } });
        await expect(acceptRequest('SR-1', 7, 7, MEMBER)).rejects.toThrow('Failed to accept request');
        expect(fake.find('service_requests', 'update')).toHaveLength(0);
    });
});

// -----------------------------------------------------------------------------
describe('adminAcceptAndAssignRequest', () => {
    function arm(o: { count?: number; upsert?: unknown; lead?: unknown } = {}) {
        fake.on('service_requests', (q) => {
            if (isCount(q)) return { count: o.count ?? 1 };
            if (q.op === 'update' && 'lead_responder_id' in (q.payload as object)) return (o.lead as never) ?? { error: null };
            if (q.columns === 'client_id, service_type') return { data: { client_id: null } };
            return { error: null };
        });
        fake.on('request_responders', (o.upsert as never) ?? { error: null });
    }

    it('rejects an unknown request', async () => {
        arm({ count: 0 });
        await expect(adminAcceptAndAssignRequest('SR-1', 8, 50, 'n')).rejects.toThrow('Request not found or access denied.');
        expect(fake.find('request_responders')).toHaveLength(0);
    });

    it('upserts the responder idempotently, sets urgency + the lead unconditionally, notifies the lead', async () => {
        arm();
        await adminAcceptAndAssignRequest('SR-1', 8, 50, 'assigning', UrgencyLevel.High);
        const up = fake.find('request_responders', 'upsert')[0];
        expect(up.payload).toEqual({ request_id: 'SR-1', user_id: 8 });
        expect(up.writeOptions).toEqual({ onConflict: 'request_id,user_id', ignoreDuplicates: true });
        const statusUpd = fake.find('service_requests', 'update').find((q) => 'status' in (q.payload as object))!;
        expect(statusUpd.payload).toMatchObject({ status: 'Accepted', urgency: 'High' });
        const lead = fake.find('service_requests', 'update').find((q) => 'lead_responder_id' in (q.payload as object))!;
        expect(lead.payload).toEqual({ lead_responder_id: 8 });
        expect(filters(lead, 'is')).toHaveLength(0);
        expect(emits('responder_change')).toEqual([{ requestId: 'SR-1', userId: 8, action: 'assigned' }]);
        expect(m.createNotification).toHaveBeenCalledWith(8, expect.objectContaining({ title: 'Lead Responder Assigned', metadata: { requestId: 'SR-1' } }));
    });

    it('a dispatcher naming themselves lead is not self-notified; no urgency means none written', async () => {
        arm();
        await adminAcceptAndAssignRequest('SR-1', 50, 50, 'self');
        const statusUpd = fake.find('service_requests', 'update').find((q) => 'status' in (q.payload as object))!;
        expect('urgency' in (statusUpd.payload as object)).toBe(false);
        expect(m.createNotification).not.toHaveBeenCalled();
    });

    it('swallows a lead-notification failure, surfaces lead write + upsert failures', async () => {
        arm();
        m.createNotification.mockRejectedValue(new Error('x'));
        await expect(adminAcceptAndAssignRequest('SR-1', 8, 50, 'n')).resolves.toBeUndefined();
        fake.reset(); arm({ lead: { error: { message: 'x' } } });
        await expect(adminAcceptAndAssignRequest('SR-1', 8, 50, 'n')).rejects.toThrow('Failed to set lead responder');
        fake.reset(); arm({ upsert: { error: { message: 'x' } } });
        await expect(adminAcceptAndAssignRequest('SR-1', 8, 50, 'n')).rejects.toThrow('Failed to assign request');
    });
});

// -----------------------------------------------------------------------------
describe('assertRequestResponderOrDuty', () => {
    it('rejects an unknown request and any terminal request — duty included', async () => {
        fake.queue('service_requests', { data: null });
        await expect(assertRequestResponderOrDuty('SR-1', DUTY, 'start')).rejects.toThrow('Request not found.');
        fake.queue('service_requests', { data: { lead_responder_id: null, status: 'Success' } });
        const err = await assertRequestResponderOrDuty('SR-1', DUTY, 'complete').catch((e) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('Action Blocked: this request is already Success and can no longer be completed.');
        fake.queue('service_requests', { data: { lead_responder_id: null, status: 'Cancelled' } });
        await expect(assertRequestResponderOrDuty('SR-1', MEMBER, 'start')).rejects.toThrow('can no longer be started');
    });

    it('admits duty, the lead, then an assigned responder; denies everyone else', async () => {
        fake.queue('service_requests', { data: { lead_responder_id: null, status: 'Accepted' } });
        await expect(assertRequestResponderOrDuty('SR-1', { id: 1, permissions: ['request:update'] }, 'start')).resolves.toBeUndefined();
        expect(fake.find('request_responders')).toHaveLength(0);
        fake.queue('service_requests', { data: { lead_responder_id: 7, status: 'Accepted' } });
        await expect(assertRequestResponderOrDuty('SR-1', MEMBER, 'start')).resolves.toBeUndefined();
        fake.queue('service_requests', { data: { lead_responder_id: 1, status: 'In-Progress' } });
        fake.queue('request_responders', { data: { user_id: 7 } });
        await expect(assertRequestResponderOrDuty('SR-1', MEMBER, 'complete')).resolves.toBeUndefined();
        const rr = fake.find('request_responders')[0];
        expect(hasCall(rr, 'eq', 'request_id', 'SR-1')).toBe(true);
        expect(hasCall(rr, 'eq', 'user_id', 7)).toBe(true);
        fake.queue('service_requests', { data: { lead_responder_id: 1, status: 'In-Progress' } });
        fake.queue('request_responders', { data: null });
        await expect(assertRequestResponderOrDuty('SR-1', MEMBER, 'complete')).rejects.toThrow('Forbidden: you are not assigned to this request.');
    });
});

// -----------------------------------------------------------------------------
describe('completeRequest', () => {
    function arm(o: { client?: unknown; rep?: unknown } = {}) {
        fake.on('service_requests', (q) => {
            if (q.columns === 'client_id, service_type') return { data: { client_id: null } };
            if (q.columns === 'client_id') return (o.client as never) ?? { data: { client_id: 3 } };
            return { error: null };
        });
        fake.on('users', (o.rep as never) ?? { data: { reputation: 95 } });
    }

    it('defaults the outcome to Success and carries the report numbers', async () => {
        arm();
        await completeRequest('SR-1', { notes: 'done', uecEarned: 5 }, 7, MEMBER);
        const upd = fake.find('service_requests', 'update')[0];
        expect(upd.payload).toMatchObject({ status: 'Success', uec_earned: 5 });
        expect(fake.find('status_history', 'insert')[0].payload).toMatchObject({ note: 'done' });
    });

    it('ignores a reputation change from a non-duty completer (no priv-esc via the report)', async () => {
        arm();
        await completeRequest('SR-1', { outcome: 'Failed', clientReputationChange: -50 }, 7, MEMBER);
        expect(m.adminAdjustUserReputation).not.toHaveBeenCalled();
        expect(fake.find('users')).toHaveLength(0);
    });

    it('applies a duty holder reputation change clamped to 0..100', async () => {
        arm();
        await completeRequest('SR-1', { clientReputationChange: 20 }, 50, DUTY);
        expect(m.adminAdjustUserReputation).toHaveBeenCalledWith(3, 100, 50, 'Mission SR-1 outcome');
        const u = fake.find('users')[0];
        expect(u.columns).toBe('reputation');
        expect(hasCall(u, 'eq', 'id', 3)).toBe(true);
        fake.reset(); arm({ rep: { data: { reputation: 5 } } });
        m.adminAdjustUserReputation.mockClear();
        await completeRequest('SR-1', { clientReputationChange: -20 }, 50, DUTY);
        expect(m.adminAdjustUserReputation).toHaveBeenCalledWith(3, 0, 50, 'Mission SR-1 outcome');
    });

    it('skips the reputation write for an unclaimed request or an unknown client', async () => {
        arm({ client: { data: { client_id: null } } });
        await completeRequest('SR-1', { clientReputationChange: 5 }, 50, DUTY);
        arm({ client: { data: null } });
        await completeRequest('SR-1', { clientReputationChange: 5 }, 50, DUTY);
        arm({ rep: { data: null } });
        await completeRequest('SR-1', { clientReputationChange: 5 }, 50, DUTY);
        expect(m.adminAdjustUserReputation).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
describe('assertRequestOwnerOrDuty', () => {
    it('duty bypasses without a read', async () => {
        await assertRequestOwnerOrDuty('SR-1', { id: 1, permissions: ['request:triage'] }, 'cancel');
        expect(fake.queries).toHaveLength(0);
    });

    it('owner may rate any status but cancel only a Submitted request; strangers never', async () => {
        fake.queue('service_requests', { data: null });
        await expect(assertRequestOwnerOrDuty('SR-1', { id: 7 }, 'rate')).rejects.toThrow('Request not found.');
        fake.queue('service_requests', { data: { client_id: 8, status: 'Submitted' } });
        await expect(assertRequestOwnerOrDuty('SR-1', { id: 7 }, 'cancel')).rejects.toThrow('only act on your own requests');
        fake.queue('service_requests', { data: { client_id: 7, status: 'Accepted' } });
        const err = await assertRequestOwnerOrDuty('SR-1', { id: 7 }, 'cancel').catch((e) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toContain('can no longer be cancelled');
        fake.queue('service_requests', { data: { client_id: 7, status: 'Submitted' } });
        await expect(assertRequestOwnerOrDuty('SR-1', { id: 7 }, 'cancel')).resolves.toBeUndefined();
        fake.queue('service_requests', { data: { client_id: 7, status: 'Success' } });
        await expect(assertRequestOwnerOrDuty('SR-1', { id: 7 }, 'rate')).resolves.toBeUndefined();
        expect(fake.find('service_requests')[0].columns).toBe('client_id, status');
    });
});

// -----------------------------------------------------------------------------
describe('rateRequest', () => {
    it.each([[0], [6], [NaN], ['abc']])('rejects an out-of-range rating %s before any read', async (r) => {
        await expect(rateRequest('SR-1', r as number, '', MEMBER)).rejects.toThrow('Rating must be 1–5 stars.');
        expect(fake.queries).toHaveLength(0);
    });

    it('requires an existing completed request', async () => {
        fake.queue('service_requests', { data: null });
        await expect(rateRequest('SR-1', 4, '', MEMBER)).rejects.toThrow('Request not found.');
        fake.queue('service_requests', { data: { status: 'In-Progress', rated: false, client_rating: null } });
        await expect(rateRequest('SR-1', 4, '', MEMBER)).rejects.toThrow('Only a completed request can be rated.');
        expect(fake.find('service_requests', 'update')).toHaveLength(0);
    });

    it('is single-shot for clients; duty may correct a rating', async () => {
        fake.queue('service_requests', { data: { status: 'Success', rated: null, client_rating: 3 } });
        await expect(rateRequest('SR-1', 5, '', { id: 7 })).rejects.toBeInstanceOf(SecurityDenial);
        fake.queue('service_requests', { data: { status: 'Success', rated: true, client_rating: 3 } }, { error: null });
        await rateRequest('SR-1', 2.6, '', DUTY);
        expect(fake.find('service_requests', 'update')[0].payload).toEqual({ rated: true, client_rating: 3, client_feedback: null });
    });

    it('writes a rounded rating with stripped, capped feedback', async () => {
        fake.queue('service_requests', { data: { status: 'Success', rated: false, client_rating: null } }, { error: null });
        await rateRequest('SR-1', 4.4, `<b>great</b>${'x'.repeat(2000)}`, { id: 7 });
        const upd = fake.find('service_requests', 'update')[0];
        const p = upd.payload as { client_rating: number; client_feedback: string };
        expect(p.client_rating).toBe(4);
        expect(p.client_feedback.startsWith('great')).toBe(true);
        expect(p.client_feedback.length).toBeLessThanOrEqual(1000);
        expect(hasCall(upd, 'eq', 'id', 'SR-1')).toBe(true);
    });

    it('surfaces the write error', async () => {
        fake.queue('service_requests', { data: { status: 'Success', rated: false, client_rating: null } }, { error: { message: 'x' } });
        await expect(rateRequest('SR-1', 4, 'ok', { id: 7 })).rejects.toThrow('Failed to rate request');
    });
});

// -----------------------------------------------------------------------------
describe('addRequestNote', () => {
    it('rejects an unknown request or a read error', async () => {
        fake.queue('service_requests', { data: null });
        await expect(addRequestNote('SR-1', 'n', 7)).rejects.toThrow('Request not found or access denied');
        fake.queue('service_requests', { data: { status: 'Accepted' }, error: { message: 'x' } });
        await expect(addRequestNote('SR-1', 'n', 7)).rejects.toThrow('Request not found or access denied');
        expect(fake.find('status_history')).toHaveLength(0);
    });

    it('appends a history row at the current status and emits', async () => {
        fake.queue('service_requests', { data: { status: 'Accepted' } });
        await addRequestNote('SR-1', 'en route', 7);
        expect(fake.find('status_history', 'insert')[0].payload).toEqual({ request_id: 'SR-1', status: 'Accepted', updated_by: 7, note: 'en route' });
        expect(broadcastSpy).toHaveBeenCalledWith('request_update', { requestId: 'SR-1' });
    });

    it('surfaces a history insert failure', async () => {
        fake.queue('service_requests', { data: { status: 'Accepted' } });
        fake.queue('status_history', { error: { message: 'x' } });
        await expect(addRequestNote('SR-1', 'n', 7)).rejects.toThrow('Failed to add note');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
describe('dispatchMembers', () => {
    function arm(o: { count?: number; existing?: unknown; del?: unknown; insert?: unknown; lead?: number | null; clearErr?: unknown } = {}) {
        fake.on('service_requests', (q) => {
            if (isCount(q)) return { count: o.count ?? 1 };
            if (q.columns === 'lead_responder_id') return { data: { lead_responder_id: o.lead ?? null } };
            if (q.op === 'update' && (q.payload as { lead_responder_id: unknown }).lead_responder_id === null) return (o.clearErr as never) ?? { error: null };
            return { error: null };
        });
        fake.on('request_responders', (q) => {
            if (q.op === 'select') return (o.existing as never) ?? { data: [{ user_id: 1 }, { user_id: 2 }] };
            if (q.op === 'delete') return (o.del as never) ?? { error: null };
            if (q.op === 'insert') return (o.insert as never) ?? { error: null };
            return { error: null };
        });
    }

    it('rejects an unknown request', async () => {
        arm({ count: 0 });
        await expect(dispatchMembers('SR-1', [1], 50)).rejects.toThrow('Request not found or access denied.');
        expect(fake.find('request_responders')).toHaveLength(0);
    });

    it('replaces the set; clears a lead no longer on it (CAS); claims for the first; notifies only NEW non-self members', async () => {
        arm({ lead: 1 });
        await dispatchMembers('SR-1', [2, 3, 50], 50);
        expect(hasCall(fake.find('request_responders', 'delete')[0], 'eq', 'request_id', 'SR-1')).toBe(true);
        expect(fake.find('request_responders', 'insert')[0].payload).toEqual([
            { request_id: 'SR-1', user_id: 2 }, { request_id: 'SR-1', user_id: 3 }, { request_id: 'SR-1', user_id: 50 },
        ]);
        const clear = fake.find('service_requests', 'update').find((q) => (q.payload as { lead_responder_id: unknown }).lead_responder_id === null)!;
        expect(hasCall(clear, 'eq', 'lead_responder_id', 1)).toBe(true);
        expect(emits('responder_change')).toEqual([
            { requestId: 'SR-1', userId: 3, action: 'assigned' },
            { requestId: 'SR-1', userId: 50, action: 'assigned' },
            { requestId: 'SR-1', userId: 1, action: 'unassigned' },
        ]);
        expect(m.createNotification.mock.calls.map((c) => c[0])).toEqual([3]);
        expect(m.createNotification.mock.calls[0][1]).toMatchObject({ title: 'Unit Dispatched', metadata: { requestId: 'SR-1' } });
        expect(emits('request_update')).toEqual([{ requestId: 'SR-1' }]);
    });

    it('keeps a lead who stays on the set', async () => {
        arm({ lead: 2 });
        await dispatchMembers('SR-1', [2], 50);
        expect(fake.find('service_requests', 'update').some((q) => (q.payload as { lead_responder_id: unknown }).lead_responder_id === null)).toBe(false);
    });

    it('sends NO notifications when the prior set is unknown (read fault), but still emits; notify failures are swallowed', async () => {
        arm({ existing: { data: null, error: { message: 'x' } } });
        await dispatchMembers('SR-1', [3], 50);
        expect(m.createNotification).not.toHaveBeenCalled();
        expect(emits('responder_change')).toEqual([{ requestId: 'SR-1', userId: 3, action: 'assigned' }]);
        fake.reset(); broadcastSpy.mockClear();
        arm({ existing: { data: [] } });
        m.createNotification.mockRejectedValue(new Error('x'));
        await expect(dispatchMembers('SR-1', [4], 50)).resolves.toBeUndefined();
        expect(m.createNotification).toHaveBeenCalledWith(4, expect.anything());
    });

    it('an empty dispatch clears everyone (unassigned emits, lead cleared)', async () => {
        arm({ lead: 2 });
        await dispatchMembers('SR-1', [], 50);
        expect(fake.find('request_responders', 'insert')).toHaveLength(0);
        expect(emits('responder_change')).toEqual([
            { requestId: 'SR-1', userId: 1, action: 'unassigned' }, { requestId: 'SR-1', userId: 2, action: 'unassigned' },
        ]);
        expect(emits('request_update')).toEqual([{ requestId: 'SR-1' }]);
    });

    it('does nothing further when the delete fails', async () => {
        arm({ del: { error: { message: 'x' } } });
        await dispatchMembers('SR-1', [3], 50);
        expect(fake.find('request_responders', 'insert')).toHaveLength(0);
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('surfaces insert and lead-clear failures', async () => {
        arm({ insert: { error: { message: 'x' } } });
        await expect(dispatchMembers('SR-1', [3], 50)).rejects.toThrow('Failed to dispatch members');
        fake.reset(); arm({ lead: 9, clearErr: { error: { message: 'x' } } });
        await expect(dispatchMembers('SR-1', [3], 50)).rejects.toThrow('Failed to clear lead responder');
    });
});

// -----------------------------------------------------------------------------
describe('add / remove responder, set lead, delete', () => {
    function arm(o: { count?: number; existing?: unknown; upsert?: unknown; del?: unknown } = {}) {
        fake.on('service_requests', (q) => {
            if (isCount(q)) return { count: o.count ?? 1 };
            if (q.columns === 'lead_responder_id') return { data: { lead_responder_id: 5 } };
            return { error: null };
        });
        fake.on('request_responders', (q) => {
            if (q.op === 'select') return (o.existing as never) ?? { data: null };
            if (q.op === 'upsert') return (o.upsert as never) ?? { error: null };
            if (q.op === 'delete') return (o.del as never) ?? { error: null };
            return { error: null };
        });
    }

    it('addResponder rejects an unknown request', async () => {
        arm({ count: 0 });
        await expect(addResponderToRequest('SR-1', 8, 50)).rejects.toThrow('Request not found or access denied.');
    });

    it('a NEW responder is upserted, emitted and notified; the lead slot is only claimed if empty', async () => {
        arm();
        await addResponderToRequest('SR-1', 8, 50);
        const sel = fake.find('request_responders', 'select')[0];
        expect(hasCall(sel, 'eq', 'user_id', 8)).toBe(true);
        expect(fake.find('request_responders', 'upsert')[0].writeOptions).toEqual({ onConflict: 'request_id,user_id', ignoreDuplicates: true });
        expect(fake.find('service_requests', 'update')).toHaveLength(0); // lead already 5
        expect(emits('responder_change')).toEqual([{ requestId: 'SR-1', userId: 8, action: 'assigned' }]);
        expect(m.createNotification).toHaveBeenCalledWith(8, expect.objectContaining({ body: 'You have been added to a service request.' }));
        expect(emits('request_update')).toEqual([{ requestId: 'SR-1' }]);
    });

    it('a re-add is silent (no emit/notify amplifier); a faulted pre-read or self-add notifies no one', async () => {
        arm({ existing: { data: { user_id: 8 } } });
        await addResponderToRequest('SR-1', 8, 50);
        expect(emits('responder_change')).toEqual([]);
        expect(m.createNotification).not.toHaveBeenCalled();
        fake.reset(); arm({ existing: { data: null, error: { message: 'x' } } });
        await addResponderToRequest('SR-1', 8, 50);
        expect(m.createNotification).not.toHaveBeenCalled();
        fake.reset(); arm();
        await addResponderToRequest('SR-1', 50, 50);
        expect(m.createNotification).not.toHaveBeenCalled();
        fake.reset(); arm();
        m.createNotification.mockRejectedValue(new Error('x'));
        await expect(addResponderToRequest('SR-1', 9, 50)).resolves.toBeUndefined();
    });

    it('addResponder surfaces an upsert failure', async () => {
        arm({ upsert: { error: { message: 'x' } } });
        await expect(addResponderToRequest('SR-1', 8, 50)).rejects.toThrow('Failed to add responder');
    });

    it('removeResponder deletes the row, CAS-clears their lead, and emits unassigned', async () => {
        arm({ count: 0 });
        await expect(removeResponderFromRequest('SR-1', 8)).rejects.toThrow('Request not found or access denied.');
        fake.reset(); arm();
        await removeResponderFromRequest('SR-1', 8);
        const del = fake.find('request_responders', 'delete')[0];
        expect(hasCall(del, 'eq', 'request_id', 'SR-1')).toBe(true);
        expect(hasCall(del, 'eq', 'user_id', 8)).toBe(true);
        const clear = fake.find('service_requests', 'update')[0];
        expect(clear.payload).toEqual({ lead_responder_id: null });
        expect(hasCall(clear, 'eq', 'lead_responder_id', 8)).toBe(true);
        expect(emits('responder_change')).toEqual([{ requestId: 'SR-1', userId: 8, action: 'unassigned' }]);
        expect(emits('request_update')).toEqual([{ requestId: 'SR-1' }]);
        fake.reset(); arm({ del: { error: { message: 'x' } } });
        await expect(removeResponderFromRequest('SR-1', 8)).rejects.toThrow('Failed to remove responder');
    });

    it('setLeadResponder writes/clears the lead and notifies only a different new lead', async () => {
        await setLeadResponder('SR-1', 8, 50);
        expect(fake.find('service_requests', 'update')[0].payload).toEqual({ lead_responder_id: 8 });
        expect(m.createNotification).toHaveBeenCalledWith(8, expect.objectContaining({ title: 'Lead Responder Assigned' }));
        m.createNotification.mockClear();
        await setLeadResponder('SR-1', undefined, 50);
        expect(fake.find('service_requests', 'update')[1].payload).toEqual({ lead_responder_id: null });
        await setLeadResponder('SR-1', 50, 50);
        expect(m.createNotification).not.toHaveBeenCalled();
        m.createNotification.mockRejectedValue(new Error('x'));
        await expect(setLeadResponder('SR-1', 9, 50)).resolves.toBeUndefined();
        expect(emits('request_update')).toHaveLength(4);
        fake.queue('service_requests', { error: { message: 'x' } });
        await expect(setLeadResponder('SR-1', 9, 50)).rejects.toThrow('Failed to set lead responder');
    });

    it('deleteServiceRequest deletes by id and emits an id-only request_delete', async () => {
        await deleteServiceRequest('SR-1');
        expect(hasCall(fake.find('service_requests', 'delete')[0], 'eq', 'id', 'SR-1')).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('request_delete', { requestId: 'SR-1' });
        broadcastSpy.mockClear();
        fake.queue('service_requests', { error: { message: 'x' } });
        await expect(deleteServiceRequest('SR-1')).rejects.toThrow('Failed to delete request');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});
