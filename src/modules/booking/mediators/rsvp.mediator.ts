import { TooManyRequestsError, BadRequestError, NotFoundError } from '../../../utils/errors'
import { BookingRepository } from '../booking.repository'
import { inviteClosed, isInviteOpen, sha } from '../booking.invites'

/** A guest answers an invite. The booking row is locked so the headcount stays exact. */
export const rsvpMediator =
  (repo: BookingRepository) =>
  async (token: string, input: { name: string; phone?: string; status: 'GOING' | 'NOT_GOING' }) => {
    const inv = await repo.inviteByHash(sha(token))
    if (!inv) throw new NotFoundError('Invite not found', 'INVITE_NOT_FOUND')
    const name = input.name.trim()
    if (!name) throw new BadRequestError('Please enter your name', 'VALIDATION_ERROR')
    const key = input.phone ? input.phone.replace(/[^0-9+]/g, '') : name.toLowerCase()
    return repo.transaction(async (q) => {
      const b = await q.lockBooking(inv.bookingId)
      if (!b || !isInviteOpen(inv, b)) throw inviteClosed()
      const count = await q.rsvpCount(inv.id)
      const existing = await q.findRsvp(inv.id, key)
      if (!existing && count >= 200)
        throw new TooManyRequestsError('This invite is full', 'INVITE_FULL')
      await q.upsertRsvp(inv.id, key, { name, phone: input.phone ?? null, status: input.status })
      // headcount = the captain + everyone across this booking's invites who is going
      const going = await q.goingCount(b.id)
      const headcount = Math.min(100, 1 + going)
      await q.setHeadcount(b.id, headcount)
      return { status: input.status, going, headcount }
    })
  }
