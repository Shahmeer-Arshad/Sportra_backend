import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { diagnosticsChannel } from './rbac.helpers'
import { uuidv7 } from '../src/lib/id'
import { syncRbac } from '../prisma/seed-rbac'
import { API_MAP, PUBLIC } from '../src/modules/rbac/rbac.api-map'
import { buildCatalog, ROLE_CODES } from '../src/modules/rbac/rbac.catalog'
import { buildApp } from '../src/app'
import { FastifyInstance } from 'fastify'
import { call, cleanupTestData, lastCode, makeApp, PASSWORD, post, uniqueEmail } from './helpers'

const prisma = new PrismaClient()
const catalog = buildCatalog()
afterAll(() => prisma.$disconnect())

describe('seed-rbac makes the database match the two config files', () => {
  beforeAll(async () => {
    await syncRbac(prisma)
  })

  it('has exactly the 4 roles with the right scope', async () => {
    const roles = await prisma.role.findMany()
    expect(roles.map((r) => r.code).sort()).toEqual([...ROLE_CODES].sort())
    for (const r of roles) expect(r.scope).toBe(catalog.roles.find((c) => c.code === r.code)!.scope)
  })

  it('has exactly the catalogue permissions', async () => {
    const perms = await prisma.permission.findMany()
    expect(perms.map((p) => p.code).sort()).toEqual(catalog.permissions.map((p) => p.code).sort())
  })

  it('grants each role exactly what rbac.roles.ts lists', async () => {
    const roles = await prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
    })
    for (const r of roles) {
      const got = r.permissions.map((rp) => rp.permission.code).sort()
      expect(got).toEqual(catalog.roles.find((c) => c.code === r.code)!.permissions)
    }
  })

  it('is idempotent: a second run changes nothing', async () => {
    const r = await syncRbac(prisma)
    expect(r).toEqual({ permissionsAdded: [], permissionsRemoved: [], granted: [], revoked: [] })
  })

  it('picks up a changed role: revokes and grants, then restores', async () => {
    const owner = await prisma.role.findUniqueOrThrow({ where: { code: 'GROUND_OWNER' } })
    const code = 'pos.block_create'
    const p = await prisma.permission.findUniqueOrThrow({ where: { code } })
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: owner.id, permissionId: p.id } },
    })
    await prisma.rolePermission.create({
      data: {
        roleId: (await prisma.role.findUniqueOrThrow({ where: { code: 'USER' } })).id,
        permissionId: p.id,
      },
    })
    const r = await syncRbac(prisma)
    expect(r.granted).toContain(`GROUND_OWNER ${code}`)
    expect(r.revoked).toContain(`USER ${code}`)
  })
})

describe('every API route has a permission, and the other way round', () => {
  it('matches the routes registered in the app', async () => {
    const seen: string[] = []
    const stop = diagnosticsChannel((route) => seen.push(route))
    const app = await buildApp()
    await app.ready()
    stop()
    await app.close()

    const mapped = API_MAP.map(([m, path]) => `${m} ${path}`)
    const unique = new Set(mapped)
    expect(unique.size).toBe(mapped.length) // no duplicate rows
    const real = seen.filter((r) => !/\/docs|\/\*|^(HEAD|OPTIONS) /.test(r))
    expect(real.filter((r) => !unique.has(r)).sort()).toEqual([]) // route without a permission row
    expect([...unique].filter((r) => !real.includes(r)).sort()).toEqual([]) // row without a route
  })

  it('PUBLIC rows are the only rows without a permission', () => {
    for (const [, , perm] of API_MAP)
      expect(perm === PUBLIC || /^[a-z_]+\.[a-z_]+$/.test(perm)).toBe(true)
  })
})

describe('user_roles constraints', () => {
  const userId = uuidv7()
  const venueId = uuidv7()
  const role = (code: string) => prisma.role.findUniqueOrThrow({ where: { code } })
  let venueRoleId = ''

  beforeAll(async () => {
    await syncRbac(prisma)
    await prisma.user.create({
      data: {
        id: userId,
        email: `rbac-${userId}@t.sportra.test`,
        fullName: 'Rbac Test',
        status: 'ACTIVE',
      },
    })
    // none of the 4 system roles is venue-scoped any more, so use a throw-away one
    venueRoleId = uuidv7()
    await prisma.role.create({
      data: {
        id: venueRoleId,
        code: 'TEST_VENUE_ROLE',
        name: 'T',
        description: 'T',
        scope: 'VENUE',
        isSystem: false,
      },
    })
  })
  afterAll(async () => {
    await prisma.userRole.deleteMany({ where: { userId } })
    await prisma.user.delete({ where: { id: userId } })
    await prisma.role.delete({ where: { id: venueRoleId } })
  })

  it('rejects a platform role that names a venue and a venue role that names none', async () => {
    const user = await role('USER')
    await expect(
      prisma.userRole.create({
        data: { id: uuidv7(), userId, roleId: user.id, scope: 'PLATFORM', venueId },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.userRole.create({
        data: { id: uuidv7(), userId, roleId: venueRoleId, scope: 'VENUE' },
      }),
    ).rejects.toThrow()
  })

  it('rejects a scope that disagrees with the role', async () => {
    const user = await role('USER')
    await expect(
      prisma.userRole.create({
        data: { id: uuidv7(), userId, roleId: user.id, scope: 'VENUE', venueId },
      }),
    ).rejects.toThrow()
  })

  it('allows one platform role once, and one venue role once per venue', async () => {
    const user = await role('USER')
    const make = (roleId: string, scope: string, v?: string) =>
      prisma.userRole.create({ data: { id: uuidv7(), userId, roleId, scope, venueId: v } })
    await make(user.id, 'PLATFORM')
    await expect(make(user.id, 'PLATFORM')).rejects.toThrow()
    await make(venueRoleId, 'VENUE', venueId)
    await expect(make(venueRoleId, 'VENUE', venueId)).rejects.toThrow()
    await make(venueRoleId, 'VENUE', uuidv7())
  })
})

describe('only a ground owner can create a venue', () => {
  let app: FastifyInstance
  const body = {
    name: 'Role Test Arena',
    city: 'Testville',
    address: '12 Test Road, Testville',
    lat: 24.86,
    lng: 67.0,
    operatingHours: { mon: [{ open: '09:00', close: '11:00' }] },
  }
  const register = async (signupIntent?: string) => {
    const email = uniqueEmail('role')
    const r = await post(app, '/api/v1/public/auth/register', {
      email,
      password: PASSWORD,
      fullName: 'Role Test',
      ...(signupIntent && { signupIntent }),
    })
    expect(r.statusCode).toBe(202)
    const v = await post(app, '/api/v1/public/auth/verify-email', { email, code: lastCode(email) })
    return { token: v.json().accessToken as string, userId: v.json().data.user.id as string }
  }

  beforeAll(async () => {
    await syncRbac(prisma)
    app = await makeApp()
  })
  afterAll(async () => {
    await cleanupTestData(prisma)
    await app.close()
  })

  it('a plain user gets the USER role only and cannot create a venue', async () => {
    const u = await register()
    const roles = await prisma.userRole.findMany({
      where: { userId: u.userId },
      include: { role: true },
    })
    expect(roles.map((r) => r.role.code)).toEqual(['USER'])
    const r = await call(app, 'POST', '/api/v1/venues', u.token, body)
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('PERMISSION_DENIED')
  })

  it('signing up with signupIntent GROUND_OWNER gives the role and allows creating a venue', async () => {
    const u = await register('GROUND_OWNER')
    const roles = await prisma.userRole.findMany({
      where: { userId: u.userId },
      include: { role: true },
    })
    expect(roles.map((r) => r.role.code).sort()).toEqual(['GROUND_OWNER', 'USER'])
    const r = await call(app, 'POST', '/api/v1/venues', u.token, body)
    expect(r.statusCode).toBe(201)
  })

  it('rejects an unknown signupIntent', async () => {
    const r = await post(app, '/api/v1/public/auth/register', {
      email: uniqueEmail('role'),
      password: PASSWORD,
      fullName: 'Role Test',
      signupIntent: 'ADMIN',
    })
    expect(r.statusCode).toBe(400)
  })
})
