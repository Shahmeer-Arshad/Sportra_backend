import { FastifyReply, FastifyRequest } from 'fastify'
import { ForbiddenError, UnauthorizedError } from '../utils/errors'

/**
 * Auth guard: verifies the access JWT, then checks the user is still ACTIVE and that the token
 * was issued after `token_valid_after` (so "log out everywhere" and password resets take effect
 * at once).
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify()
  } catch {
    throw new UnauthorizedError('Invalid or expired token', 'TOKEN_INVALID')
  }
  const user = await request.server.prisma.user.findUnique({
    where: { id: request.user.sub },
    select: { status: true, tokenValidAfter: true, platformRole: true },
  })
  const issuedAtMs = (request.user.iat ?? 0) * 1000
  // iat has 1-second precision, so compare at second precision
  if (
    !user ||
    user.status !== 'ACTIVE' ||
    issuedAtMs < Math.floor(user.tokenValidAfter.getTime() / 1000) * 1000
  ) {
    throw new UnauthorizedError('Session is no longer valid', 'TOKEN_REVOKED')
  }
  // Role always comes from the database, never from a possibly stale token
  request.user.role = user.platformRole as 'USER' | 'PLATFORM_ADMIN'
}

/** Platform admin only. Use after `authenticate`. */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.user?.role !== 'PLATFORM_ADMIN') {
    throw new ForbiddenError('Admin access required', 'ADMIN_ONLY')
  }
}

export type VenueRole = 'OWNER' | 'MANAGER' | 'FRONT_DESK' | 'SCORER'

/**
 * Venue staff guard for `/pos/venues/:venueId/*`. The membership is read from the database on
 * every call, so deactivating a staff member works immediately. Use after `authenticate`.
 */
export function requireVenueRole(...roles: VenueRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const { venueId } = request.params as { venueId: string }
    const m = await request.server.prisma.venueMembership.findUnique({
      where: { userId_venueId: { userId: request.user.sub, venueId } },
    })
    if (!m || !m.isActive || !roles.includes(m.role as VenueRole)) {
      throw new ForbiddenError('You do not have access to this venue', 'VENUE_ACCESS_DENIED')
    }
    ;(request as FastifyRequest & { venueRole?: VenueRole }).venueRole = m.role as VenueRole
  }
}
