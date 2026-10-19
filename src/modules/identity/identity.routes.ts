import { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin, requireVenueRole } from '../../hooks/auth.hook'
import { createIdentityController } from './identity.controller'
import * as S from './identity.schema'

// Auth endpoints get a tighter per-IP limit than the global one
const authLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } }
const sec = [{ bearerAuth: [] }]

export async function identityRoutes(app: FastifyInstance) {
  const c = createIdentityController(app)

  // ───────────── Public auth: /api/v1/public/auth/* ─────────────
  await app.register(
    async (pub) => {
      const auth = (extra = {}) => ({ config: authLimit, schema: { tags: ['Auth'], ...extra } })

      pub.post('/register', auth({ body: S.registerBody }), c.register)
      pub.post('/verify-email', auth({ body: S.emailCodeBody }), c.verifyEmail)
      pub.post('/login', auth({ body: S.loginBody }), c.login)
      pub.post('/login/verify-otp', auth({ body: S.emailCodeBody }), c.loginVerifyOtp)
      pub.post('/otp/request', auth({ body: S.emailBody }), c.otpRequest)
      pub.post('/otp/verify', auth({ body: S.emailCodeBody }), c.otpVerify)
      pub.post('/password/forgot', auth({ body: S.emailBody }), c.forgotPassword)
      pub.post('/password/reset', auth({ body: S.resetBody }), c.resetPassword)
      pub.post('/refresh', { config: authLimit, schema: { tags: ['Auth'] } }, c.refresh)
      pub.post('/logout', { schema: { tags: ['Auth'] } }, c.logout)
      pub.post('/staff-invitations/accept', auth({ body: S.acceptInviteBody }), c.acceptInvitation)
    },
    { prefix: '/api/v1/public/auth' },
  )

  // ───────────── Signed-in user: /api/v1/me/* ─────────────
  await app.register(
    async (me) => {
      me.addHook('onRequest', authenticate)
      const mine = (extra = {}) => ({ schema: { tags: ['Me'], security: sec, ...extra } })

      me.get('/', mine(), c.getMe)
      me.patch('/', mine({ body: S.updateMeBody }), c.updateMe)
      me.post('/whatsapp-consent', mine({ body: S.consentBody }), c.whatsappConsent)
      me.post(
        '/email-change',
        { config: authLimit, ...mine({ body: S.emailChangeBody }) },
        c.emailChange,
      )
      me.post(
        '/email-change/confirm',
        { config: authLimit, ...mine({ body: S.emailChangeConfirmBody }) },
        c.emailChangeConfirm,
      )
      me.get('/sessions', mine(), c.sessions)
      me.post('/logout-all', mine(), c.logoutAll)
    },
    { prefix: '/api/v1/me' },
  )

  // ───────────── Owner: staff of a venue ─────────────
  await app.register(
    async (pos) => {
      pos.addHook('onRequest', authenticate)
      const staff = (roles: ('OWNER' | 'MANAGER')[], extra = {}) => ({
        onRequest: [requireVenueRole(...roles)],
        schema: { tags: ['Staff'], security: sec, ...extra },
      })

      pos.get('/staff', staff(['OWNER', 'MANAGER']), c.listStaff)
      pos.post('/staff/invitations', staff(['OWNER'], { body: S.inviteBody }), c.inviteStaff)
      pos.delete('/staff/:membershipId', staff(['OWNER']), c.deactivateStaff)
    },
    { prefix: '/api/v1/pos/venues/:venueId' },
  )

  // ───────────── Admin: users and audit ─────────────
  await app.register(
    async (admin) => {
      admin.addHook('onRequest', authenticate)
      admin.addHook('onRequest', requireAdmin)
      const adm = (extra = {}) => ({ schema: { tags: ['Admin'], security: sec, ...extra } })

      admin.get('/users', adm({ querystring: S.adminUsersQuery }), c.adminUsers)
      admin.post('/users/:id/suspend', adm(), c.suspendUser)
      admin.post('/users/:id/unsuspend', adm(), c.unsuspendUser)
      admin.post('/users/:id/force-logout', adm(), c.forceLogout)
      admin.get('/audit-logs', adm({ querystring: S.auditLogsQuery }), c.auditLogs)
    },
    { prefix: '/api/v1/admin' },
  )
}
