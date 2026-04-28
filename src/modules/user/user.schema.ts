import { z } from 'zod'

// ─────────────────────────────────────────
// Zod Schemas (runtime validation)
// ─────────────────────────────────────────
export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100).optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['USER', 'ADMIN']).default('USER'),
})

export const updateUserSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
})

export const userParamsSchema = z.object({
  id: z.string().cuid(),
})

// ─────────────────────────────────────────
// JSON Schema for Fastify route validation
// ─────────────────────────────────────────
export const createUserJsonSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      name: { type: 'string', minLength: 2, maxLength: 100 },
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
            name: { type: 'string' },
            role: { type: 'string' },
            createdAt: { type: 'string' },
          },
        },
      },
    },
  },
}

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
      name: { type: 'string', minLength: 2, maxLength: 100 },
      email: { type: 'string', format: 'email' },
    },
  },
}

// ─────────────────────────────────────────
// TypeScript Types
// ─────────────────────────────────────────
export type CreateUserInput = z.infer<typeof createUserSchema>
export type UpdateUserInput = z.infer<typeof updateUserSchema>
export type UserParams = z.infer<typeof userParamsSchema>
