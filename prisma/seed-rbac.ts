import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { uuidv7 } from '../src/lib/id'
import { buildCatalog } from '../src/modules/rbac/rbac.catalog'

/**
 * Makes the database match `rbac.api-map.ts` + `rbac.roles.ts` exactly. Safe to run again and again:
 * a second run changes nothing. Run it after every edit of those two files (`npm run db:seed:rbac`)
 * and after every deploy; `npm run db:seed` runs it too.
 */
export interface RbacSyncResult {
  permissionsAdded: string[]
  permissionsRemoved: string[]
  granted: string[] // "ROLE permission"
  revoked: string[]
}

export async function syncRbac(prisma: PrismaClient): Promise<RbacSyncResult> {
  const { permissions, roles } = buildCatalog()
  const result: RbacSyncResult = {
    permissionsAdded: [],
    permissionsRemoved: [],
    granted: [],
    revoked: [],
  }

  await prisma.$transaction(async (tx) => {
    // permissions
    const existing = new Map((await tx.permission.findMany()).map((p) => [p.code, p]))
    for (const p of permissions) {
      const have = existing.get(p.code)
      if (!have) {
        await tx.permission.create({ data: { id: uuidv7(), ...p } })
        result.permissionsAdded.push(p.code)
      } else if (have.description !== p.description) {
        await tx.permission.update({
          where: { code: p.code },
          data: { description: p.description },
        })
      }
    }
    const wanted = new Set(permissions.map((p) => p.code))
    for (const code of existing.keys()) {
      if (!wanted.has(code)) {
        await tx.permission.delete({ where: { code } }) // role_permissions rows cascade
        result.permissionsRemoved.push(code)
      }
    }

    // roles and their permissions
    const ids = new Map((await tx.permission.findMany()).map((p) => [p.code, p.id]))
    for (const r of roles) {
      const have = await tx.role.findUnique({
        where: { code: r.code },
        include: { permissions: { include: { permission: true } } },
      })
      if (have && have.scope !== r.scope) {
        throw new Error(`Role ${r.code}: scope cannot change from ${have.scope} to ${r.scope}`)
      }
      const role = have
        ? await tx.role.update({
            where: { code: r.code },
            data: { name: r.name, description: r.description },
          })
        : await tx.role.create({
            data: {
              id: uuidv7(),
              code: r.code,
              name: r.name,
              description: r.description,
              scope: r.scope,
            },
          })

      const held = new Set(have?.permissions.map((rp) => rp.permission.code) ?? [])
      const target = new Set(r.permissions)
      for (const code of target) {
        if (held.has(code)) continue
        await tx.rolePermission.create({ data: { roleId: role.id, permissionId: ids.get(code)! } })
        result.granted.push(`${r.code} ${code}`)
      }
      for (const code of held) {
        if (target.has(code) || !ids.has(code)) continue // removed permissions already cascaded
        await tx.rolePermission.delete({
          where: { roleId_permissionId: { roleId: role.id, permissionId: ids.get(code)! } },
        })
        result.revoked.push(`${r.code} ${code}`)
      }
    }
  })
  return result
}

if (require.main === module) {
  const prisma = new PrismaClient()
  syncRbac(prisma)
    .then((r) => {
      console.log(
        `RBAC synced: +${r.permissionsAdded.length}/-${r.permissionsRemoved.length} permissions, ` +
          `${r.granted.length} granted, ${r.revoked.length} revoked`,
      )
      r.revoked.forEach((x) => console.log(`  revoked ${x}`))
    })
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
