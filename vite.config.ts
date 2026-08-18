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
          // Ratcheted 18 Aug 26 to sit ~1pt under the measured baseline
          // (lines 41.19 / statements 39.05 / functions 32.17 / branches 35.38).
          // The previous 5/5/3/3 floor sat so far below actual coverage that a
          // collapse to 6% would still have passed the gate.
          lines: 40,
          statements: 38,
          functions: 31,
          branches: 34,
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
