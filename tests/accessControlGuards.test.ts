import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each block asserts a server-side authorization gate, driven through a
// select-string-aware supabase mock so the dossier/radio aggregation paths are
// exercised end to end, plus pure-unit checks for the extracted predicates.

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: number },
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

// LiveKit secrets absent so a viewer that PASSES the op-visibility auth check
// fails later on 'Radio configuration missing' — letting us distinguish
// "blocked by clearance" from "passed clearance" without a real LiveKit SDK.
vi.mock('../lib/secrets', () => ({ getOrgSecret: async () => null }));

import { getDossier, createIntelReport, createIntelBulletin } from '../lib/db/intel';
import { createOperation } from '../lib/db/ops';
import { generateOpRadioToken, generateRadioToken } from '../lib/radio';
import { createWikiPage, updateWikiPage } from '../lib/db/wiki';
import { assertCanClassify } from '../lib/clearance';
import { getClientIp } from '../lib/clientIp';
import { isAllowedPushEndpoint, MAX_PUSH_SUBSCRIPTIONS_PER_USER } from '../lib/push';
import type { User } from '../types';

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    h.broadcasts = [];
});

const viewer = (over: Record<string, unknown> = {}): User => ({
    id: 6, role: 'Member', permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [],
    ...over,
} as unknown as User);

// Intel dossier filters its derived surfaces by the viewer.
describe('getDossier viewer-scoped filtering (H1/H2/H3)', () => {
    // A PERSON dossier whose source reports/ops span two classification tiers.
    function personDossierFixture() {
        h.resolveQuery = ({ table, calls }) => {
            const sel = String(calls.find(c => c.method === 'select')?.args[0] ?? '');
            if (table === 'users') return { data: { id: 42 }, error: null };           // target resolves to a user
            if (table === 'intel_reports') {
                if (sel === 'subject_type') return { data: { subject_type: 'Person' }, error: null };
                if (sel.startsWith('affiliated_org')) return {
                    data: [
                        { affiliated_org: 'OPENORG', threat_level: 'Low', created_at: '2026-01-01', classification_level: 0, intel_report_limiting_markers: [] },
                        { affiliated_org: 'SECRETORG', threat_level: 'Critical', created_at: '2026-01-02', classification_level: 3, intel_report_limiting_markers: [] },
                    ], error: null,
                };
                return { data: [], error: null }; // reports / org-affiliated reports (bodies filtered by the handler)
            }
            if (table === 'operations') return {
                data: [
                    { id: 'op-open', name: 'Open Op', status: 'Planning', type: 'Mining', description: 'visible', created_at: '2026-01-01', owner_id: 99, clearance_level: 0, limiting_markers: [] },
                    { id: 'op-secret', name: 'Nightfall', status: 'Planning', type: 'Combat', description: 'TOP SECRET tactical plan', created_at: '2026-01-02', owner_id: 99, clearance_level: 4, limiting_markers: [] },
                ], error: null,
            };
            if (table === 'dossier_summaries') return { data: { summary: 'CLASSIFIED SYNTHESIS', generated_at: '2026-01-03' }, error: null };
            return { data: [], error: null }; // warrants, service_requests
        };
    }

    it('H1: a low-clearance viewer sees only at-or-below-clearance affiliates', async () => {
        personDossierFixture();
        const d = await getDossier('jdoe', viewer());
        const orgs = (d.affiliates ?? []).map(a => a.targetId);
        expect(orgs).toContain('OPENORG');
        expect(orgs).not.toContain('SECRETORG');
    });

    it('H2: a low-clearance viewer sees only ops they could open in the list', async () => {
        personDossierFixture();
        const d = await getDossier('jdoe', viewer());
        const ids = (d.operations ?? []).map((o: { id: string }) => o.id);
        expect(ids).toContain('op-open');
        expect(ids).not.toContain('op-secret');
    });

    it('H3: the cached AI summary is withheld from non-managers', async () => {
        personDossierFixture();
        const d = await getDossier('jdoe', viewer());
        expect(d.cachedSummary).toBeUndefined();
        expect(d.cachedSummaryDate).toBeUndefined();
    });

    // The system Admin by role IDENTITY. A forged 'Admin' tier (name-derived, zero
    // permissions) gets the ordinary clearance ceiling — asserted below.
    it('the stamped system Admin sees every affiliate + op + the cached summary', async () => {
        personDossierFixture();
        const d = await getDossier('jdoe', viewer({ isSystemAdmin: true }));
        expect((d.affiliates ?? []).map(a => a.targetId)).toEqual(expect.arrayContaining(['OPENORG', 'SECRETORG']));
        expect((d.operations ?? []).map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining(['op-open', 'op-secret']));
        expect(d.cachedSummary).toBe('CLASSIFIED SYNTHESIS');
    });

    it('a forged Admin role NAME with no permissions gets NO dossier bypass', async () => {
        personDossierFixture();
        const d = await getDossier('jdoe', viewer({ role: 'Admin' }));
        expect((d.affiliates ?? []).map(a => a.targetId)).not.toContain('SECRETORG');
        expect(d.cachedSummary).toBeUndefined();
    });

    it('per-surface bypass: intel:manage unlocks affiliates+summary but NOT ops clearance', async () => {
        personDossierFixture();
        const d = await getDossier('jdoe', viewer({ permissions: ['intel:manage'] }));
        // intel:manage is the intel read-bypass → affiliates + summary unlocked
        expect((d.affiliates ?? []).map(a => a.targetId)).toContain('SECRETORG');
        expect(d.cachedSummary).toBe('CLASSIFIED SYNTHESIS');
        // ...but ops use the operations:manage bypass, which intel:manage is not
        expect((d.operations ?? []).map((o: { id: string }) => o.id)).not.toContain('op-secret');
    });

    it('no viewer → classified surfaces withheld (unclassified level-0 is public by design)', async () => {
        personDossierFixture();
        const d = await getDossier('jdoe', null);
        // level-0 affiliates are unclassified → visible (passesClearance(null,0,[])===true),
        // but the classified affiliate, ALL ops (the !!viewer guard), and the
        // manager-only summary are withheld.
        expect((d.affiliates ?? []).map(a => a.targetId)).not.toContain('SECRETORG');
        expect(d.operations ?? []).toHaveLength(0);
        expect(d.cachedSummary).toBeUndefined();
    });

    // The ORG branch derives affiliates from a SEPARATE members query — pin it
    // independently so it cannot drift from the person branch.
    function orgDossierFixture() {
        h.resolveQuery = ({ table, calls }) => {
            const sel = String(calls.find(c => c.method === 'select')?.args[0] ?? '');
            if (table === 'users') return { data: null, error: null };                 // an org is not a user
            if (table === 'intel_reports') {
                if (sel === 'subject_type') return { data: { subject_type: 'Organization' }, error: null };
                if (sel.startsWith('target_id')) return {
                    data: [
                        { target_id: 'GruntA', threat_level: 'Low', created_at: '2026-01-01', classification_level: 0, intel_report_limiting_markers: [] },
                        { target_id: 'SleeperB', threat_level: 'Critical', created_at: '2026-01-02', classification_level: 3, intel_report_limiting_markers: [] },
                    ], error: null,
                };
                return { data: [], error: null }; // org reports
            }
            if (table === 'dossier_summaries') return { data: { summary: 'X', generated_at: '2026-01-03' }, error: null };
            return { data: [], error: null };
        };
    }

    it('H1 (org branch): low-clearance viewer sees only at-or-below-clearance member affiliates', async () => {
        orgDossierFixture();
        const orgs = (await getDossier('SHADOWCORP', viewer())).affiliates?.map(a => a.targetId) ?? [];
        expect(orgs).toContain('GruntA');
        expect(orgs).not.toContain('SleeperB');
    });

    it('H1 (org branch): intel:manage sees the classified member affiliate', async () => {
        orgDossierFixture();
        const orgs = (await getDossier('SHADOWCORP', viewer({ permissions: ['intel:manage'] }))).affiliates?.map(a => a.targetId) ?? [];
        expect(orgs).toEqual(expect.arrayContaining(['GruntA', 'SleeperB']));
    });
});

// Write-side clamp wired into intel/operation create with the right bypass.
describe('intel/operation create write-side clamp (H8)', () => {
    const actor = (level: number, over: Record<string, unknown> = {}) =>
        ({ clearanceLevel: { level }, limitingMarkers: [], permissions: [], role: 'Member', ...over });

    it('createIntelReport rejects a below-clearance author labelling above their clearance', async () => {
        await expect(createIntelReport({ targetId: 'x', classificationLevel: 5, user: actor(2) }))
            .rejects.toThrow(/above your own clearance/i);
    });

    it('createIntelReport allows an intel:manage author to classify high (pins the intel:manage bypass)', async () => {
        // If the call site used the wrong bypass perm (e.g. operations:manage),
        // this intel:manage actor would be rejected — so this pins the wiring.
        await expect(createIntelReport({ targetId: 'x', classificationLevel: 5, user: actor(0, { permissions: ['intel:manage'] }) }))
            .resolves.toBeUndefined();
    });

    it('createOperation rejects a below-clearance creator setting a clearance above their own', async () => {
        await expect(createOperation({ ownerId: 6, userId: 6, name: 'Op', clearanceLevel: 5, user: actor(2) }))
            .rejects.toThrow(/above your own clearance/i);
    });

    it('createIntelBulletin rejects a below-clearance author labelling above their clearance (sweep)', async () => {
        await expect(createIntelBulletin({ title: 'Alert', body: 'x', classificationLevel: 5, user: actor(2) }))
            .rejects.toThrow(/above your own clearance/i);
    });

    it('createIntelBulletin allows an intel:manage author to classify high', async () => {
        // intel:manage bypasses the clamp; the insert returns a row so the
        // post-insert broadcast has an id.
        h.resolveQuery = () => ({ data: { id: 'b1', created_by_id: 0 }, error: null });
        await expect(createIntelBulletin({ title: 'Alert', body: 'x', classificationLevel: 5, user: actor(0, { permissions: ['intel:manage'] }) }))
            .resolves.toBeDefined();
    });
});

// Op voice token honours limiting markers (not level-only).
describe('generateOpRadioToken op-visibility gate (H4)', () => {
    function opFixture(clearanceLevel: number, markers: Array<{ marker: unknown }> = []) {
        h.resolveQuery = ({ table, calls }) => {
            if (table !== 'operations') return { data: null, error: null };
            const sel = String(calls.find(c => c.method === 'select')?.args[0] ?? '');
            if (sel === 'id, owner_id') return { data: { id: 'op1', owner_id: 99 }, error: null };
            // assertOpVisibleToUser's richer select
            return { data: { id: 'op1', owner_id: 99, clearance_level: clearanceLevel, limiting_markers: markers }, error: null };
        };
    }

    it('a compartment-excluded member (level ok, marker missing) is denied', async () => {
        opFixture(0, [{ marker: { id: 7, code: 'COSMIC', name: 'COSMIC' } }]);
        await expect(generateOpRadioToken(
            { id: 6, permissions: ['operations:view'], clearanceLevel: { level: 5 }, limitingMarkers: [] },
            'op1',
        )).rejects.toThrow(/clearance|operation channel/i);
    });

    it('a below-clearance member is denied', async () => {
        opFixture(4);
        await expect(generateOpRadioToken(
            { id: 6, permissions: ['operations:view'], clearanceLevel: { level: 0 }, limitingMarkers: [] },
            'op1',
        )).rejects.toThrow(/clearance|operation channel/i);
    });

    it('a sufficiently-cleared member PASSES auth (then fails on missing LiveKit config)', async () => {
        opFixture(3);
        await expect(generateOpRadioToken(
            { id: 6, permissions: ['operations:view'], clearanceLevel: { level: 5 }, limitingMarkers: [] },
            'op1',
        )).rejects.toThrow(/configuration missing/i);
    });

    it('a member without operations:view is denied outright', async () => {
        opFixture(0);
        await expect(generateOpRadioToken(
            { id: 6, permissions: [], clearanceLevel: { level: 9 }, limitingMarkers: [] },
            'op1',
        )).rejects.toThrow(/clearance|operation channel/i);
    });
});

describe('generateRadioToken restricted-unit voice gate (G1)', () => {
    // Drives generateRadioToken -> assertUnitAccess through the same mock. A
    // viewer that PASSES the gate falls through to the nulled LiveKit secrets and
    // fails on 'configuration missing', so that string means "gate passed".
    //
    // Every caller here carries a STAFF permission: base channels are staff-only
    // (lib/staffPerms hasAnyStaffViewPerm) and that gate runs before the linked-unit
    // check, so a permissionless caller would now be refused for the wrong reason.
    // `viewerPerms` is separate — it seeds the users row assertUnitAccess reads.
    function radioFixture(opts: { linkedUnit: number | null; restricted: boolean; viewerUnitId: number | null; viewerPerms?: string[] }) {
        h.resolveQuery = ({ table, calls }) => {
            if (table === 'radio_channels') return { data: { id: 'chan-1' }, error: null };
            if (table === 'units') {
                const eqCols = calls.filter(c => c.method === 'eq').map(c => c.args[0]);
                // generateRadioToken's linked-units lookup (eq linked_channel_id) — returns an ARRAY.
                if (eqCols.includes('linked_channel_id')) {
                    return { data: opts.linkedUnit ? [{ id: opts.linkedUnit, is_restricted: opts.restricted }] : [], error: null };
                }
                // assertUnitAccess's restriction lookup (eq id) — single row.
                return { data: opts.linkedUnit ? { id: opts.linkedUnit, is_restricted: opts.restricted } : null, error: null };
            }
            if (table === 'users') return {
                data: { unit_id: opts.viewerUnitId, role: { role_permissions: (opts.viewerPerms || []).map(name => ({ permission: { name } })) } },
                error: null,
            };
            return { data: null, error: null };
        };
    }

    it('a non-member is denied a token for a restricted unit channel', async () => {
        radioFixture({ linkedUnit: 5, restricted: true, viewerUnitId: 99, viewerPerms: [] });
        await expect(generateRadioToken({ id: 6, permissions: ['operations:view'] }, 'radio-chan-1'))
            .rejects.toThrow(/restricted/i);
    });

    it('a unit member PASSES the gate (then fails on missing LiveKit config)', async () => {
        radioFixture({ linkedUnit: 5, restricted: true, viewerUnitId: 5, viewerPerms: [] });
        await expect(generateRadioToken({ id: 5, permissions: ['operations:view'] }, 'radio-chan-1'))
            .rejects.toThrow(/configuration missing/i);
    });

    it('a member holding units:view_all PASSES the gate for a restricted channel', async () => {
        // units:view_all is deliberately NOT a staff-view perm (it is grantable to
        // customers), so the caller also carries operations:view to clear the base
        // gate — units:view_all is what assertUnitAccess reads off the users row.
        radioFixture({ linkedUnit: 5, restricted: true, viewerUnitId: 99, viewerPerms: ['units:view_all'] });
        await expect(generateRadioToken({ id: 6, permissions: ['units:view_all', 'operations:view'] }, 'radio-chan-1'))
            .rejects.toThrow(/configuration missing/i);
    });

    it('a general channel not linked to any unit stays open to all STAFF', async () => {
        radioFixture({ linkedUnit: null, restricted: false, viewerUnitId: 99, viewerPerms: [] });
        await expect(generateRadioToken({ id: 6, permissions: ['operations:view'] }, 'radio-chan-1'))
            .rejects.toThrow(/configuration missing/i);
    });

    it('a caller holding only client-default perms is denied a base channel outright', async () => {
        // The base-channel gate used to live ONLY in RadioWidget's render filter, so a
        // Client could POST radio:auth for the org's dispatch net and get a 6h grant.
        // They must be refused before the LiveKit config sentinel is ever reached.
        radioFixture({ linkedUnit: null, restricted: false, viewerUnitId: 99, viewerPerms: [] });
        await expect(generateRadioToken({ id: 6, permissions: ['request:create', 'request:cancel', 'request:rate'] }, 'radio-chan-1'))
            .rejects.toThrow(/not authorized/i);
    });

    it('denies a non-member even when an OPEN unit is also linked to the restricted channel (multi-unit dodge closed)', async () => {
        // Two units share the channel: a restricted one (id 5) and the viewer's open
        // one (id 6). The viewer is a member of the open unit but not the restricted —
        // they must still be denied (every restricted linked unit is checked).
        h.resolveQuery = ({ table, calls }) => {
            if (table === 'radio_channels') return { data: { id: 'chan-1' }, error: null };
            if (table === 'units') {
                const eqCols = calls.filter(c => c.method === 'eq').map(c => c.args[0]);
                if (eqCols.includes('linked_channel_id')) {
                    return { data: [{ id: 5, is_restricted: true }, { id: 6, is_restricted: false }], error: null };
                }
                // assertUnitAccess restriction lookup for the restricted unit id 5
                return { data: { id: 5, is_restricted: true }, error: null };
            }
            if (table === 'users') return { data: { unit_id: 6, role: { role_permissions: [] } }, error: null }; // member of the OPEN unit only
            return { data: null, error: null };
        };
        await expect(generateRadioToken({ id: 9, permissions: ['operations:view'] }, 'radio-chan-1'))
            .rejects.toThrow(/restricted/i);
    });
});

// Write-side clearance integrity (assertCanClassify + wiki guards).
describe('assertCanClassify (H8)', () => {
    const u = (level: number, markers: unknown[] = [], over: Record<string, unknown> = {}) =>
        ({ clearanceLevel: { level }, limitingMarkers: markers, permissions: [], role: 'Member', ...over } as unknown as User);

    it('rejects classifying above the author clearance', () => {
        expect(() => assertCanClassify(u(2), 5, [])).toThrow(/above your own clearance/i);
    });
    it('allows classifying at or below the author clearance', () => {
        expect(() => assertCanClassify(u(3), 3, [])).not.toThrow();
        expect(() => assertCanClassify(u(3), 0, [])).not.toThrow();
    });
    it('rejects applying a marker the author does not hold', () => {
        expect(() => assertCanClassify(u(5, [{ id: 1 }]), 0, [2])).toThrow(/marker you do not hold/i);
    });
    it('allows markers the author holds', () => {
        expect(() => assertCanClassify(u(5, [{ id: 1 }, { id: 2 }]), 0, [1, 2])).not.toThrow();
    });
    it('the stamped system Admin classifies anything', () => {
        expect(() => assertCanClassify(u(0, [], { isSystemAdmin: true }), 5, [9])).not.toThrow();
    });
    // ROLE NAME IS NOT AUTHORITY: `role` is inferred from the role row's free-text
    // name, so a permissionless custom role called 'Commander' classified anything.
    it('a forged Admin role NAME does NOT classify above its own clearance', () => {
        expect(() => assertCanClassify(u(0, [], { role: 'Admin' }), 5, [9])).toThrow(/above your own clearance/i);
    });
    it('a domain-manage bypass holder classifies anything', () => {
        expect(() => assertCanClassify(u(0, [], { permissions: ['intel:manage'] }), 5, [9], ['intel:manage'])).not.toThrow();
    });
    it('fails closed for no user', () => {
        expect(() => assertCanClassify(null, 1, [])).toThrow();
        expect(() => assertCanClassify(undefined, 0, [3])).toThrow();
    });
});

describe('wiki write-side clearance (H8)', () => {
    it('createWikiPage rejects labelling above the author clearance', async () => {
        await expect(createWikiPage({ title: 'SOP', classificationLevel: 5 }, 6, viewer())).rejects.toThrow(/above your own clearance/i);
    });

    it('updateWikiPage blocks downgrading a page the author cannot currently see', async () => {
        // Current page is level 5; a level-0 author tries to relabel it to 0.
        h.resolveQuery = ({ table }) => table === 'wiki_pages'
            ? { data: { classification_level: 5, wiki_page_limiting_markers: [] }, error: null }
            : { data: null, error: null };
        await expect(updateWikiPage('p1', { classificationLevel: 0 }, 6, viewer())).rejects.toThrow(/not cleared/i);
    });

    it('updateWikiPage blocks a CONTENT-only edit to a page the author cannot see (vandalism guard)', async () => {
        // No classification fields in the payload — the live-row visibility check
        // must still fire (content/title integrity of a classified page).
        h.resolveQuery = ({ table }) => table === 'wiki_pages'
            ? { data: { classification_level: 5, wiki_page_limiting_markers: [] }, error: null }
            : { data: null, error: null };
        await expect(updateWikiPage('p1', { content: { type: 'doc', content: [] }, title: 'pwned' }, 6, viewer()))
            .rejects.toThrow(/not cleared/i);
    });

    it('updateWikiPage blocks a MARKER-only relabel on a page the author cannot see', async () => {
        h.resolveQuery = ({ table }) => table === 'wiki_pages'
            ? { data: { classification_level: 3, wiki_page_limiting_markers: [{ marker: { id: 1, code: 'X', name: 'X' } }] }, error: null }
            : { data: null, error: null };
        await expect(updateWikiPage('p1', { markerIds: [1] }, 6, viewer())).rejects.toThrow(/not cleared/i);
    });

    it('updateWikiPage lets a cleared author relabel within their clearance', async () => {
        h.resolveQuery = ({ table }) => table === 'wiki_pages'
            ? { data: { classification_level: 2, wiki_page_limiting_markers: [] }, error: null }
            : { data: null, error: null };
        // level-3 author can see the level-2 page and relabel to level 3
        await expect(updateWikiPage('p1', { classificationLevel: 3 }, 6, viewer({ clearanceLevel: { level: 3 } }))).resolves.toBeUndefined();
    });
});

// Client IP resolution is trusted-proxy aware.
describe('getClientIp trusted-proxy resolution (H6)', () => {
    const req = (over: Record<string, unknown>) => ({ headers: {}, ip: undefined, ...over } as unknown as Parameters<typeof getClientIp>[0]);

    it('ignores CF-Connecting-IP unless TRUST_CF_PROXY=1', () => {
        delete process.env.TRUST_CF_PROXY;
        expect(getClientIp(req({ headers: { 'cf-connecting-ip': '6.6.6.6' }, ip: '1.2.3.4' }))).toBe('1.2.3.4');
    });
    it('ignores a spoofed X-Forwarded-For (never hand-parsed) — uses req.ip', () => {
        delete process.env.TRUST_CF_PROXY;
        expect(getClientIp(req({ headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }, ip: '1.2.3.4' }))).toBe('1.2.3.4');
    });
    it('honours CF-Connecting-IP only when TRUST_CF_PROXY=1', () => {
        process.env.TRUST_CF_PROXY = '1';
        try {
            expect(getClientIp(req({ headers: { 'cf-connecting-ip': '9.9.9.9' }, ip: '1.2.3.4' }))).toBe('9.9.9.9');
        } finally {
            delete process.env.TRUST_CF_PROXY;
        }
    });
    it('returns "unknown" when nothing identifies the caller', () => {
        delete process.env.TRUST_CF_PROXY;
        expect(getClientIp(req({}))).toBe('unknown');
    });
});

// Push endpoint host allow-list (stored-SSRF guard).
describe('isAllowedPushEndpoint (H7)', () => {
    it('accepts real Web-Push vendor hosts over https', () => {
        expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
        expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
        expect(isAllowedPushEndpoint('https://web.push.apple.com/xyz')).toBe(true);
        expect(isAllowedPushEndpoint('https://abc.notify.windows.com/w/?token=x')).toBe(true);
    });
    it('rejects internal / private SSRF targets', () => {
        expect(isAllowedPushEndpoint('https://10.0.0.5:8443/internal-admin')).toBe(false);
        expect(isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data/')).toBe(false);
        expect(isAllowedPushEndpoint('http://localhost/x')).toBe(false);
    });
    it('rejects non-https and lookalike hosts', () => {
        expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
        expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
        expect(isAllowedPushEndpoint('https://evilgoogleapis.com/x')).toBe(false);
        expect(isAllowedPushEndpoint('')).toBe(false);
        expect(isAllowedPushEndpoint(null)).toBe(false);
    });
    it('exposes a finite per-user cap', () => {
        expect(MAX_PUSH_SUBSCRIPTIONS_PER_USER).toBeGreaterThan(0);
        expect(MAX_PUSH_SUBSCRIPTIONS_PER_USER).toBeLessThanOrEqual(50);
    });
});
