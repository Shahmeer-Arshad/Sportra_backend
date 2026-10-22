import { FastifyReply, FastifyRequest } from 'fastify'
import { createRbacRepository } from '../modules/rbac/rbac.repository'
import { createRbacService } from '../modules/rbac/rbac.service'
import { ForbiddenError } from '../utils/errors'

/**
 * Role-based guard: the user must hold `code` through one of their roles (see
 * src/modules/rbac/rbac.api-map.ts and rbac.roles.ts). Use after `authenticate`. The venue is taken
 * from the `:venueId` path parameter when the route has one.
 */
export function requirePermission(code: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const { venueId } = (request.params ?? {}) as { venueId?: string }
    const rbac = createRbacService(createRbacRepository(request.server.prisma))
    if (!(await rbac.hasPermission(request.user.sub, code, venueId))) {
      throw new ForbiddenError('You do not have permission to do this', 'PERMISSION_DENIED')
    }
  }
}
