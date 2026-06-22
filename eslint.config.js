// Flat ESLint config (ESLint v9). Project is "type": "module" so this file is ESM.
//
// Type-aware rules (recommendedTypeChecked) are skipped to avoid the per-file
// cost of `parserOptions.project`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

export default [
    {
        ignores: [
            'dist/**',
            'dist-server/**',
            'node_modules/**',
            'legacy-portal/**',
            'supabase-reports/**',
            'coverage/**',
            '.vite/**',
            // Vite serves /public/ as static assets; not part of the TS compile.
            'public/**',
        ],
    },

    js.configs.recommended,
    {
        rules: {
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-var': 'error',
            'prefer-const': 'error',
            // Empty catch is allowed only when the block contains a comment
            // explaining why — `no-empty` treats commented blocks as non-empty.
            'no-empty': ['error', { allowEmptyCatch: false }],
        },
    },

    ...tseslint.configs.recommended.map((cfg) => ({
        ...cfg,
        files: ['**/*.{ts,tsx}'],
    })),
    {
        files: ['**/*.{ts,tsx}'],
        plugins: { 'unused-imports': unusedImports },
        rules: {
            // Off globally; enforced only on api/actions + lib/db (see ratchet
            // override below). Enabling everywhere is a large typing refactor.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'error',
            'no-unused-vars': 'off',
            // unused-imports plugin provides the autofix for unused imports that
            // typescript-eslint's rule lacks. The unused vars/args companion is
            // off — those sites need per-site judgment.
            '@typescript-eslint/no-unused-vars': 'off',
            'unused-imports/no-unused-imports': 'error',
            'unused-imports/no-unused-vars': 'off',
            // TS handles undeclared vars; the base rule false-positives on TS-only syntax.
            'no-undef': 'off',
            // Triggers on `{}` interfaces; allow for now.
            '@typescript-eslint/no-empty-object-type': 'off',
            // Allow void short-circuit expressions.
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    },

    {
        files: ['**/*.tsx'],
        plugins: { react },
        languageOptions: {
            parserOptions: {
                ecmaFeatures: { jsx: true },
            },
        },
        settings: { react: { version: '19' } },
        rules: {
            ...react.configs.recommended.rules,
            'react/react-in-jsx-scope': 'off', // React 19 / new JSX transform
            'react/prop-types': 'off',         // TypeScript handles prop typing
            // Off: legitimate ' and " in JSX text are parsed unambiguously by
            // the modern JSX transform, so the rule adds only cosmetic churn.
            'react/no-unescaped-entities': 'off',
        },
    },

    // Non-null-assertion overrides. The rule stays on for component code where
    // sloppy `!` hides null cases; it is exempted for two categories where `!`
    // is deliberate: (1) api/** + lib/** + tests/** + App.tsx, where `!` sits at
    // trust boundaries (env asserted at boot, row narrows after select, test
    // fixtures, SSR-injected globals); and (2) specific component files where
    // `!` is structural (chart renderers narrowing by runtime type field,
    // post-filter narrowing chains, modals that already guarded their prop).
    // New files still get caught — do not grow this list.
    {
        files: [
            'App.tsx',
            'api/**/*.{ts,tsx}',
            'lib/**/*.{ts,tsx}',
            'tests/**/*.{ts,tsx}',
            'contexts/HIDPTTContext.tsx',
            'hooks/useTableControls.ts',
            'components/modals/CreateOperationWizard.tsx',
            'components/modals/hr/ScheduleInterviewModal.tsx',
            'components/modals/hr/SecurityVettingModal.tsx',
            'components/ui/RadioWidget.tsx',
            'components/views/admin/AdminMemberManagement.tsx',
            'components/views/admin/ExternalToolsManagementTab.tsx',
            'components/views/admin/UnitManagementTab.tsx',
            'components/views/fleet/FleetManagerView.tsx',
            'components/views/fleet/FleetOrgChart.tsx',
            'components/views/government/LegislationDetailView.tsx',
            'components/views/government/VotingBooth.tsx',
            'components/views/hr/ProbationTab.tsx',
            'components/views/hr/UnifiedCaseFileView.tsx',
            'components/views/operations/OperationsCenterView.tsx',
            'components/views/operations/tabs/OpAARTab.tsx',
            'components/views/operations/tabs/OpCommandSignalsTab.tsx',
            'components/views/operations/tabs/OpExecutionTab.tsx',
            'components/views/operations/tabs/OpOrbatNodeGraph.tsx',
            'components/views/quartermaster/AdjustStockDialog.tsx',
            'components/views/tools/ExternalToolsView.tsx',
            'components/views/tools/RadioControlView.tsx',
            'components/views/warehouse/WhStockTab.tsx',
            'components/views/warehouse/modals/WhAdjustStockDialog.tsx',
        ],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },

    {
        files: ['**/*.{ts,tsx}'],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            ...reactHooks.configs.recommended.rules,
            // On at 'error'. The few intentional omissions each carry an
            // inline `eslint-disable-next-line react-hooks/exhaustive-deps`
            // with a one-line reason; treat any new violation as a real bug.
            'react-hooks/exhaustive-deps': 'error',
        },
    },

    {
        files: ['**/*.tsx'],
        plugins: { 'react-refresh': reactRefresh },
        rules: {
            'react-refresh/only-export-components': [
                'warn',
                { allowConstantExport: true },
            ],
        },
    },
    {
        // Context/hook modules and a few view files legitimately export
        // constants/utils alongside their component — disable the
        // HMR-only-components rule for them.
        files: [
            'contexts/**/*.tsx',
            'hooks/**/*.{ts,tsx}',
            '**/*Context.tsx',
            'components/views/intel/BulletinCard.tsx',
            'components/shared/BootSplash.tsx',
        ],
        rules: {
            'react-refresh/only-export-components': 'off',
        },
    },

    // Globals — Node for server-side, browser for client-side.
    {
        files: [
            'api/**/*.{ts,tsx}',
            'lib/**/*.{ts,tsx}',
            'scripts/**/*.{js,mjs,ts}',
            'server.ts',
            '*.config.{js,ts,mjs,cjs}',
            'eslint.config.js',
        ],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
    {
        files: [
            'components/**/*.{ts,tsx}',
            'contexts/**/*.{ts,tsx}',
            'hooks/**/*.{ts,tsx}',
            'services/**/*.{ts,tsx}',
            '*.tsx',
            'DashboardApp.tsx',
        ],
        languageOptions: {
            globals: { ...globals.browser },
        },
    },

    // Shared modules (run in both Node and browser contexts).
    {
        files: ['types.ts', 'index.tsx'],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
    },

    // Tests overlay — vitest globals.
    {
        files: ['tests/**/*.{ts,tsx}'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeAll: 'readonly',
                beforeEach: 'readonly',
                afterAll: 'readonly',
                afterEach: 'readonly',
                vi: 'readonly',
            },
        },
    },

    // no-console ratchet, scoped to the server-only directories already migrated
    // to the lib/log.ts structured logger (RPC action handlers + DB layer).
    // Broader globs still hold intentional console.* (the api/sw.ts browser emit,
    // isomorphic/client modules that must not import the Node logger). Expand as
    // those areas migrate.
    {
        files: ['api/actions/**/*.ts', 'lib/db/**/*.ts'],
        rules: {
            'no-console': 'error',
        },
    },

    // no-explicit-any ratchet. The auth boundary (api/actions/**) and the data
    // layer (lib/db/**) are fully typed, so any-freedom is enforced there to
    // prevent backsliding. The rule stays globally 'off' (see above) — typing
    // the ~800 component/context/hook sites is a separate, larger effort.
    {
        files: ['api/actions/**/*.ts', 'lib/db/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },

    // Vite inlines every `import.meta.env.VITE_*` value into the PUBLIC client
    // bundle, so referencing one ships it to every visitor. There are none today;
    // ban the pattern in client code so a future VITE_<secret> can't be added
    // silently. A genuinely public VITE_ value must opt in with an eslint-disable
    // + a comment confirming it carries no secret. (HANDOFF s8-bb, generic.)
    {
        files: ['components/**/*.{ts,tsx}', 'contexts/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}', 'services/**/*.{ts,tsx}', '*.tsx'],
        rules: {
            'no-restricted-syntax': ['error', {
                selector: "MemberExpression[object.type='MemberExpression'][object.object.type='MetaProperty'][object.property.name='env'][property.name=/^VITE_/]",
                message: 'Do not reference import.meta.env.VITE_* in client code — Vite inlines it into the public bundle. If it is genuinely non-secret, add an eslint-disable with a justifying comment.',
            }],
        },
    },

    // Client code (components / contexts / hooks / services / root *.tsx) must not
    // import server-only modules: Vite would bundle their code and any literals — the
    // service-role Supabase client, key derivation, JWT signing, the Discord bot token
    // — into the public client bundle. This turns that into a build failure instead of
    // relying on review. Modules that are safe in both places (oauthState, the anon
    // supabaseClient, audio*, slice*, debugLog, time, imageUrl, linkUrl, ...) aren't
    // listed and stay importable. Client code reaches server logic via
    // services/apiService.ts.
    {
        files: ['components/**/*.{ts,tsx}', 'contexts/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}', 'services/**/*.{ts,tsx}', '*.tsx'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: [
                        '**/lib/db', '**/lib/db/**',
                        '**/lib/secrets', '**/lib/crypto', '**/lib/auth', '**/lib/discord',
                        '**/lib/push', '**/lib/radio', '**/lib/ai', '**/lib/pgrest',
                        '**/lib/ssrf', '**/lib/firstBoot', '**/lib/cronLock', '**/lib/seeder',
                        '**/lib/supabaseServer', '**/lib/abuseFilter',
                        '**/api/services', '**/api/query', '**/api/public', '**/api/index', '**/api/sw',
                        '**/api/actions/**',
                    ],
                    message: 'Server-only module — importing it into client code would ship server logic/secrets into the public client bundle. Reach it through services/apiService.ts instead.',
                }],
            }],
        },
    },
];
