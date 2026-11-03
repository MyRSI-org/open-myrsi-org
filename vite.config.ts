import { defineConfig, loadEnv } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Security-critical files are held to >= 90% on every coverage metric, per file: the
// dispatcher, read path and server boundary; auth, session and OAuth state; the
// sanitisers; the SSRF and clearance predicates; secret handling; rate limiting and abuse
// blocking; log redaction; the unauthenticated public API, uploads and first-boot setup.
const SECURITY_CRITICAL_FILES = [
  'server.ts', 'api/services.ts', 'api/query.ts', 'api/actions/auth.ts', 'api/public.ts', 'api/orgUpload.ts',
  'lib/auth.ts', 'lib/sessionCookie.ts', 'lib/sessionSecretPolicy.ts', 'lib/oauthState.ts', 'lib/oauthStateCookie.ts',
  'lib/csrfOrigin.ts', 'lib/constantTime.ts', 'lib/joinPinLockout.ts', 'lib/joinPinPolicy.ts', 'lib/firstBoot.ts',
  'lib/tiptapValidate.ts', 'lib/htmlSanitize.ts', 'lib/textSanitize.ts',
  'lib/ssrf.ts', 'lib/linkUrl.ts', 'lib/clearance.ts',
  'lib/crypto.ts', 'lib/secrets.ts', 'lib/supabaseKeyGuard.ts', 'lib/log.ts',
  'lib/abuseFilter.ts', 'lib/clientIp.ts', 'lib/userRateLimit.ts', 'lib/authRateLimit.ts',
  'lib/terminalErrorHandler.ts', 'lib/errors.ts',
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': import.meta.dirname,
      }
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './tests/setup.ts',
      // Keep vitest's default excludes, plus the reference-only / non-app trees.
      exclude: [...configDefaults.exclude, 'porting/**', 'legacy-portal/**', 'supabase-reports/**'],
      coverage: {
        // The coverage STANDARD for the server/business-logic surface (lib + api +
        // server.ts). These are fixed thresholds, not a floor under the last
        // measurement, and every measured file must meet them on its own: a well
        // tested module cannot hide an untested one. `all: true` counts files no test
        // imports, so a new untested file fails the gate. UI components are outside
        // the gate; behaviour changes there are pinned by their own tests.
        provider: 'v8',
        all: true,
        // server.ts is the security boundary (rate limiters, CSRF gate, body parsers,
        // the import-stream inline auth, boot guards), so it is measured like the rest
        // of the server. The generated Supabase schema types are not code under test.
        include: ['lib/**', 'api/**', 'server.ts'],
        exclude: ['**/*.d.ts', 'lib/database.types.ts'],
        reporter: ['text-summary'],
        thresholds: {
          // Every measured file: >= 80% statements, functions and lines, >= 75% branches.
          perFile: true,
          statements: 80,
          functions: 80,
          lines: 80,
          branches: 75,
          // Security-critical files: >= 90% on all four (glob entries need their own perFile).
          ...Object.fromEntries(SECURITY_CRITICAL_FILES.map((file) => [
            file, { statements: 90, functions: 90, lines: 90, branches: 90, perFile: true },
          ])),
        },
      },
    },
    build: {
      rolldownOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              if (id.includes('livekit')) return 'vendor-livekit';
              if (id.includes('@supabase')) return 'vendor-supabase';
              if (id.includes('@google') || id.includes('genai')) return 'vendor-genai';
              return 'vendor';
            }
            // Bundle the supabaseClient wrapper into the @supabase vendor chunk
            // rather than a standalone chunk, which Cloudflare's edge
            // optimization fails to proxy (returns 522 instead of the file).
            if (id.includes('lib/supabaseClient')) return 'vendor-supabase';
          }
        }
      },
      chunkSizeWarningLimit: 1000
    }
  };
});
