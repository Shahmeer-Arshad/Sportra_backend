import { PrismaClient } from '@prisma/client'
import { makeRepository } from '../../lib/repository'
import { roleQueries } from './rbac.queries'

export const createRbacRepository = (prisma: PrismaClient) => makeRepository(prisma, roleQueries)
export type RbacRepository = ReturnType<typeof createRbacRepository>
