import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Run tests sequentially to avoid DB race conditions
    pool: 'forks',
    maxWorkers: 1,
    // Test files share one database (outbox table), so files must run one at a time
    fileParallelism: false,
    // Load test env overrides before each suite
    setupFiles: ['./tests/setup.ts'],
    globals: true,
  },
})
