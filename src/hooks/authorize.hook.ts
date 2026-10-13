import { FastifyRequest, FastifyReply } from 'fastify'
import { Role } from '@prisma/client'
import { ForbiddenError } from '../utils/errors'
import { JwtPayload } from '../types'

/**
 * Role-based authorization guard.
 * Must be used AFTER the `authenticate` hook so `request.user` is populated.
 *
 * @example
 * app.delete('/:id', { preHandler: [authenticate, authorize('ADMIN')] }, handler)
 */
export function authorize(...roles: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const payload = request.user as JwtPayload
    if (!payload || !roles.includes(payload.role)) {
      throw new ForbiddenError('You do not have permission to perform this action')
    }
  }
}
