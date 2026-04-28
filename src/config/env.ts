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
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
})

const parsedEnv = envSchema.safeParse(process.env)

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsedEnv.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsedEnv.data
export type Env = z.infer<typeof envSchema>
