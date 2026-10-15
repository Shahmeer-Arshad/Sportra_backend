import { Role, PrismaClient } from '@prisma/client'
import '@fastify/cookie'
import type { Redis } from 'ioredis'

// ─────────────────────────────────────────
// JWT Payload
// ─────────────────────────────────────────
export interface JwtPayload {
  sub: string // user id
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
    redis: Redis | null
  }
  interface FastifyRequest {
    accessJwtVerify: <T>(options?: any) => Promise<T>
    refreshJwtVerify: <T>(options?: any) => Promise<T>
  }
  interface FastifyReply {
    accessJwtSign: (payload: any, options?: any) => Promise<string>
    refreshJwtSign: (payload: any, options?: any) => Promise<string>
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
