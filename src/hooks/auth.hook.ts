import { FastifyRequest, FastifyReply } from 'fastify'
import '@fastify/jwt'

/**
 * Auth guard hook — verifies JWT from Authorization header.
 * Use as a `preHandler` hook on protected routes.
 *
 * @example
 * app.get('/protected', { preHandler: [authenticate] }, handler)
 */
export async function authenticate(
  request: FastifyRequest<any>,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.accessJwtVerify()
  } catch (err) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    })
  }
}
