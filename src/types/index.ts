import { PrismaClient } from '@prisma/client'
import '@fastify/cookie'
import type { Redis } from 'ioredis'

// ─────────────────────────────────────────
// JWT Payload
// ─────────────────────────────────────────
export type PlatformRole = 'USER' | 'PLATFORM_ADMIN'

export interface JwtPayload {
  sub: string // user id (UUID v7)
  email: string
  role: PlatformRole
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
