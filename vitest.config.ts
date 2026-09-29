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
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: testFiles, exclude: ['**/*.int.test.ts', '**/node_modules/**'] },
      },
      { extends: true, test: { name: 'integration', include: integrationFiles, exclude: ['**/node_modules/**'] } },
    ],
  },
});
