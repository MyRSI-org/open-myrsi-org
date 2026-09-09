import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// Blueprint Manager — registry consent, request lifecycle, and the amplifier
// =============================================================================
// Four things this module can get wrong, in descending order of how much it costs:
//
//  1. THE AMPLIFIER. Every raised request fans a notification to every
//     blueprint:craft holder, and in this build one notification is a row insert
//     PLUS a realtime broadcast PLUS a web push. MAX_OPEN_REQUESTS_PER_REQUESTER is
//     the only bound on it, so the count read that enforces it must fail CLOSED —
//     hosted discards that query's error, which makes any read fault (42P01, a
//     statement timeout) read as "cap satisfied".
//
//  2. CONSENT. `offers_crafting` is not a property of an item, it is a member
//     saying they will do work. blueprint:manage moderates other people's rows and
//     still may not set it — and a departing member's is cleared for them.
//
//  3. THE A-B-A. Status alone is not enough to advance a request: crafter A reads
//     a `claimed` row, releases it, crafter B claims it, and A's in-flight UPDATE
//     still matches `status = 'claimed'`. Every transition re-asserts the ACTOR.
//
//  4. EGRESS. /api/services returns a handler result directly — stripSecrets is on
//     the /api/query path only — so the two mappers are the whole narrowing.

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Blank comments length-preservingly, so no assertion can be satisfied by the
 *  prose that explains it. */
function codeOnly(s: string): string {
    let out = '', i = 0, mode: string | null = null;
    const BACKSLASH = String.fromCharCode(92);
    while (i < s.length) {
        const c = s[i], n = s[i + 1];
        if (mode === null) {
            if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
            if (c === '`' || c === "'" || c === '"') { mode = c; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (mode === 'line') { if (c === '\n') { mode = null; out += c; } else out += ' '; i++; continue; }
        if (mode === 'block') { if (c === '*' && n === '/') { mode = null; out += '  '; i += 2; continue; } out += (c === '\n' ? c : ' '); i++; continue; }
        if (c === BACKSLASH) { out += c + (s[i + 1] || ''); i += 2; continue; }
        if (c === mode) { mode = null; out += c; i++; continue; }
        out += c; i++;
    }
    return out;
}

function sqlCodeOnly(s: string): string {
    return s.split('\n').map(line => {
        const i = line.indexOf('--');
        return i === -1 ? line : line.slice(0, i) + ' '.repeat(line.length - i);
    }).join('\n');
}

/** Forward slice between two anchors, refusing to run backwards — a backwards
 *  slice yields '' and every assertion on it passes vacuously. */
function between(src: string, a: string, b: string): string {
    const i = src.indexOf(a);
    expect(i, `anchor missing: ${a}`).toBeGreaterThan(-1);
    const j = src.indexOf(b, i + a.length);
    expect(j, `anchor missing after ${a}: ${b}`).toBeGreaterThan(i);
    const slice = src.slice(i, j);
    expect(slice.length, `slice ${a} → ${b} reached no code`).toBeGreaterThan(a.length);
    return slice;
}

// ── Behavioural harness ──────────────────────────────────────────────────────
const h = vi.hoisted(() => {
    const rows = new Map<string, unknown>();
    const lists = new Map<string, unknown[]>();
    const counts = new Map<string, number | null>();
    // Successive count reads on ONE table: createBlueprintRequest now issues TWO
    // (the concurrency cap, then the rate bound), and they must be able to differ.
    const countQueue = new Map<string, Array<number | null>>();
    const rowErrors = new Map<string, unknown>();
    const listErrors = new Map<string, unknown>();
    const writes: Array<{ table: string; op: string; arg: unknown }> = [];
    const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const makeBuilder = (table: string) => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'neq', 'not', 'is', 'or', 'order', 'limit', 'range', 'gte', 'ilike', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return b; };
        }
        for (const m of ['insert', 'update', 'delete']) b[m] = (arg: unknown) => { writes.push({ table, op: m, arg }); return b; };
        b.maybeSingle = async () => ({ data: rows.get(table) ?? null, error: rowErrors.get(table) ?? null });
        b.single = async () => ({ data: rows.get(table) ?? null, error: rowErrors.get(table) ?? null });
        b.then = (resolve2: (v: unknown) => unknown) => resolve2({
            data: lists.get(table) ?? [],
            error: listErrors.get(table) ?? null,
            count: (countQueue.get(table)?.length ? countQueue.get(table)!.shift() : (counts.has(table) ? counts.get(table) : 0)),
        });
        return b;
    };
    const supabaseStub = { from: (t: string) => makeBuilder(t) };
    return { rows, lists, counts, countQueue, rowErrors, listErrors, writes, calls, supabaseStub };
});

vi.mock('../lib/db/common.js', () => ({
    supabase: h.supabaseStub,
    handleSupabaseError: ({ error, message }: { error: unknown; message?: string }) => {
        if (error) throw new Error(message || 'db error');
    },
    broadcastToOrg: () => Promise.resolve(),
    getSystemRoles: async () => ({}),
    safeFetch: async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
        const { data, error } = await query; return error ? fallback : (data ?? fallback);
    },
}));

import {
    listBlueprints, listCraftableItems, registerBlueprint, updateBlueprint, deleteBlueprint,
    withdrawCraftingOffers, listBlueprintRequests, createBlueprintRequest,
    claimBlueprintRequest, releaseBlueprintRequest, markBlueprintRequestReady,
    markBlueprintRequestDelivered, confirmBlueprintRequestReceived, cancelBlueprintRequest,
    getCraftNotifyIds,
} from '../lib/db/blueprints';
import { toBlueprint, toCraftableItem, toBlueprintRequest } from '../lib/db/mappers';
import { SecurityDenial } from '../lib/errors';

const OWNER = 7;
const OTHER = 9;

/** A row shaped enough for toBlueprintRequest, so an insert's returning select maps. */
const requestRow = (over: Record<string, unknown> = {}) => ({
    id: 5, requester_id: OWNER, crafter_id: null, blueprint_id: null, qm_catalog_id: null,
    item_name: 'Widget', quantity: 1, materials_note: null, offer_price_uec: null,
    status: 'open', claimed_at: null, ready_at: null, delivered_at: null,
    completed_at: null, cancelled_at: null, cancel_reason: null,
    created_at: 'x', updated_at: 'x', ...over,
});

beforeEach(() => {
    h.rows.clear(); h.lists.clear(); h.counts.clear(); h.countQueue.clear();
    h.rowErrors.clear(); h.listErrors.clear();
    h.writes.length = 0; h.calls.length = 0;
});

const BP_SRC = codeOnly(read('lib/db/blueprints.ts'));
const ACTIONS_SRC = codeOnly(read('api/actions/blueprints.ts'));
const SERVICES_SRC = codeOnly(read('api/services.ts'));
const SCHEMA_SRC = sqlCodeOnly(read('schema.sql'));
const MAPPERS_SRC = codeOnly(read('lib/db/mappers.ts'));

// ════════════════════════════════════════════════════════════════════════════
describe('the notification amplifier is bounded, and the bound fails closed', () => {
    it('a count READ FAULT refuses the request instead of reading as "cap satisfied"', async () => {
        // Hosted destructures only `count`, so 42P01 / a statement timeout yields
        // count === null → `?? 0` → the cap passes and the fan-out fires unbounded.
        h.listErrors.set('blueprint_requests', { code: '42P01', message: 'relation does not exist' });
        await expect(createBlueprintRequest({ itemName: 'Widget' }, OWNER)).rejects.toThrow();
        expect(h.writes.filter(w => w.op === 'insert'), 'no request may be inserted on a count fault').toEqual([]);
    });

    it('a null count is a refusal, not a zero', async () => {
        h.counts.set('blueprint_requests', null);
        await expect(createBlueprintRequest({ itemName: 'Widget' }, OWNER)).rejects.toThrow(/Could not verify/i);
        expect(h.writes.filter(w => w.op === 'insert')).toEqual([]);
    });

    it('at the ceiling the request is refused before anything is written', async () => {
        h.counts.set('blueprint_requests', 10);
        await expect(createBlueprintRequest({ itemName: 'Widget' }, OWNER)).rejects.toThrow(/already have 10/i);
        expect(h.writes).toEqual([]);
    });

    it('the ceiling counts every UNCLOSED state, not just open ones', () => {
        const section = between(BP_SRC, 'export async function createBlueprintRequest', 'export async function claimBlueprintRequest');
        expect(section).toContain("'open', 'claimed', 'ready', 'delivered'");
        // A completed or cancelled request is closed and must not hold a slot.
        expect(section).not.toContain("'completed'");
    });

    it('the fan-out recipient set is capped and deterministic at every hop', async () => {
        h.lists.set('permissions', [{ id: 1 }]);
        h.lists.set('role_permissions', [{ role_id: 3 }]);
        h.lists.set('users', [{ id: 4 }, { id: OWNER }]);
        const ids = await getCraftNotifyIds(OWNER);
        expect(ids).toEqual([4]);                    // the requester is excluded
        const limits = h.calls.filter(c => c.method === 'limit');
        expect(limits.length).toBe(3);
        expect(limits.some(l => l.args[0] === 50), 'the users hop must carry MAX_NOTIFY_FANOUT').toBe(true);
        // Departed members are not notified.
        expect(h.calls.some(c => c.table === 'users' && c.method === 'is' && c.args[0] === 'deleted_at')).toBe(true);
    });

    it('a missing blueprint:craft permission row notifies NOBODY, never everybody', async () => {
        h.lists.set('permissions', []);
        expect(await getCraftNotifyIds(OWNER)).toEqual([]);
        h.lists.set('permissions', [{ id: 1 }]);
        h.lists.set('role_permissions', []);
        expect(await getCraftNotifyIds(OWNER)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('offering to craft is consent, and consent does not transfer', () => {
    beforeEach(() => { h.rows.set('blueprints', { id: 1, owner_id: OWNER, item_name: 'Widget' }); });

    it('a blueprint:manage holder cannot switch on someone else\'s offer', async () => {
        await expect(updateBlueprint(1, { offersCrafting: true }, OTHER, true)).rejects.toBeInstanceOf(SecurityDenial);
        expect(h.writes).toEqual([]);
    });

    it('…nor switch it OFF, which is the same decision in reverse', async () => {
        await expect(updateBlueprint(1, { offersCrafting: false }, OTHER, true)).rejects.toBeInstanceOf(SecurityDenial);
        expect(h.writes).toEqual([]);
    });

    it('a blueprint:manage holder MAY still moderate the row itself', async () => {
        await updateBlueprint(1, { itemName: 'Renamed', notes: 'moderated' }, OTHER, true);
        const patch = h.writes.find(w => w.op === 'update')?.arg as Record<string, unknown>;
        expect(patch.item_name).toBe('Renamed');
        expect(patch).not.toHaveProperty('offers_crafting');
    });

    it('the owner may set their own offer', async () => {
        await updateBlueprint(1, { offersCrafting: true }, OWNER, false);
        const patch = h.writes.find(w => w.op === 'update')?.arg as Record<string, unknown>;
        expect(patch.offers_crafting).toBe(true);
    });

    it('a stranger with neither ownership nor manage cannot edit or remove', async () => {
        await expect(updateBlueprint(1, { itemName: 'x' }, OTHER, false)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(deleteBlueprint(1, OTHER, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(h.writes).toEqual([]);
    });

    it('a missing row and a forbidden one give the SAME answer — no existence oracle', async () => {
        h.rows.delete('blueprints');
        const missing = await updateBlueprint(1, { itemName: 'x' }, OWNER, true).catch(e => (e as Error).message);
        const bad = await updateBlueprint(0, { itemName: 'x' }, OWNER, true).catch(e => (e as Error).message);
        expect(missing).toBe(bad);
    });
});

describe('the update allowlist is the only thing standing between a patch and the row', () => {
    beforeEach(() => { h.rows.set('blueprints', { id: 1, owner_id: OWNER }); });

    it('ignores every actor-id field the dispatcher rewrote into the payload', async () => {
        // The handler rest-spreads the payload minus blueprintId/userId/user, so every
        // OTHER ACTOR_ID_FIELDS key arrives here. None may reach a column.
        await updateBlueprint(1, {
            itemName: 'Widget',
            ownerId: OTHER, authorId: OTHER, creatorId: OTHER, requesterId: OTHER,
            actorId: OTHER, adminId: OTHER, senderId: OTHER, issuerId: OTHER,
        }, OWNER, false);
        const patch = h.writes.find(w => w.op === 'update')?.arg as Record<string, unknown>;
        expect(Object.keys(patch).sort()).toEqual(['item_name', 'updated_at']);
    });

    it('ignores category — it follows the catalog pin, never the client', async () => {
        await updateBlueprint(1, { category: 'weapon' }, OWNER, false);
        const patch = h.writes.find(w => w.op === 'update')?.arg as Record<string, unknown>;
        expect(patch).not.toHaveProperty('category');
    });

    it('clearing the catalog pin clears the category with it', async () => {
        await updateBlueprint(1, { qmCatalogId: null }, OWNER, false);
        const patch = h.writes.find(w => w.op === 'update')?.arg as Record<string, unknown>;
        expect(patch.qm_catalog_id).toBeNull();
        expect(patch.category).toBeNull();
    });

    it('a catalog pin that does not exist is refused, and is NOT a security event', async () => {
        h.rows.delete('quartermaster_catalog');
        await expect(updateBlueprint(1, { qmCatalogId: 55 }, OWNER, false)).rejects.toThrow(/catalog item was not found/i);
        // Single-org: a bad reference is a bad reference. Emitting a cross_org denial
        // here would write a permanent lie into security_events.
        expect(BP_SRC).not.toContain('cross_org');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the request lifecycle re-asserts the actor, not just the status', () => {
    const seedRequest = (over: Record<string, unknown> = {}) =>
        h.rows.set('blueprint_requests', requestRow(over));

    it('a claim pins "still unclaimed" in the WHERE clause', async () => {
        seedRequest();
        await claimBlueprintRequest(5, OTHER);
        const isCalls = h.calls.filter(c => c.table === 'blueprint_requests' && c.method === 'is');
        expect(isCalls.some(c => c.args[0] === 'crafter_id' && c.args[1] === null)).toBe(true);
    });

    it('a member cannot claim their own request', async () => {
        seedRequest();
        await expect(claimBlueprintRequest(5, OWNER)).rejects.toThrow(/your own/i);
        expect(h.writes).toEqual([]);
    });

    it('release pins the crafter it READ, so a third party cannot race a re-claim', async () => {
        seedRequest({ status: 'claimed', crafter_id: OTHER });
        await releaseBlueprintRequest(5, OTHER, false);
        const eqs = h.calls.filter(c => c.table === 'blueprint_requests' && c.method === 'eq');
        expect(eqs.some(c => c.args[0] === 'crafter_id' && c.args[1] === OTHER)).toBe(true);
    });

    it('a claimed row with NO crafter still carries an actor predicate', async () => {
        // Hosted drops the predicate entirely on this branch, turning the swap into a
        // status-only guard on exactly the malformed row that most deserves the check.
        seedRequest({ status: 'claimed', crafter_id: null });
        await releaseBlueprintRequest(5, OWNER, true);
        const isCalls = h.calls.filter(c => c.table === 'blueprint_requests' && c.method === 'is');
        expect(isCalls.some(c => c.args[0] === 'crafter_id' && c.args[1] === null)).toBe(true);
    });

    it('ready and delivered are the crafter\'s alone — manage does not stand in', async () => {
        seedRequest({ status: 'claimed', crafter_id: OTHER });
        await expect(markBlueprintRequestReady(5, OWNER)).rejects.toBeInstanceOf(SecurityDenial);
        h.rows.set('blueprint_requests', { id: 5, requester_id: OWNER, crafter_id: OTHER, status: 'ready' });
        await expect(markBlueprintRequestDelivered(5, OWNER)).rejects.toBeInstanceOf(SecurityDenial);
        expect(h.writes).toEqual([]);
    });

    it('confirming receipt is the requester\'s alone, with no manage bypass anywhere', () => {
        const section = between(BP_SRC, 'export async function confirmBlueprintRequestReceived', 'export async function cancelBlueprintRequest');
        expect(section).toContain('existing.requester_id !== userId');
        expect(section, 'a canManage escape hatch would forge the customer\'s confirmation').not.toContain('canManage');
    });

    it('ownership is checked BEFORE status, so the error cannot be walked as an oracle', async () => {
        // A CLOSED request plus a non-participant is the case that separates the two
        // orders. Ownership first: 'not yours'. Status first: 'already closed' — which
        // tells a stranger the id exists AND what state it reached, one probe at a
        // time, which is exactly what pinning a non-crafter to their own rows in
        // listBlueprintRequests exists to prevent.
        for (const status of ['completed', 'cancelled', 'delivered', 'open']) {
            seedRequest({ status });
            const err = await cancelBlueprintRequest(5, OTHER, false).catch(e => e);
            expect(err, `status=${status} must deny on ownership, not leak state`).toBeInstanceOf(SecurityDenial);
            expect(String((err as Error).message)).not.toMatch(/already closed/i);
        }
        // Wrong state for the RIGHT person still reports the state — they may know it.
        seedRequest({ status: 'completed' });
        await expect(cancelBlueprintRequest(5, OWNER, false)).rejects.toThrow(/already closed/i);

        seedRequest({ status: 'open' });
        await expect(confirmBlueprintRequestReceived(5, OTHER)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('a closed request cannot be cancelled again', async () => {
        for (const status of ['completed', 'cancelled']) {
            h.writes.length = 0;
            seedRequest({ status });
            await expect(cancelBlueprintRequest(5, OWNER, false)).rejects.toThrow(/already closed/i);
            expect(h.writes).toEqual([]);
        }
    });

    it('the visibility ladder narrows to own rows without the craft permission', async () => {
        h.lists.set('blueprint_requests', []);
        await listBlueprintRequests(OWNER, {});
        const eqs = h.calls.filter(c => c.method === 'eq' && c.args[0] === 'requester_id');
        expect(eqs).toHaveLength(1);
        expect(h.calls.some(c => c.method === 'or')).toBe(false);

        h.calls.length = 0;
        await listBlueprintRequests(OWNER, { canCraft: true });
        expect(h.calls.some(c => c.method === 'or')).toBe(true);

        h.calls.length = 0;
        await listBlueprintRequests(OWNER, { canManage: true });
        expect(h.calls.some(c => c.method === 'or')).toBe(false);
        expect(h.calls.some(c => c.method === 'eq' && c.args[0] === 'requester_id')).toBe(false);
    });

    it('a viewer id that is not an integer never reaches the .or() filter string', async () => {
        await expect(listBlueprintRequests('1,status.eq.open' as unknown as number, { canCraft: true })).rejects.toThrow(/Invalid viewerId/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a request can only be raised against somebody ELSE\'s offer', () => {
    it('refuses when nothing on offer matches', async () => {
        h.counts.set('blueprint_requests', 0);
        h.lists.set('blueprints', []);
        await expect(createBlueprintRequest({ itemName: 'Widget' }, OWNER)).rejects.toThrow(/Nobody else/i);
        expect(h.writes).toEqual([]);
    });

    it('excludes the requester\'s OWN offers — a request only they could fill is dead on arrival', async () => {
        h.counts.set('blueprint_requests', 0);
        h.rows.set('blueprint_requests', requestRow());
        h.lists.set('blueprints', [{ item_name: 'Widget' }]);
        await createBlueprintRequest({ itemName: 'Widget' }, OWNER);
        expect(h.calls.some(c => c.table === 'blueprints' && c.method === 'neq' && c.args[0] === 'owner_id')).toBe(true);
    });

    it('persists the REGISTRY\'s canonical name, not the caller\'s string', async () => {
        h.counts.set('blueprint_requests', 0);
        h.rows.set('blueprint_requests', requestRow());
        h.lists.set('blueprints', [{ item_name: 'Ballista Dunestalker' }]);
        await createBlueprintRequest({ itemName: '  ballista DUNESTALKER  ' }, OWNER);
        const insert = h.writes.find(w => w.op === 'insert')?.arg as Record<string, unknown>;
        expect(insert.item_name).toBe('Ballista Dunestalker');
        // …and the crafter is not pinned at creation, which would name the matcher.
        expect(insert.blueprint_id).toBeNull();
        expect(insert.crafter_id).toBeNull();
    });

    it('a LIKE wildcard is escaped, not stripped — it cannot match everything on offer', async () => {
        h.counts.set('blueprint_requests', 0);
        h.lists.set('blueprints', [{ item_name: 'Ballista' }]);
        // The JS compare is exact, so '%' matches nothing even if the ilike widened.
        await expect(createBlueprintRequest({ itemName: '%' }, OWNER)).rejects.toThrow(/Nobody else/i);
        const ilike = h.calls.find(c => c.method === 'ilike');
        expect(String(ilike?.args[1])).toContain(String.fromCharCode(92) + '%');
    });

    it('the underscore wildcard survives as a literal — hosted\'s likeSafe silently deletes it', async () => {
        h.counts.set('blueprint_requests', 0);
        h.rows.set('blueprint_requests', requestRow({ item_name: 'Ballista_5' }));
        h.lists.set('blueprints', [{ item_name: 'Ballista_5' }]);
        await createBlueprintRequest({ itemName: 'Ballista_5' }, OWNER);
        const ilike = h.calls.find(c => c.method === 'ilike');
        expect(String(ilike?.args[1])).toContain('Ballista');
        expect(String(ilike?.args[1])).toContain('_');
    });

    it('the module hand-rolls no LIKE escaper of its own', () => {
        expect(BP_SRC).not.toContain('likeSafe');
        expect(BP_SRC).toContain('escapeLikePattern');
    });

    it('quantity and price are clamped server-side', async () => {
        h.counts.set('blueprint_requests', 0);
        h.rows.set('blueprint_requests', requestRow());
        h.lists.set('blueprints', [{ item_name: 'Widget' }]);
        await createBlueprintRequest({ itemName: 'Widget', quantity: 999999 }, OWNER);
        expect((h.writes.find(w => w.op === 'insert')?.arg as { quantity: number }).quantity).toBe(10000);

        h.writes.length = 0;
        await expect(createBlueprintRequest({ itemName: 'Widget', offerPriceUec: -5 }, OWNER)).rejects.toThrow(/between 0/);
        expect(h.writes).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a departing member is stood down, not left advertising', () => {
    it('withdraws their offers AND hands back what they had claimed', async () => {
        await withdrawCraftingOffers(OWNER);
        const offer = h.writes.find(w => w.table === 'blueprints');
        expect((offer?.arg as { offers_crafting: boolean }).offers_crafting).toBe(false);

        const release = h.writes.find(w => w.table === 'blueprint_requests');
        expect((release?.arg as { status: string }).status).toBe('open');
        expect((release?.arg as { crafter_id: number | null }).crafter_id).toBeNull();
    });

    it('releases ONLY a claimed job — ready and delivered are work the requester must close out', async () => {
        await withdrawCraftingOffers(OWNER);
        const statusFilters = h.calls.filter(c => c.table === 'blueprint_requests' && c.method === 'eq' && c.args[0] === 'status');
        expect(statusFilters.map(c => c.args[1])).toEqual(['claimed']);
    });

    it('an absent module table is not a failure — a member removal must not hinge on it', async () => {
        h.listErrors.set('blueprints', { code: '42P01' });
        h.listErrors.set('blueprint_requests', { code: '42P01' });
        await expect(withdrawCraftingOffers(OWNER)).resolves.toEqual({ offersWithdrawn: 0, claimsReleased: 0 });
    });

    it('a REAL fault still throws, so deleteUser logs it rather than silently skipping', async () => {
        h.listErrors.set('blueprints', { code: '08006', message: 'connection failure' });
        await expect(withdrawCraftingOffers(OWNER)).rejects.toThrow();
    });

    it('deleteUser calls it, best-effort, and never lets it block the removal', () => {
        const users = codeOnly(read('lib/db/users.ts'));
        expect(users).toContain('withdrawCraftingOffers(userId)');
        const section = between(users, 'await withdrawCraftingOffers(userId);', 'broadcastUserUpdate(userId)');
        expect(section).toContain('catch');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('what crosses the wire', () => {
    it('the party embed carries roster-safe fields only', () => {
        const embed = between(BP_SRC, 'const PARTY_COLS', 'const BLUEPRINT_OWNER_EMBED');
        for (const forbidden of ['discord_id', 'email', 'clearance', 'admin_notes', 'personnel_notes', 'role_permissions', 'tokens_valid_from']) {
            expect(embed, `${forbidden} must not ride an embed`).not.toContain(forbidden);
        }
        expect(embed).toContain('deleted_at');   // to WITHHOLD the name, see below
    });

    it('a departed member is not named on a row that outlives them', () => {
        const departed = toBlueprint({
            id: 1, owner_id: OWNER, qm_catalog_id: null, item_name: 'Widget', category: null,
            notes: null, offers_crafting: true, created_at: 'x', updated_at: 'x',
            owner: { id: OWNER, name: 'Gone', avatar_url: null, rsi_handle: null, deleted_at: '2026-01-01' },
        });
        expect(departed.owner).toBeUndefined();
        expect(departed.ownerId).toBe(OWNER);   // the row itself is org history and survives

        const live = toBlueprint({
            id: 1, owner_id: OWNER, qm_catalog_id: null, item_name: 'Widget', category: null,
            notes: null, offers_crafting: true, created_at: 'x', updated_at: 'x',
            owner: { id: OWNER, name: 'Here', avatar_url: null, rsi_handle: null, deleted_at: null },
        });
        expect(live.owner?.name).toBe('Here');
    });

    it('the same rule applies to both request parties', () => {
        const req = toBlueprintRequest({
            id: 5, requester_id: OWNER, crafter_id: OTHER, blueprint_id: null, qm_catalog_id: null,
            item_name: 'Widget', quantity: 1, materials_note: null, offer_price_uec: null,
            status: 'claimed', claimed_at: null, ready_at: null, delivered_at: null,
            completed_at: null, cancelled_at: null, cancel_reason: null, created_at: 'x', updated_at: 'x',
            requester: { id: OWNER, name: 'A', avatar_url: null, rsi_handle: null, deleted_at: null },
            crafter: { id: OTHER, name: 'B', avatar_url: null, rsi_handle: null, deleted_at: '2026-01-01' },
        });
        expect(req.requester?.name).toBe('A');
        expect(req.crafter).toBeUndefined();
    });

    it('the craftable projection has no owner to leak, even if a row arrives carrying one', () => {
        const item = toCraftableItem({ qm_catalog_id: 3, item_name: 'Widget', category: 'weapon', owner_id: OWNER } as never);
        expect(item).toEqual({ qmCatalogId: 3, itemName: 'Widget', category: 'weapon' });
        expect(Object.keys(item)).toHaveLength(3);
    });

    it('the craftable column list is not derived from the registry one', () => {
        // Derivation would silently inherit any column added to the registry select.
        expect(BP_SRC).toContain("const CRAFTABLE_COLS = 'qm_catalog_id, item_name, category'");
        expect(BP_SRC).not.toContain('CRAFTABLE_COLS = `${BLUEPRINT_COLS}');
    });

    it('two owners of the same item collapse to ONE row — the list cannot be counted', async () => {
        h.lists.set('blueprints', [
            { qm_catalog_id: 1, item_name: 'Widget', category: 'weapon' },
            { qm_catalog_id: null, item_name: ' widget ', category: null },
            { qm_catalog_id: 2, item_name: 'Gadget', category: 'misc' },
        ]);
        const { items } = await listCraftableItems({});
        expect(items.map(i => i.itemName)).toEqual(['Widget', 'Gadget']);
    });

    it('a capped picker says so rather than presenting itself as the whole catalogue', async () => {
        h.lists.set('blueprints', Array.from({ length: 500 }, (_, i) => ({ qm_catalog_id: null, item_name: `Item ${i}`, category: null })));
        const { truncated } = await listCraftableItems({});
        expect(truncated).toBe(true);

        h.lists.set('blueprints', [{ qm_catalog_id: null, item_name: 'Widget', category: null }]);
        expect((await listCraftableItems({})).truncated).toBe(false);
    });

    it('the registry read is capped and ends on a primary-key tiebreak', async () => {
        h.lists.set('blueprints', []);
        await listBlueprints({ limit: 99999 });
        const orders = h.calls.filter(c => c.table === 'blueprints' && c.method === 'order').map(c => c.args[0]);
        expect(orders[orders.length - 1]).toBe('id');
        const limit = h.calls.find(c => c.table === 'blueprints' && c.method === 'limit');
        expect(limit?.args[0]).toBe(500);   // MAX_LIST, not the 99999 asked for
    });

    it('no broadcast: the view is RPC-hydrated, so an id-only emit would have no consumer', () => {
        expect(BP_SRC).not.toContain('broadcastToOrg');
    });

    it('the mappers are the only narrowing — nothing spreads a row', () => {
        expect(BP_SRC).not.toContain('...row');
        expect(BP_SRC).not.toContain('...data');
        expect(MAPPERS_SRC.includes('toBlueprint')).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('dispatcher wiring', () => {
    const EXPECTED: Record<string, string> = {
        'blueprint:list_registry': 'blueprint:view',
        'blueprint:list_craftable': 'blueprint:view',
        'blueprint:list_requests': 'blueprint:view',
        'blueprint:register': 'blueprint:register',
        'blueprint:update': 'blueprint:register',
        'blueprint:delete': 'blueprint:register',
        'blueprint:create_request': 'blueprint:request',
        'blueprint:confirm_received': 'blueprint:request',
        'blueprint:cancel_request': 'blueprint:request',
        'blueprint:claim_request': 'blueprint:craft',
        'blueprint:release_request': 'blueprint:craft',
        'blueprint:mark_ready': 'blueprint:craft',
        'blueprint:mark_delivered': 'blueprint:craft',
    };

    it('every action maps to the rung it belongs to', () => {
        for (const [action, perm] of Object.entries(EXPECTED)) {
            expect(SERVICES_SRC, `${action} → ${perm}`).toContain(`'${action}': '${perm}',`);
        }
    });

    it('every handler in the module has a map entry — an unmapped one silently 403s', () => {
        const declared = [...ACTIONS_SRC.matchAll(/'(blueprint:[a-z_]+)':\s*async/g)].map(m => m[1]);
        expect(declared.length).toBe(Object.keys(EXPECTED).length);
        expect(declared.sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    it('the namespace is protected and feature-gated, with nothing exempt', () => {
        expect(SERVICES_SRC).toContain("'blueprint:'];");
        expect(SERVICES_SRC).toContain("'blueprint:':   { feature: 'blueprints',    source: 'features',   label: 'Blueprint Manager' },");
        const entry = between(SERVICES_SRC, "'blueprint:':   { feature:", '\n');
        expect(entry, 'a features-sourced module carries no exempt actions').not.toContain('exempt');
    });

    it('the Client hard-deny is deliberately absent, and no role-NAME test replaced it', () => {
        // A role-name compare would grant a permissionless role called "Commander" and
        // deny a real member on a role called "Recruit" — the inversion hosted hit.
        expect(ACTIONS_SRC).not.toContain('assertNotClient');
        expect(ACTIONS_SRC).not.toContain("user?.role ===");
        expect(ACTIONS_SRC).not.toContain("=== 'Client'");
    });

    it('the notification link has a view to land on', () => {
        // HeaderNotificationsBell casts n.link straight into setActiveView, so a link
        // with no case here fails silently to a blank screen.
        expect(ACTIONS_SRC).toContain("link: 'blueprints'");
        expect(codeOnly(read('DashboardApp.tsx'))).toContain("case 'blueprints':");
        expect(codeOnly(read('components/layout/HeaderNotificationsBell.tsx'))).toContain('blueprint_request:');
    });

    it('one notification call per recipient — not a push AND a row', () => {
        // createNotification already writes the row, broadcasts the id and pushes.
        expect(ACTIONS_SRC).not.toContain('sendPushToUsers');
        expect(ACTIONS_SRC).toContain('createNotification');
    });

    it('the Discord post carries no requester and no materials note', () => {
        const section = between(ACTIONS_SRC, 'async function notifyDiscordCraftingRequest', 'export const blueprintActions');
        expect(section).toContain('embeds:');
        // No `content` string means there is no text a mention could ride in.
        expect(section).not.toContain('content:');
        expect(section).not.toContain('materialsNote');
        expect(section).not.toContain('requester');
        expect(section).toContain('craftingRequestChannelId');
        expect(section).toContain('newRequestChannelId');   // the fallback
    });

    it('the in-app fan-out is narrower still — no item, no price, no asker', () => {
        // The NOTIFICATION PAYLOAD only. The enclosing handler destructures
        // offerPriceUec off the request body, which says nothing about what is sent.
        const section = between(ACTIONS_SRC, 'const crafters = await db.getCraftNotifyIds', '} catch (err) {');
        expect(section).toContain('A new crafting request is open on the board.');
        expect(section).toContain('blueprintRequestId');
        expect(section).not.toContain('itemName');
        expect(section).not.toContain('offerPriceUec');
        expect(section).not.toContain('requesterId');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('schema', () => {
    const section = between(SCHEMA_SRC, 'CREATE TABLE IF NOT EXISTS public.blueprints (', 'CREATE TABLE IF NOT EXISTS public.warehouse_catalog');

    it('uses GENERATED BY DEFAULT, which the org importer needs for explicit ids', () => {
        expect(section).not.toContain('GENERATED ALWAYS');
        expect((section.match(/GENERATED BY DEFAULT AS IDENTITY/g) || []).length).toBe(2);
    });

    it('adds NO grants, policies or revokes — §5 and §6 already cover every table', () => {
        // A permissive `CREATE POLICY … USING (false)` is one careless OR away from
        // granting something; no policy at all cannot be.
        expect(section).not.toContain('GRANT');
        expect(section).not.toContain('CREATE POLICY');
        expect(section).not.toContain('REVOKE');
        expect(section).not.toContain('ENABLE ROW LEVEL SECURITY');
    });

    it('carries no organization_id anywhere — this build is single-org', () => {
        expect(section).not.toContain('organization_id');
        expect(section).not.toContain('organizations(id)');
    });

    it('the retired reference_url column is not resurrected', () => {
        expect(section).not.toContain('reference_url');
    });

    it('one registry entry per member per item, case-insensitively', () => {
        expect(section).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_blueprints_owner_item');
        expect(section).toContain('lower(item_name)');
    });

    it('a request survives its blueprint and its crafter being removed', () => {
        expect(section).toContain('blueprint_id    bigint REFERENCES public.blueprints(id) ON DELETE SET NULL');
        expect(section).toContain('crafter_id      integer REFERENCES public.users(id) ON DELETE SET NULL');
    });

    it('quantity and price are bounded in the database too, not only in TypeScript', () => {
        expect(section).toContain('CHECK (quantity > 0 AND quantity <= 10000)');
        expect(section).toContain('offer_price_uec <= 1000000000000');
    });

    it('the status vocabulary matches the TypeScript union exactly', () => {
        expect(section).toContain("CHECK (status IN ('open', 'claimed', 'ready', 'delivered', 'completed', 'cancelled'))");
    });

    it('the five permissions are seeded and mirrored in GLOBAL_PERMISSIONS', () => {
        const system = codeOnly(read('lib/db/system.ts'));
        for (const p of ['blueprint:view', 'blueprint:register', 'blueprint:request', 'blueprint:craft', 'blueprint:manage']) {
            expect(SCHEMA_SRC, `${p} in schema.sql §7`).toContain(`('${p}'`);
            expect(system, `${p} in GLOBAL_PERMISSIONS`).toContain(`name: '${p}'`);
        }
    });

    it('schema.sql grants nothing to a role — that is the one-shot backfill\'s job', () => {
        // A grants backfill in a re-runnable convergence script restores what an
        // operator deliberately revoked, on every upgrade.
        expect(SCHEMA_SRC).not.toContain("INSERT INTO public.role_permissions");
    });
});

describe('registration writes what it was given, and nothing it was not', () => {
    it('derives category from the catalog pin and never from the caller', async () => {
        h.rows.set('quartermaster_catalog', { id: 3, category: 'weapon' });
        h.rows.set('blueprints', { id: 1, owner_id: OWNER });
        await registerBlueprint({ itemName: 'Widget', qmCatalogId: 3, category: 'anything-i-like' }, OWNER);
        const insert = h.writes.find(w => w.op === 'insert')?.arg as Record<string, unknown>;
        expect(insert.category).toBe('weapon');
        expect(insert.owner_id).toBe(OWNER);
    });

    it('a freehand entry has no category rather than a made-up one', async () => {
        h.rows.set('blueprints', { id: 1, owner_id: OWNER });
        await registerBlueprint({ itemName: 'Widget' }, OWNER);
        expect((h.writes.find(w => w.op === 'insert')?.arg as { category: unknown }).category).toBeNull();
    });

    it('offers_crafting defaults OFF — consent is opted into, never assumed', async () => {
        h.rows.set('blueprints', { id: 1, owner_id: OWNER });
        await registerBlueprint({ itemName: 'Widget', offersCrafting: 'yes' }, OWNER);
        expect((h.writes.find(w => w.op === 'insert')?.arg as { offers_crafting: boolean }).offers_crafting).toBe(false);
    });

    it('an empty or oversized name is refused before any write', async () => {
        await expect(registerBlueprint({ itemName: '   ' }, OWNER)).rejects.toThrow(/required/i);
        await expect(registerBlueprint({ itemName: 'x'.repeat(161) }, OWNER)).rejects.toThrow(/160 characters/);
        expect(h.writes).toEqual([]);
    });
});

describe('the amplifier has a RATE bound, not just a concurrency cap', () => {
    // MAX_OPEN_REQUESTS_PER_REQUESTER counts requests in a non-terminal status, which
    // is a concurrency limit. cancelBlueprintRequest is self-service, so an account can
    // raise ten, cancel ten and raise ten more — each creation re-firing a fan-out to
    // every blueprint:craft holder. The comment on the open cap claims to "bound it at
    // the source"; over time it did not bound it at all.
    const CAP_QUEUE = (open: number | null, recent: number | null) =>
        h.countQueue.set('blueprint_requests', [open, recent]);

    it('refuses once the rolling-window creation count is reached, even with nothing open', async () => {
        CAP_QUEUE(0, 20);
        await expect(createBlueprintRequest({ itemName: 'Widget' }, 5))
            .rejects.toThrow(/too many crafting requests today/i);
        expect(h.writes.filter(w => w.op === 'insert'), 'the row was still written').toEqual([]);
    });

    it('the rate count ignores status, so cancelling cannot buy another slot', async () => {
        // The read must not carry a status filter — that is the entire distinction
        // between this bound and the open cap above it.
        CAP_QUEUE(0, 0);
        await createBlueprintRequest({ itemName: 'Widget' }, 5).catch(() => undefined);
        const countCalls = h.calls.filter(c => c.table === 'blueprint_requests' && c.method === 'in' && c.args[0] === 'status');
        const rateCall = h.calls.filter(c => c.table === 'blueprint_requests' && c.method === 'gte' && c.args[0] === 'created_at');
        expect(rateCall.length, 'no created_at window read — the bound is not a rate bound').toBeGreaterThan(0);
        // The status filter belongs to the OPEN cap only, so exactly one such call.
        expect(countCalls).toHaveLength(1);
    });

    it('fails CLOSED when the rate count cannot be read', async () => {
        CAP_QUEUE(0, null);
        await expect(createBlueprintRequest({ itemName: 'Widget' }, 5))
            .rejects.toThrow(/could not verify your recent/i);
    });

    it('the concurrency cap still applies on its own', async () => {
        CAP_QUEUE(10, 0);
        await expect(createBlueprintRequest({ itemName: 'Widget' }, 5))
            .rejects.toThrow(/already have 10 crafting requests/i);
    });
});

describe('request transitions check OWNERSHIP before STATUS (no id-space oracle)', () => {
    // confirmBlueprintRequestReceived documents the rule: checking status first lets a
    // non-participant tell "wrong state" from "not yours" and walk the id space to map
    // every request's status — exactly what pinning non-crafters to their own rows in
    // listBlueprintRequests prevents. Its three siblings had the checks the other way.
    const seed = (over: Record<string, unknown>) =>
        h.rows.set('blueprint_requests', { id: 7, requester_id: 99, crafter_id: 42, status: 'open', ...over });

    it('markBlueprintRequestReady denies a stranger before revealing the status', async () => {
        seed({ status: 'ready' });   // wrong state for this call AND not the caller's
        await expect(markBlueprintRequestReady(7, 1234)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('markBlueprintRequestDelivered does the same', async () => {
        seed({ status: 'claimed' });
        await expect(markBlueprintRequestDelivered(7, 1234)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('releaseBlueprintRequest does the same', async () => {
        seed({ status: 'open' });
        await expect(releaseBlueprintRequest(7, 1234, false)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('and the crafter still gets the ordinary state error, not a denial', async () => {
        // The guard must not swallow the legitimate wrong-state message for the actor
        // who IS entitled to act — that would just move the confusion.
        seed({ status: 'ready' });
        await expect(markBlueprintRequestReady(7, 42)).rejects.toThrow(/only a claimed request/i);
    });
});
