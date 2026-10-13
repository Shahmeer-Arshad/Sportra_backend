import { randomUUID } from 'crypto'
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

    // Generate cryptographically random JTI for refresh token
    const jti = randomUUID()

    // Generate Access Token
    const accessToken = await reply.accessJwtSign({
      sub: user.id,
      email: user.email,
      role: user.role,
    })

    // Generate Refresh Token
    const refreshToken = await reply.refreshJwtSign({
      sub: user.id,
      jti,
    })

    // Save Refresh Token to DB (hashed)
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7) // 7 days matches env REFRESH_TOKEN_EXPIRES_IN

    await mediator.send('SaveRefreshToken', {
      userId: user.id,
      jti,
      token: refreshToken,
      expiresAt,
    })

    // Set Refresh Token in HttpOnly Cookie
    reply.setCookie('refreshToken', refreshToken, {
      path: '/',
      httpOnly: true,
      secure: true, // Only send over HTTPS
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 7, // 7 days in seconds
    })

    reply.send({
      success: true,
      message: 'Login successful',
      accessToken,
      data: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    })
  },

  refresh: async (request: FastifyRequest, reply: FastifyReply) => {
    request.log.info('UserController.refresh: Refreshing access token')

    // 1. Extract refresh token from cookie
    const refreshToken = request.cookies.refreshToken
    if (!refreshToken) {
      return reply.status(401).send({
        success: false,
        message: 'Refresh token missing',
      })
    }

    try {
      // 2. Verify and decode the refresh token
      const decoded = await request.refreshJwtVerify<{ sub: string; jti: string }>()

      // 3. Verify existence and validity in DB (also validates hash)
      const user = await mediator.send('VerifyRefreshToken', {
        jti: decoded.jti,
        token: refreshToken,
      })

      // 4. Rotate: revoke old refresh token
      await mediator.send('RevokeRefreshToken', { jti: decoded.jti })

      // 5. Issue new refresh token (rotation)
      const newJti = randomUUID()
      const newRefreshToken = await reply.refreshJwtSign({ sub: user.id, jti: newJti })
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 7)
      await mediator.send('SaveRefreshToken', {
        userId: user.id,
        jti: newJti,
        token: newRefreshToken,
        expiresAt,
      })

      // 6. Set new refresh token cookie
      reply.setCookie('refreshToken', newRefreshToken, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 60 * 60 * 24 * 7,
      })

      // 7. Issue new access token
      const accessToken = await reply.accessJwtSign({
        sub: user.id,
        email: user.email,
        role: user.role,
      })

      reply.send({
        success: true,
        accessToken,
      })
    } catch (err) {
      request.log.error(err, 'UserController.refresh: Failed')
      reply.status(401).send({
        success: false,
        message: 'Invalid or expired refresh token',
      })
    }
  },

  logout: async (request: FastifyRequest, reply: FastifyReply) => {
    request.log.info('UserController.logout: Logging out')
    const refreshToken = request.cookies.refreshToken

    if (refreshToken) {
      try {
        const decoded = await request.refreshJwtVerify<{ jti: string }>()
        await mediator.send('RevokeRefreshToken', { jti: decoded.jti })
      } catch (err) {
        // Ignore token decode errors on logout
      }
    }

    reply.clearCookie('refreshToken', { path: '/' })
    reply.send({
      success: true,
      message: 'Logged out successfully',
    })
  },
})

export type UserController = ReturnType<typeof createUserController>
