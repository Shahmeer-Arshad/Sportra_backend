import bcrypt from 'bcrypt'
import { env } from '../../../config/env'
import { BadRequestError, ConflictError, ForbiddenError } from '../../../utils/errors'
import { recordConsent } from '../identity.consent'
import { IdentityDeps } from '../identity.deps'
import {
  AuthResult,
  GENERIC_SENT,
  isBlockedStatus,
  isDisposableEmail,
  normalizeEmail,
  RequestMeta,
} from '../identity.domain'
import { userEvent } from '../identity.events'

type RegisterInput = {
  email: string
  password: string
  fullName: string
  phone?: string
  signupIntent?: 'PLAYER' | 'OWNER'
  whatsappConsent?: { optIn: boolean; textVersion?: string }
}

/** Sign-up and e-mail verification. */
export const signupMediator = ({ repo, otp, session }: IdentityDeps) => ({
  async register(input: RegisterInput, meta: RequestMeta) {
    const email = normalizeEmail(input.email)
    if (isDisposableEmail(email)) {
      throw new BadRequestError('Please use a permanent email address', 'DISPOSABLE_EMAIL')
    }
    const existing = await repo.userByEmail(email)
    if (existing) {
      // Same answer as a new sign-up. Unverified accounts get a fresh code.
      if (existing.status === 'PENDING_VERIFICATION') {
        await otp.issue(email, 'SIGNUP_VERIFY', existing.id, meta.ip)
      }
      return GENERIC_SENT
    }
    if (input.phone && (await repo.userByPhone(input.phone))) {
      throw new ConflictError('This phone number is already in use', 'PHONE_IN_USE')
    }
    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_COST)
    const user = await repo.transaction(async (q) => {
      const u = await q.createUser({
        email,
        passwordHash,
        fullName: input.fullName.trim(),
        phone: input.phone ?? null,
        signupIntent: input.signupIntent ?? 'PLAYER',
      })
      if (input.whatsappConsent?.optIn) {
        const consent = { action: 'OPT_IN', source: 'SIGNUP_FORM' } as const
        await recordConsent(
          q,
          u,
          { ...consent, textVersion: input.whatsappConsent.textVersion },
          meta,
        )
      }
      await q.emit(userEvent(u))
      return u
    })
    await otp.issue(email, 'SIGNUP_VERIFY', user.id, meta.ip)
    return GENERIC_SENT
  },

  async verifyEmail(
    input: { email: string; code: string },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const email = normalizeEmail(input.email)
    await otp.verify({ email, purpose: 'SIGNUP_VERIFY', code: input.code })
    const user = await repo.userByEmail(email)
    if (!user) throw new BadRequestError('Invalid or expired code', 'OTP_INVALID')
    if (isBlockedStatus(user.status)) {
      throw new ForbiddenError('Account is not active', 'ACCOUNT_SUSPENDED')
    }
    const updated = await repo.transaction(async (q) => {
      const u = await q.updateUser(user.id, {
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        status: 'ACTIVE',
      })
      await q.emit(userEvent(u))
      return u
    })
    return session.start(updated, meta)
  },
})
