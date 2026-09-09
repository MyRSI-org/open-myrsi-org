import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXPECTED_SCHEMA_VERSION, compareSchemaVersion } from '../lib/schemaVersion';

// =============================================================================
// The version string lives in SIX places. This is the gate that keeps them equal.
// =============================================================================
// It is not a tidiness rule. schema.sql stamps settings.schema_version on every apply
// and the Database Tools health check now compares that stamp against
// EXPECTED_SCHEMA_VERSION — so a release that bumps the banners and forgets the schema
// stamp makes the app report DRIFT on a database that is perfectly up to date, and an
// operator who is told to re-run schema.sql when they do not need to learns to ignore
// the warning. The inverse is worse: bumping the stamp without the code means a real
// drift reports OK.
//
// This was not a hypothetical. The version was believed to live in four places; the
// changelog card was a fifth nobody had listed, and it was found only by grepping.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// Every file that must carry the version, and how to pull it out of that file.
const SITES: Array<{ file: string; label: string; extract: (s: string) => string[] }> = [
    {
        file: 'schema.sql',
        label: 'the settings.schema_version stamp applied to the database',
        extract: (s) => [...s.matchAll(/VALUES \('schema_version', '"([^"]+)"'::jsonb\)/g)].map(m => m[1]),
    },
    {
        file: 'api/index.ts',
        label: 'the SSR boot-splash banner',
        extract: (s) => [...s.matchAll(/Termlink v(\d+\.\d+\.\d+-open)/g)].map(m => m[1]),
    },
    {
        file: 'components/layout/Sidebar.tsx',
        label: 'the sidebar build stamp',
        extract: (s) => [...s.matchAll(/v(\d+\.\d+\.\d+-open)/g)].map(m => m[1]),
    },
    {
        file: 'components/shared/BootSplash.tsx',
        label: 'the client boot splash',
        extract: (s) => [...s.matchAll(/Termlink v(\d+\.\d+\.\d+-open)/g)].map(m => m[1]),
    },
    {
        file: 'DashboardApp.tsx',
        label: 'the dashboard footer stamp',
        extract: (s) => [...s.matchAll(/Termlink v(\d+\.\d+\.\d+-open)/g)].map(m => m[1]),
    },
];

describe('the release version is the same everywhere it is written', () => {
    it.each(SITES)('$file carries $label at the expected version', ({ file, extract }) => {
        const found = extract(read(file));
        expect(found.length, `no version string found in ${file} — the format changed and this gate stopped checking anything`)
            .toBeGreaterThan(0);
        for (const v of found) {
            expect(v, `${file} is at ${v} but lib/schemaVersion.ts expects ${EXPECTED_SCHEMA_VERSION}`)
                .toBe(EXPECTED_SCHEMA_VERSION);
        }
    });

    it('the changelog has a card for the current release, marked as current', () => {
        // The fifth site, and the one that was missing from the list of four. A release
        // whose changelog still marks the PREVIOUS version as current tells every user
        // the update did not land.
        const log = read('components/views/help/ChangeLogView.tsx');
        expect(log, `no changelog card for ${EXPECTED_SCHEMA_VERSION}`)
            .toContain(`version="${EXPECTED_SCHEMA_VERSION}"`);
        const cardAt = log.indexOf(`version="${EXPECTED_SCHEMA_VERSION}"`);
        const cardTag = log.slice(cardAt, log.indexOf('>', cardAt));
        expect(cardTag, 'the current release card must carry isLatest').toContain('isLatest');
        // And no OTHER card may claim it. Count VersionCard USAGES carrying the prop,
        // not bare occurrences of the word — the component's own declaration mentions
        // isLatest four times, so a raw count is a number nobody can reason about.
        const latestCards = [...log.matchAll(/<VersionCard[^>]*\bisLatest\b/g)];
        expect(latestCards.length, 'exactly one VersionCard may be marked isLatest').toBe(1);
        expect(latestCards[0][0], 'the isLatest card must be the current release')
            .toContain(EXPECTED_SCHEMA_VERSION);
    });
});

describe('compareSchemaVersion fails safe', () => {
    it('reports ok on a match', () => {
        expect(compareSchemaVersion(EXPECTED_SCHEMA_VERSION).status).toBe('ok');
    });

    it('reports drift on a mismatch', () => {
        const r = compareSchemaVersion('15.2.0-open');
        expect(r.status).toBe('drift');
        expect(r.applied).toBe('15.2.0-open');
        expect(r.expected).toBe(EXPECTED_SCHEMA_VERSION);
    });

    it('reports UNKNOWN — never drift — when the stamp is missing or unreadable', () => {
        // "We could not tell" must not render to an operator as "your database is out of
        // date". Sending someone to re-run schema.sql for a problem they do not have is
        // how a warning becomes background noise, and this warning has to be believed.
        for (const v of [null, undefined, '', '   ']) {
            expect(compareSchemaVersion(v as string | null | undefined).status).toBe('unknown');
        }
    });

    it('trims whitespace rather than reporting a false drift', () => {
        expect(compareSchemaVersion(` ${EXPECTED_SCHEMA_VERSION} `).status).toBe('ok');
    });
});

describe('the health check surfaces the comparison', () => {
    it('runDatabaseHealthCheck reports the schema version and how to fix drift', () => {
        const sys = read('lib/db/system.ts');
        expect(sys).toContain('compareSchemaVersion');
        expect(sys, 'the drift row must tell the operator what to do about it')
            .toContain('Re-run schema.sql');
        // The read must be defensive: an absent settings row or table reports unknown,
        // not a false drift, so a fresh install does not scream on first boot.
        const at = sys.indexOf('compareSchemaVersion(applied)');
        expect(at, 'the comparison call moved').toBeGreaterThan(-1);
        const around = sys.slice(Math.max(0, at - 900), at + 900);
        expect(around, 'the stamp read must be wrapped so a fault cannot throw the whole health check')
            .toContain('try {');
    });
});
