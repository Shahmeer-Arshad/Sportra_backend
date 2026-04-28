import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../src/app'
import { FastifyInstance } from 'fastify'

describe('User Module (Functional)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  const testUser = {
    email: `test_${Date.now()}@example.com`,
    username: `user_${Date.now()}`,
    firstName: 'John',
    lastName: 'Doe',
    password: 'SecurePassword123!',
    phone: `12345678${Math.floor(Math.random() * 100)}`,
  }

  it('should successfully sign up a new user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users/signup',
      payload: testUser,
    })

    expect(response.statusCode).toBe(201)
    
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.data.email).toBe(testUser.email)
    expect(body.data.username).toBe(testUser.username)
    expect(body.data.role).toBe('USER')
  })

  it('should successfully log in the created user and return a JWT', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users/login',
      payload: {
        email: testUser.email,
        password: testUser.password,
      },
    })

    expect(response.statusCode).toBe(200)
    
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.token).toBeDefined()
    expect(body.data.email).toBe(testUser.email)
  })

  it('should fail login with incorrect password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/users/login',
      payload: {
        email: testUser.email,
        password: 'WrongPassword!',
      },
    })

    expect(response.statusCode).toBe(401)
  })
})
