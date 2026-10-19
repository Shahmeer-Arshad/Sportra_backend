import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'

const REDIS_TIMEOUT_MS = 1000

/** Dependency probes: each resolves true when the dependency answers. */
export const createHealthRepository = (prisma: PrismaClient, redis: Redis | null) => ({
  database: () =>
    prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    ),

  /** null when Redis is not configured. */
  redis: redis
    ? () =>
        Promise.race([
          redis.ping(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), REDIS_TIMEOUT_MS),
          ),
        ]).then(
          () => true,
          () => false,
        )
    : null,
})
