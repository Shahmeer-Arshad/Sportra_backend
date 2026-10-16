import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import {
  makeApp,
  post,
  call,
  lastCode,
  mailCount,
  uniqueEmail,
  uniquePhone,
  signupVerified,
  createAdmin,
  loginAdmin,
  cleanupTestData,
  PASSWORD,
} from './helpers'

const A = '/api/v1/public/auth'
let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
  await cleanupTestData(app.prisma)
})
afterAll(async () => {
  await cleanupTestData(app.prisma)
  await app.close()
})

describe('sign-up and e-mail OTP', () => {
  it('registers, e-mails a 6-digit code, and verifying logs the user in', async () => {
    const email = uniqueEmail()
    const reg = await post(app, `${A}/register`, {
      email,
      password: PASSWORD,
      fullName: 'Ali Khan',
    })
    expect(reg.statusCode).toBe(202)
    expect(reg.body).not.toContain(PASSWORD)
    const code = lastCode(email)
    expect(code).toMatch(/^[0-9]{6}$/)

    // user exists but is not active yet; the code is NOT stored in plain text
    const u = await app.prisma.user.findUniqueOrThrow({ where: { id: undefined, email } })
    expect(u.status).toBe('PENDING_VERIFICATION')
    expect(u.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/) // UUID v7
    const ch = await app.prisma.otpChallenge.findFirstOrThrow({ where: { email } })
    expect(ch.codeHash).not.toContain(code)

    const ver = await post(app, `${A}/verify-email`, { email, code })
    expect(ver.statusCode).toBe(200)
    expect(ver.json().accessToken).toBeTruthy()
    const cookie = ver.cookies.find((c) => c.name === 'refreshToken')!
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.path).toBe(A)

    const me = await call(app, 'GET', '/api/v1/me', ver.json().accessToken)
    expect(me.statusCode).toBe(200)
    expect(me.json().data).toMatchObject({ email, status: 'ACTIVE', emailVerified: true })
    expect(me.body).not.toMatch(/password|hash/i)
  })

  it('answers the same for an e-mail that already exists (no account enumeration)', async () => {
    const { email } = await signupVerified(app)
    const again = await post(app, `${A}/register`, {
      email,
      password: PASSWORD,
      fullName: 'Someone Else',
    })
    const fresh = await post(app, `${A}/register`, {
      email: uniqueEmail(),
      password: PASSWORD,
      fullName: 'New Person',
    })
    expect(again.statusCode).toBe(fresh.statusCode)
    expect(again.json()).toEqual(fresh.json())
  })

  it('same generic answer for forgot-password and otp/request on unknown e-mails', async () => {
    const ghost = uniqueEmail('ghost')
    const f = await post(app, `${A}/password/forgot`, { email: ghost })
    const o = await post(app, `${A}/otp/request`, { email: ghost })
    expect(f.statusCode).toBe(202)
    expect(o.statusCode).toBe(202)
    expect(mailCount(ghost)).toBe(0)
  })

  it('rejects weak passwords, bad e-mails and disposable domains', async () => {
    expect(
      (
        await post(app, `${A}/register`, {
          email: uniqueEmail(),
          password: 'short1',
          fullName: 'Weak Pass',
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await post(app, `${A}/register`, {
          email: uniqueEmail(),
          password: 'allletters',
          fullName: 'Weak Pass',
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await post(app, `${A}/register`, {
          email: 'not-an-email',
          password: PASSWORD,
          fullName: 'Bad Mail',
        })
      ).statusCode,
    ).toBe(400)
    const d = await post(app, `${A}/register`, {
      email: 'x@mailinator.com',
      password: PASSWORD,
      fullName: 'Throwaway',
    })
    expect(d.statusCode).toBe(400)
    expect(d.json().code).toBe('DISPOSABLE_EMAIL')
  })

  it('resend cooldown: a second request within 60s sends no new e-mail', async () => {
    const email = uniqueEmail()
    await post(app, `${A}/register`, { email, password: PASSWORD, fullName: 'Cool Down' })
    expect(mailCount(email)).toBe(1)
    const again = await post(app, `${A}/register`, {
      email,
      password: PASSWORD,
      fullName: 'Cool Down',
    })
    expect(again.statusCode).toBe(202) // same answer
    expect(mailCount(email)).toBe(1) // but nothing was sent
  })

  it('hourly cap: at most 5 codes per address per hour', async () => {
    const email = uniqueEmail()
    await post(app, `${A}/register`, { email, password: PASSWORD, fullName: 'Capped User' })
    const user = await app.prisma.user.findUniqueOrThrow({ where: { email } })
    // simulate 4 more earlier codes within the hour (older than the cooldown)
    for (let i = 0; i < 4; i++) {
      await app.prisma.otpChallenge.create({
        data: {
          id: `00000000-0000-7000-8000-${String(Date.now() + i)
            .slice(-12)
            .padStart(12, '0')}`,
          email,
          userId: user.id,
          purpose: 'LOGIN_PASSWORDLESS',
          codeHash: 'x',
          expiresAt: new Date(Date.now() - 1000),
          createdAt: new Date(Date.now() - 120_000),
        },
      })
    }
    const before = mailCount(email)
    await app.prisma.otpChallenge.updateMany({
      where: { email, purpose: 'SIGNUP_VERIFY' },
      data: { createdAt: new Date(Date.now() - 120_000) },
    })
    await post(app, `${A}/register`, { email, password: PASSWORD, fullName: 'Capped User' })
    expect(mailCount(email)).toBe(before) // cap reached: silently throttled
  })

  it('rejects a phone already used by another account', async () => {
    const phone = uniquePhone()
    await signupVerified(app, { phone })
    const r = await post(app, `${A}/register`, {
      email: uniqueEmail(),
      password: PASSWORD,
      fullName: 'Phone Thief',
      phone,
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('PHONE_IN_USE')
  })
})

describe('OTP rules', () => {
  async function pending() {
    const email = uniqueEmail()
    await post(app, `${A}/register`, { email, password: PASSWORD, fullName: 'Otp Tester' })
    return { email, code: lastCode(email) }
  }
  const wrong = (code: string) => (code === '000000' ? '111111' : '000000')

  it('wrong code is rejected with a generic error', async () => {
    const { email, code } = await pending()
    const r = await post(app, `${A}/verify-email`, { email, code: wrong(code) })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('OTP_INVALID')
  })

  it('5 wrong attempts burn the challenge, even the right code fails afterwards', async () => {
    const { email, code } = await pending()
    for (let i = 0; i < 5; i++) await post(app, `${A}/verify-email`, { email, code: wrong(code) })
    const r = await post(app, `${A}/verify-email`, { email, code })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('OTP_INVALID')
  })

  it('an expired code is rejected', async () => {
    const { email, code } = await pending()
    await app.prisma.otpChallenge.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect((await post(app, `${A}/verify-email`, { email, code })).statusCode).toBe(400)
  })

  it('is single use: the same code cannot be used twice', async () => {
    const { email, code } = await pending()
    expect((await post(app, `${A}/verify-email`, { email, code })).statusCode).toBe(200)
    expect((await post(app, `${A}/verify-email`, { email, code })).statusCode).toBe(400)
  })

  it('race: 10 parallel verifications with the right code, exactly one wins', async () => {
    const { email, code } = await pending()
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post(app, `${A}/verify-email`, { email, code })),
    )
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(9)
  })

  it('a code for one purpose cannot be used for another', async () => {
    const { email, code } = await pending()
    const r = await post(app, `${A}/login/verify-otp`, { email, code })
    expect(r.statusCode).toBe(400)
  })

  it('a new code invalidates the previous one', async () => {
    const email = uniqueEmail()
    await post(app, `${A}/register`, { email, password: PASSWORD, fullName: 'Two Codes' })
    const first = lastCode(email)
    await app.prisma.otpChallenge.updateMany({
      where: { email },
      data: { createdAt: new Date(Date.now() - 120_000) },
    })
    await post(app, `${A}/register`, { email, password: PASSWORD, fullName: 'Two Codes' })
    const second = lastCode(email)
    if (first !== second) {
      expect((await post(app, `${A}/verify-email`, { email, code: first })).statusCode).toBe(400)
    }
    expect((await post(app, `${A}/verify-email`, { email, code: second })).statusCode).toBe(200)
  })
})

describe('login', () => {
  it('wrong password and unknown e-mail give the same answer', async () => {
    const { email } = await signupVerified(app)
    const bad = await post(app, `${A}/login`, { email, password: 'WrongPass123' })
    const ghost = await post(app, `${A}/login`, {
      email: uniqueEmail('ghost'),
      password: 'WrongPass123',
    })
    expect(bad.statusCode).toBe(401)
    expect(ghost.statusCode).toBe(401)
    expect(bad.json().code).toBe(ghost.json().code)
    expect(bad.json().message).toBe(ghost.json().message)
  })

  it('a verified player logs in with e-mail + password', async () => {
    const { email } = await signupVerified(app)
    const r = await post(app, `${A}/login`, { email: email.toUpperCase(), password: PASSWORD })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ mfaRequired: false })
    expect(r.json().accessToken).toBeTruthy()
  })

  it('an unverified account cannot log in and gets a fresh code', async () => {
    const email = uniqueEmail()
    await post(app, `${A}/register`, { email, password: PASSWORD, fullName: 'Not Verified' })
    await app.prisma.otpChallenge.updateMany({
      where: { email },
      data: { createdAt: new Date(Date.now() - 120_000) },
    })
    const before = mailCount(email)
    const r = await post(app, `${A}/login`, { email, password: PASSWORD })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('EMAIL_NOT_VERIFIED')
    expect(mailCount(email)).toBe(before + 1)
  })

  it('10 failed logins lock the account, even the right password is refused', async () => {
    const { email } = await signupVerified(app)
    for (let i = 0; i < 10; i++) await post(app, `${A}/login`, { email, password: 'WrongPass123' })
    const r = await post(app, `${A}/login`, { email, password: PASSWORD })
    expect(r.statusCode).toBe(429)
    expect(r.json().code).toBe('ACCOUNT_LOCKED')
  })

  it('a suspended user cannot log in', async () => {
    const { email, userId } = await signupVerified(app)
    await app.prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } })
    const r = await post(app, `${A}/login`, { email, password: PASSWORD })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('ACCOUNT_SUSPENDED')
  })

  it('passwordless: request a code, verify it, get a session', async () => {
    const { email } = await signupVerified(app)
    const req = await post(app, `${A}/otp/request`, { email })
    expect(req.statusCode).toBe(202)
    const v = await post(app, `${A}/otp/verify`, { email, code: lastCode(email) })
    expect(v.statusCode).toBe(200)
    expect(v.json().accessToken).toBeTruthy()
  })
})

describe('admin login always needs an e-mailed code', () => {
  it('password alone gives no token; password + code does', async () => {
    const admin = await createAdmin(app.prisma)
    const l = await post(app, `${A}/login`, { email: admin.email, password: PASSWORD })
    expect(l.statusCode).toBe(200)
    expect(l.json().mfaRequired).toBe(true)
    expect(l.json().accessToken).toBeUndefined()
    expect(l.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined()
    const v = await post(app, `${A}/login/verify-otp`, {
      email: admin.email,
      code: lastCode(admin.email),
    })
    expect(v.statusCode).toBe(200)
    expect(v.json().data.user.platformRole).toBe('PLATFORM_ADMIN')
  })

  it('passwordless login is switched off for admins', async () => {
    const admin = await createAdmin(app.prisma)
    const before = mailCount(admin.email)
    expect((await post(app, `${A}/otp/request`, { email: admin.email })).statusCode).toBe(202)
    expect(mailCount(admin.email)).toBe(before)
  })

  it('venue staff also need a code', async () => {
    const owner = await signupVerified(app)
    await app.prisma.venueMembership.create({
      data: {
        id: '0194c8a0-0000-7000-8000-' + String(Date.now()).slice(-12).padStart(12, '0'),
        userId: owner.userId,
        venueId: '0194c8a0-1111-7000-8000-000000000001',
        role: 'MANAGER',
      },
    })
    const l = await post(app, `${A}/login`, { email: owner.email, password: PASSWORD })
    expect(l.json().mfaRequired).toBe(true)
  })
})

describe('refresh tokens and sessions', () => {
  it('rotates on every refresh and the old token cannot be used again', async () => {
    const s = await signupVerified(app)
    const r1 = await post(app, `${A}/refresh`, undefined, {}, { refreshToken: s.refreshCookie })
    expect(r1.statusCode).toBe(200)
    const newCookie = r1.cookies.find((c) => c.name === 'refreshToken')!.value
    expect(newCookie).not.toBe(s.refreshCookie)
    expect(r1.json().accessToken).toBeTruthy()
    // reuse of the OLD token: rejected, and the whole family is revoked
    const reuse = await post(app, `${A}/refresh`, undefined, {}, { refreshToken: s.refreshCookie })
    expect(reuse.statusCode).toBe(401)
    expect(reuse.json().code).toBe('REFRESH_REUSED')
    const stolen = await post(app, `${A}/refresh`, undefined, {}, { refreshToken: newCookie })
    expect(stolen.statusCode).toBe(401)
  })

  it('refresh without a cookie or with garbage is 401', async () => {
    expect((await post(app, `${A}/refresh`)).statusCode).toBe(401)
    expect(
      (await post(app, `${A}/refresh`, undefined, {}, { refreshToken: 'abc.def' })).statusCode,
    ).toBe(401)
  })

  it('refresh tokens are stored hashed', async () => {
    const s = await signupVerified(app)
    const rows = await app.prisma.refreshToken.findMany({ where: { userId: s.userId } })
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows.every((r) => !s.refreshCookie.includes(r.tokenHash) && r.tokenHash !== s.refreshCookie),
    ).toBe(true)
  })

  it('logout revokes the refresh token', async () => {
    const s = await signupVerified(app)
    const out = await post(app, `${A}/logout`, undefined, {}, { refreshToken: s.refreshCookie })
    expect(out.statusCode).toBe(200)
    expect(
      (await post(app, `${A}/refresh`, undefined, {}, { refreshToken: s.refreshCookie }))
        .statusCode,
    ).toBe(401)
  })

  it('log out everywhere kills access tokens and refresh tokens at once', async () => {
    const s = await signupVerified(app)
    // access tokens have 1-second precision; wait so "issued before" is unambiguous
    await new Promise((r) => setTimeout(r, 1100))
    expect((await call(app, 'POST', '/api/v1/me/logout-all', s.accessToken)).statusCode).toBe(200)
    const me = await call(app, 'GET', '/api/v1/me', s.accessToken)
    expect(me.statusCode).toBe(401)
    expect(me.json().code).toBe('TOKEN_REVOKED')
    expect(
      (await post(app, `${A}/refresh`, undefined, {}, { refreshToken: s.refreshCookie }))
        .statusCode,
    ).toBe(401)
  })

  it('lists active sessions', async () => {
    const s = await signupVerified(app)
    const r = await call(app, 'GET', '/api/v1/me/sessions', s.accessToken)
    expect(r.json().data.length).toBeGreaterThanOrEqual(1)
  })
})

describe('password reset', () => {
  it('resets with a code, revokes every session, and the new password works', async () => {
    const s = await signupVerified(app)
    await new Promise((r) => setTimeout(r, 1100))
    expect((await post(app, `${A}/password/forgot`, { email: s.email })).statusCode).toBe(202)
    const reset = await post(app, `${A}/password/reset`, {
      email: s.email,
      code: lastCode(s.email),
      newPassword: 'BrandNew123',
    })
    expect(reset.statusCode).toBe(200)
    expect((await call(app, 'GET', '/api/v1/me', s.accessToken)).statusCode).toBe(401)
    expect(
      (await post(app, `${A}/refresh`, undefined, {}, { refreshToken: s.refreshCookie }))
        .statusCode,
    ).toBe(401)
    expect((await post(app, `${A}/login`, { email: s.email, password: PASSWORD })).statusCode).toBe(
      401,
    )
    expect(
      (await post(app, `${A}/login`, { email: s.email, password: 'BrandNew123' })).statusCode,
    ).toBe(200)
  })

  it('a wrong code does not reset the password', async () => {
    const s = await signupVerified(app)
    await post(app, `${A}/password/forgot`, { email: s.email })
    const code = lastCode(s.email)
    const r = await post(app, `${A}/password/reset`, {
      email: s.email,
      code: code === '123456' ? '654321' : '123456',
      newPassword: 'BrandNew123',
    })
    expect(r.statusCode).toBe(400)
    expect((await post(app, `${A}/login`, { email: s.email, password: PASSWORD })).statusCode).toBe(
      200,
    )
  })
})

describe('profile, WhatsApp consent, e-mail change', () => {
  it('updates name and phone; GET /me needs a token', async () => {
    expect((await call(app, 'GET', '/api/v1/me')).statusCode).toBe(401)
    const s = await signupVerified(app)
    const phone = uniquePhone()
    const r = await call(app, 'PATCH', '/api/v1/me', s.accessToken, { fullName: 'New Name', phone })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ fullName: 'New Name', phone })
  })

  it("cannot take another user's phone", async () => {
    const phone = uniquePhone()
    await signupVerified(app, { phone })
    const s = await signupVerified(app)
    const r = await call(app, 'PATCH', '/api/v1/me', s.accessToken, { phone })
    expect(r.statusCode).toBe(409)
  })

  it('WhatsApp opt-in needs a phone, stores evidence, and opt-out is instant', async () => {
    const s = await signupVerified(app)
    const noPhone = await call(app, 'POST', '/api/v1/me/whatsapp-consent', s.accessToken, {
      action: 'OPT_IN',
      textVersion: 'v1',
    })
    expect(noPhone.statusCode).toBe(400)
    expect(noPhone.json().code).toBe('PHONE_REQUIRED')

    await call(app, 'PATCH', '/api/v1/me', s.accessToken, { phone: uniquePhone() })
    const noVersion = await call(app, 'POST', '/api/v1/me/whatsapp-consent', s.accessToken, {
      action: 'OPT_IN',
    })
    expect(noVersion.statusCode).toBe(400)
    const inn = await call(app, 'POST', '/api/v1/me/whatsapp-consent', s.accessToken, {
      action: 'OPT_IN',
      textVersion: 'v1',
    })
    expect(inn.json().data.whatsappOptIn).toBe(true)
    const out = await call(app, 'POST', '/api/v1/me/whatsapp-consent', s.accessToken, {
      action: 'OPT_OUT',
    })
    expect(out.json().data.whatsappOptIn).toBe(false)
    const hist = await app.prisma.whatsappConsent.findMany({
      where: { userId: s.userId },
      orderBy: { occurredAt: 'asc' },
    })
    expect(hist.map((h) => h.action)).toEqual(['OPT_IN', 'OPT_OUT'])
    expect(hist[0].consentTextVersion).toBe('v1')
  })

  it('consent at sign-up is recorded with its text version', async () => {
    const email = uniqueEmail()
    await post(app, `${A}/register`, {
      email,
      password: PASSWORD,
      fullName: 'Consent User',
      phone: uniquePhone(),
      whatsappConsent: { optIn: true, textVersion: 'signup-v2' },
    })
    const u = await app.prisma.user.findUniqueOrThrow({ where: { email } })
    expect(u.whatsappOptIn).toBe(true)
    expect(u.whatsappOptInSource).toBe('SIGNUP_FORM')
    expect(u.whatsappOptInTextVersion).toBe('signup-v2')
  })

  it('the database refuses opt-in without a timestamp (evidence rule)', async () => {
    const s = await signupVerified(app)
    await expect(
      app.prisma.$executeRaw`UPDATE users SET whatsapp_opt_in = true WHERE id = ${s.userId}::uuid`,
    ).rejects.toThrow()
  })

  it('changing the phone withdraws WhatsApp consent', async () => {
    const s = await signupVerified(app, { phone: uniquePhone() })
    await call(app, 'POST', '/api/v1/me/whatsapp-consent', s.accessToken, {
      action: 'OPT_IN',
      textVersion: 'v1',
    })
    await call(app, 'PATCH', '/api/v1/me', s.accessToken, { phone: uniquePhone() })
    const me = await call(app, 'GET', '/api/v1/me', s.accessToken)
    expect(me.json().data.whatsappOptIn).toBe(false)
  })

  it('e-mail change: code goes to the NEW address, sessions are revoked', async () => {
    const s = await signupVerified(app)
    const newEmail = uniqueEmail('new')
    await new Promise((r) => setTimeout(r, 1100))
    const req = await call(app, 'POST', '/api/v1/me/email-change', s.accessToken, {
      newEmail,
      password: PASSWORD,
    })
    expect(req.statusCode).toBe(202)
    const bad = await call(app, 'POST', '/api/v1/me/email-change', s.accessToken, {
      newEmail: uniqueEmail('x'),
      password: 'WrongPass123',
    })
    expect(bad.statusCode).toBe(401)
    const done = await call(app, 'POST', '/api/v1/me/email-change/confirm', s.accessToken, {
      newEmail,
      code: lastCode(newEmail),
    })
    expect(done.statusCode).toBe(200)
    expect((await call(app, 'GET', '/api/v1/me', s.accessToken)).statusCode).toBe(401)
    expect(
      (await post(app, `${A}/login`, { email: newEmail, password: PASSWORD })).statusCode,
    ).toBe(200)
    expect((await post(app, `${A}/login`, { email: s.email, password: PASSWORD })).statusCode).toBe(
      401,
    )
  })
})

describe('admin: users and audit', () => {
  it('normal users and anonymous callers cannot use admin routes', async () => {
    const s = await signupVerified(app)
    expect((await call(app, 'GET', '/api/v1/admin/users')).statusCode).toBe(401)
    const r = await call(app, 'GET', '/api/v1/admin/users', s.accessToken)
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('ADMIN_ONLY')
  })

  it('admin can search, suspend (kills sessions), unsuspend, force logout; all audited', async () => {
    const admin = await createAdmin(app.prisma)
    const token = await loginAdmin(app, admin.email)
    const victim = await signupVerified(app)

    const list = await call(
      app,
      'GET',
      `/api/v1/admin/users?q=${encodeURIComponent(victim.email)}`,
      token,
    )
    expect(list.json().data.items.map((u: any) => u.email)).toContain(victim.email)

    await new Promise((r) => setTimeout(r, 1100))
    expect(
      (
        await call(app, 'POST', `/api/v1/admin/users/${victim.userId}/suspend`, token, {
          reason: 'abuse',
        })
      ).statusCode,
    ).toBe(200)
    expect((await call(app, 'GET', '/api/v1/me', victim.accessToken)).statusCode).toBe(401)
    expect(
      (await post(app, `${A}/login`, { email: victim.email, password: PASSWORD })).statusCode,
    ).toBe(403)

    expect(
      (await call(app, 'POST', `/api/v1/admin/users/${victim.userId}/unsuspend`, token)).statusCode,
    ).toBe(200)
    expect(
      (await post(app, `${A}/login`, { email: victim.email, password: PASSWORD })).statusCode,
    ).toBe(200)
    expect(
      (await call(app, 'POST', `/api/v1/admin/users/${victim.userId}/force-logout`, token))
        .statusCode,
    ).toBe(200)

    const logs = await call(app, 'GET', `/api/v1/admin/audit-logs?entityId=${victim.userId}`, token)
    const actions = logs.json().data.map((l: any) => l.action)
    expect(actions).toEqual(
      expect.arrayContaining(['USER_SUSPENDED', 'USER_UNSUSPENDED', 'USER_FORCE_LOGOUT']),
    )
    const susp = logs.json().data.find((l: any) => l.action === 'USER_SUSPENDED')
    expect(susp.actorId).toBe(admin.id)
    expect(susp.before).toEqual({ status: 'ACTIVE' })
  })

  it('an admin cannot suspend themselves', async () => {
    const admin = await createAdmin(app.prisma)
    const token = await loginAdmin(app, admin.email)
    expect(
      (await call(app, 'POST', `/api/v1/admin/users/${admin.id}/suspend`, token)).statusCode,
    ).toBe(403)
  })
})

describe('events', () => {
  it('sign-up writes user.upserted to the outbox', async () => {
    const s = await signupVerified(app)
    const rows = await app.prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM outbox WHERE event_type = 'user.upserted' AND payload->'data'->>'userId' = ${s.userId}`
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2) // created + verified
  })
})
