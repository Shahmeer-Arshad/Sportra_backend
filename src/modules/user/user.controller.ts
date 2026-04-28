import { FastifyReply, FastifyRequest } from 'fastify'
import { UserMediator } from './user.mediator'
import { CreateUserInput, UpdateUserInput, UserParams } from './user.schema'
import { successResponse, paginatedResponse, parsePagination } from '../../utils/response'
import { PaginationQuery } from '../../types'

/**
 * Thin controller — orchestrates request parsing.
 * Delegates actual fulfillment to UserMediator.
 */
export class UserController {
  constructor(private readonly mediator: UserMediator) {}

  async getAll(
    request: FastifyRequest<{ Querystring: PaginationQuery }>,
    reply: FastifyReply,
  ) {
    request.log.info('UserController.getAll: Fetching all users')
    const { page, limit, skip } = parsePagination(request.query)
    
    const { users, total } = await this.mediator.send('GetAllUsers', { skip, limit })
    reply.send(paginatedResponse(users, total, page, limit))
  }

  async getById(
    request: FastifyRequest<{ Params: UserParams }>,
    reply: FastifyReply,
  ) {
    request.log.info({ id: request.params.id }, 'UserController.getById: Fetching user')
    const user = await this.mediator.send('GetUserById', { id: request.params.id })
    reply.send(successResponse(user))
  }

  async create(
    request: FastifyRequest<{ Body: CreateUserInput }>,
    reply: FastifyReply,
  ) {
    request.log.info({ email: request.body.email }, 'UserController.create: Creating user')
    const user = await this.mediator.send('CreateUser', request.body)
    reply.status(201).send(successResponse(user, 'User created successfully'))
  }

  async update(
    request: FastifyRequest<{ Params: UserParams; Body: UpdateUserInput }>,
    reply: FastifyReply,
  ) {
    request.log.info({ id: request.params.id }, 'UserController.update: Updating user')
    const user = await this.mediator.send('UpdateUser', { id: request.params.id, data: request.body })
    reply.send(successResponse(user, 'User updated successfully'))
  }

  async remove(
    request: FastifyRequest<{ Params: UserParams }>,
    reply: FastifyReply,
  ) {
    request.log.warn({ id: request.params.id }, 'UserController.remove: Deleting user')
    await this.mediator.send('DeleteUser', { id: request.params.id })
    reply.status(204).send()
  }
}
