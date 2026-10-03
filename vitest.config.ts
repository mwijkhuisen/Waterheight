import { defineConfig } from 'vitest/config';

// Anchored to the workspace, so nested checkouts (.claude/worktrees/*) are never picked up.
const testFiles = ['test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'];
const integrationFiles = testFiles.map((glob) => glob.replace(/\.test\.ts$/, '.int.test.ts'));

export default defineConfig({
  test: {
    // Every project inherits this: no test ever reaches the network (msw
    // fails on any unhandled request).
    setupFiles: ['test/msw.setup.ts'],
    passWithNoTests: false,
    // Node 26 enables Web Storage by default and warns in every worker; tests never use it.
    execArgv: ['--no-experimental-webstorage'],
    // `pnpm test:coverage` (issue #17: at least 90% line coverage of every adapter's parse and normalise).
    // It runs the adapter tests and the core tests only: under instrumentation the timing tests of the recorder are too slow.
    coverage: {
      provider: 'v8',
      include: [
        'apps/server/src/adapters/*/parse.ts',
        'apps/server/src/adapters/*/normalise.ts',
        // P5c: the shared code of a provider or a protocol (the KiWIS client, the AGE slug).
        'apps/server/src/adapters/_shared/*/*.ts',
        // P7b: the classifier and the class crosswalk (packages/core/test).
        'packages/core/src/classify.ts',
        'packages/core/src/crosswalk.ts',
      ],
      reporter: ['text'],
      thresholds: { lines: 90, perFile: true },
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: testFiles, exclude: ['**/*.int.test.ts', '**/node_modules/**'] },
      },
      {
        extends: true,
        // One file at a time: the database roles are cluster-wide, and every file creates its own database.
        test: {
          name: 'integration',
          include: integrationFiles,
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
