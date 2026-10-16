import { PrismaClient } from '@prisma/client'
import { env } from '../../config/env'
import { hmac, randomOtp, safeEqual } from '../../lib/crypto'
import { uuidv7 } from '../../lib/id'
import { BadRequestError } from '../../utils/errors'

export type OtpPurpose =
  | 'SIGNUP_VERIFY'
  | 'LOGIN_STEP_UP'
  | 'LOGIN_PASSWORDLESS'
  | 'PASSWORD_RESET'
  | 'EMAIL_CHANGE'
  | 'STAFF_INVITE'

export const OTP_TTL_MS = 10 * 60 * 1000
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000
export const OTP_HOURLY_CAP = 5
const MAX_ATTEMPTS = 5

const codeHash = (email: string, purpose: string, code: string) =>
  hmac(`${email}|${purpose}|${code}`, env.OTP_HMAC_SECRET)

/**
 * Create a new OTP challenge. Returns the plain code to e-mail, or null when throttled
 * (60 s cooldown, 5 per hour per address). Callers answer the same either way, so an attacker
 * learns nothing about which addresses exist.
 */
export async function createOtp(
  prisma: PrismaClient,
  input: { email: string; purpose: OtpPurpose; userId?: string | null; ip?: string | null },
): Promise<string | null> {
  const now = Date.now()
  const recent = await prisma.otpChallenge.findMany({
    where: { email: input.email, createdAt: { gt: new Date(now - 3600_000) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, purpose: true },
  })
  if (recent.length >= OTP_HOURLY_CAP) return null
  const last = recent.find((r) => r.purpose === input.purpose)
  if (last && now - last.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) return null

  const code = randomOtp()
  await prisma.$transaction([
    // Only one live code per (email, purpose)
    prisma.otpChallenge.updateMany({
      where: { email: input.email, purpose: input.purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.otpChallenge.create({
      data: {
        id: uuidv7(),
        userId: input.userId ?? null,
        email: input.email,
        purpose: input.purpose,
        codeHash: codeHash(input.email, input.purpose, code),
        expiresAt: new Date(now + OTP_TTL_MS),
        requestIp: input.ip ?? null,
      },
    }),
  ])
  return code
}

/**
 * Check a code. Single use and race-safe: the attempt counter and the "consumed" flag are set
 * with conditional UPDATEs, so two parallel requests cannot both succeed. After 5 wrong tries
 * the challenge is burned. Always fails with the same error, whatever the reason.
 */
export async function verifyOtp(
  prisma: PrismaClient,
  input: { email: string; purpose: OtpPurpose; code: string },
): Promise<{ userId: string | null }> {
  const fail = () => new BadRequestError('Invalid or expired code', 'OTP_INVALID')

  const live = await prisma.otpChallenge.findFirst({
    where: {
      email: input.email,
      purpose: input.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!live) throw fail()

  // Count this attempt first. Only succeeds while attempts remain.
  const counted = await prisma.$executeRaw`
    UPDATE otp_challenges SET attempts = attempts + 1
    WHERE id = ${live.id}::uuid AND consumed_at IS NULL AND attempts < max_attempts`
  if (counted !== 1) throw fail()

  const ok = safeEqual(live.codeHash, codeHash(input.email, input.purpose, input.code))
  if (!ok) {
    if (live.attempts + 1 >= MAX_ATTEMPTS) {
      await prisma.otpChallenge.updateMany({
        where: { id: live.id, consumedAt: null },
        data: { consumedAt: new Date() },
      })
    }
    throw fail()
  }

  // Burn it. Exactly one concurrent caller wins.
  const won = await prisma.otpChallenge.updateMany({
    where: { id: live.id, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (won.count !== 1) throw fail()
  return { userId: live.userId }
}
