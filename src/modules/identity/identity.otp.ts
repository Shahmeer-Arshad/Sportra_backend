import { FastifyBaseLogger } from 'fastify'
import { env } from '../../config/env'
import { hmac, randomOtp, safeEqual } from '../../lib/crypto'
import { Mailer } from '../../lib/mailer'
import { BadRequestError } from '../../utils/errors'
import { IdentityRepository } from './identity.repository'

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

const SUBJECT: Record<OtpPurpose, string> = {
  SIGNUP_VERIFY: 'Verify your Sportra email',
  LOGIN_STEP_UP: 'Your Sportra login code',
  LOGIN_PASSWORDLESS: 'Your Sportra login code',
  PASSWORD_RESET: 'Reset your Sportra password',
  EMAIL_CHANGE: 'Confirm your new email',
  STAFF_INVITE: 'Your Sportra invitation code',
}

const codeHash = (email: string, purpose: string, code: string) =>
  hmac(`${email}|${purpose}|${code}`, env.OTP_HMAC_SECRET)

export function createOtpService(repo: IdentityRepository, mailer: Mailer, log: FastifyBaseLogger) {
  /**
   * Create a new OTP challenge. Returns the plain code to e-mail, or null when throttled
   * (60 s cooldown, 5 per hour per address). Callers answer the same either way, so an attacker
   * learns nothing about which addresses exist.
   */
  async function create(input: {
    email: string
    purpose: OtpPurpose
    userId?: string | null
    ip?: string | null
  }): Promise<string | null> {
    const now = Date.now()
    const recent = await repo.recentOtps(input.email, new Date(now - 3600_000))
    if (recent.length >= OTP_HOURLY_CAP) return null
    const last = recent.find((r) => r.purpose === input.purpose)
    if (last && now - last.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) return null

    const code = randomOtp()
    await repo.transaction(async (q) => {
      // Only one live code per (email, purpose)
      await q.burnLiveOtps(input.email, input.purpose)
      await q.createOtp({
        userId: input.userId ?? null,
        email: input.email,
        purpose: input.purpose,
        codeHash: codeHash(input.email, input.purpose, code),
        expiresAt: new Date(now + OTP_TTL_MS),
        requestIp: input.ip ?? null,
      })
    })
    return code
  }

  return {
    /** Creates a code and e-mails it. Delivery problems are logged, never shown to the caller. */
    async issue(email: string, purpose: OtpPurpose, userId: string | null, ip?: string | null) {
      const code = await create({ email, purpose, userId, ip })
      if (!code) return
      try {
        await mailer.send({
          to: email,
          subject: SUBJECT[purpose],
          text: `Your code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
        })
      } catch (err) {
        // Never log the code itself.
        log.error({ err, purpose }, 'Failed to send OTP email')
      }
    },

    /**
     * Check a code. Single use and race-safe: the attempt counter and the "consumed" flag are set
     * with conditional UPDATEs, so two parallel requests cannot both succeed. After 5 wrong tries
     * the challenge is burned. Always fails with the same error, whatever the reason.
     */
    async verify(input: {
      email: string
      purpose: OtpPurpose
      code: string
    }): Promise<{ userId: string | null }> {
      const fail = () => new BadRequestError('Invalid or expired code', 'OTP_INVALID')

      const live = await repo.liveOtp(input.email, input.purpose)
      if (!live) throw fail()

      // Count this attempt first. Only succeeds while attempts remain.
      if (!(await repo.countOtpAttempt(live.id))) throw fail()

      const ok = safeEqual(live.codeHash, codeHash(input.email, input.purpose, input.code))
      if (!ok) {
        if (live.attempts + 1 >= MAX_ATTEMPTS) await repo.burnOtp(live.id)
        throw fail()
      }

      // Burn it. Exactly one concurrent caller wins.
      if (!(await repo.burnOtp(live.id))) throw fail()
      return { userId: live.userId }
    },
  }
}

export type OtpService = ReturnType<typeof createOtpService>
