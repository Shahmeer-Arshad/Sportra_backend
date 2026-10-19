import { User } from '@prisma/client'
import { env } from '../../config/env'
import { randomToken, sha256 } from '../../lib/crypto'
import { uuidv7 } from '../../lib/id'
import { AuthResult, RequestMeta, toPublicUser } from './identity.domain'
import { IdentityRepository } from './identity.repository'

export type SignAccess = (payload: {
  sub: string
  email: string
  role: 'USER' | 'PLATFORM_ADMIN'
}) => string

/** Issues a refresh token (opaque `<id>.<secret>`, stored hashed) and an access JWT. */
export function createSessionService(repo: IdentityRepository, signAccess: SignAccess) {
  return {
    async start(user: User, meta: RequestMeta, familyId = uuidv7()): Promise<AuthResult> {
      const id = uuidv7()
      const token = `${id}.${randomToken(32)}`
      const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400_000)
      await repo.createRefreshToken({
        id,
        userId: user.id,
        familyId,
        tokenHash: sha256(token),
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        ip: meta.ip ?? null,
        expiresAt,
      })
      await repo.updateUser(user.id, { lastLoginAt: new Date() })
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
    },
  }
}

export type SessionService = ReturnType<typeof createSessionService>
