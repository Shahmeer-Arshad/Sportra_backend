import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { AppError, ConflictError, ForbiddenError } from '../src/utils/errors'

describe('platform behaviour (error handler, security, docs)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    app.get('/__test/conflict', async () => {
      throw new ConflictError('Slot is held', 'SLOT_HELD', { secondsRemaining: 40 })
    })
    app.get('/__test/forbidden', async () => {
      throw new ForbiddenError()
    })
    app.get('/__test/crash', async () => {
      throw new Error('secret internal detail')
    })
    app.get('/__test/app-error', async () => {
      throw new AppError('custom', 418, true, 'TEAPOT')
    })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('AppError returns status, code, message and details', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/conflict' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      statusCode: 409,
      code: 'SLOT_HELD',
      message: 'Slot is held',
      details: { secondsRemaining: 40 },
    })
  })

  it('default codes and custom status work', async () => {
    expect((await app.inject({ method: 'GET', url: '/__test/forbidden' })).json().code).toBe(
      'FORBIDDEN',
    )
    const t = await app.inject({ method: 'GET', url: '/__test/app-error' })
    expect(t.statusCode).toBe(418)
    expect(t.json().code).toBe('TEAPOT')
  })

  it('unexpected errors return 500 with INTERNAL_ERROR and keep the request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test/crash',
      headers: { 'x-request-id': 'rid-9' },
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('INTERNAL_ERROR')
    expect(res.headers['x-request-id']).toBe('rid-9')
  })

  it('unknown route is a 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('sends security headers (helmet)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('CORS allows a listed origin and refuses others', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    const bad = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    })
    expect(bad.headers['access-control-allow-origin']).toBeUndefined()
    expect(bad.statusCode).toBe(403)
  })

  it('serves Swagger docs titled Sportra', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' })
    expect(res.statusCode).toBe(200)
    expect(res.json().info.title).toMatch(/Sportra/)
    expect(Object.keys(res.json().paths)).toEqual(expect.arrayContaining(['/healthz', '/readyz']))
  })

  it('never returns password hashes or tokens in the login error body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/login',
      payload: { email: 'nobody@example.com', password: 'WrongPassword1!' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toMatch(/hash|\$2[aby]\$/i)
  })

  it('rate limits a client that sends too many requests', async () => {
    const limited = await buildApp()
    await limited.ready()
    let last = 200
    let limitedBody: any = {}
    for (let i = 0; i < 105; i++) {
      const r = await limited.inject({ method: 'GET', url: '/healthz', remoteAddress: '10.9.9.9' })
      last = r.statusCode
      if (last === 429) limitedBody = r.json()
    }
    await limited.close()
    expect(last).toBe(429)
    expect(limitedBody.code).toBe('RATE_LIMITED')
  })
})

describe('readiness when Redis is configured but down', () => {
  it('/readyz returns 503 and names redis as down', async () => {
    vi.resetModules()
    process.env.REDIS_URL = 'redis://127.0.0.1:1' // nothing listens here
    const { buildApp: build } = await import('../src/app.js')
    const down = await build()
    await down.ready()
    const res = await down.inject({ method: 'GET', url: '/readyz' })
    await down.close()
    delete process.env.REDIS_URL
    expect(res.statusCode).toBe(503)
    expect(res.json().checks).toMatchObject({ database: 'ok', redis: 'down' })
  })
})
