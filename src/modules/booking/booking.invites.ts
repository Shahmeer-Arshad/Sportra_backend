import { createHash } from 'crypto'
import { AppError } from '../../utils/errors'

export const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** 410: the invite existed but is no longer open (revoked, expired, or the booking was cancelled). */
export const inviteClosed = () =>
  new AppError('This invite is no longer open', 410, true, 'INVITE_CLOSED')

/** An invite works while it is not revoked or expired and the booking is still confirmed. */
export const isInviteOpen = (
  inv: { revokedAt: Date | null; expiresAt: Date },
  booking: { status: string },
) =>
  !inv.revokedAt &&
  inv.expiresAt.getTime() > Date.now() &&
  ['CONFIRMED', 'CHECKED_IN'].includes(booking.status)
