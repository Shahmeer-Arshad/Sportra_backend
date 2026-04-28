import { FastifyInstance } from 'fastify'
import '@fastify/swagger'
import { createUserController } from './user.controller'
import { createUserService } from './user.service'
import { createUserRepository } from './user.repository'
import { createUserMediator } from './user.mediator'
import { authenticate } from '../../hooks/auth.hook'
import {
  createUserJsonSchema,
  updateUserJsonSchema,
  signUpJsonSchema,
  loginJsonSchema,
  CreateUserInput,
  UpdateUserInput,
  UserParams,
} from './user.schema'
import { PaginationQuery } from '../../types'

/**
 * User module routes — registered under /api/v1/users
 */
export async function userRoutes(app: FastifyInstance) {
  const repository = createUserRepository(app.prisma)
  const service = createUserService(repository, app.log)
  const mediator = createUserMediator(service)
  const controller = createUserController(mediator)

  // POST /api/v1/users/signup
  app.post<{ Body: CreateUserInput }>(
    '/signup',
    {
      schema: {
        body: signUpJsonSchema.body,
        response: signUpJsonSchema.response,
        tags: ['Authentication'],
        summary: 'User Signup',
      },
    },
    (request, reply) => controller.signUp(request, reply),
  )

  // POST /api/v1/users/login
  app.post<{ Body: any }>(
    '/login',
    {
      schema: {
        body: loginJsonSchema.body,
        response: loginJsonSchema.response,
        tags: ['Authentication'],
        summary: 'User Login',
      },
    },
    (request, reply) => controller.login(request, reply),
  )

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
