import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripSqlComments } from './stripComments';

// F3/F4: the two session-revocation surfaces that drifted from the dispatcher.
// These are wiring/policy pins (source-text), mirroring how the federation suite
// pins alliances.ts source — the predicates themselves are unit-tested elsewhere.

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('F3 — /api/admin/import-stream enforces per-user revocation', () => {
    const server = read('server.ts');
    // Anchored on the ROUTE REGISTRATION, not on the first occurrence of the path string. The
    // path is now also named in the CSRF gate's guarded-path list much earlier in the file, so a
    // bare indexOf on the literal opens the window in the wrong place and the assertion passes
    // or fails for reasons unrelated to this route.
    const ROUTE_ANCHOR = "app.post('/api/admin/import-stream'";
    const routeStart = server.indexOf(ROUTE_ANCHOR);
    const route = server.slice(routeStart, routeStart + 2500);

    it('imports the watermark predicate', () => {
        expect(server).toContain('isSessionRevokedByWatermark');
    });
    it('registers the route exactly once, so the anchor above is unambiguous', () => {
        expect(routeStart).toBeGreaterThan(-1);
        expect(server.indexOf(ROUTE_ANCHOR, routeStart + 1)).toBe(-1);
    });
    it('checks the watermark inside the import-stream route, before streaming', () => {
        expect(route).toContain('isSessionRevokedByWatermark(decoded, user?.tokensValidFrom)');
        // the check sits before the importer runs (compared on the full source)
        const watermarkAt = server.indexOf('isSessionRevokedByWatermark', routeStart);
        const importerAt = server.indexOf('importOrgData', routeStart);
        expect(watermarkAt).toBeGreaterThan(-1);
        expect(importerAt).toBeGreaterThan(watermarkAt);
    });
});

describe('F4 — realtime RLS folds in tokens_valid_from (iat watermark)', () => {
    // Comment-stripped, and that is load-bearing rather than tidiness: these helpers
    // are HEAVILY commented, and the comments name the very terms asserted below
    // ("tokens_valid_from", "deleted_at"). Scanning the raw file lets a pin pass on the
    // prose that explains the check after the check itself has gone — the self-match
    // trap that has produced a green-but-vacuous test in three prior phases here.
    const schema = stripSqlComments(read('schema.sql'));

    // schema.sql §4.9 moved these predicates out of the policies and into the
    // SECURITY DEFINER helpers private.rt_is_live_member() /
    // private.rt_can_read_op_board(), because §5 stopped granting role
    // `authenticated` SELECT on public.users (an inline EXISTS would have needed it
    // and would now silently evaluate false). The watermark check moved with them,
    // so pin it where it lives AND pin that the policies still call it.
    const fnBody = (name: string) => {
        const start = schema.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
        expect(start, `${name} not found in schema.sql`).toBeGreaterThan(-1);
        return schema.slice(start, schema.indexOf('$$;', start) + 3);
    };

    it('the live-member helper checks iat vs tokens_valid_from', () => {
        const body = fnBody('private.rt_is_live_member');
        expect(body).toContain('tokens_valid_from');
        expect(body).toContain("auth.jwt()->>'iat'");
    });

    it('the live-member helper still refuses a SOFT-DELETED member', () => {
        // Pinned POSITIVELY, and only since the op-board helper stopped keeping a second
        // copy. While there were two, a slip in one was survivable; now this is the only
        // definition, and the sibling tests below assert its ABSENCE from the op-board
        // helper — so without this line, deleting the term entirely leaves every one of
        // these tests green while restoring realtime broadcast, the twelve reference
        // tables and op-board content to every removed member.
        const body = fnBody('private.rt_is_live_member');
        expect(body).toContain('u.deleted_at IS NULL');
    });

    it('the op-board helper DELEGATES the watermark instead of restating it', () => {
        // It used to carry its own copy of the watermark and the soft-delete check. That
        // second copy is what the rt_is_staff() note in schema.sql warns against, and it
        // duly went stale: when an active-org-ban term was added as a third revocation
        // condition, only rt_is_live_member() got it, leaving this predicate authorizing
        // banned members to read live tactical-board content — which carries full element
        // payloads, not ids.
        //
        // So the pin inverted. It now asserts the delegation AND the absence of a second
        // copy; the watermark itself stays pinned one test above, on the single helper
        // that owns it. Both halves are needed: delegation alone would still pass if
        // someone re-added a stale duplicate beside it.
        const body = fnBody('private.rt_can_read_op_board');
        expect(body).toContain('private.rt_is_live_member()');
        expect(body, 'the watermark was restated here again — delegate it').not.toContain('tokens_valid_from');
        expect(body, 'the soft-delete check was restated here again — delegate it').not.toContain('u.deleted_at');
    });

    it('and the helper it delegates to refuses an ACTIVE ORG BAN, the third revocation term', () => {
        // The reason the duplication above had to go. Pinned here as well as in
        // tests/orgBanEnforcement.test.ts because THIS file is the one that exists to
        // catch a revocation surface drifting away from the dispatcher.
        const body = fnBody('private.rt_is_live_member');
        expect(body).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM public\.organization_bans/);
        expect(body).toContain('lifted_at IS NULL');
    });

    it('the org-channel policy delegates to the live-member helper', () => {
        const policy = schema.slice(
            schema.indexOf('CREATE POLICY rt_recv_org_channels'),
            schema.indexOf('CREATE POLICY rt_recv_op_board'),
        );
        expect(policy).toContain('private.rt_is_live_member()');
    });

    it('the op-board policy delegates to the op-board helper', () => {
        const policy = schema.slice(schema.indexOf('CREATE POLICY rt_recv_op_board'), schema.indexOf('CREATE POLICY rt_recv_op_board') + 400);
        expect(policy).toContain('private.rt_can_read_op_board(');
    });

    it('the reference-table authenticated_select policy delegates to the live-member helper', () => {
        // NOTE: the §6 loop now emits TWO authenticated_select literals (an empty
        // customer-visible allowlist arm and the staff-only default arm), and this
        // slices the FIRST of them — the customer-visible arm, which is the one that
        // is still live-member-only. The 300-character window is what keeps that arm's
        // ~135-character policy literal inside the slice; splitting the literal across
        // lines, building it in a variable or reordering the IF/ELSE turns this red
        // with no warning. Which predicate sits in which arm is pinned properly by
        // tests/sec-schema-rls.test.ts; this stays a revocation-drift pin only.
        const block = schema.slice(schema.indexOf('CREATE POLICY authenticated_select'), schema.indexOf('CREATE POLICY authenticated_select') + 300);
        expect(block).toContain('private.rt_is_live_member()');
    });
});

describe('hardening cluster pins (F25/F23)', () => {
    it('F25 — Express framework fingerprint header is disabled', () => {
        expect(read('server.ts')).toContain("app.disable('x-powered-by')");
    });
    it('F23 — the wiki iframe sandbox no longer grants allow-popups', () => {
        const ext = read('components/views/wiki/extensions/IframeExtension.ts');
        expect(ext).toContain("sandbox: 'allow-scripts allow-same-origin'");
        // the previous (popups-granting) sandbox value must be gone
        expect(ext).not.toContain("allow-same-origin allow-popups");
    });
});
