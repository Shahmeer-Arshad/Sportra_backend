import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../../config/env'
import { authenticate } from '../../hooks/auth.hook'
import { successResponse } from '../../utils/response'
import { acceptInvitationMediator } from './mediators/accept-invitation.mediator'
import { adminUserMediator } from './mediators/admin-user.mediator'
import { credentialsMediator } from './mediators/credentials.mediator'
import { profileMediator } from './mediators/profile.mediator'
import { signupMediator } from './mediators/signup.mediator'
import { staffMediator } from './mediators/staff.mediator'
import { createIdentityService } from './identity.service'
import { IdentityDeps } from './identity.deps'
import { AuthResult, RequestMeta } from './identity.domain'
import { createOtpService } from './identity.otp'
import { createIdentityRepository } from './identity.repository'
import { createSessionService } from './identity.session'

const COOKIE = 'refreshToken'
export const COOKIE_PATH = '/api/v1/public/auth'

type Req = FastifyRequest
type Res = FastifyReply
const body = (req: Req) => req.body as any
const query = (req: Req) => req.query as any
const params = (req: Req) => req.params as any
const meta = (req: Req): RequestMeta => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'] ?? null,
})

function setRefreshCookie(reply: Res, r: AuthResult) {
  reply.setCookie(COOKIE, r.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: COOKIE_PATH,
    expires: r.refreshExpiresAt,
  })
}
const clearRefreshCookie = (reply: Res) => reply.clearCookie(COOKIE, { path: COOKIE_PATH })

const sessionBody = (r: AuthResult, message: string) => ({
  ...successResponse({ user: r.user }, message),
  accessToken: r.accessToken,
})

/** HTTP layer only: cookies, status codes and the response envelope. */
export function createIdentityController(app: FastifyInstance) {
  const repo = createIdentityRepository(app.prisma)
  const deps: IdentityDeps = {
    repo,
    otp: createOtpService(repo, app.mailer, app.log),
    session: createSessionService(repo, (payload) => app.jwt.sign(payload)),
    mailer: app.mailer,
    log: app.log,
  }
  const svc = createIdentityService(deps)
  const signup = signupMediator(deps)
  const credentials = credentialsMediator(deps)
  const profile = profileMediator(deps)
  const staff = staffMediator(deps)
  const adminUsers = adminUserMediator(deps)
  const acceptInvitation = acceptInvitationMediator(deps)

  /** Logs in with a session result: sets the cookie and sends the access token. */
  const session = (reply: Res, r: AuthResult, message: string) => {
    setRefreshCookie(reply, r)
    return reply.send(sessionBody(r, message))
  }

  return {
    // ───────── public auth ─────────
    register: async (req: Req, reply: Res) =>
      reply
        .status(202)
        .send(successResponse(null, (await signup.register(body(req), meta(req))).message)),
    verifyEmail: async (req: Req, reply: Res) =>
      session(reply, await signup.verifyEmail(body(req), meta(req)), 'Email verified'),

    login: async (req: Req, reply: Res) => {
      const r = await svc.login(body(req), meta(req))
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
    loginVerifyOtp: async (req: Req, reply: Res) =>
      session(reply, await svc.loginVerifyStepUp(body(req), meta(req)), 'Logged in'),
    otpRequest: async (req: Req, reply: Res) =>
      reply
        .status(202)
        .send(successResponse(null, (await svc.otpRequest(body(req), meta(req))).message)),
    otpVerify: async (req: Req, reply: Res) =>
      session(reply, await svc.otpVerify(body(req), meta(req)), 'Logged in'),
    forgotPassword: async (req: Req, reply: Res) =>
      reply
        .status(202)
        .send(successResponse(null, (await svc.forgotPassword(body(req), meta(req))).message)),
    resetPassword: async (req: Req, reply: Res) => {
      const r = await credentials.resetPassword(body(req))
      clearRefreshCookie(reply)
      return reply.send(successResponse(null, r.message))
    },

    refresh: async (req: Req, reply: Res) => {
      try {
        return session(reply, await svc.refresh(req.cookies[COOKIE], meta(req)), 'Token refreshed')
      } catch (e) {
        clearRefreshCookie(reply)
        throw e
      }
    },
    logout: async (req: Req, reply: Res) => {
      await svc.logout(req.cookies[COOKIE])
      clearRefreshCookie(reply)
      return reply.send(successResponse(null, 'Logged out'))
    },

    acceptInvitation: async (req: Req, reply: Res) => {
      // Optional bearer token: needed when the invited email already has an account
      let authed: string | null = null
      if (req.headers.authorization) {
        await authenticate(req, reply)
        authed = req.user.sub
      }
      const r = await acceptInvitation(body(req), authed)
      return reply.status(201).send(successResponse(r, 'Invitation accepted'))
    },

    // ───────── signed-in user ─────────
    getMe: async (req: Req) => successResponse(await svc.getMe(req.user.sub)),
    updateMe: async (req: Req) =>
      successResponse(
        await profile.updateMe(req.user.sub, body(req), meta(req)),
        'Profile updated',
      ),
    whatsappConsent: async (req: Req) =>
      successResponse(
        await profile.setWhatsappConsent(req.user.sub, body(req), meta(req)),
        'Consent saved',
      ),
    emailChange: async (req: Req, reply: Res) =>
      reply
        .status(202)
        .send(
          successResponse(
            null,
            (await svc.requestEmailChange(req.user.sub, body(req), meta(req))).message,
          ),
        ),
    emailChangeConfirm: async (req: Req, reply: Res) => {
      const r = await credentials.confirmEmailChange(req.user.sub, body(req))
      clearRefreshCookie(reply)
      return successResponse(null, r.message)
    },
    sessions: async (req: Req) => successResponse(await svc.listSessions(req.user.sub)),
    logoutAll: async (req: Req, reply: Res) => {
      await credentials.logoutEverywhere(req.user.sub)
      clearRefreshCookie(reply)
      return successResponse(null, 'Logged out everywhere')
    },

    // ───────── owner: staff ─────────
    listStaff: async (req: Req) => successResponse(await svc.listStaff(params(req).venueId)),
    inviteStaff: async (req: Req, reply: Res) =>
      reply
        .status(201)
        .send(
          successResponse(
            null,
            (await staff.invite(params(req).venueId, req.user.sub, body(req))).message,
          ),
        ),
    deactivateStaff: async (req: Req) => {
      const p = params(req)
      await staff.deactivate(p.venueId, p.membershipId, req.user.sub)
      return successResponse(null, 'Staff member deactivated')
    },

    // ───────── admin ─────────
    adminUsers: async (req: Req) => successResponse(await svc.adminListUsers(query(req))),
    suspendUser: async (req: Req) => {
      const reason = String(body(req)?.reason ?? '').slice(0, 500) || undefined
      await adminUsers.setStatus(req.user.sub, params(req).id, 'suspend', reason, req.ip)
      return successResponse(null, 'User suspended')
    },
    unsuspendUser: async (req: Req) => {
      await adminUsers.setStatus(req.user.sub, params(req).id, 'unsuspend', undefined, req.ip)
      return successResponse(null, 'User unsuspended')
    },
    forceLogout: async (req: Req) => {
      await adminUsers.forceLogout(req.user.sub, params(req).id, req.ip)
      return successResponse(null, 'User logged out everywhere')
    },
    auditLogs: async (req: Req) => successResponse(await svc.adminAuditLogs(query(req))),
  }
}
