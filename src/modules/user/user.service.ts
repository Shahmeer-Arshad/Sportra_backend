import { FastifyBaseLogger } from 'fastify'
import bcrypt from 'bcrypt'
import { UserRepository } from './user.repository'
import { CreateUserInput, UpdateUserInput, LoginInput } from './user.schema'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../utils/errors'

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
    
    const existingEmail = await this.repository.findByEmail(data.email)
    if (existingEmail) throw new ConflictError(`Email "${data.email}" already in use`)

    const existingUsername = await this.repository.findByUsername(data.username)
    if (existingUsername) throw new ConflictError(`Username "${data.username}" already in use`)

    // Hash the password
    const hashedPassword = await bcrypt.hash(data.password, 10)

    return this.repository.create({
      ...data,
      password: hashedPassword,
    })
  }

  async login(data: LoginInput) {
    this.logger.info({ email: data.email }, 'UserService.login: Authenticating user')
    
    const user = await this.repository.findByEmail(data.email)
    if (!user) {
      throw new UnauthorizedError('Invalid email or password')
    }

    const isValid = await bcrypt.compare(data.password, user.password)
    if (!isValid) {
      throw new UnauthorizedError('Invalid email or password')
    }

    return user
  }

  async update(id: string, data: UpdateUserInput) {
    this.logger.info({ id }, 'UserService.update: Updating user')
    await this.findById(id) // throws 404 if not found

    if (data.email) {
      const conflict = await this.repository.findByEmailExcludeId(data.email, id)
      if (conflict) throw new ConflictError(`Email "${data.email}" already in use`)
    }

    if (data.username) {
      const conflict = await this.repository.findByUsernameExcludeId(data.username, id)
      if (conflict) throw new ConflictError(`Username "${data.username}" already in use`)
    }

    return this.repository.update(id, data)
  }

  async delete(id: string) {
    this.logger.warn({ id }, 'UserService.delete: Deleting user')
    await this.findById(id) // throws 404 if not found
    await this.repository.delete(id)
  }
}
