import { Role, PrismaClient } from '@prisma/client'
import { FastifyJWT } from '@fastify/jwt'

// ─────────────────────────────────────────
// JWT Payload
// ─────────────────────────────────────────
export interface JwtPayload {
  sub: string      // user id
  email: string
  role: Role
  iat?: number
  exp?: number
}

// ─────────────────────────────────────────
// Augment Fastify types
// ─────────────────────────────────────────
declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user: JwtPayload
  }
}


// ─────────────────────────────────────────
// Generic API types
// ─────────────────────────────────────────
export interface PaginationQuery {
  page?: string
  limit?: string
}

export interface ApiResponse<T> {
  success: boolean
  message: string
  data: T
}

export interface PaginatedApiResponse<T> extends ApiResponse<T[]> {
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}
