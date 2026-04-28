import { FastifyInstance } from 'fastify'
import '@fastify/swagger'
import { UserController } from './user.controller'
import { UserService } from './user.service'
import { UserRepository } from './user.repository'
import { UserMediator } from './user.mediator'
import { authenticate } from '../../hooks/auth.hook'
import {
  createUserJsonSchema,
  updateUserJsonSchema,
  CreateUserInput,
  UpdateUserInput,
  UserParams,
} from './user.schema'
import { PaginationQuery } from '../../types'

/**
 * User module routes — registered under /api/v1/users
 */
export async function userRoutes(app: FastifyInstance) {
  const repository = new UserRepository(app.prisma)
  const service = new UserService(repository, app.log)
  const mediator = new UserMediator(service)
  const controller = new UserController(mediator)

  // GET /api/v1/users
  app.get<{ Querystring: PaginationQuery }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        summary: 'List all users (paginated)',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'string', default: '1' },
            limit: { type: 'string', default: '10' },
          },
        },
      },
    },
    (request, reply) => controller.getAll(request, reply),
  )

  // GET /api/v1/users/:id
  app.get<{ Params: UserParams }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Get a user by ID',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
      },
    },
    (request, reply) => controller.getById(request, reply),
  )

  // POST /api/v1/users
  app.post<{ Body: CreateUserInput }>(
    '/',
    {
      schema: {
        body: createUserJsonSchema.body,
        response: createUserJsonSchema.response,
        tags: ['Users'],
        summary: 'Create a new user',
      },
    },
    (request, reply) => controller.create(request, reply),
  )

  // PATCH /api/v1/users/:id
  app.patch<{ Params: UserParams; Body: UpdateUserInput }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        params: updateUserJsonSchema.params,
        body: updateUserJsonSchema.body,
        tags: ['Users'],
        summary: 'Update a user',
        security: [{ bearerAuth: [] }],
      },
    },
    (request, reply) => controller.update(request, reply),
  )

  // DELETE /api/v1/users/:id
  app.delete<{ Params: UserParams }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Delete a user',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    (request, reply) => controller.remove(request, reply),
  )
}
