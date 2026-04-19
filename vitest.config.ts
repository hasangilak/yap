import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/setup.ts'],
    // Run serially so Postgres TRUNCATE doesn't race between files.
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
