import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// THE ONE DELIBERATE EXCEPTION TO SECURITY RULE 4 ("realtime carries ids, never
// content"), pinned from both sides.
//
// broadcastBoardAdd / broadcastBoardUpdate (lib/db/ops.ts) send tactical-board CONTENT
// — the element object, the `changes` object. That is acceptable only because they go
// to the private per-op channel op-board-<uuid>, whose receipt is authorized per
// operation by the rt_recv_op_board RLS policy → private.rt_can_read_op_board()
// (schema.sql §4.9 / §6b; the predicate itself is pinned by tests/sec-schema-rls.test.ts
// and tests/opParticipationConsistency.test.ts). Recorded in SECURITY.md and at the
// broadcast sites.
//
// This file pins the other half: board content is sent ONLY on op-board-<id> — never
// 'db-changes', 'auth-alerts' or any org channel — and EVERY other broadcast in
// lib/db/ops.ts stays id-only. Behaviourally (what actually gets emitted) and
// statically (every call site in the module, so a new broadcast cannot slip in
// unreviewed).

vi.mock('../lib/db/common', async () => (await import('./cov-db-ops-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-ops-fake')).logMock);
vi.mock('../lib/db/operations-federation', async () => (await import('./cov-db-ops-fake')).fed);
vi.mock('../lib/push', async () => ({ sendPushToUsers: (await import('./cov-db-ops-fake')).collab.sendPushToUsers }));
vi.mock('../lib/db/users', async () => {
    const f = await import('./cov-db-ops-fake');
    return { getUserById: f.collab.getUserById, getActorLabel: f.collab.getActorLabel };
});
vi.mock('../lib/db/notifications', async () => ({ createNotification: (await import('./cov-db-ops-fake')).collab.createNotification }));
vi.mock('../lib/db/securityEvents', async () => ({ recordSecurityEvent: (await import('./cov-db-ops-fake')).collab.recordSecurityEvent }));
// The board HANDLER (api/actions/operations.ts) reaches the REAL lib/db/ops through the
// barrel, so the update delta below is the one the production path actually emits.
vi.mock('../lib/db', async () => ({ ...(await import('../lib/db/ops')) }));
vi.mock('../lib/discord', () => ({
    createGuildScheduledEvent: vi.fn(), deleteGuildScheduledEvent: vi.fn(), updateGuildScheduledEvent: vi.fn(),
    listGuildChannels: vi.fn(), postOperationAnnouncementEmbed: vi.fn(), editOperationAnnouncementEmbed: vi.fn(),
    deleteDiscordChannelMessage: vi.fn(),
}));

import { fake, resetFake, resetCollaborators, on, flush, newOpId, writesOn, payload, eqs } from './cov-db-ops-fake';
import {
    broadcastBoardAdd, broadcastBoardUpdate, broadcastBoardDelete, broadcastOpChange, broadcastOperationAlert,
} from '../lib/db/ops';
import { operationActions } from '../api/actions/operations';

const OP = '3c9b6f0e-2a4d-4e1f-8b7c-6d5e4f3a2b1c';
const SECRET = 'SECRET-BOARD-CONTENT-rally at Yela L4';
const ID_ONLY_KEYS = new Set(['operationId', 'timestamp']);

beforeEach(() => {
    resetFake();
    resetCollaborators();
});

describe('behaviour — what each broadcaster actually emits', () => {
    it('broadcastBoardAdd: the element rides op-board-<id> and NOTHING else', async () => {
        const element = { id: 41, elementType: 'marker', label: SECRET, data: { note: SECRET } };
        await broadcastBoardAdd(OP, element, 'nonce-1');
        expect(fake.emits).toEqual([{
            channel: `op-board-${OP}`, event: 'board_element_update',
            payload: { operationId: OP, op: 'add', element, clientNonce: 'nonce-1' },
        }]);
    });

    it('broadcastBoardUpdate: the changes ride op-board-<id> and NOTHING else', async () => {
        await broadcastBoardUpdate(OP, 41, { label: SECRET });
        expect(fake.emits).toEqual([{
            channel: `op-board-${OP}`, event: 'board_element_update',
            payload: { operationId: OP, op: 'update', elementId: 41, changes: { label: SECRET } },
        }]);
    });

    it('broadcastBoardDelete is id-only even on the board channel', async () => {
        await broadcastBoardDelete(OP, 41);
        expect(fake.emits).toEqual([{
            channel: `op-board-${OP}`, event: 'board_element_update', payload: { operationId: OP, op: 'delete', elementId: 41 },
        }]);
    });

    it('every OTHER broadcaster is id-only and never touches a board channel', async () => {
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { count: 0 });
        on('operation_participants', { data: [{ user_id: 4 }] });
        await broadcastOpChange(OP);
        await broadcastOperationAlert(OP, SECRET);
        await flush();
        expect(fake.emits.map((e) => [e.channel, e.event])).toEqual([
            ['db-changes', 'operation_update'],
            ['auth-alerts', 'operation_alert'],
        ]);
        for (const e of fake.emits) {
            for (const k of Object.keys(e.payload)) expect(ID_ONLY_KEYS, `${e.event} carries "${k}"`).toContain(k);
            expect(JSON.stringify(e.payload)).not.toContain(SECRET);
        }
    });

    it('board content never reaches an org-wide channel, whatever the sequence', async () => {
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { count: 0 });
        await broadcastBoardAdd(OP, { label: SECRET });
        await broadcastOpChange(OP);
        await broadcastBoardUpdate(OP, 1, { label: SECRET });
        await broadcastOperationAlert(OP, 'm');
        await broadcastBoardDelete(OP, 1);
        await flush();
        const carrying = fake.emits.filter((e) => JSON.stringify(e.payload).includes(SECRET));
        expect(carrying.map((e) => e.channel)).toEqual([`op-board-${OP}`, `op-board-${OP}`]);
        expect(fake.emits.filter((e) => !e.channel.startsWith('op-board-')).map((e) => e.channel)).toEqual(['db-changes', 'auth-alerts']);
    });
});

// ── The update delta is the PERSISTED projection, never the caller's payload ─
// The exception above is sound only while a receiver gets nothing it could not read
// back through operation:get_details. operation:update_board_element used to broadcast
// the caller's raw `data` while updateBoardElement persisted a whitelisted subset — so
// any key the write dropped still rode the board channel. These run the real handler.
describe('operation:update_board_element — the channel carries what was written, nothing else', () => {
    const updateEl = (operationActions as unknown as Record<string, (p: Record<string, unknown>) => Promise<unknown>>)['operation:update_board_element'];
    /** The camelCase OperationBoardElement keys the board consumer merges, and their columns. */
    const WHITELIST: Record<string, string> = {
        elementType: 'element_type', label: 'label', posX: 'pos_x', posY: 'pos_y', width: 'width', height: 'height',
        rotation: 'rotation', color: 'color', data: 'data', layer: 'layer', sortOrder: 'sort_order',
    };

    function grant(op: string) {
        on('operations', { data: { is_joint: false } });
        return op;
    }

    it('an unknown key and extra fields never reach the channel; the whitelisted ones do', async () => {
        const op = grant(newOpId());
        await updateEl({
            elementId: 41, operationId: op,
            data: {
                label: SECRET, posX: 12,
                // Not a board field at all — dropped by the write, so dropped from the delta.
                smuggled: 'INJECTED-UNKNOWN-KEY',
                // Real element fields the update path does not write (or a snake_case
                // column spelled raw): none of them is persisted by this call.
                id: 999, operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', createdAt: 'INJECTED-CREATED-AT',
                element_type: 'INJECTED-RAW-COLUMN', clientNonce: 'INJECTED-NONCE',
            },
        });
        expect(fake.emits).toEqual([{
            channel: `op-board-${op}`, event: 'board_element_update',
            payload: { operationId: op, op: 'update', elementId: 41, changes: { label: SECRET, posX: 12 } },
        }]);
        expect(JSON.stringify(fake.emits)).not.toMatch(/INJECTED|999|ffffffff/);
        // ...and the delta is exactly the persisted row change, key for key.
        const w = writesOn('operation_board_elements', 'update');
        expect(w).toHaveLength(1);
        expect(payload(w[0])).toEqual({ label: SECRET, pos_x: 12 });
        expect(eqs(w[0])).toEqual([['id', 41], ['operation_id', op]]);
    });

    it('every whitelisted field rides through in the client\'s camelCase shape, matching its written column', async () => {
        const op = grant(newOpId());
        const data = {
            elementType: 'zone', label: 'Rally', posX: 1, posY: 2, width: 30, height: 40, rotation: 90, color: '#ff0000',
            data: { note: 'hold' }, layer: 3, sortOrder: 4, junk: 'INJECTED',
        };
        await updateEl({ elementId: 7, operationId: op, data });
        const changes = fake.emits[0].payload.changes as Record<string, unknown>;
        expect(Object.keys(changes).sort()).toEqual(Object.keys(WHITELIST).sort());
        const written = payload(writesOn('operation_board_elements', 'update')[0]) as Record<string, unknown>;
        for (const [key, column] of Object.entries(WHITELIST)) {
            expect(changes[key], key).toEqual((data as Record<string, unknown>)[key]);
            expect(written[column], column).toEqual(changes[key]);
        }
        expect(Object.keys(written).sort()).toEqual(Object.values(WHITELIST).sort());
    });

    it('an undefined whitelisted field is neither written nor broadcast; a payload of only unknown keys broadcasts no content', async () => {
        const op = grant(newOpId());
        await updateEl({ elementId: 7, operationId: op, data: { label: undefined, posY: 0 } });
        expect(fake.emits[0].payload.changes).toEqual({ posY: 0 });
        expect(payload(writesOn('operation_board_elements', 'update')[0])).toEqual({ pos_y: 0 });

        resetFake();
        await updateEl({ elementId: 7, operationId: op, data: { note: SECRET, title: SECRET } });
        expect(fake.emits).toEqual([{
            channel: `op-board-${op}`, event: 'board_element_update',
            payload: { operationId: op, op: 'update', elementId: 7, changes: {} },
        }]);
        expect(JSON.stringify(fake.emits)).not.toContain(SECRET);
    });

    it('a write that fails emits nothing at all', async () => {
        const op = grant(newOpId());
        on('operation_board_elements', { error: { message: 'x' } });
        await expect(updateEl({ elementId: 7, operationId: op, data: { label: SECRET } })).rejects.toThrow('Failed to update board element');
        expect(fake.emits).toEqual([]);
    });

    it('an operation that does not exist is refused before any write or emit', async () => {
        const op = newOpId();
        on('operations', { data: null });
        await expect(updateEl({ elementId: 7, operationId: op, data: { label: SECRET } })).rejects.toThrow('Operation not found or access denied.');
        expect(writesOn('operation_board_elements')).toHaveLength(0);
        expect(fake.emits).toEqual([]);
    });
});

// ── Static: every broadcast call site in lib/db/ops.ts ──────────────────────
// CRLF-normalised (the local tree is CRLF, CI checks out LF) and comment-stripped, so
// a call named in documentation is not counted and prose cannot satisfy a pin.
function codeOnly(src: string): string {
    return src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Text between the parentheses of a call starting at `open` (index of '('). */
function callArgs(src: string, open: number): string {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(open + 1, i); }
    }
    throw new Error('unbalanced call');
}

/** Split on top-level commas. */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0; let cur = '';
    for (const ch of s) {
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** Keys of a flat object literal `{ a, b: x, c }` (nested literals are refused). */
function payloadKeys(literal: string): string[] {
    const t = literal.trim();
    expect(t.startsWith('{') && t.endsWith('}'), `payload is not an inline object literal: ${t}`).toBe(true);
    const inner = t.slice(1, -1);
    expect(inner, `nested object in a broadcast payload: ${t}`).not.toMatch(/[{}]/);
    return splitTop(inner).map((p) => p.split(':')[0].trim()).filter(Boolean);
}

describe('static — every broadcast call site in lib/db/ops.ts', () => {
    const src = codeOnly(readFileSync(resolve(__dirname, '..', 'lib', 'db', 'ops.ts'), 'utf8'));
    const sites = [...src.matchAll(/\bbroadcastTo(Org|Channel)\(/g)].map((m) => {
        const args = splitTop(callArgs(src, m.index! + m[0].length - 1));
        return m[1] === 'Org'
            ? { kind: 'org', channel: "'db-changes'", event: args[0], payload: args[1] }
            : { kind: 'channel', channel: args[0], event: args[1], payload: args[2] };
    });

    it('the set of call sites is exactly the reviewed one (a new broadcast must be reviewed here)', () => {
        expect(sites.map((s) => `${s.channel} ${s.event}`)).toEqual([
            "'db-changes' 'operation_update'",
            "'auth-alerts' 'operation_alert'",
            "boardChannelName(operationId) 'board_element_update'",
            "boardChannelName(operationId) 'board_element_update'",
            "boardChannelName(operationId) 'board_element_update'",
        ]);
        expect(src).toMatch(/function boardChannelName\(operationId: string\) \{\s*return `op-board-\$\{operationId\}`;\s*\}/);
    });

    it('content keys (element / changes) appear ONLY on board-channel sites, once each', () => {
        const board = sites.filter((s) => s.channel === 'boardChannelName(operationId)');
        const other = sites.filter((s) => s.channel !== 'boardChannelName(operationId)');
        const boardKeys = board.map((s) => payloadKeys(s.payload));
        expect(boardKeys).toEqual([
            ['operationId', 'op', 'element', 'clientNonce'],
            ['operationId', 'op', 'elementId', 'changes'],
            ['operationId', 'op', 'elementId'],
        ]);
        for (const s of other) {
            for (const k of payloadKeys(s.payload)) expect(ID_ONLY_KEYS, `${s.event} on ${s.channel} carries "${k}"`).toContain(k);
        }
    });

    it('the exception is documented at the broadcast sites', () => {
        const raw = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'ops.ts'), 'utf8').replace(/\r\n/g, '\n');
        const note = raw.indexOf('THE ONE DELIBERATE EXCEPTION TO SECURITY RULE 4');
        expect(note).toBeGreaterThan(-1);
        expect(note).toBeLessThan(raw.indexOf('export async function broadcastBoardAdd'));
        expect(raw.slice(note, raw.indexOf('export async function broadcastBoardAdd'))).toContain('rt_can_read_op_board');
        expect(raw.slice(raw.indexOf('export async function broadcastBoardAdd'), raw.indexOf('export async function broadcastBoardUpdate')))
            .toContain('Content-bearing');
    });

    it('SECURITY.md records it', () => {
        const md = readFileSync(resolve(__dirname, '..', 'SECURITY.md'), 'utf8');
        expect(md).toContain('Documented design exception: tactical-board realtime deltas');
        expect(md).toContain('op-board-<operation id>');
        expect(md).toContain('rt_can_read_op_board');
    });
});

describe('static — who feeds the content-bearing board broadcasters (api/**)', () => {
    const apiDir = resolve(__dirname, '..', 'api');
    const sources = (readdirSync(apiDir, { recursive: true }) as string[])
        .filter((rel) => rel.endsWith('.ts'))
        .map((rel) => ({ file: rel.replace(/\\/g, '/'), src: codeOnly(readFileSync(resolve(apiDir, rel), 'utf8')) }));
    const callsOf = (fn: string) => sources.flatMap(({ file, src }) =>
        [...src.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))].map((m) => ({ file, src, args: splitTop(callArgs(src, m.index! + m[0].length - 1)) })));

    it('broadcastBoardUpdate has ONE caller, and it is fed updateBoardElement\'s return — never the raw payload', () => {
        const calls = callsOf('broadcastBoardUpdate');
        expect(calls.map((c) => c.file)).toEqual(['actions/operations.ts']);
        const [{ src, args }] = calls;
        expect(args[0]).toBe('operationId');
        expect(args[1]).toBe('elementId');
        expect(args[2]).not.toBe('data');
        expect(src).toContain(`const ${args[2]} = await db.updateBoardElement(elementId, data, operationId);`);
    });

    it('broadcastBoardAdd has ONE caller, and it is fed the MAPPED inserted row', () => {
        const calls = callsOf('broadcastBoardAdd');
        expect(calls.map((c) => c.file)).toEqual(['actions/operations.ts']);
        const [{ src, args }] = calls;
        expect(args).toEqual(['operationId', 'element', 'clientNonce']);
        expect(src).toContain('const element = toOperationBoardElement(row);');
    });
});
