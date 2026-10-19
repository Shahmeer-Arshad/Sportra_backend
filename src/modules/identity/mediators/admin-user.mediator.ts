import { ForbiddenError, NotFoundError } from '../../../utils/errors'
import { IdentityDeps } from '../identity.deps'
import { userEvent } from '../identity.events'
import { credentialsMediator } from './credentials.mediator'

/** Admin actions on a user account. Each one is audited. */
export const adminUserMediator = (deps: IdentityDeps) => {
  const { repo } = deps
  const requireUser = async (userId: string) => {
    const u = await repo.userById(userId)
    if (!u) throw new NotFoundError('User not found', 'USER_NOT_FOUND')
    return u
  }

  return {
    async setStatus(
      adminId: string,
      userId: string,
      action: 'suspend' | 'unsuspend',
      reason: string | undefined,
      ip?: string | null,
    ) {
      const u = await requireUser(userId)
      if (u.id === adminId)
        throw new ForbiddenError('You cannot change your own status', 'SELF_ACTION')
      const next =
        action === 'suspend' ? 'SUSPENDED' : u.emailVerifiedAt ? 'ACTIVE' : 'PENDING_VERIFICATION'
      await repo.transaction(async (q) => {
        const upd = await q.updateUser(userId, {
          status: next,
          ...(action === 'suspend' && { tokenValidAfter: new Date() }),
        })
        if (action === 'suspend') await q.revokeAllTokens(userId)
        await q.emit(userEvent(upd))
        await q.audit({
          actorId: adminId,
          actorType: 'ADMIN',
          action: action === 'suspend' ? 'USER_SUSPENDED' : 'USER_UNSUSPENDED',
          entity: 'user',
          entityId: userId,
          before: { status: u.status },
          after: { status: next, reason },
          ip,
        })
      })
    },

    async forceLogout(adminId: string, userId: string, ip?: string | null) {
      await requireUser(userId)
      await credentialsMediator(deps).logoutEverywhere(userId)
      await repo.audit({
        actorId: adminId,
        actorType: 'ADMIN',
        action: 'USER_FORCE_LOGOUT',
        entity: 'user',
        entityId: userId,
        ip,
      })
    },
  }
}
