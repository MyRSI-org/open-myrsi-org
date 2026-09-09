import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from './stripComments';

// THE BELL SHIPPED AN ICON FOR A NOTIFICATION TYPE NOTHING COULD EVER WRITE.
//
// `responder: 'fa-user-plus'` sat in HeaderNotificationsBell's TYPE_ICON map from the start
// with zero writers anywhere in the tree. It was not cosmetic — the map is the authoritative
// statement of which durable notifications this product intends to send, so a key with no
// writer is a feature that was designed, half-built, and then silently dropped. Nothing in
// CI could see it, because an unknown type just falls back to `fa-bell` at render time.
//
// This is the ratchet that makes that visible, in BOTH directions:
//   - a type written by the server with no icon renders as a generic bell (a real UI defect);
//   - an icon with no writer is a dropped feature masquerading as a shipped one.
//
// If you are deleting a trigger on purpose, delete its icon key in the same change.

const ROOT = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!/node_modules|dist|dist-server/.test(p)) walk(p, out); }
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

/** Every `type:` literal passed to a notification writer, with where it came from. */
function writtenTypes(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'api'))];
    for (const f of files) {
        const src = readFileSync(f, 'utf8');
        const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
        // Anchor on the CALL so unrelated `type:` fields (task_type, node_type, entryType…)
        // cannot be mistaken for a notification type.
        for (const m of src.matchAll(/(?:createNotification|pushAcademyNotifications)\s*\(/g)) {
            const window = src.slice(m.index, m.index + 500);
            const t = /\btype:\s*'([a-z0-9_]+)'/.exec(window);
            if (!t) continue;
            const line = src.slice(0, m.index).split(/\r?\n/).length;
            found.set(t[1], [...(found.get(t[1]) || []), `${rel}:${line}`]);
        }
    }
    return found;
}

function iconKeys(): string[] {
    const src = readFileSync(join(ROOT, 'components', 'layout', 'HeaderNotificationsBell.tsx'), 'utf8');
    const at = src.indexOf('const TYPE_ICON');
    expect(at, 'TYPE_ICON was renamed — update this test with it').toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('};', at));
    return [...block.matchAll(/^\s*([a-z0-9_]+):\s*'fa-/gm)].map((m) => m[1]);
}

const WRITTEN = writtenTypes();
const ICONS = iconKeys();

describe('notification type ↔ icon parity', () => {
    it('scans a meaningful surface (guards against the scanner matching nothing)', () => {
        expect(WRITTEN.size).toBeGreaterThanOrEqual(10);
        expect(ICONS.length).toBeGreaterThanOrEqual(10);
    });

    it('every type the server writes has an icon', () => {
        const orphans = [...WRITTEN.entries()]
            .filter(([t]) => !ICONS.includes(t))
            .map(([t, where]) => `${t} — written at ${where.join(', ')} but absent from TYPE_ICON`);
        expect(orphans, `types with no icon:\n${orphans.join('\n')}`).toEqual([]);
    });

    it('every icon has a writer — THE `responder` DEFECT', () => {
        const dead = ICONS.filter((t) => !WRITTEN.has(t));
        expect(dead, `icon keys nothing can ever set:\n${dead.join('\n')}`).toEqual([]);
    });

    it('the responder type specifically is written, in every one of its five places', () => {
        // Named explicitly because this is the trigger set the whole unit exists to add, and
        // a partial revert (say, four of five swapped back to a raw push) would still satisfy
        // the parity assertion above.
        const sites = WRITTEN.get('responder') || [];
        expect(sites.length, `responder written at:\n${sites.join('\n')}`).toBe(5);
        expect(sites.every((s) => s.startsWith('lib/db/requests.ts:'))).toBe(true);
    });
});

// Comment blanking is the shared, string-aware helper (tests/stripComments.ts).

describe('no double-push: a durable notification already sends its own push', () => {
    // createNotification fires sendPushToUsers itself (lib/db/notifications.ts). The responder
    // path used to send a RAW push; the fix REPLACES those calls. Adding a notification beside
    // a surviving push would double-notify — and the house comments at requests.ts:241 and
    // hr.ts:605 say exactly that, which is why this is worth pinning rather than trusting.
    it('lib/db/requests.ts no longer sends raw user pushes at all', () => {
        const src = stripComments(readFileSync(join(ROOT, 'lib', 'db', 'requests.ts'), 'utf8'));
        expect(src).not.toMatch(/\bsendPushToUsers\s*\(/);
        // sendPushToStaff is a role fan-out, not a targeted recipient — it stays.
        expect(src).toMatch(/\bsendPushToStaff\s*\(/);
    });

    it('api/actions/finances.ts routes targeted recipients through createNotification', () => {
        const src = stripComments(readFileSync(join(ROOT, 'api', 'actions', 'finances.ts'), 'utf8'));
        expect(src).not.toMatch(/\bsendPushToUsers\s*\(/);
        // The submit legs are permission fan-outs and are deliberately left as pushes.
        expect(src).toMatch(/\bsendPushToPermission\s*\(/);
    });
});

describe('notification bodies never carry gated content', () => {
    const src = readFileSync(join(ROOT, 'lib', 'db', 'ops.ts'), 'utf8');

    it('the operation notifier body is a constant, never interpolated', () => {
        // Operations carry clearance levels and limiting markers, and NEITHER a durable
        // notification row NOR an OS push tray is clearance-filtered at read time. An
        // operation name or task title in one of these bodies is a clearance bypass.
        const at = src.indexOf('async function notifyOperationAssignment');
        expect(at, 'notifyOperationAssignment was renamed').toBeGreaterThan(-1);
        const body = src.slice(at, src.indexOf('\n}', at));
        // No template interpolation anywhere in the notifier.
        expect(body).not.toMatch(/\$\{/);
    });

    it('the finance rejection no longer ships the officer free-text reason', () => {
        const fin = readFileSync(join(ROOT, 'api', 'actions', 'finances.ts'), 'utf8');
        const at = fin.indexOf("'finance:reject_entry'");
        const handler = fin.slice(at, fin.indexOf("'finance:reverse_entry'", at));
        // It rode into an OS notification tray — a surface with no permission gate that
        // renders on a lock screen — and the durable row would have made it permanent.
        expect(handler).not.toMatch(/reason\s*\?\.\s*slice/);
        expect(handler).toContain('open the ledger for details');
    });
});
