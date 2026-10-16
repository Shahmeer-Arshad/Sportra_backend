import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'

describe('health and request ids', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('/healthz is alive', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ok')
  })

  it('/readyz checks the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    // Database is required. Redis (if configured) may be down without failing this test.
    expect(res.json().checks.database).toBe('ok')
    expect([200, 503]).toContain(res.statusCode)
  })

  it('echoes a caller request id and creates one otherwise', async () => {
    const a = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'abc-123' },
    })
    expect(a.headers['x-request-id']).toBe('abc-123')
    const b = await app.inject({ method: 'GET', url: '/healthz' })
    expect(b.headers['x-request-id']).toBeTruthy()
  })

  it('errors carry a code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/public/auth/login', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
  })
})
