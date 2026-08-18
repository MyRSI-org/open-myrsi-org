import { describe, it, expect, vi, beforeEach } from 'vitest';

// An operation template stores the clearance of the op it was extracted from, so
// a low-clearance member can't read a classified op's plan via the template list /
// single fetch. Operations managers bypass, mirroring op visibility.

const h = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
    lastInsert: null as Record<string, unknown> | null,
    lastUpdate: null as Record<string, unknown> | null,
    deleted: false,
}));

vi.mock('../lib/db/common', () => {
    const builder = () => {
        const b: any = { _insert: null };
        b.select = () => b; b.order = () => b; b.eq = () => b;
        b.insert = (v: Record<string, unknown>) => { h.lastInsert = v; b._insert = v; return b; };
        b.update = (v: Record<string, unknown>) => { h.lastUpdate = v; return b; };
        b.delete = () => { h.deleted = true; return b; };
        // assertTemplateVisible reads the live clearance through maybeSingle.
        b.maybeSingle = () => Promise.resolve({ data: h.rows[0] ?? null, error: null });
        b.single = () => b._insert
            ? Promise.resolve({ data: { id: 99, created_at: 't', updated_at: 't', ...(b._insert as object) }, error: null })
            : Promise.resolve({ data: h.rows[0] ?? null, error: h.rows.length ? null : { code: 'PGRST116' } });
        return b;
    };
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: () => {},
        safeFetch: async () => h.rows,
    };
});

import { listOperationTemplates, getOperationTemplate, createOperationTemplate, instantiateTemplateOnOperation, updateOperationTemplate, deleteOperationTemplate } from '../lib/db/operation-templates';

const tplRow = (over: Record<string, unknown> = {}) => ({
    id: 1, name: 'Plan', description: null, created_by: 1, creator: { name: 'A' },
    created_at: 't', updated_at: 't', payload: { phases: [] },
    classification_level: 0, limiting_marker_ids: [], ...over,
});

const L0 = { clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: [] as string[] };
const L5 = { clearanceLevel: { level: 5 }, limitingMarkers: [], permissions: [] as string[] };
const L5mk = { clearanceLevel: { level: 5 }, limitingMarkers: [{ id: 7 }], permissions: [] as string[] };
const MGR = { clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['operations:manage'] };

beforeEach(() => { h.rows = []; h.lastInsert = null; h.lastUpdate = null; h.deleted = false; });

describe('operation template clearance gating', () => {
    it('hides an above-clearance template from a low-clearance viewer', async () => {
        h.rows = [tplRow({ id: 1, classification_level: 0 }), tplRow({ id: 2, classification_level: 4 })];
        expect((await listOperationTemplates(L0)).map(t => t.id)).toEqual([1]);
    });

    it('shows an above-clearance template to a sufficiently-cleared viewer', async () => {
        h.rows = [tplRow({ id: 2, classification_level: 4 })];
        expect((await listOperationTemplates(L5)).map(t => t.id)).toEqual([2]);
    });

    it('enforces limiting markers — level alone is not enough', async () => {
        h.rows = [tplRow({ id: 3, classification_level: 1, limiting_marker_ids: [7] })];
        expect(await listOperationTemplates(L5)).toEqual([]);
        expect((await listOperationTemplates(L5mk)).map(t => t.id)).toEqual([3]);
    });

    it('operations managers bypass the clearance filter', async () => {
        h.rows = [tplRow({ id: 4, classification_level: 9, limiting_marker_ids: [7] })];
        expect((await listOperationTemplates(MGR)).map(t => t.id)).toEqual([4]);
    });

    it('getOperationTemplate withholds an above-clearance template, but server-internal calls bypass', async () => {
        h.rows = [tplRow({ id: 5, classification_level: 4 })];
        expect(await getOperationTemplate(5, L0)).toBeNull();
        expect((await getOperationTemplate(5, L5))?.id).toBe(5);
        expect((await getOperationTemplate(5))?.id).toBe(5);
    });

    it('createOperationTemplate stamps the supplied source clearance', async () => {
        await createOperationTemplate(1, 'Plan', null, { phases: [{ name: 'P' }] }, { classificationLevel: 3, markerIds: [7, 8] });
        expect(h.lastInsert?.classification_level).toBe(3);
        expect(h.lastInsert?.limiting_marker_ids).toEqual([7, 8]);
    });

    it('defaults to unclassified when no clearance is supplied', async () => {
        await createOperationTemplate(1, 'Plan', null, { phases: [{ name: 'P' }] });
        expect(h.lastInsert?.classification_level).toBe(0);
        expect(h.lastInsert?.limiting_marker_ids).toEqual([]);
    });

    it('instantiating refuses a template the op creator cannot see', async () => {
        h.rows = [tplRow({ id: 6, classification_level: 4 })];
        await expect(instantiateTemplateOnOperation('op1', 6, {}, L0)).rejects.toThrow(/not found/i);
    });
});

// The mutation twins. list/get were clearance-gated from the start, but
// update/delete were reachable with 'operations:create' alone — a LOWER bar than
// the 'operations:manage' bypass in the read gate. Because update re-selects the
// row it also handed back the full payload (the source op's entire plan) that
// template:get denies. These pin the gate on the write side so the two can't drift.
describe('operation template clearance gating — mutation paths', () => {
    it('update refuses a viewer below the template clearance', async () => {
        h.rows = [tplRow({ id: 7, classification_level: 4 })];
        await expect(updateOperationTemplate(7, { name: 'pwned' }, L0)).rejects.toThrow(/not cleared/i);
        // Refused BEFORE the write and before the row is re-selected.
        expect(h.lastUpdate).toBeNull();
    });

    it('update allows a sufficiently-cleared viewer', async () => {
        h.rows = [tplRow({ id: 7, classification_level: 4 })];
        await expect(updateOperationTemplate(7, { name: 'ok' }, L5)).resolves.toBeTruthy();
        expect(h.lastUpdate?.name).toBe('ok');
    });

    it('update enforces limiting markers — level alone is not enough', async () => {
        h.rows = [tplRow({ id: 8, classification_level: 1, limiting_marker_ids: [7] })];
        await expect(updateOperationTemplate(8, { name: 'x' }, L5)).rejects.toThrow(/not cleared/i);
        await expect(updateOperationTemplate(8, { name: 'x' }, L5mk)).resolves.toBeTruthy();
    });

    it('operations managers bypass the update gate', async () => {
        h.rows = [tplRow({ id: 9, classification_level: 9, limiting_marker_ids: [7] })];
        await expect(updateOperationTemplate(9, { name: 'x' }, MGR)).resolves.toBeTruthy();
    });

    it('server-internal update (no viewer) bypasses the gate', async () => {
        h.rows = [tplRow({ id: 10, classification_level: 9 })];
        await expect(updateOperationTemplate(10, { name: 'x' })).resolves.toBeTruthy();
    });

    it('delete refuses a viewer below the template clearance', async () => {
        h.rows = [tplRow({ id: 11, classification_level: 4 })];
        await expect(deleteOperationTemplate(11, L0)).rejects.toThrow(/not cleared/i);
        expect(h.deleted).toBe(false);
    });

    it('delete allows a sufficiently-cleared viewer and server-internal callers', async () => {
        h.rows = [tplRow({ id: 11, classification_level: 4 })];
        await expect(deleteOperationTemplate(11, L5)).resolves.toBeUndefined();
        expect(h.deleted).toBe(true);
        h.deleted = false;
        await expect(deleteOperationTemplate(11)).resolves.toBeUndefined();
        expect(h.deleted).toBe(true);
    });

    it('a missing row soft-passes so callers see their normal not-found path', async () => {
        h.rows = [];
        await expect(deleteOperationTemplate(404, L0)).resolves.toBeUndefined();
    });
});
