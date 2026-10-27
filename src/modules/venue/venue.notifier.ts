import { Venue } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { Mailer } from '../../lib/mailer'
import { VenueQueries } from './venue.repository'
import { Mail } from './venue.mail'

/**
 * Sends a decision email to the venue owner (and the venue's contact email when it differs).
 * Always called AFTER the database change committed. A failed email is logged and never fails the
 * request: the notification service of Phase 4 will add retries and WhatsApp.
 */
export function createVenueNotifier(
  repo: Pick<VenueQueries, 'ownerContact'>,
  mailer?: Mailer,
  log?: Pick<FastifyBaseLogger, 'warn'>,
) {
  return {
    async toOwner(v: Pick<Venue, 'id' | 'ownerUserId' | 'contactEmail'>, mail: Mail) {
      if (!mailer) return
      try {
        const owner = await repo.ownerContact(v.ownerUserId)
        const to = new Set([owner?.email, v.contactEmail].filter((x): x is string => !!x))
        for (const address of to) await mailer.send({ to: address, ...mail })
      } catch (err) {
        log?.warn({ err, venueId: v.id }, 'Could not send the venue decision email')
      }
    },
  }
}
export type VenueNotifier = ReturnType<typeof createVenueNotifier>
