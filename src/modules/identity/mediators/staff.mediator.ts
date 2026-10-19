import { randomToken, sha256 } from '../../../lib/crypto'
import { ForbiddenError, NotFoundError } from '../../../utils/errors'
import { IdentityDeps } from '../identity.deps'
import { normalizeEmail } from '../identity.domain'
import { membershipEvent } from '../identity.events'

/** Staff invitations and removals for one venue. */
export const staffMediator = ({ repo, mailer, log }: IdentityDeps) => ({
  async invite(
    venueId: string,
    invitedBy: string,
    input: { email: string; role: 'MANAGER' | 'FRONT_DESK' | 'SCORER' },
  ) {
    const email = normalizeEmail(input.email)
    const token = randomToken(32)
    await repo.transaction(async (q) => {
      // Re-sending revokes the previous open invitation
      await q.revokeOpenInvitations(venueId, email)
      await q.createInvitation({
        venueId,
        email,
        role: input.role,
        tokenHash: sha256(token),
        invitedBy,
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      })
    })
    try {
      await mailer.send({
        to: email,
        subject: 'You were invited to a Sportra venue',
        text: `You have been invited as ${input.role}. Your invitation token is: ${token}\nIt expires in 7 days.`,
      })
    } catch (err) {
      log.error({ err }, 'Failed to send invitation email')
    }
    return { message: 'Invitation sent' }
  },

  async deactivate(venueId: string, membershipId: string, actorId: string) {
    const m = await repo.membershipOfVenue(venueId, membershipId)
    if (!m) throw new NotFoundError('Staff member not found', 'MEMBERSHIP_NOT_FOUND')
    if (m.role === 'OWNER')
      throw new ForbiddenError('The owner cannot be removed', 'CANNOT_REMOVE_OWNER')
    await repo.transaction(async (q) => {
      await q.deactivateMembership(m.id)
      await q.emit(membershipEvent(m.userId, venueId, m.role, false))
      await q.audit({
        actorId,
        actorType: 'STAFF',
        venueId,
        action: 'STAFF_DEACTIVATED',
        entity: 'membership',
        entityId: m.id,
      })
    })
  },
})
