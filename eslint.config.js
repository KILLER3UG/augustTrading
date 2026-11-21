import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/**',
      'dist_electron/**',
      'node_modules/**',
      '.probe-artifacts/**',
      'android/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      // Desk tooling — one-off CJS scripts, never shipped.
      'scripts/**/*.cjs',
      // The verifier's scratch tree — node harnesses and Playwright probes run
      // against a built bundle, in CommonJS, with their own globals. Untracked,
      // so CI never sees it, yet `npm run lint` swept it and reported 568 errors
      // from it on a tree whose tracked files hold 0. Ignoring it changes no
      // verdict about shipped code; it removes a blind fold over the result.
      '.verify/**',
      // Local archive of superseded notes and one-off migration scripts. Ignored
      // by git and never shipped; linting it reports on files no gate can see.
      '.local-archive/**',
    ],
  },
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setImmediate: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  {
    // Node CommonJS modules under shared/ loaded by Electron main and tests.
    files: ['shared/repoSandbox.cjs', 'shared/updateVerificationPolicy.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  {
    rules: {
      // Relax rules that would produce too many errors initially.
      //
      // WARNING RATCHET: `npm run lint` runs with --max-warnings 379 in
      // package.json. The number must EQUAL the warning count on a clean main,
      // because the cap is only a ratchet if it actually binds.
      //
      // 659 -> 385: the 515-file test tree was deleted on 2026-10-23 and the
      // tests/ eslint block carried 267 of the tree's warnings with it.
      // 385 -> 379: the scheduled-automation feature was deleted on 2026-10-24
      // (its own modules carried 6 warnings). Re-measured with
      // `npm run lint:loose`; the cap is re-tightened to the exact count in the
      // same change, which is the only way it keeps binding.
      //
      // It did not, for a long time: the cap sat at 1020 while the tree stood
      // at 949, so 71 warnings could be added and CI would still pass. That is
      // why `tests/hookDestructureHygiene.test.ts` had to exist — the repo was
      // hand-rolling a dead-binding guard because the installed AST rule that
      // already does the job was gated by a cap with slack in it. The guard was
      // removed when the cap was corrected.
      //
      // 949 -> 889: the first cleanup the corrected ratchet made safe. It
      // removed 58 unused imports from App.tsx, whose real dependency surface
      // was 58 names wider than anything in the file actually used.
      //
      // 889 -> 659: the cap had drifted loose again — it stood at 889 against a
      // 659-warning tree, so 230 warnings could be added and CI would still
      // pass. Re-measured with `npm run lint:loose` and re-tightened to the
      // exact count (2026-10-20).
      //
      // App.tsx carries 17 `no-unused-vars` warnings in all: 10 unused LOCAL
      // declarations, plus 7 unused import bindings spread across 5 import
      // statements. The 10 locals are deliberately NOT swept in: each is a
      // hook binding or a destructured return value whose initialiser has to
      // be read before deciding whether removing it removes a computation or
      // a subscription. Pay those down as their files are touched, not in a
      // bulk pass.
      //
      // Re-measure on a clean checkout after touching this file, and LOWER the
      // number when you pay warnings down; never raise it to go green.
      // `npm run lint:loose` lists them without the cap for a cleanup pass.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off', // App uses console extensively; migrate to logger incrementally
    },
  },
);
