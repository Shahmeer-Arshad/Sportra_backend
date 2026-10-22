import { User } from '@prisma/client'
import bcrypt from 'bcrypt'
import { env } from '../../../config/env'
import { sha256 } from '../../../lib/crypto'
import { BadRequestError, UnauthorizedError } from '../../../utils/errors'
import { IdentityDeps } from '../identity.deps'
import { PublicUser, toPublicUser } from '../identity.domain'
import { membershipEvent, userEvent } from '../identity.events'

/** Invitee redeems a single-use token: creates the account if needed, then the membership. */
export const acceptInvitationMediator =
  ({ repo }: IdentityDeps) =>
  async (
    input: { token: string; fullName?: string; password?: string },
    authedUserId: string | null,
  ): Promise<{ user: PublicUser }> => {
    const bad = () => new BadRequestError('Invalid or expired invitation', 'INVITATION_INVALID')
    const inv = await repo.invitationByHash(sha256(input.token))
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw bad()

    let user: User | null = await repo.userByEmail(inv.email)
    const newAccount = !user
    if (user) {
      if (authedUserId !== user.id) {
        throw new UnauthorizedError('Log in with the invited email first', 'LOGIN_REQUIRED')
      }
    } else if (!input.password || !input.fullName) {
      throw new BadRequestError('Full name and password are required', 'VALIDATION_ERROR')
    }
    const passwordHash = newAccount ? await bcrypt.hash(input.password!, env.BCRYPT_COST) : null

    const result = await repo.transaction(async (q) => {
      // Single use: only one concurrent accept can flip this
      if (!(await q.claimInvitation(inv.id))) throw bad()
      if (newAccount) {
        // Holding the token proves the invitee controls the email address
        user = await q.createUser({
          email: inv.email,
          passwordHash,
          fullName: input.fullName!.trim(),
          emailVerifiedAt: new Date(),
          status: 'ACTIVE',
          signupIntent: 'STAFF',
        })
        await q.grantRole(user.id, 'USER')
        await q.emit(userEvent(user))
      }
      await q.upsertMembership(user!.id, inv.venueId, inv.role, inv.invitedBy)
      await q.emit(membershipEvent(user!.id, inv.venueId, inv.role, true))
      return user!
    })
    return { user: toPublicUser(result) }
  }
