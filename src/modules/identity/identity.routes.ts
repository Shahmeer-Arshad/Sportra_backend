import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../../config/env'
import { authenticate, requireAdmin, requireVenueRole } from '../../hooks/auth.hook'
import { successResponse } from '../../utils/response'
import { AuthResult, createIdentityService, RequestMeta } from './identity.service'
import * as S from './identity.schema'

const COOKIE = 'refreshToken'
const COOKIE_PATH = '/api/v1/public/auth'
// Auth endpoints get a tighter per-IP limit than the global one
const authLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } }

const meta = (req: FastifyRequest): RequestMeta => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'] ?? null,
})

function setRefreshCookie(reply: FastifyReply, r: AuthResult) {
  reply.setCookie(COOKIE, r.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: COOKIE_PATH,
    expires: r.refreshExpiresAt,
  })
}

function sessionBody(r: AuthResult, message: string) {
  return { ...successResponse({ user: r.user }, message), accessToken: r.accessToken }
}

export async function identityRoutes(app: FastifyInstance) {
  const service = createIdentityService({
    prisma: app.prisma,
    mailer: app.mailer,
    log: app.log,
    signAccess: (payload) => app.jwt.sign(payload),
  })
  const tags = (t: string) => ({ tags: [t] })

  // ───────────── Public auth: /api/v1/public/auth/* ─────────────
  await app.register(
    async (pub) => {
      pub.post(
        '/register',
        { config: authLimit, schema: { ...tags('Auth'), body: S.registerBody } },
        async (req, reply) => {
          const r = await service.register(req.body as any, meta(req))
          return reply.status(202).send(successResponse(null, r.message))
        },
      )

      pub.post(
        '/verify-email',
        { config: authLimit, schema: { ...tags('Auth'), body: S.emailCodeBody } },
        async (req, reply) => {
          const r = await service.verifyEmail(req.body as any, meta(req))
          setRefreshCookie(reply, r)
          return reply.send(sessionBody(r, 'Email verified'))
        },
      )

      pub.post(
        '/login',
        { config: authLimit, schema: { ...tags('Auth'), body: S.loginBody } },
        async (req, reply) => {
          const r = await service.login(req.body as any, meta(req))
          if (r.mfaRequired) {
            return reply.send({
              success: true,
              message: 'A login code was sent to your email',
              mfaRequired: true,
            })
          }
          setRefreshCookie(reply, r)
          return reply.send({ ...sessionBody(r, 'Logged in'), mfaRequired: false })
        },
      )

      pub.post(
        '/login/verify-otp',
        { config: authLimit, schema: { ...tags('Auth'), body: S.emailCodeBody } },
        async (req, reply) => {
          const r = await service.loginVerifyStepUp(req.body as any, meta(req))
          setRefreshCookie(reply, r)
          return reply.send(sessionBody(r, 'Logged in'))
        },
      )

      pub.post(
        '/otp/request',
        { config: authLimit, schema: { ...tags('Auth'), body: S.emailBody } },
        async (req, reply) => {
          const r = await service.otpRequest(req.body as any, meta(req))
          return reply.status(202).send(successResponse(null, r.message))
        },
      )

      pub.post(
        '/otp/verify',
        { config: authLimit, schema: { ...tags('Auth'), body: S.emailCodeBody } },
        async (req, reply) => {
          const r = await service.otpVerify(req.body as any, meta(req))
          setRefreshCookie(reply, r)
          return reply.send(sessionBody(r, 'Logged in'))
        },
      )

      pub.post(
        '/password/forgot',
        { config: authLimit, schema: { ...tags('Auth'), body: S.emailBody } },
        async (req, reply) => {
          const r = await service.forgotPassword(req.body as any, meta(req))
          return reply.status(202).send(successResponse(null, r.message))
        },
      )

      pub.post(
        '/password/reset',
        { config: authLimit, schema: { ...tags('Auth'), body: S.resetBody } },
        async (req, reply) => {
          const r = await service.resetPassword(req.body as any)
          reply.clearCookie(COOKIE, { path: COOKIE_PATH })
          return reply.send(successResponse(null, r.message))
        },
      )

      pub.post('/refresh', { config: authLimit, schema: tags('Auth') }, async (req, reply) => {
        try {
          const r = await service.refresh(req.cookies[COOKIE], meta(req))
          setRefreshCookie(reply, r)
          return reply.send(sessionBody(r, 'Token refreshed'))
        } catch (e) {
          reply.clearCookie(COOKIE, { path: COOKIE_PATH })
          throw e
        }
      })

      pub.post('/logout', { schema: tags('Auth') }, async (req, reply) => {
        await service.logout(req.cookies[COOKIE])
        reply.clearCookie(COOKIE, { path: COOKIE_PATH })
        return reply.send(successResponse(null, 'Logged out'))
      })

      pub.post(
        '/staff-invitations/accept',
        { config: authLimit, schema: { ...tags('Auth'), body: S.acceptInviteBody } },
        async (req, reply) => {
          // Optional bearer token: needed when the invited email already has an account
          let authed: string | null = null
          if (req.headers.authorization) {
            await authenticate(req, reply)
            authed = req.user.sub
          }
          const r = await service.acceptInvitation(req.body as any, authed)
          return reply.status(201).send(successResponse(r, 'Invitation accepted'))
        },
      )
    },
    { prefix: '/api/v1/public/auth' },
  )

  // ───────────── Signed-in user: /api/v1/me/* ─────────────
  await app.register(
    async (me) => {
      me.addHook('onRequest', authenticate)
      const sec = [{ bearerAuth: [] }]

      me.get('/', { schema: { tags: ['Me'], security: sec } }, async (req) =>
        successResponse(await service.getMe(req.user.sub)),
      )
      me.patch(
        '/',
        { schema: { tags: ['Me'], security: sec, body: S.updateMeBody } },
        async (req) =>
          successResponse(
            await service.updateMe(req.user.sub, req.body as any, meta(req)),
            'Profile updated',
          ),
      )
      me.post(
        '/whatsapp-consent',
        { schema: { tags: ['Me'], security: sec, body: S.consentBody } },
        async (req) =>
          successResponse(
            await service.setWhatsappConsent(req.user.sub, req.body as any, meta(req)),
            'Consent saved',
          ),
      )
      me.post(
        '/email-change',
        { config: authLimit, schema: { tags: ['Me'], security: sec, body: S.emailChangeBody } },
        async (req, reply) => {
          const r = await service.requestEmailChange(req.user.sub, req.body as any, meta(req))
          return reply.status(202).send(successResponse(null, r.message))
        },
      )
      me.post(
        '/email-change/confirm',
        {
          config: authLimit,
          schema: { tags: ['Me'], security: sec, body: S.emailChangeConfirmBody },
        },
        async (req, reply) => {
          const r = await service.confirmEmailChange(req.user.sub, req.body as any)
          reply.clearCookie(COOKIE, { path: COOKIE_PATH })
          return successResponse(null, r.message)
        },
      )
      me.get('/sessions', { schema: { tags: ['Me'], security: sec } }, async (req) =>
        successResponse(await service.listSessions(req.user.sub)),
      )
      me.post('/logout-all', { schema: { tags: ['Me'], security: sec } }, async (req, reply) => {
        await service.logoutEverywhere(req.user.sub)
        reply.clearCookie(COOKIE, { path: COOKIE_PATH })
        return successResponse(null, 'Logged out everywhere')
      })
    },
    { prefix: '/api/v1/me' },
  )

  // ───────────── Owner: staff of a venue ─────────────
  await app.register(
    async (pos) => {
      pos.addHook('onRequest', authenticate)
      const sec = [{ bearerAuth: [] }]
      const ownerOnly = requireVenueRole('OWNER')

      pos.get(
        '/staff',
        {
          onRequest: [requireVenueRole('OWNER', 'MANAGER')],
          schema: { tags: ['Staff'], security: sec },
        },
        async (req) => successResponse(await service.listStaff((req.params as any).venueId)),
      )
      pos.post(
        '/staff/invitations',
        { onRequest: [ownerOnly], schema: { tags: ['Staff'], security: sec, body: S.inviteBody } },
        async (req, reply) => {
          const r = await service.inviteStaff(
            (req.params as any).venueId,
            req.user.sub,
            req.body as any,
          )
          return reply.status(201).send(successResponse(null, r.message))
        },
      )
      pos.delete(
        '/staff/:membershipId',
        { onRequest: [ownerOnly], schema: { tags: ['Staff'], security: sec } },
        async (req) => {
          const p = req.params as any
          await service.deactivateStaff(p.venueId, p.membershipId, req.user.sub)
          return successResponse(null, 'Staff member deactivated')
        },
      )
    },
    { prefix: '/api/v1/pos/venues/:venueId' },
  )

  // ───────────── Admin: users and audit ─────────────
  await app.register(
    async (admin) => {
      admin.addHook('onRequest', authenticate)
      admin.addHook('onRequest', requireAdmin)
      const sec = [{ bearerAuth: [] }]

      admin.get(
        '/users',
        {
          schema: {
            tags: ['Admin'],
            security: sec,
            querystring: {
              type: 'object',
              properties: {
                q: { type: 'string', maxLength: 100 },
                status: { type: 'string' },
                ...S.pageQuery.properties,
              },
            },
          },
        },
        async (req) => successResponse(await service.adminListUsers(req.query as any)),
      )
      admin.post(
        '/users/:id/suspend',
        {
          schema: {
            tags: ['Admin'],
            security: sec,
          },
        },
        async (req) => {
          await service.adminSetUserStatus(
            req.user.sub,
            (req.params as any).id,
            'suspend',
            String((req.body as any)?.reason ?? '').slice(0, 500) || undefined,
            req.ip,
          )
          return successResponse(null, 'User suspended')
        },
      )
      admin.post(
        '/users/:id/unsuspend',
        { schema: { tags: ['Admin'], security: sec } },
        async (req) => {
          await service.adminSetUserStatus(
            req.user.sub,
            (req.params as any).id,
            'unsuspend',
            undefined,
            req.ip,
          )
          return successResponse(null, 'User unsuspended')
        },
      )
      admin.post(
        '/users/:id/force-logout',
        { schema: { tags: ['Admin'], security: sec } },
        async (req) => {
          await service.adminForceLogout(req.user.sub, (req.params as any).id, req.ip)
          return successResponse(null, 'User logged out everywhere')
        },
      )
      admin.get(
        '/audit-logs',
        {
          schema: {
            tags: ['Admin'],
            security: sec,
            querystring: {
              type: 'object',
              properties: {
                actorId: { type: 'string' },
                entity: { type: 'string' },
                entityId: { type: 'string' },
                action: { type: 'string' },
                ...S.pageQuery.properties,
              },
            },
          },
        },
        async (req) => successResponse(await service.adminAuditLogs(req.query as any)),
      )
    },
    { prefix: '/api/v1/admin' },
  )
}
