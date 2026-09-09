import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ADMIN PANEL TAB WIRING — three lists that must never drift apart.
//
// AdminPanelView holds a tab in THREE places: a React.lazy import, an entry in
// tabGroups (the left nav), and a case in renderContent's switch. Nothing in the
// type system ties them together, so an edit can satisfy two and drop the third and
// still typecheck, lint and pass every other test.
//
// This is not hypothetical. The six-phase catch-up diff added the Bans & Appeals and
// Security Audit tabs by OVERWRITING the Database Tools tab's three lines instead of
// adding beside them: the component file stayed, the server actions stayed, the
// permission stayed — the only route to them disappeared. Database Tools is the org's
// break-glass (repairDatabase re-syncs the Admin role's permissions and lifts an
// otherwise-unliftable ban on an Admin via liftBansOnSystemAdmins), so losing the
// route turned a recoverable state into one needing raw SQL against the database.
//
// A tab whose only symptom is "nobody can reach it" is exactly what a source-level
// pin catches and a render test does not.

const SRC_PATH = resolve(__dirname, '..', 'components', 'views', 'admin', 'AdminPanelView.tsx');
const src = readFileSync(SRC_PATH, 'utf8');

/** The tabGroups object literal, from its declaration to the line that closes it. */
function tabGroupsBlock(): string {
    const start = src.indexOf('const tabGroups = {');
    expect(start, 'tabGroups was renamed or removed').toBeGreaterThan(-1);
    const end = src.indexOf('\n};', start);
    expect(end, 'tabGroups is not closed by a top-level };').toBeGreaterThan(start);
    return src.slice(start, end);
}

/** renderContent's switch, from `switch (activeTab)` to its default arm. */
function switchBlock(): string {
    const start = src.indexOf('switch (activeTab)');
    expect(start, 'renderContent no longer switches on activeTab').toBeGreaterThan(-1);
    const end = src.indexOf('default:', start);
    expect(end, 'the switch has no default arm').toBeGreaterThan(start);
    return src.slice(start, end);
}

const tabs = [...tabGroupsBlock().matchAll(/\{\s*id:\s*'([\w]+)'[^}]*\}/g)].map((m) => ({
    id: m[1],
    entry: m[0],
    permission: /permission:\s*'([^']+)'/.exec(m[0])?.[1],
    anyOf: /anyOf:\s*\[/.test(m[0]),
}));

const cases = [...switchBlock().matchAll(/case '([\w]+)':([^\n]*)/g)].map((m) => ({
    id: m[1],
    body: m[2],
}));

const lazyImports = new Map(
    [...src.matchAll(/const (\w+) = React\.lazy\(\(\) => import\('([^']+)'\)\)/g)]
        .map((m) => [m[1], m[2]] as const),
);

describe('AdminPanelView: nav ↔ switch ↔ lazy import stay in lockstep', () => {
    it('parses a plausible number of tabs, cases and lazy imports', () => {
        // Guards the regexes themselves: a parse that silently matched nothing would
        // make every assertion below vacuously true.
        expect(tabs.length).toBeGreaterThan(20);
        expect(cases.length).toBeGreaterThan(20);
        expect(lazyImports.size).toBeGreaterThan(20);
    });

    it('every tab in the nav has a case that renders it', () => {
        const caseIds = new Set(cases.map((c) => c.id));
        const unreachable = tabs.filter((t) => !caseIds.has(t.id)).map((t) => t.id);
        expect(unreachable, `nav tabs with no switch case: ${unreachable.join(', ')}`).toEqual([]);
    });

    it('every case in the switch has a tab that reaches it', () => {
        const tabIds = new Set(tabs.map((t) => t.id));
        const orphans = cases.filter((c) => !tabIds.has(c.id)).map((c) => c.id);
        expect(orphans, `switch cases with no nav entry: ${orphans.join(', ')}`).toEqual([]);
    });

    it('every component a case renders is imported in this file', () => {
        const declared = new Set([
            ...lazyImports.keys(),
            ...[...src.matchAll(/const (\w+): React\.FC/g)].map((m) => m[1]),
            ...[...src.matchAll(/^import (\w+) from/gm)].map((m) => m[1]),
        ]);
        for (const c of cases) {
            const rendered = [...c.body.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1]);
            expect(rendered.length, `case '${c.id}' renders no component`).toBeGreaterThan(0);
            for (const name of rendered) {
                expect(declared.has(name), `case '${c.id}' renders <${name}/>, which is not imported`).toBe(true);
            }
        }
    });

    it('every lazily imported tab file exists on disk', () => {
        // A chunk that 404s at runtime is a blank tab, and lazyWithRetry's force-reload
        // turns it into a reload loop rather than an error anyone reports.
        for (const [name, rel] of lazyImports) {
            const base = resolve(SRC_PATH, '..', rel);
            expect(existsSync(`${base}.tsx`) || existsSync(`${base}.ts`), `${name} imports ${rel}, which does not exist`).toBe(true);
        }
    });

    it('a case that gates on a permission gates on ITS OWN tab permission', () => {
        // Cosmetic-only (the server is the boundary), but a mismatch shows the tab to
        // someone who then 403s on every click, or hides it from someone entitled to it.
        for (const t of tabs) {
            if (t.anyOf || !t.permission) continue;
            const c = cases.find((x) => x.id === t.id);
            if (!c || !c.body.includes('hasPermission(')) continue;
            expect(c.body, `case '${t.id}' gates on a permission other than ${t.permission}`).toContain(`'${t.permission}'`);
        }
    });
});

describe('the break-glass tab specifically', () => {
    // Named rather than left to the generic checks above: those pass if Database Tools
    // is deleted cleanly from all three lists, which is precisely the outcome that
    // strands an org with an unliftable ban on its own Admin.
    it('Database Tools is present in all three lists', () => {
        expect(lazyImports.has('DatabaseToolsTab'), 'the lazy import was dropped').toBe(true);
        expect(tabs.some((t) => t.id === 'db_tools'), 'the nav entry was dropped').toBe(true);
        expect(cases.some((c) => c.id === 'db_tools'), 'the switch case was dropped').toBe(true);
    });

    it('is reachable on the BROAD permission, not the one only Repair can grant', () => {
        // admin:db:destroy gates the buttons server-side. Gating the route on it too
        // would mean an install whose Admin role predates that permission — the exact
        // install that needs Repair — cannot see the tab that runs Repair.
        const tab = tabs.find((t) => t.id === 'db_tools')!;
        expect(tab.permission).toBe('admin:access');
    });

    it('Bans & Appeals was ADDED beside it, not over it', () => {
        expect(tabs.some((t) => t.id === 'bans')).toBe(true);
        expect(cases.some((c) => c.id === 'bans')).toBe(true);
        expect(lazyImports.has('BanManagementTab')).toBe(true);
    });
});
