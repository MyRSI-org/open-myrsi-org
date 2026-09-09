import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// =============================================================================
// security_events — the egress contract for the ONE deliberately PII-bearing table
// =============================================================================
// This table exists to answer "who tried what, when". To do that it stores an actor
// IP and an actor user id, which makes it the most sensitive table in the schema and
// the one whose containment has to be structural rather than careful.
//
// Three containment claims are made in lib/db/securityEvents.ts and schema.sql. This
// file is what makes them true rather than asserted:
//   1. It is not realtime-readable — not in rt_client_tables(), so SECTION 6's
//      deny-all loop covers it and it is not in the publication.
//   2. It has NO /api/query subset at all, so it cannot ride the boot bundle, a
//      *_slice refetch or any state aggregate. The only read is a permission-gated RPC.
//   3. Its permission is NOT admin:access — that is a DISPATCHER default, and a
//      queryable log of member IP addresses is not what "open the admin console" means.
// Plus the redaction share: the audit row outlives the log line, so it must be at
// least as clean as one.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Structural containment
// ---------------------------------------------------------------------------

describe('security_events is structurally unreachable from the client tier', () => {
    it('is NOT in private.rt_client_tables(), so the deny-all loop covers it', () => {
        const schema = read('schema.sql');
        const start = schema.indexOf('CREATE OR REPLACE FUNCTION private.rt_client_tables(');
        expect(start, 'rt_client_tables is gone').toBeGreaterThan(-1);
        const body = schema.slice(start, schema.indexOf('$$;', start));
        expect(body, 'security_events must never be realtime-published — it carries actor IPs')
            .not.toContain('security_events');
    });

    it('has NO /api/query state subset — the only read is the RPC', () => {
        // The leak shape Phase 3 spent eight items closing was a sensitive array riding
        // a shared state bundle. The cheapest way to be immune is to never give this
        // table a subset in the first place.
        const query = read('api/query.ts');
        expect(query).not.toContain("case 'security_events'");
        expect(query, 'no query-path code should touch this table')
            .not.toContain('security_events');
    });

    it('the RPC is gated on admin:security:view_audit, NOT admin:access', () => {
        const services = read('api/services.ts');
        expect(services).toContain("'admin:security:list_events': 'admin:security:view_audit'");
        // The distinction is the whole point, so pin the reason too: admin:access is a
        // seeded Dispatcher default. Gating on it would have handed every dispatcher a
        // queryable log of member IP addresses.
        expect(read('lib/roleDefaultPermissions.ts')).toContain("'admin:access'");
    });

    it('the audit permission is not a seeded Member or Dispatcher default', () => {
        const defaults = read('lib/roleDefaultPermissions.ts');
        expect(defaults, 'admin:security:view_audit must be granted deliberately, never by default')
            .not.toContain('admin:security:view_audit');
    });

    it('the permission is seeded in schema.sql and in the repair backstop', () => {
        // Without both, the action is dead on a fresh install: the seeder grants Admin
        // every permission that EXISTS, and repairDatabase heals from GLOBAL_PERMISSIONS.
        expect(read('schema.sql')).toContain("('admin:security:view_audit', 'View Security Audit Trail', 'System')");
        expect(read('lib/db/system.ts')).toContain("name: 'admin:security:view_audit'");
    });

    it('the table is not spread or wildcard-selected anywhere', () => {
        const mod = read('lib/db/securityEvents.ts');
        expect(mod).not.toMatch(/\.select\(\s*['"`]\*/);
        expect(mod).not.toMatch(/\.select\(\s*\)/);
        // The mapper must be field-by-field, never a spread of the raw row.
        expect(mod).not.toMatch(/\.\.\.row/);
    });
});

// ---------------------------------------------------------------------------
// Redaction share — one redactor, not two
// ---------------------------------------------------------------------------

describe('the audit trail reuses the logger redactor rather than rolling its own', () => {
    it('imports redactFields from lib/log instead of re-declaring a secret regex', () => {
        const mod = read('lib/db/securityEvents.ts');
        expect(mod).toContain('redactFields');
        expect(mod, 'a second copy of the secret-key regex is a drift hazard — import the one in lib/log.ts')
            .not.toMatch(/authorization\|secret\|password/);
    });

    it('lib/log.ts still exports it', () => {
        expect(read('lib/log.ts')).toContain('export function redactFields');
    });
});

// ---------------------------------------------------------------------------
// Behaviour — the write path must be unbreakable
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
    inserted: [] as Array<Record<string, unknown>>,
    insertError: null as { code?: string } | null,
    insertThrows: false,
    selectRows: [] as Array<{ id: number }>,
    selectError: null as { code?: string } | null,
}));

vi.mock('../lib/db/common', () => ({
    supabase: {
        from: () => ({
            insert: async (row: Record<string, unknown>) => {
                if (h.insertThrows) throw new Error('connection reset');
                h.inserted.push(row);
                return { error: h.insertError };
            },
            select: () => ({
                lt: () => ({
                    // ordered: the capped prune read carries a PK tiebreak
                    order: () => ({
                        limit: async () => ({ data: h.selectRows, error: h.selectError }),
                    }),
                }),
            }),
            delete: () => ({ in: async () => ({ error: null }) }),
        }),
    },
}));

import { recordSecurityEvent, pruneSecurityEvents } from '../lib/db/securityEvents';

beforeEach(() => {
    h.inserted = [];
    h.insertError = null;
    h.insertThrows = false;
    h.selectRows = [];
    h.selectError = null;
});

describe('recordSecurityEvent', () => {
    it('redacts a secret-named field before it is persisted', async () => {
        // The row is durable, queryable and read back by an admin screen. A stray
        // { botToken } in a SecurityDenial fields bag must not survive into it — the
        // log line that carried the same bag is scrubbed, and this outlives the log.
        await recordSecurityEvent({
            event: 'authz.denied',
            action: 'admin:db:reset_finances',
            details: { requiredPerm: 'admin:db:destroy', botToken: 'super-secret-value' },
        });
        expect(h.inserted).toHaveLength(1);
        const details = h.inserted[0].details as Record<string, unknown>;
        expect(details.requiredPerm).toBe('admin:db:destroy');
        expect(details.botToken).toBe('[REDACTED]');
        expect(JSON.stringify(h.inserted[0])).not.toContain('super-secret-value');
    });

    it('bounds an oversized details bag instead of storing it', async () => {
        // The denial path fires BEFORE authorization succeeds, so it is reachable by an
        // unauthorised caller. An unbounded details write would be a storage amplifier.
        await recordSecurityEvent({
            event: 'authz.denied',
            details: { blob: 'x'.repeat(20_000) },
        });
        const details = h.inserted[0].details as Record<string, unknown>;
        expect(details._truncated).toBe(true);
        expect(JSON.stringify(details).length).toBeLessThan(2000);
    });

    it('clips over-long text fields', async () => {
        await recordSecurityEvent({
            event: 'e'.repeat(1000),
            action: 'a'.repeat(1000),
            actorLabel: 'l'.repeat(1000),
            actorIp: 'i'.repeat(1000),
        });
        const row = h.inserted[0];
        expect((row.event as string).length).toBeLessThanOrEqual(256);
        expect((row.action as string).length).toBeLessThanOrEqual(256);
        expect((row.actor_label as string).length).toBeLessThanOrEqual(256);
        expect((row.actor_ip as string).length).toBeLessThanOrEqual(64);
    });

    it('NEVER rejects when the insert errors', async () => {
        // A denial whose audit write fails must still be a denial. If this could reject,
        // an attacker able to break the audit table could turn every 403 into a 500.
        h.insertError = { code: '23505' };
        await expect(recordSecurityEvent({ event: 'authz.denied' })).resolves.toBeUndefined();
    });

    it('NEVER rejects when the table does not exist yet', async () => {
        // The expected state between deploying the code and re-running schema.sql.
        h.insertError = { code: '42P01' };
        await expect(recordSecurityEvent({ event: 'authz.denied' })).resolves.toBeUndefined();
    });

    it('NEVER rejects when the driver throws', async () => {
        h.insertThrows = true;
        await expect(recordSecurityEvent({ event: 'authz.denied' })).resolves.toBeUndefined();
    });

    it('defaults outcome to denied and coerces an unknown outcome', async () => {
        await recordSecurityEvent({ event: 'authz.denied' });
        expect(h.inserted[0].outcome).toBe('denied');
        await recordSecurityEvent({ event: 'x', outcome: 'sideways' as unknown as 'allowed' });
        expect(h.inserted[1].outcome).toBe('denied');
    });

    it('drops a non-numeric actor id rather than writing junk', async () => {
        await recordSecurityEvent({ event: 'authz.denied', actorUserId: Number.NaN });
        expect(h.inserted[0].actor_user_id).toBeNull();
    });
});

describe('pruneSecurityEvents', () => {
    it('never throws when the table is absent', async () => {
        h.selectError = { code: '42P01' };
        await expect(pruneSecurityEvents(30)).resolves.toBe(0);
    });

    it('never throws on a nonsense retention value', async () => {
        await expect(pruneSecurityEvents(Number.NaN)).resolves.toBe(0);
    });

    it('deletes the rows it selected', async () => {
        h.selectRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
        await expect(pruneSecurityEvents(365)).resolves.toBe(3);
    });
});

// ---------------------------------------------------------------------------
// The dispatcher actually emits
// ---------------------------------------------------------------------------

describe('the dispatcher emits to both sinks from one place', () => {
    it('routes denials through auditDenial rather than a bare log.warn', () => {
        const services = read('api/services.ts');
        // If a new denial path is added with a bare log.warn, it lands in stdout only
        // and is invisible to the admin screen — the drift this helper exists to stop.
        expect(services).toContain('function auditDenial(');
        for (const slug of [
            'auth.rate_limited',
            'auth.oauth_state.denied',
            'authz.client_namespace.denied',
            'authz.permission.denied',
            'authz.unmapped_action.denied',
        ]) {
            expect(services, `${slug} must be emitted through auditDenial`).toContain(slug);
        }
    });

    it('the emit cannot turn a denial into a 500', () => {
        // `void` does not catch a synchronous throw or an absent export, so the guard
        // has to be a real try/catch. This was not hypothetical: without it, 26 existing
        // tests failed because their lib/db double had no recordSecurityEvent.
        const services = read('api/services.ts');
        const at = services.indexOf('function auditDenial(');
        expect(at, 'auditDenial is gone').toBeGreaterThan(-1);
        // Start AFTER the parameter type literal: its own closing brace sits at column 0
        // (`}): void {`), so slicing to the first line-initial `}` from `at` would stop
        // before the body and pass for the wrong reason. This file is CRLF, so match
        // \r?\n rather than a bare \n.
        const sigEnd = services.indexOf('): void {', at);
        expect(sigEnd, 'auditDenial signature changed shape').toBeGreaterThan(-1);
        const rel = services.slice(sigEnd).search(/\r?\n\}/);
        expect(rel, 'could not find the end of auditDenial').toBeGreaterThan(-1);
        const body = services.slice(sigEnd, sigEnd + rel);
        expect(body).toContain('try {');
        expect(body).toContain('catch');
    });
});
