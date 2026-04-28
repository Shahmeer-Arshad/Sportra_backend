import { z } from 'zod'

// ─────────────────────────────────────────
// Zod Schemas (runtime validation)
// ─────────────────────────────────────────
export const createUserSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30),
  firstName: z.string().min(1).max(50),
  middleName: z.string().max(50).optional().nullable(),
  lastName: z.string().min(1).max(50),
  phone: z.string().max(20).optional().nullable(),
  profileUrl: z.string().url().optional().nullable().default(null),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['USER', 'ADMIN']).default('USER'),
})

export const signUpSchema = createUserSchema

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

export const updateUserSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  middleName: z.string().max(50).optional().nullable(),
  lastName: z.string().min(1).max(50).optional(),
  phone: z.string().max(20).optional().nullable(),
  profileUrl: z.string().url().optional().nullable(),
  email: z.string().email().optional(),
  username: z.string().min(3).max(30).optional(),
})

export const userParamsSchema = z.object({
  id: z.string().cuid(),
})

// ─────────────────────────────────────────
// JSON Schema for Fastify route validation
// ─────────────────────────────────────────
export const signUpJsonSchema = {
  body: {
    type: 'object',
    required: ['email', 'username', 'firstName', 'lastName', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      username: { type: 'string', minLength: 3, maxLength: 30 },
      firstName: { type: 'string', minLength: 1, maxLength: 50 },
      middleName: { type: ['string', 'null'], maxLength: 50 },
      lastName: { type: 'string', minLength: 1, maxLength: 50 },
      phone: { type: ['string', 'null'], maxLength: 20 },
      profileUrl: { type: ['string', 'null'], format: 'uri' },
      password: { type: 'string', minLength: 8 },
      role: { type: 'string', enum: ['USER', 'ADMIN'] },
    },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            username: { type: 'string' },
            firstName: { type: 'string' },
            middleName: { type: 'string', nullable: true },
            lastName: { type: 'string' },
            role: { type: 'string' },
            createdAt: { type: 'string' },
          },
        },
      },
    },
  },
}

export const loginJsonSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        token: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            username: { type: 'string' },
            role: { type: 'string' },
          },
        },
      },
    },
  },
}

export const createUserJsonSchema = signUpJsonSchema

export const updateUserJsonSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
    },
  },
  body: {
    type: 'object',
    properties: {
      firstName: { type: 'string', minLength: 1, maxLength: 50 },
      middleName: { type: ['string', 'null'], maxLength: 50 },
      lastName: { type: 'string', minLength: 1, maxLength: 50 },
      phone: { type: ['string', 'null'], maxLength: 20 },
      profileUrl: { type: ['string', 'null'], format: 'uri' },
      email: { type: 'string', format: 'email' },
      username: { type: 'string', minLength: 3, maxLength: 30 },
    },
  },
}

// ─────────────────────────────────────────
// TypeScript Types
// ─────────────────────────────────────────
export type CreateUserInput = z.infer<typeof createUserSchema>
export type SignUpInput = z.infer<typeof signUpSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
export type UserParams = z.infer<typeof userParamsSchema>
