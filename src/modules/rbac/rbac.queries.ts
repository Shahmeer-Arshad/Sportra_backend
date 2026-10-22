import { Prisma } from '@prisma/client'
import { uuidv7 } from '../../lib/id'
import { Db } from '../../lib/outbox'

/** Role and permission queries. Other repositories spread these in so they share one transaction. */
export function roleQueries(db: Db) {
  return {
    /** Gives a user a role by its code. Safe to repeat: an existing assignment is left alone. */
    grantRole: async (userId: string, roleCode: string, venueId?: string, assignedBy?: string) => {
      const role = await db.role.findUniqueOrThrow({ where: { code: roleCode } })
      await db.userRole.createMany({
        data: [
          {
            id: uuidv7(),
            userId,
            roleId: role.id,
            scope: role.scope,
            venueId: venueId ?? null,
            assignedBy: assignedBy ?? null,
          },
        ],
        skipDuplicates: true,
      })
    },

    /** Permission codes of a user's active roles: platform-wide ones plus those of `venueId`. */
    permissionCodesOfUser: async (userId: string, venueId?: string) => {
      const rows = await db.$queryRaw<{ code: string }[]>(Prisma.sql`
        SELECT DISTINCT p.code
          FROM user_roles ur
          JOIN role_permissions rp ON rp.role_id = ur.role_id
          JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = ${userId}::uuid AND ur.is_active
           AND (ur.venue_id IS NULL OR ur.venue_id = ${venueId ?? null}::uuid)`)
      return rows.map((r) => r.code)
    },
  }
}
