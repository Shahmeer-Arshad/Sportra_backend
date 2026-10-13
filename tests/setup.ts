/**
 * Vitest global setup — runs before all test files.
 * Override env vars here so tests use a dedicated test database
 * and shorter-lived tokens.
 */
import { config } from 'dotenv'
import { resolve } from 'path'

// Load base .env then allow TEST_* overrides
config({ path: resolve(process.cwd(), '.env') })

// Use a separate test DB if TEST_DATABASE_URL is set
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}

// Short-lived tokens in tests for convenience
process.env.ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN ?? '15m'
process.env.REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN ?? '7d'
process.env.NODE_ENV = 'test'
