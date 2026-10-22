import { API_MAP, PLANNED_PERMISSIONS, PUBLIC } from './rbac.api-map'
import { RoleDef, ROLES } from './rbac.roles'

/**
 * Turns the two hand-edited files (`rbac.api-map.ts`, `rbac.roles.ts`) into the exact rows the
 * database should hold. Pure: no I/O. The seed (`prisma/seed-rbac.ts`) writes the result.
 */
export type RoleCode = keyof typeof ROLES
export const ROLE_CODES = Object.keys(ROLES) as RoleCode[]

export interface PermissionRow {
  code: string
  resource: string
  action: string
  description: string
}

const CODE = /^[a-z_]+(\.[a-z_]+)+$/

function row(code: string, description: string): PermissionRow {
  if (!CODE.test(code)) throw new Error(`Bad permission code "${code}" (use resource.action)`)
  const dot = code.indexOf('.')
  return { code, resource: code.slice(0, dot), action: code.slice(dot + 1), description }
}

/** Every permission, from the API map first and the planned list after (first description wins). */
export function buildPermissions(): PermissionRow[] {
  const byCode = new Map<string, PermissionRow>()
  for (const [, , permission, description] of API_MAP) {
    if (permission !== PUBLIC && !byCode.has(permission))
      byCode.set(permission, row(permission, description))
  }
  for (const [code, description] of PLANNED_PERMISSIONS) {
    if (byCode.has(code)) throw new Error(`Planned permission "${code}" already has an endpoint`)
    byCode.set(code, row(code, description))
  }
  return [...byCode.values()]
}

/** Expands 'pos.*' and checks that every entry matches something real. */
export function resolvePermissions(role: string, def: RoleDef, all: PermissionRow[]): string[] {
  const out = new Set<string>()
  for (const entry of def.permissions) {
    const matches = entry.endsWith('.*')
      ? all.filter((p) => p.resource === entry.slice(0, -2)).map((p) => p.code)
      : all.filter((p) => p.code === entry).map((p) => p.code)
    if (matches.length === 0) throw new Error(`Role ${role}: "${entry}" matches no permission`)
    matches.forEach((c) => out.add(c))
  }
  return [...out].sort()
}

export function buildCatalog() {
  const permissions = buildPermissions()
  const roles = ROLE_CODES.map((code) => ({
    code,
    name: ROLES[code].name,
    description: ROLES[code].description,
    scope: ROLES[code].scope as 'PLATFORM' | 'VENUE',
    permissions: resolvePermissions(code, ROLES[code], permissions),
  }))
  return { permissions, roles }
}
