import { Prisma } from '@prisma/client'
import bcrypt from 'bcrypt'
import { env } from '../../../config/env'
import { BadRequestError, ConflictError } from '../../../utils/errors'
import { IdentityDeps } from '../identity.deps'
import { normalizeEmail } from '../identity.domain'
import { sessionsRevokedEvent, userEvent } from '../identity.events'

/** Changes that invalidate existing sessions: password reset, e-mail change, log out everywhere. */
export const credentialsMediator = ({ repo, otp }: IdentityDeps) => ({
  async resetPassword(input: { email: string; code: string; newPassword: string }) {
    const email = normalizeEmail(input.email)
    await otp.verify({ email, purpose: 'PASSWORD_RESET', code: input.code })
    const user = await repo.userByEmail(email)
    if (!user) throw new BadRequestError('Invalid or expired code', 'OTP_INVALID')
    const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_COST)
    await repo.transaction(async (q) => {
      await q.updateUser(user.id, {
        passwordHash,
        tokenValidAfter: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      })
      await q.revokeAllTokens(user.id)
      await q.emit(sessionsRevokedEvent(user.id, 'PASSWORD_RESET'))
    })
    return { message: 'Password updated. Please log in again.' }
  },

  async confirmEmailChange(userId: string, input: { newEmail: string; code: string }) {
    const newEmail = normalizeEmail(input.newEmail)
    const { userId: owner } = await otp.verify({
      email: newEmail,
      purpose: 'EMAIL_CHANGE',
      code: input.code,
    })
    if (owner !== userId) throw new BadRequestError('Invalid or expired code', 'OTP_INVALID')
    try {
      await repo.transaction(async (q) => {
        const u = await q.updateUser(userId, {
          email: newEmail,
          emailVerifiedAt: new Date(),
          tokenValidAfter: new Date(),
        })
        await q.revokeAllTokens(userId)
        await q.emit(userEvent(u))
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictError('This email is already in use', 'EMAIL_IN_USE')
      }
      throw e
    }
    return { message: 'Email updated. Please log in again.' }
  },

  logoutEverywhere: (userId: string) =>
    repo.transaction(async (q) => {
      await q.updateUser(userId, { tokenValidAfter: new Date() })
      await q.revokeAllTokens(userId)
      await q.emit(sessionsRevokedEvent(userId, 'LOGOUT_EVERYWHERE'))
    }),
})
