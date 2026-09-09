/**
 * The schema version this build EXPECTS the database to be at.
 *
 * schema.sql stamps `settings.schema_version` on every apply, but until now nothing
 * compared that stamp against the running code — so the single most common upgrade
 * mistake (pull the new code, forget to re-run schema.sql) was invisible until a
 * feature failed with a confusing error. The Database Tools health check now reports
 * the mismatch, and the server logs it once at boot.
 *
 * KEEP THIS EQUAL to the version stamped at the end of schema.sql. Both are pinned to
 * the app's banner string by tests/schemaVersionParity.test.ts, which exists because
 * the version lives in FIVE places (this file, schema.sql, api/index.ts,
 * components/layout/Sidebar.tsx, components/shared/BootSplash.tsx and DashboardApp.tsx)
 * and a release that updates four of them reports a database state that is not true.
 *
 * Dependency-free on purpose: it compiles under both tsconfigs and a test can read it
 * without pulling in the server.
 */
export const EXPECTED_SCHEMA_VERSION = '15.7.0-open';

/**
 * Compare the stamp read from the database against what this build expects.
 *
 * Fails SAFE rather than loud: an unreadable or absent stamp reports `unknown` rather
 * than `drift`, because "we could not tell" must not be rendered to an operator as
 * "your database is out of date" — that would send them to re-run schema.sql to fix a
 * problem they do not have, and cry-wolf warnings get ignored exactly when they matter.
 */
export function compareSchemaVersion(applied: string | null | undefined): {
    status: 'ok' | 'drift' | 'unknown';
    applied: string | null;
    expected: string;
} {
    const value = typeof applied === 'string' && applied.trim() ? applied.trim() : null;
    if (!value) return { status: 'unknown', applied: null, expected: EXPECTED_SCHEMA_VERSION };
    return {
        status: value === EXPECTED_SCHEMA_VERSION ? 'ok' : 'drift',
        applied: value,
        expected: EXPECTED_SCHEMA_VERSION,
    };
}
