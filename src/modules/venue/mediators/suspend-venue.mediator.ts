import { AppError, BadRequestError, ConflictError } from '../../../utils/errors'
import { SuspensionMode } from '../venue.domain'
import { VenueRepository } from '../venue.repository'
import { venueJson } from '../venue.view'
import { VenueService } from '../venue.service'
import { TransitionMediator } from './transition-venue.mediator'

/** What STOP_ALL needs from the booking module. The controller adapts `app.booking` to this. */
export interface StopAllPort {
  preview(
    venueId: string,
    courtIds: string[],
    from: Date,
    to: Date,
  ): Promise<{
    appBookings: number
    players: number
    manualToCall: number
    freeHoursToBlock: number
  }>
  start(
    venueId: string,
    adminId: string,
    courtIds: string[],
    from: Date,
    to: Date,
    key: string,
    note: string,
  ): Promise<{ id: string }>
  release(venueId: string, adminId: string, lockId: string): Promise<void>
}

const DAY = 86_400_000

/**
 * Two kinds of suspend. PAUSE_ONLINE only hides the venue from players. STOP_ALL also cancels and
 * refunds every future app booking through an outage lock (resumable, idempotent) and locks the
 * point of sale. The admin first sees a preview and must type back the number of bookings.
 */
export const suspendVenueMediator = (
  repo: VenueRepository,
  svc: VenueService,
  transitions: TransitionMediator,
  port: StopAllPort,
  horizonDays: number,
) => {
  const courtIdsOf = async (venueId: string) => (await repo.courtsOf(venueId)).map((c) => c.id)
  const windowFrom = (from: Date) => ({ from, to: new Date(from.getTime() + horizonDays * DAY) })

  async function preview(venueId: string) {
    const v = await svc.requireVenue(venueId)
    if (v.verificationStatus !== 'VERIFIED') {
      throw new ConflictError('Only a verified venue can be suspended', 'VENUE_NOT_VERIFIED')
    }
    const { from, to } = windowFrom(new Date())
    const p = await port.preview(venueId, await courtIdsOf(venueId), from, to)
    return {
      mode: 'STOP_ALL' as const,
      futureBookings: p.appBookings,
      players: p.players,
      walkInsToCall: p.manualToCall,
      freeHoursToBlock: p.freeHoursToBlock,
      confirmCount: p.appBookings,
      message: `${p.appBookings} booking(s) of ${p.players} player(s) will be cancelled with a full refund. ${p.manualToCall} walk-in/manual booking(s) need a phone call. Send "confirmCount": ${p.appBookings} to continue.`,
    }
  }

  async function startRefunds(venueId: string, adminId: string, reason: string) {
    const v = await svc.requireVenue(venueId)
    const at = v.suspendedAt ?? new Date()
    const { from, to } = windowFrom(at)
    try {
      const lock = await port.start(
        venueId,
        adminId,
        await courtIdsOf(venueId),
        from,
        to,
        `suspend-${venueId}-${at.getTime()}`,
        `Venue suspended: ${reason}`.slice(0, 200),
      )
      const updated = await repo.updateVenue(venueId, { suspensionLockId: lock.id })
      return { ...venueJson(updated), stopAll: { lockId: lock.id } }
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError(
        'The venue is suspended but cancelling its bookings failed. Call suspend again to retry.',
        502,
        true,
        'STOP_ALL_INCOMPLETE',
      )
    }
  }

  return {
    preview,

    async suspend(
      venueId: string,
      adminId: string,
      input: { reason: string; mode?: SuspensionMode; confirmCount?: number },
      ip?: string | null,
    ) {
      const mode = input.mode ?? 'PAUSE_ONLINE'
      if (mode === 'PAUSE_ONLINE') {
        return venueJson(
          await transitions.suspend(venueId, adminId, { reason: input.reason, mode }, ip),
        )
      }
      const v = await svc.requireVenue(venueId)
      // retry: already stopped, but the refund job never started
      if (
        v.verificationStatus === 'SUSPENDED' &&
        v.suspensionMode === 'STOP_ALL' &&
        !v.suspensionLockId
      ) {
        return startRefunds(venueId, adminId, input.reason)
      }
      const current = await preview(venueId)
      if (input.confirmCount === undefined) {
        throw new BadRequestError(
          'Stopping a venue needs confirmCount (see the preview)',
          'CONFIRM_COUNT_REQUIRED',
          { futureBookings: current.futureBookings },
        )
      }
      if (input.confirmCount !== current.futureBookings) {
        throw new ConflictError(
          'The number of bookings changed, check the preview again',
          'PREVIEW_STALE',
          {
            futureBookings: current.futureBookings,
          },
        )
      }
      await transitions.suspend(venueId, adminId, { reason: input.reason, mode }, ip)
      return startRefunds(venueId, adminId, input.reason)
    },

    /** Releases the stop-all lock (slots reopen) and then brings the venue back. */
    async reinstate(venueId: string, adminId: string, reason: string, ip?: string | null) {
      const v = await svc.requireVenue(venueId)
      if (v.verificationStatus === 'SUSPENDED' && v.suspensionLockId) {
        await port.release(venueId, adminId, v.suspensionLockId)
      }
      return transitions.reinstate(venueId, adminId, reason, ip)
    },
  }
}
