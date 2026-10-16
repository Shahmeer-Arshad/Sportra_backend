import { Prisma, PrismaClient, User } from '@prisma/client'
import bcrypt from 'bcrypt'
import { FastifyBaseLogger } from 'fastify'
import { env } from '../../config/env'
import { audit } from '../../lib/audit'
import { randomToken, sha256 } from '../../lib/crypto'
import { uuidv7 } from '../../lib/id'
import { Mailer } from '../../lib/mailer'
import { addOutbox } from '../../lib/outbox'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../utils/errors'
import { createOtp, OtpPurpose, verifyOtp } from './identity.otp'

const BCRYPT_COST = env.BCRYPT_COST
// Compared against when the e-mail is unknown, so response time does not reveal accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST)
const LOCK_AFTER_FAILURES = 10
const STAFF_ROLES = ['OWNER', 'MANAGER', 'FRONT_DESK', 'SCORER']
const DISPOSABLE_DOMAINS = [
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
]

export const GENERIC_SENT = {
  message: 'If the details are valid, a code has been sent to the email address.',
}

export interface RequestMeta {
  ip?: string | null
  userAgent?: string | null
}

export interface AuthResult {
  accessToken: string
  refreshToken: string
  refreshExpiresAt: Date
  user: PublicUser
}
export type LoginResult = ({ mfaRequired: false } & AuthResult) | { mfaRequired: true }

export interface PublicUser {
  id: string
  email: string
  fullName: string
  phone: string | null
  platformRole: string
  status: string
  emailVerified: boolean
  whatsappOptIn: boolean
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase()

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    phone: u.phone,
    platformRole: u.platformRole,
    status: u.status,
    emailVerified: !!u.emailVerifiedAt,
    whatsappOptIn: u.whatsappOptIn,
  }
}

export function createIdentityService(deps: {
  prisma: PrismaClient
  mailer: Mailer
  log: FastifyBaseLogger
  signAccess: (payload: { sub: string; email: string; role: 'USER' | 'PLATFORM_ADMIN' }) => string
}) {
  const { prisma, mailer, log, signAccess } = deps

  async function sendCode(email: string, purpose: OtpPurpose, code: string) {
    const subject: Record<OtpPurpose, string> = {
      SIGNUP_VERIFY: 'Verify your Sportra email',
      LOGIN_STEP_UP: 'Your Sportra login code',
      LOGIN_PASSWORDLESS: 'Your Sportra login code',
      PASSWORD_RESET: 'Reset your Sportra password',
      EMAIL_CHANGE: 'Confirm your new email',
      STAFF_INVITE: 'Your Sportra invitation code',
    }
    try {
      await mailer.send({
        to: email,
        subject: subject[purpose],
        text: `Your code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
      })
    } catch (err) {
      // Never reveal delivery problems to the caller; log for ops. (Never log the code.)
      log.error({ err, purpose }, 'Failed to send OTP email')
    }
  }

  async function issueAndSend(
    email: string,
    purpose: OtpPurpose,
    userId: string | null,
    ip?: string | null,
  ) {
    const code = await createOtp(prisma, { email, purpose, userId, ip })
    if (code) await sendCode(email, purpose, code)
  }

  async function startSession(
    user: User,
    meta: RequestMeta,
    familyId = uuidv7(),
  ): Promise<AuthResult> {
    const secret = randomToken(32)
    const id = uuidv7()
    const token = `${id}.${secret}`
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400_000)
    await prisma.refreshToken.create({
      data: {
        id,
        userId: user.id,
        familyId,
        tokenHash: sha256(token),
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        ip: meta.ip ?? null,
        expiresAt,
      },
    })
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    const accessToken = signAccess({
      sub: user.id,
      email: user.email,
      role: user.platformRole as 'USER' | 'PLATFORM_ADMIN',
    })
    return {
      accessToken,
      refreshToken: token,
      refreshExpiresAt: expiresAt,
      user: toPublicUser(user),
    }
  }

  async function isStaffOrAdmin(user: User) {
    if (user.platformRole === 'PLATFORM_ADMIN') return true
    const n = await prisma.venueMembership.count({ where: { userId: user.id, isActive: true } })
    return n > 0
  }

  async function recordConsent(
    tx: Prisma.TransactionClient,
    user: { id: string; phone: string | null },
    c: { action: 'OPT_IN' | 'OPT_OUT'; source: string; textVersion?: string | null },
    meta: RequestMeta,
  ) {
    if (!user.phone)
      throw new BadRequestError('A phone number is required for WhatsApp', 'PHONE_REQUIRED')
    const now = new Date()
    if (c.action === 'OPT_IN') {
      if (!c.textVersion)
        throw new BadRequestError('Consent text version is required', 'VALIDATION_ERROR')
      await tx.user.update({
        where: { id: user.id },
        data: {
          whatsappOptIn: true,
          whatsappOptInAt: now,
          whatsappOptInSource: c.source,
          whatsappOptInTextVersion: c.textVersion,
          whatsappOptOutAt: null,
        },
      })
    } else {
      await tx.user.update({
        where: { id: user.id },
        data: { whatsappOptIn: false, whatsappOptOutAt: now },
      })
    }
    await tx.whatsappConsent.create({
      data: {
        id: uuidv7(),
        userId: user.id,
        phoneE164: user.phone,
        action: c.action,
        source: c.source,
        consentTextVersion: c.textVersion ?? null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        occurredAt: now,
      },
    })
    await addOutbox(tx, {
      type: 'WhatsAppConsentChanged',
      routingKey: 'user.whatsapp_consent.changed',
      producer: 'identity',
      data: { userId: user.id, action: c.action, at: now.toISOString() },
    })
  }

  async function userUpserted(tx: Prisma.TransactionClient, u: User) {
    await addOutbox(tx, {
      type: 'user.upserted',
      routingKey: 'user.upserted',
      producer: 'identity',
      data: {
        userId: u.id,
        email: u.email,
        fullName: u.fullName,
        phone: u.phone,
        status: u.status,
      },
    })
  }

  return {
    // ───────────────────────── sign-up ─────────────────────────
    async register(
      input: {
        email: string
        password: string
        fullName: string
        phone?: string
        signupIntent?: 'PLAYER' | 'OWNER'
        whatsappConsent?: { optIn: boolean; textVersion?: string }
      },
      meta: RequestMeta,
    ) {
      const email = normalizeEmail(input.email)
      const domain = email.split('@')[1]
      if (DISPOSABLE_DOMAINS.includes(domain)) {
        throw new BadRequestError('Please use a permanent email address', 'DISPOSABLE_EMAIL')
      }
      const existing = await prisma.user.findUnique({ where: { email } })
      if (existing) {
        // Same answer as a new sign-up. Unverified accounts get a fresh code.
        if (existing.status === 'PENDING_VERIFICATION') {
          await issueAndSend(email, 'SIGNUP_VERIFY', existing.id, meta.ip)
        }
        return GENERIC_SENT
      }
      if (input.phone) {
        const taken = await prisma.user.findUnique({ where: { phone: input.phone } })
        if (taken) throw new ConflictError('This phone number is already in use', 'PHONE_IN_USE')
      }
      const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST)
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            id: uuidv7(),
            email,
            passwordHash,
            fullName: input.fullName.trim(),
            phone: input.phone ?? null,
            signupIntent: input.signupIntent ?? 'PLAYER',
          },
        })
        if (input.whatsappConsent?.optIn) {
          await recordConsent(
            tx,
            u,
            {
              action: 'OPT_IN',
              source: 'SIGNUP_FORM',
              textVersion: input.whatsappConsent.textVersion,
            },
            meta,
          )
        }
        await userUpserted(tx, u)
        return u
      })
      await issueAndSend(email, 'SIGNUP_VERIFY', user.id, meta.ip)
      return GENERIC_SENT
    },

    async verifyEmail(
      input: { email: string; code: string },
      meta: RequestMeta,
    ): Promise<AuthResult> {
      const email = normalizeEmail(input.email)
      await verifyOtp(prisma, { email, purpose: 'SIGNUP_VERIFY', code: input.code })
      const user = await prisma.user.findUnique({ where: { email } })
      if (!user) throw new BadRequestError('Invalid or expired code', 'OTP_INVALID')
      if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
        throw new ForbiddenError('Account is not active', 'ACCOUNT_SUSPENDED')
      }
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: user.id },
          data: { emailVerifiedAt: user.emailVerifiedAt ?? new Date(), status: 'ACTIVE' },
        })
        await userUpserted(tx, u)
        return u
      })
      return startSession(updated, meta)
    },

    // ───────────────────────── login ─────────────────────────
    async login(
      input: { email: string; password: string },
      meta: RequestMeta,
    ): Promise<LoginResult> {
      const email = normalizeEmail(input.email)
      const user = await prisma.user.findUnique({ where: { email } })
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
      const ok = await bcrypt.compare(input.password, user.passwordHash)
      if (!ok) {
        const failed = user.failedLoginCount + 1
        // Every 10 failures: lock for 15 min, doubling each time, max 24 h
        const lockMs =
          failed % LOCK_AFTER_FAILURES === 0
            ? Math.min(15 * 60_000 * 2 ** (failed / LOCK_AFTER_FAILURES - 1), 24 * 3600_000)
            : 0
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: failed,
            ...(lockMs && { lockedUntil: new Date(Date.now() + lockMs) }),
          },
        })
        throw bad()
      }
      if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
        throw new ForbiddenError('This account is suspended', 'ACCOUNT_SUSPENDED')
      }
      if (user.status === 'PENDING_VERIFICATION') {
        await issueAndSend(email, 'SIGNUP_VERIFY', user.id, meta.ip)
        throw new ForbiddenError(
          'Please verify your email. We sent a new code.',
          'EMAIL_NOT_VERIFIED',
        )
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      })

      // Staff and admins always confirm with an emailed code as well
      if (await isStaffOrAdmin(user)) {
        await issueAndSend(email, 'LOGIN_STEP_UP', user.id, meta.ip)
        return { mfaRequired: true }
      }
      return { mfaRequired: false, ...(await startSession(user, meta)) }
    },

    async loginVerifyStepUp(
      input: { email: string; code: string },
      meta: RequestMeta,
    ): Promise<AuthResult> {
      const email = normalizeEmail(input.email)
      await verifyOtp(prisma, { email, purpose: 'LOGIN_STEP_UP', code: input.code })
      const user = await prisma.user.findUnique({ where: { email } })
      if (!user || user.status !== 'ACTIVE')
        throw new UnauthorizedError('Invalid login', 'INVALID_CREDENTIALS')
      return startSession(user, meta)
    },

    // passwordless: not available for platform admins
    async otpRequest(input: { email: string }, meta: RequestMeta) {
      const email = normalizeEmail(input.email)
      const user = await prisma.user.findUnique({ where: { email } })
      if (user && user.status === 'ACTIVE' && user.platformRole !== 'PLATFORM_ADMIN') {
        await issueAndSend(email, 'LOGIN_PASSWORDLESS', user.id, meta.ip)
      }
      return GENERIC_SENT
    },

    async otpVerify(
      input: { email: string; code: string },
      meta: RequestMeta,
    ): Promise<AuthResult> {
      const email = normalizeEmail(input.email)
      await verifyOtp(prisma, { email, purpose: 'LOGIN_PASSWORDLESS', code: input.code })
      const user = await prisma.user.findUnique({ where: { email } })
      if (!user || user.status !== 'ACTIVE' || user.platformRole === 'PLATFORM_ADMIN') {
        throw new UnauthorizedError('Invalid login', 'INVALID_CREDENTIALS')
      }
      return startSession(user, meta)
    },

    // ───────────────────────── password reset ─────────────────────────
    async forgotPassword(input: { email: string }, meta: RequestMeta) {
      const email = normalizeEmail(input.email)
      const user = await prisma.user.findUnique({ where: { email } })
      if (user && user.emailVerifiedAt && user.status === 'ACTIVE') {
        await issueAndSend(email, 'PASSWORD_RESET', user.id, meta.ip)
      }
      return GENERIC_SENT
    },

    async resetPassword(input: { email: string; code: string; newPassword: string }) {
      const email = normalizeEmail(input.email)
      await verifyOtp(prisma, { email, purpose: 'PASSWORD_RESET', code: input.code })
      const user = await prisma.user.findUnique({ where: { email } })
      if (!user) throw new BadRequestError('Invalid or expired code', 'OTP_INVALID')
      const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_COST)
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            tokenValidAfter: new Date(),
            failedLoginCount: 0,
            lockedUntil: null,
          },
        })
        await tx.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        await addOutbox(tx, {
          type: 'user.sessions_revoked',
          routingKey: 'user.sessions_revoked',
          producer: 'identity',
          data: { userId: user.id, reason: 'PASSWORD_RESET' },
        })
      })
      return { message: 'Password updated. Please log in again.' }
    },

    // ───────────────────────── refresh / logout ─────────────────────────
    /** Rotating refresh. Re-using an old token kills the whole family (theft signal). */
    async refresh(token: string | undefined, meta: RequestMeta): Promise<AuthResult> {
      const invalid = () => new UnauthorizedError('Invalid refresh token', 'REFRESH_INVALID')
      if (!token) throw invalid()
      const row = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(token) },
        include: { user: true },
      })
      if (!row) throw invalid()
      if (row.revokedAt) {
        await prisma.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        throw new UnauthorizedError('Refresh token was already used', 'REFRESH_REUSED')
      }
      if (row.expiresAt < new Date()) throw invalid()
      if (row.user.status !== 'ACTIVE' || row.createdAt < row.user.tokenValidAfter) throw invalid()

      // Only one request can win the rotation
      const won = await prisma.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (won.count !== 1) throw invalid()
      const next = await startSession(row.user, meta, row.familyId)
      const nextId = next.refreshToken.split('.')[0]
      await prisma.refreshToken.update({ where: { id: row.id }, data: { replacedBy: nextId } })
      return next
    },

    async logout(token: string | undefined) {
      if (!token) return
      const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } })
      if (row) {
        await prisma.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      }
    },

    async logoutEverywhere(userId: string) {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { tokenValidAfter: new Date() } })
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        await addOutbox(tx, {
          type: 'user.sessions_revoked',
          routingKey: 'user.sessions_revoked',
          producer: 'identity',
          data: { userId, reason: 'LOGOUT_EVERYWHERE' },
        })
      })
    },

    // ───────────────────────── profile ─────────────────────────
    async getMe(userId: string) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
      const memberships = await prisma.venueMembership.findMany({
        where: { userId, isActive: true },
        select: { venueId: true, role: true },
      })
      return { ...toPublicUser(u), memberships }
    },

    async updateMe(
      userId: string,
      input: { fullName?: string; phone?: string | null },
      meta: RequestMeta,
    ) {
      const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
      if (input.phone && input.phone !== current.phone) {
        const taken = await prisma.user.findUnique({ where: { phone: input.phone } })
        if (taken) throw new ConflictError('This phone number is already in use', 'PHONE_IN_USE')
      }
      const phoneChanged = input.phone !== undefined && input.phone !== current.phone
      const updated = await prisma.$transaction(async (tx) => {
        // Consent belongs to a phone number: changing it withdraws WhatsApp consent
        if (phoneChanged && current.whatsappOptIn) {
          await recordConsent(tx, current, { action: 'OPT_OUT', source: 'PROFILE_SETTINGS' }, meta)
        }
        const u = await tx.user.update({
          where: { id: userId },
          data: {
            ...(input.fullName !== undefined && { fullName: input.fullName.trim() }),
            ...(phoneChanged && { phone: input.phone, phoneVerifiedAt: null }),
          },
        })
        await userUpserted(tx, u)
        return u
      })
      return toPublicUser(updated)
    },

    async setWhatsappConsent(
      userId: string,
      input: { action: 'OPT_IN' | 'OPT_OUT'; textVersion?: string; source?: string },
      meta: RequestMeta,
    ) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
      await prisma.$transaction((tx) =>
        recordConsent(
          tx,
          user,
          {
            action: input.action,
            source: input.source ?? 'PROFILE_SETTINGS',
            textVersion: input.textVersion,
          },
          meta,
        ),
      )
      const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
      return {
        whatsappOptIn: u.whatsappOptIn,
        optInAt: u.whatsappOptInAt,
        optOutAt: u.whatsappOptOutAt,
      }
    },

    async requestEmailChange(
      userId: string,
      input: { newEmail: string; password: string },
      meta: RequestMeta,
    ) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
      if (!user.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) {
        throw new UnauthorizedError('Invalid password', 'INVALID_CREDENTIALS')
      }
      const newEmail = normalizeEmail(input.newEmail)
      // Same answer whether or not the address is taken
      const taken = await prisma.user.findUnique({ where: { email: newEmail } })
      if (!taken) await issueAndSend(newEmail, 'EMAIL_CHANGE', userId, meta.ip)
      return GENERIC_SENT
    },

    async confirmEmailChange(userId: string, input: { newEmail: string; code: string }) {
      const newEmail = normalizeEmail(input.newEmail)
      const { userId: owner } = await verifyOtp(prisma, {
        email: newEmail,
        purpose: 'EMAIL_CHANGE',
        code: input.code,
      })
      if (owner !== userId) throw new BadRequestError('Invalid or expired code', 'OTP_INVALID')
      try {
        await prisma.$transaction(async (tx) => {
          const u = await tx.user.update({
            where: { id: userId },
            data: { email: newEmail, emailVerifiedAt: new Date(), tokenValidAfter: new Date() },
          })
          await tx.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          })
          await userUpserted(tx, u)
        })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictError('This email is already in use', 'EMAIL_IN_USE')
        }
        throw e
      }
      return { message: 'Email updated. Please log in again.' }
    },

    async listSessions(userId: string) {
      const rows = await prisma.refreshToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
      })
      return rows
    },

    // ───────────────────────── staff invitations ─────────────────────────
    async inviteStaff(
      venueId: string,
      invitedBy: string,
      input: { email: string; role: 'MANAGER' | 'FRONT_DESK' | 'SCORER' },
    ) {
      const email = normalizeEmail(input.email)
      const token = randomToken(32)
      await prisma.$transaction(async (tx) => {
        // Re-sending revokes the previous open invitation
        await tx.staffInvitation.updateMany({
          where: { venueId, email, acceptedAt: null, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        await tx.staffInvitation.create({
          data: {
            id: uuidv7(),
            venueId,
            email,
            role: input.role,
            tokenHash: sha256(token),
            invitedBy,
            expiresAt: new Date(Date.now() + 7 * 86400_000),
          },
        })
      })
      try {
        await mailer.send({
          to: email,
          subject: 'You were invited to a Sportra venue',
          text: `You have been invited as ${input.role}. Your invitation token is: ${token}\nIt expires in 7 days.`,
        })
      } catch (err) {
        log.error({ err }, 'Failed to send invitation email')
      }
      return { message: 'Invitation sent' }
    },

    async acceptInvitation(
      input: { token: string; fullName?: string; password?: string },
      authedUserId: string | null,
    ): Promise<{ user: PublicUser }> {
      const bad = () => new BadRequestError('Invalid or expired invitation', 'INVITATION_INVALID')
      const inv = await prisma.staffInvitation.findUnique({
        where: { tokenHash: sha256(input.token) },
      })
      if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw bad()

      let user = await prisma.user.findUnique({ where: { email: inv.email } })
      let newAccount = false
      if (user) {
        if (authedUserId !== user.id) {
          throw new UnauthorizedError('Log in with the invited email first', 'LOGIN_REQUIRED')
        }
      } else {
        if (!input.password || !input.fullName) {
          throw new BadRequestError('Full name and password are required', 'VALIDATION_ERROR')
        }
        newAccount = true
      }
      const passwordHash = newAccount ? await bcrypt.hash(input.password!, BCRYPT_COST) : null

      const result = await prisma.$transaction(async (tx) => {
        // Single use: only one concurrent accept can flip this
        const claimed = await tx.staffInvitation.updateMany({
          where: { id: inv.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        })
        if (claimed.count !== 1) throw bad()
        if (newAccount) {
          // Holding the token proves the invitee controls the email address
          user = await tx.user.create({
            data: {
              id: uuidv7(),
              email: inv.email,
              passwordHash,
              fullName: input.fullName!.trim(),
              emailVerifiedAt: new Date(),
              status: 'ACTIVE',
              signupIntent: 'STAFF',
            },
          })
          await userUpserted(tx, user)
        }
        await tx.venueMembership.upsert({
          where: { userId_venueId: { userId: user!.id, venueId: inv.venueId } },
          create: {
            id: uuidv7(),
            userId: user!.id,
            venueId: inv.venueId,
            role: inv.role,
            invitedBy: inv.invitedBy,
          },
          update: { role: inv.role, isActive: true },
        })
        await addOutbox(tx, {
          type: 'membership.changed',
          routingKey: 'membership.changed',
          producer: 'identity',
          data: { userId: user!.id, venueId: inv.venueId, role: inv.role, active: true },
        })
        return user!
      })
      return { user: toPublicUser(result) }
    },

    async listStaff(venueId: string) {
      const rows = await prisma.venueMembership.findMany({
        where: { venueId },
        include: { user: { select: { email: true, fullName: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return rows.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        email: m.user.email,
        fullName: m.user.fullName,
        role: m.role,
        isActive: m.isActive,
      }))
    },

    async deactivateStaff(venueId: string, membershipId: string, actorId: string) {
      const m = await prisma.venueMembership.findFirst({ where: { id: membershipId, venueId } })
      if (!m) throw new NotFoundError('Staff member not found', 'MEMBERSHIP_NOT_FOUND')
      if (m.role === 'OWNER')
        throw new ForbiddenError('The owner cannot be removed', 'CANNOT_REMOVE_OWNER')
      await prisma.$transaction(async (tx) => {
        await tx.venueMembership.update({ where: { id: m.id }, data: { isActive: false } })
        await addOutbox(tx, {
          type: 'membership.changed',
          routingKey: 'membership.changed',
          producer: 'identity',
          data: { userId: m.userId, venueId, role: m.role, active: false },
        })
        await audit(tx, {
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'STAFF_DEACTIVATED',
          entity: 'membership',
          entityId: m.id,
        })
      })
    },

    // ───────────────────────── admin ─────────────────────────
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
      const [rows, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: q.limit,
          skip: q.offset,
        }),
        prisma.user.count({ where }),
      ])
      return { items: rows.map(toPublicUser), total }
    },

    async adminSetUserStatus(
      adminId: string,
      userId: string,
      action: 'suspend' | 'unsuspend',
      reason: string | undefined,
      ip?: string | null,
    ) {
      const u = await prisma.user.findUnique({ where: { id: userId } })
      if (!u) throw new NotFoundError('User not found', 'USER_NOT_FOUND')
      if (u.id === adminId)
        throw new ForbiddenError('You cannot change your own status', 'SELF_ACTION')
      const next =
        action === 'suspend' ? 'SUSPENDED' : u.emailVerifiedAt ? 'ACTIVE' : 'PENDING_VERIFICATION'
      await prisma.$transaction(async (tx) => {
        const upd = await tx.user.update({
          where: { id: userId },
          data: { status: next, ...(action === 'suspend' && { tokenValidAfter: new Date() }) },
        })
        if (action === 'suspend') {
          await tx.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          })
        }
        await userUpserted(tx, upd)
        await audit(tx, {
          actorId: adminId,
          actorType: 'ADMIN',
          action: action === 'suspend' ? 'USER_SUSPENDED' : 'USER_UNSUSPENDED',
          entity: 'user',
          entityId: userId,
          before: { status: u.status },
          after: { status: next, reason },
          ip,
        })
      })
    },

    async adminForceLogout(adminId: string, userId: string, ip?: string | null) {
      const u = await prisma.user.findUnique({ where: { id: userId } })
      if (!u) throw new NotFoundError('User not found', 'USER_NOT_FOUND')
      await this.logoutEverywhere(userId)
      await audit(prisma, {
        actorId: adminId,
        actorType: 'ADMIN',
        action: 'USER_FORCE_LOGOUT',
        entity: 'user',
        entityId: userId,
        ip,
      })
    },

    async adminAuditLogs(q: {
      actorId?: string
      entity?: string
      entityId?: string
      action?: string
      limit: number
      offset: number
    }) {
      const rows = await prisma.auditLog.findMany({
        where: {
          ...(q.actorId && { actorId: q.actorId }),
          ...(q.entity && { entity: q.entity }),
          ...(q.entityId && { entityId: q.entityId }),
          ...(q.action && { action: q.action }),
        },
        orderBy: { id: 'desc' },
        take: q.limit,
        skip: q.offset,
      })
      return rows.map((r) => ({ ...r, id: r.id.toString() }))
    },

    STAFF_ROLES,
  }
}

export type IdentityService = ReturnType<typeof createIdentityService>
