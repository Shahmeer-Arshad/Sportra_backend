import { z } from 'zod'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env from project root (works in both dev and production)
config({ path: resolve(process.cwd(), '.env') })

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  ACCESS_TOKEN_SECRET: z.string().min(16, 'ACCESS_TOKEN_SECRET must be at least 16 characters'),
  REFRESH_TOKEN_SECRET: z.string().min(16, 'REFRESH_TOKEN_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'), // legacy, unused: refresh tokens last REFRESH_TOKEN_DAYS
  // Comma-separated list of allowed CORS origins, e.g. "http://localhost:3000,https://myapp.com"
  ALLOWED_ORIGINS: z.string().optional(),
  // Optional infrastructure. The API runs without them; /readyz reports what is configured.
  REDIS_URL: z.string().optional(),
  RABBITMQ_URL: z.string().optional(),
  // Identity
  // bcrypt work factor (12 in production; tests use a low value to stay fast)
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(30),
  OTP_HMAC_SECRET: z.string().min(16, 'OTP_HMAC_SECRET must be at least 16 characters'),
  // Email (MailHog in dev). In tests mail is captured in memory.
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(51025),
  // Set both for a real provider (e.g. Gmail app password). Leave empty for MailHog.
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Sportra <no-reply@sportra.local>'),
  // Outbox relay worker
  OUTBOX_POLL_MS: z.coerce.number().default(500),
  OUTBOX_BATCH: z.coerce.number().default(100),
  // Booking (Phase 2)
  HOLD_SECONDS: z.coerce.number().int().min(1).default(300), // a hold lasts exactly 5 minutes
  SLOT_HORIZON_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  MAX_PENDING_HOLDS: z.coerce.number().int().min(1).default(2),
  MAX_UNPAID_BOOKINGS: z.coerce.number().int().min(1).default(1),
  NO_SHOW_AFTER_MINUTES: z.coerce.number().int().min(1).default(20),
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(60),
  // Signs QR entry passes. Falls back to a value derived from ACCESS_TOKEN_SECRET when unset.
  QR_PASS_SECRET: z.string().min(16).optional(),
})

const parsedEnv = envSchema.safeParse(process.env)

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsedEnv.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsedEnv.data
export type Env = z.infer<typeof envSchema>
