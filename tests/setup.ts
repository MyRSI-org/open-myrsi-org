import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Stub env vars consumed at module-load time by server-side modules
// (e.g. lib/supabaseServer.ts throws if these are absent). Real DB access
// in tests should mock the supabase client; these stubs only get the
// import graph past the boot-time guard.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.JWT_SECRET ??= 'test-jwt-secret-for-vitest-only';

// Silence the structured logger by default — tests that exercise the
// logger directly (tests/log.test.ts) override this in their own
// beforeEach. Without this, code paths under test that emit info/warn
// would pollute the vitest console with JSON lines.
process.env.LOG_LEVEL ??= 'silent';

// Cleanup after each test case (e.g. clearing jsdom)
afterEach(() => {
    cleanup();
});
