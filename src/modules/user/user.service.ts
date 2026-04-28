import { FastifyBaseLogger } from 'fastify'
import { UserRepository } from './user.repository'
import { CreateUserInput, UpdateUserInput } from './user.schema'
import { ConflictError, NotFoundError } from '../../utils/errors'

/**
 * Pure business logic layer. 
 * Delegates state changes to UserRepository.
 */
export class UserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly logger: FastifyBaseLogger
  ) {}

  async findAll(skip: number, take: number) {
    this.logger.info({ skip, take }, 'UserService.findAll: Fetching users')
    return this.repository.findAll(skip, take)
  }

  async findById(id: string) {
    this.logger.debug({ id }, 'UserService.findById: Finding user')
    const user = await this.repository.findById(id)
    if (!user) throw new NotFoundError(`User with id "${id}" not found`)
    return user
  }

  async create(data: CreateUserInput) {
    this.logger.info({ email: data.email }, 'UserService.create: Creating user')
    const existing = await this.repository.findByEmail(data.email)
    if (existing) throw new ConflictError(`Email "${data.email}" already in use`)

    return this.repository.create(data)
  }

  async update(id: string, data: UpdateUserInput) {
    this.logger.info({ id }, 'UserService.update: Updating user')
    await this.findById(id) // throws 404 if not found

    if (data.email) {
      const conflict = await this.repository.findByEmailExcludeId(data.email, id)
      if (conflict) throw new ConflictError(`Email "${data.email}" already in use`)
    }

    return this.repository.update(id, data)
  }

  async delete(id: string) {
    this.logger.warn({ id }, 'UserService.delete: Deleting user')
    await this.findById(id) // throws 404 if not found
    await this.repository.delete(id)
  }
}
