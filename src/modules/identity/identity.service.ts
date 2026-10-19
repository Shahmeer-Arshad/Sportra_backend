import { Prisma, User } from '@prisma/client'
import bcrypt from 'bcrypt'
import { env } from '../../config/env'
import { sha256 } from '../../lib/crypto'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../../utils/errors'
import { IdentityDeps } from './identity.deps'
import {
  AuthResult,
  GENERIC_SENT,
  isBlockedStatus,
  LoginResult,
  lockDurationMs,
  normalizeEmail,
  RequestMeta,
  toPublicUser,
} from './identity.domain'

// Compared against when the e-mail is unknown, so response time does not reveal accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', env.BCRYPT_COST)

type EmailCode = { email: string; code: string }

/** Authentication flows, profile reads and admin queries. Multi-step writes live in mediators. */
export function createIdentityService({ repo, otp, session }: IdentityDeps) {
  const invalidLogin = () => new UnauthorizedError('Invalid login', 'INVALID_CREDENTIALS')

  async function isStaffOrAdmin(user: User) {
    return (
      user.platformRole === 'PLATFORM_ADMIN' || (await repo.countActiveMemberships(user.id)) > 0
    )
  }

  return {
    async login(
      input: { email: string; password: string },
      meta: RequestMeta,
    ): Promise<LoginResult> {
      const email = normalizeEmail(input.email)
      const user = await repo.userByEmail(email)
      const bad = () => new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS')

      if (!user || !user.passwordHash) {
        await bcrypt.compare(input.password, DUMMY_HASH)
        throw bad()
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new TooManyRequestsError(
          'Too many failed attempts. Try again later.',
          'ACCOUNT_LOCKED',
        )
      }
      if (!(await bcrypt.compare(input.password, user.passwordHash))) {
        const failed = user.failedLoginCount + 1
        const lockMs = lockDurationMs(failed)
        await repo.updateUser(user.id, {
          failedLoginCount: failed,
          ...(lockMs && { lockedUntil: new Date(Date.now() + lockMs) }),
        })
        throw bad()
      }
      if (isBlockedStatus(user.status)) {
        throw new ForbiddenError('This account is suspended', 'ACCOUNT_SUSPENDED')
      }
      if (user.status === 'PENDING_VERIFICATION') {
        await otp.issue(email, 'SIGNUP_VERIFY', user.id, meta.ip)
        throw new ForbiddenError(
          'Please verify your email. We sent a new code.',
          'EMAIL_NOT_VERIFIED',
        )
      }
      await repo.updateUser(user.id, { failedLoginCount: 0, lockedUntil: null })

      // Staff and admins always confirm with an emailed code as well
      if (await isStaffOrAdmin(user)) {
        await otp.issue(email, 'LOGIN_STEP_UP', user.id, meta.ip)
        return { mfaRequired: true }
      }
      return { mfaRequired: false, ...(await session.start(user, meta)) }
    },

    async loginVerifyStepUp(input: EmailCode, meta: RequestMeta): Promise<AuthResult> {
      const email = normalizeEmail(input.email)
      await otp.verify({ email, purpose: 'LOGIN_STEP_UP', code: input.code })
      const user = await repo.userByEmail(email)
      if (!user || user.status !== 'ACTIVE') throw invalidLogin()
      return session.start(user, meta)
    },

    // passwordless: not available for platform admins
    async otpRequest(input: { email: string }, meta: RequestMeta) {
      const email = normalizeEmail(input.email)
      const user = await repo.userByEmail(email)
      if (user && user.status === 'ACTIVE' && user.platformRole !== 'PLATFORM_ADMIN') {
        await otp.issue(email, 'LOGIN_PASSWORDLESS', user.id, meta.ip)
      }
      return GENERIC_SENT
    },

    async otpVerify(input: EmailCode, meta: RequestMeta): Promise<AuthResult> {
      const email = normalizeEmail(input.email)
      await otp.verify({ email, purpose: 'LOGIN_PASSWORDLESS', code: input.code })
      const user = await repo.userByEmail(email)
      if (!user || user.status !== 'ACTIVE' || user.platformRole === 'PLATFORM_ADMIN') {
        throw invalidLogin()
      }
      return session.start(user, meta)
    },

    async forgotPassword(input: { email: string }, meta: RequestMeta) {
      const email = normalizeEmail(input.email)
      const user = await repo.userByEmail(email)
      if (user && user.emailVerifiedAt && user.status === 'ACTIVE') {
        await otp.issue(email, 'PASSWORD_RESET', user.id, meta.ip)
      }
      return GENERIC_SENT
    },

    // ───────── refresh / logout ─────────
    /** Rotating refresh. Re-using an old token kills the whole family (theft signal). */
    async refresh(token: string | undefined, meta: RequestMeta): Promise<AuthResult> {
      const invalid = () => new UnauthorizedError('Invalid refresh token', 'REFRESH_INVALID')
      if (!token) throw invalid()
      const row = await repo.refreshTokenWithUser(sha256(token))
      if (!row) throw invalid()
      if (row.revokedAt) {
        await repo.revokeFamily(row.familyId)
        throw new UnauthorizedError('Refresh token was already used', 'REFRESH_REUSED')
      }
      if (row.expiresAt < new Date()) throw invalid()
      if (row.user.status !== 'ACTIVE' || row.createdAt < row.user.tokenValidAfter) throw invalid()

      // Only one request can win the rotation
      if (!(await repo.revokeRefreshToken(row.id))) throw invalid()
      const next = await session.start(row.user, meta, row.familyId)
      await repo.markReplaced(row.id, next.refreshToken.split('.')[0])
      return next
    },

    async logout(token: string | undefined) {
      if (!token) return
      const row = await repo.refreshTokenByHash(sha256(token))
      if (row) await repo.revokeFamily(row.familyId)
    },

    // ───────── profile ─────────
    async getMe(userId: string) {
      const u = await repo.userByIdOrThrow(userId)
      return { ...toPublicUser(u), memberships: await repo.activeMemberships(userId) }
    },

    listSessions: (userId: string) => repo.activeSessions(userId),

    async requestEmailChange(
      userId: string,
      input: { newEmail: string; password: string },
      meta: RequestMeta,
    ) {
      const user = await repo.userByIdOrThrow(userId)
      if (!user.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) {
        throw new UnauthorizedError('Invalid password', 'INVALID_CREDENTIALS')
      }
      const newEmail = normalizeEmail(input.newEmail)
      // Same answer whether or not the address is taken
      if (!(await repo.userByEmail(newEmail)))
        await otp.issue(newEmail, 'EMAIL_CHANGE', userId, meta.ip)
      return GENERIC_SENT
    },

    // ───────── staff ─────────
    async listStaff(venueId: string) {
      const rows = await repo.venueStaff(venueId)
      return rows.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        email: m.user.email,
        fullName: m.user.fullName,
        role: m.role,
        isActive: m.isActive,
      }))
    },

    // ───────── admin ─────────
    async adminListUsers(q: { q?: string; status?: string; limit: number; offset: number }) {
      const where: Prisma.UserWhereInput = {
        ...(q.status && { status: q.status }),
        ...(q.q && {
          OR: [
            { email: { contains: q.q.toLowerCase() } },
            { phone: { contains: q.q } },
            { fullName: { contains: q.q, mode: 'insensitive' } },
          ],
        }),
      }
      const [rows, total] = await repo.listUsers(where, q.limit, q.offset)
      return { items: rows.map(toPublicUser), total }
    },

    async adminAuditLogs(q: {
      actorId?: string
      entity?: string
      entityId?: string
      action?: string
      limit: number
      offset: number
    }) {
      const rows = await repo.auditLogs(
        {
          ...(q.actorId && { actorId: q.actorId }),
          ...(q.entity && { entity: q.entity }),
          ...(q.entityId && { entityId: q.entityId }),
          ...(q.action && { action: q.action }),
        },
        q.limit,
        q.offset,
      )
      return rows.map((r) => ({ ...r, id: r.id.toString() }))
    },
  }
}
