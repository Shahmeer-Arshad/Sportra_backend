import { Prisma, PrismaClient } from '@prisma/client'
import { uuidv7 } from '../../lib/id'
import { Db } from '../../lib/outbox'
import { eventWrites, makeRepository } from '../../lib/repository'
import { roleQueries } from '../rbac/rbac.queries'

/** Every identity-module query. Bound to a transaction client inside `transaction(fn)`. */
function queries(db: Db) {
  return {
    ...eventWrites(db),
    ...roleQueries(db),

    // ───────── users ─────────
    userByEmail: (email: string) => db.user.findUnique({ where: { email } }),
    userByPhone: (phone: string) => db.user.findUnique({ where: { phone } }),
    userById: (id: string) => db.user.findUnique({ where: { id } }),
    userByIdOrThrow: (id: string) => db.user.findUniqueOrThrow({ where: { id } }),
    createUser: (data: Omit<Prisma.UserUncheckedCreateInput, 'id'>) =>
      db.user.create({ data: { id: uuidv7(), ...data } }),
    updateUser: (id: string, data: Prisma.UserUncheckedUpdateInput) =>
      db.user.update({ where: { id }, data }),
    listUsers: (where: Prisma.UserWhereInput, limit: number, offset: number) =>
      Promise.all([
        db.user.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        db.user.count({ where }),
      ]),

    // ───────── refresh tokens ─────────
    createRefreshToken: (data: Prisma.RefreshTokenUncheckedCreateInput) =>
      db.refreshToken.create({ data }),
    refreshTokenByHash: (tokenHash: string) => db.refreshToken.findUnique({ where: { tokenHash } }),
    refreshTokenWithUser: (tokenHash: string) =>
      db.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } }),
    /** Only one caller can win a rotation: true when this call revoked the token. */
    revokeRefreshToken: async (id: string) =>
      (
        await db.refreshToken.updateMany({
          where: { id, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      ).count === 1,
    markReplaced: (id: string, replacedBy: string) =>
      db.refreshToken.update({ where: { id }, data: { replacedBy } }),
    revokeFamily: (familyId: string) =>
      db.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    revokeAllTokens: (userId: string) =>
      db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    activeSessions: (userId: string) =>
      db.refreshToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true },
      }),

    // ───────── otp challenges ─────────
    recentOtps: (email: string, since: Date) =>
      db.otpChallenge.findMany({
        where: { email, createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, purpose: true },
      }),
    burnLiveOtps: (email: string, purpose: string) =>
      db.otpChallenge.updateMany({
        where: { email, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    createOtp: (data: Omit<Prisma.OtpChallengeUncheckedCreateInput, 'id'>) =>
      db.otpChallenge.create({ data: { id: uuidv7(), ...data } }),
    liveOtp: (email: string, purpose: string) =>
      db.otpChallenge.findFirst({
        where: { email, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    /** Counts one attempt; true only while the challenge is open and has attempts left. */
    countOtpAttempt: async (id: string) =>
      (await db.$executeRaw`
        UPDATE otp_challenges SET attempts = attempts + 1
        WHERE id = ${id}::uuid AND consumed_at IS NULL AND attempts < max_attempts`) === 1,
    /** Burns the challenge; true when this call was the one that consumed it. */
    burnOtp: async (id: string) =>
      (
        await db.otpChallenge.updateMany({
          where: { id, consumedAt: null },
          data: { consumedAt: new Date() },
        })
      ).count === 1,

    // ───────── memberships and invitations ─────────
    activeMemberships: (userId: string) =>
      db.venueMembership.findMany({
        where: { userId, isActive: true },
        select: { venueId: true, role: true },
      }),
    countActiveMemberships: (userId: string) =>
      db.venueMembership.count({ where: { userId, isActive: true } }),
    venueStaff: (venueId: string) =>
      db.venueMembership.findMany({
        where: { venueId },
        include: { user: { select: { email: true, fullName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    membershipOfVenue: (venueId: string, id: string) =>
      db.venueMembership.findFirst({ where: { id, venueId } }),
    upsertMembership: (userId: string, venueId: string, role: string, invitedBy: string | null) =>
      db.venueMembership.upsert({
        where: { userId_venueId: { userId, venueId } },
        create: { id: uuidv7(), userId, venueId, role, invitedBy },
        update: { role, isActive: true },
      }),
    deactivateMembership: (id: string) =>
      db.venueMembership.update({ where: { id }, data: { isActive: false } }),
    revokeOpenInvitations: (venueId: string, email: string) =>
      db.staffInvitation.updateMany({
        where: { venueId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    createInvitation: (data: Omit<Prisma.StaffInvitationUncheckedCreateInput, 'id'>) =>
      db.staffInvitation.create({ data: { id: uuidv7(), ...data } }),
    invitationByHash: (tokenHash: string) =>
      db.staffInvitation.findUnique({ where: { tokenHash } }),
    /** Single use: true for exactly one concurrent caller. */
    claimInvitation: async (id: string) =>
      (
        await db.staffInvitation.updateMany({
          where: { id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        })
      ).count === 1,

    // ───────── consent and audit ─────────
    createConsent: (data: Omit<Prisma.WhatsappConsentUncheckedCreateInput, 'id'>) =>
      db.whatsappConsent.create({ data: { id: uuidv7(), ...data } }),
    auditLogs: (where: Prisma.AuditLogWhereInput, limit: number, offset: number) =>
      db.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: limit, skip: offset }),
  }
}

export const createIdentityRepository = (prisma: PrismaClient) => makeRepository(prisma, queries)
export type IdentityQueries = ReturnType<typeof queries>
export type IdentityRepository = ReturnType<typeof createIdentityRepository>
