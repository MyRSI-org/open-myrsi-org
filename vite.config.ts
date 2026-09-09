import { defineConfig, loadEnv } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
        // Regression floor scoped to the server/business-logic surface (lib +
        // api); the untested UI is excluded so the gate isn't dominated by
        // component churn. `all: true` counts untested files so the baseline is
        // honest. Thresholds sit just under the measured baseline — ratchet up
        // as coverage grows, never down.
        provider: 'v8',
        all: true,
        include: ['lib/**', 'api/**'],
        exclude: ['**/*.d.ts'],
        reporter: ['text-summary'],
        thresholds: {
          // Ratcheted 6 Sep 26 (catch-up phase 6: org bans, ship seats, armoury
          // facets, Discord feature layer, marketplace barter, Academy v1.2,
          // Blueprint Manager) to sit ~1pt under the measured baseline
          // (lines 56.02 / statements 53.58 / functions 44.92 / branches 47.37).
          // Previously 54/51/42/45 against a 54.66/52.38/43.60/46.27 baseline,
          // 50/48/39/42 before that, 41/39/32/35 before that, and 40/38/31/34
          // before that.
          // This is a regression FLOOR — ratchet it up, never down.
          lines: 55,
          statements: 52,
          functions: 43,
          branches: 46,
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
