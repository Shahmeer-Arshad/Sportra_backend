import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Run tests sequentially to avoid DB race conditions
    pool: 'forks',
    maxWorkers: 1,
    // Load test env overrides before each suite
    setupFiles: ['./tests/setup.ts'],
    globals: true,
  },
})
