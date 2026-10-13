import { FastifyBaseLogger } from 'fastify'
import bcrypt from 'bcrypt'
import { UserRepository } from './user.repository'
import { CreateUserInput, UpdateUserInput, LoginInput } from './user.schema'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../utils/errors'

/**
 * Pure business logic layer. 
 * Delegates state changes to UserRepository.
 */
export const createUserService = (
  repository: UserRepository,
  logger: FastifyBaseLogger
) => {
  const findById = async (id: string) => {
    logger.debug({ id }, 'UserService.findById: Finding user')
    const user = await repository.findById(id)
    if (!user) throw new NotFoundError(`User with id "${id}" not found`)
    return user
  }

  return {
    findAll: async (skip: number, take: number) => {
      logger.info({ skip, take }, 'UserService.findAll: Fetching users')
      return repository.findAll(skip, take)
    },

    findById,

    create: async (data: CreateUserInput) => {
      logger.info({ email: data.email }, 'UserService.create: Creating user')
      
      const existingEmail = await repository.findByEmail(data.email)
      if (existingEmail) throw new ConflictError(`Email "${data.email}" already in use`)

      const existingUsername = await repository.findByUsername(data.username)
      if (existingUsername) throw new ConflictError(`Username "${data.username}" already in use`)

      // Hash the password
      const hashedPassword = await bcrypt.hash(data.password, 10)

      return repository.create({
        ...data,
        password: hashedPassword,
      })
    },

    login: async (data: LoginInput) => {
      logger.info({ email: data.email }, 'UserService.login: Authenticating user')
      
      const user = await repository.findByEmail(data.email)
      if (!user) {
        throw new UnauthorizedError('Invalid email or password')
      }

      const isValid = await bcrypt.compare(data.password, user.password)
      if (!isValid) {
        throw new UnauthorizedError('Invalid email or password')
      }

      return user
    },

    update: async (id: string, data: UpdateUserInput) => {
      logger.info({ id }, 'UserService.update: Updating user')
      await findById(id) // throws 404 if not found

      if (data.email) {
        const conflict = await repository.findByEmailExcludeId(data.email, id)
        if (conflict) throw new ConflictError(`Email "${data.email}" already in use`)
      }

      if (data.username) {
        const conflict = await repository.findByUsernameExcludeId(data.username, id)
        if (conflict) throw new ConflictError(`Username "${data.username}" already in use`)
      }

      return repository.update(id, data)
    },

    delete: async (id: string) => {
      logger.warn({ id }, 'UserService.delete: Deleting user')
      await findById(id) // throws 404 if not found
      await repository.delete(id)
    },

    // Refresh Token Business Logic
    saveRefreshToken: async (userId: string, jti: string, token: string, expiresAt: Date) => {
      logger.debug({ userId, jti }, 'UserService.saveRefreshToken: Saving new refresh token')
      const hashedToken = await bcrypt.hash(token, 10)
      return repository.saveRefreshToken(userId, jti, hashedToken, expiresAt)
    },

    verifyRefreshToken: async (jti: string, token: string) => {
      logger.debug({ jti }, 'UserService.verifyRefreshToken: Verifying refresh token')
      const storedToken = await repository.findRefreshToken(jti)
      
      if (!storedToken) {
        throw new UnauthorizedError('Refresh token not found or revoked')
      }

      const now = new Date()
      if (storedToken.expiresAt < now) {
        await repository.deleteRefreshToken(jti)
        throw new UnauthorizedError('Refresh token expired')
      }

      const isValid = await bcrypt.compare(token, storedToken.hashedToken)
      if (!isValid) {
        throw new UnauthorizedError('Invalid refresh token')
      }

      return storedToken.user
    },

    revokeRefreshToken: async (jti: string) => {
      logger.info({ jti }, 'UserService.revokeRefreshToken: Revoking token')
      try {
        await repository.deleteRefreshToken(jti)
      } catch (err) {
        // Ignore if already deleted
      }
    },
  }
}

export type UserService = ReturnType<typeof createUserService>
