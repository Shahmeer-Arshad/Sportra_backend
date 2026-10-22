import { RbacRepository } from './rbac.repository'

export const createRbacService = (repo: RbacRepository) => ({
  /** Does the user hold `code` through any active role (platform-wide, or at `venueId`)? */
  async hasPermission(userId: string, code: string, venueId?: string): Promise<boolean> {
    return (await repo.permissionCodesOfUser(userId, venueId)).includes(code)
  },
})
export type RbacService = ReturnType<typeof createRbacService>
