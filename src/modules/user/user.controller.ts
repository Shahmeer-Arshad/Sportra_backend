import { FastifyReply, FastifyRequest } from 'fastify'
import { UserMediator } from './user.mediator'
import { CreateUserInput, UpdateUserInput, UserParams, LoginInput } from './user.schema'
import { successResponse, paginatedResponse, parsePagination } from '../../utils/response'
import { PaginationQuery } from '../../types'

/**
 * Thin controller — orchestrates request parsing.
 * Delegates actual fulfillment to UserMediator.
 */
export const createUserController = (mediator: UserMediator) => ({
  getAll: async (
    request: FastifyRequest<{ Querystring: PaginationQuery }>,
    reply: FastifyReply,
  ) => {
    request.log.info('UserController.getAll: Fetching all users')
    const { page, limit, skip } = parsePagination(request.query)
    
    const { users, total } = await mediator.send('GetAllUsers', { skip, limit })
    reply.send(paginatedResponse(users, total, page, limit))
  },

  getById: async (
    request: FastifyRequest<{ Params: UserParams }>,
    reply: FastifyReply,
  ) => {
    request.log.info({ id: request.params.id }, 'UserController.getById: Fetching user')
    const user = await mediator.send('GetUserById', { id: request.params.id })
    reply.send(successResponse(user))
  },

  create: async (
    request: FastifyRequest<{ Body: CreateUserInput }>,
    reply: FastifyReply,
  ) => {
    request.log.info({ email: request.body.email }, 'UserController.create: Creating user')
    const user = await mediator.send('CreateUser', request.body)
    reply.status(201).send(successResponse(user, 'User created successfully'))
  },

  update: async (
    request: FastifyRequest<{ Params: UserParams; Body: UpdateUserInput }>,
    reply: FastifyReply,
  ) => {
    request.log.info({ id: request.params.id }, 'UserController.update: Updating user')
    const user = await mediator.send('UpdateUser', { id: request.params.id, data: request.body })
    reply.send(successResponse(user, 'User updated successfully'))
  },

  remove: async (
    request: FastifyRequest<{ Params: UserParams }>,
    reply: FastifyReply,
  ) => {
    request.log.warn({ id: request.params.id }, 'UserController.remove: Deleting user')
    await mediator.send('DeleteUser', { id: request.params.id })
    reply.status(204).send()
  },

  signUp: async (
    request: FastifyRequest<{ Body: CreateUserInput }>,
    reply: FastifyReply,
  ) => {
    request.log.info({ email: request.body.email }, 'UserController.signUp: Registering user')
    const user = await mediator.send('SignUpUser', request.body)
    reply.status(201).send(successResponse(user, 'Registration successful'))
  },

  login: async (
    request: FastifyRequest<{ Body: LoginInput }>,
    reply: FastifyReply,
  ) => {
    request.log.info({ email: request.body.email }, 'UserController.login: Authenticating')
    const user = await mediator.send('LoginUser', request.body)

    const token = await reply.jwtSign({
      sub: user.id,
      email: user.email,
      role: user.role,
    })

    reply.send({
      success: true,
      message: 'Login successful',
      token,
      data: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    })
  },
})

export type UserController = ReturnType<typeof createUserController>
