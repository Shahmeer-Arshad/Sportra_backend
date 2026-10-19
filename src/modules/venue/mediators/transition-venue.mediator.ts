import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../../utils/errors'
import { VenueAction } from '../venue.domain'
import { venueEvent } from '../venue.events'
import { VenueRepository } from '../venue.repository'
import { venueJson } from '../venue.view'
import { reviewAction, submissionProblems, targetStatus } from '../venue.rules'
import { VenueService } from '../venue.service'

type Actor = { id: string; type: 'STAFF' | 'ADMIN'; ip?: string | null }
type Review = { decision: string; comments?: string; fieldFlags?: unknown[] }

/** Every verification state change: submit, open review, decide, suspend, reinstate. */
export const transitionVenueMediator = (repo: VenueRepository, svc: VenueService) => {
  const transition = (venueId: string, action: VenueAction, actor: Actor, review?: Review) =>
    repo.transaction(async (q) => {
      const from = await q.lockVerificationStatus(venueId)
      if (from === null) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      const to = targetStatus(from, action)
      const now = new Date()
      const v = await q.updateVenue(venueId, {
        verificationStatus: to,
        version: { increment: 1 },
        ...(action === 'submit' && { submittedAt: now }),
        ...(action === 'approve' && { verifiedAt: now, verifiedBy: actor.id }),
      })
      if (review) {
        await q.createReview({
          venueId,
          submissionNo: await q.nextSubmissionNo(venueId),
          reviewerId: actor.id,
          decision: review.decision,
          comments: review.comments ?? null,
          fieldFlags: (review.fieldFlags ?? []) as Prisma.InputJsonValue,
        })
      }
      await q.audit({
        actorId: actor.id,
        actorType: actor.type,
        venueId,
        action: `VENUE_${action.toUpperCase()}`,
        entity: 'venue',
        entityId: venueId,
        before: { status: from },
        after: { status: to, comments: review?.comments },
        ip: actor.ip,
      })
      await q.emit(venueEvent(v))
      if (to === 'VERIFIED') await q.emit(venueEvent(v, 'venue.verified'))
      if (to === 'SUSPENDED') await q.emit(venueEvent(v, 'venue.suspended'))
      return venueJson(v)
    })

  const admin = (id: string, ip?: string | null): Actor => ({ id, type: 'ADMIN', ip })

  return {
    async submit(venueId: string, actorId: string, ip?: string | null) {
      const v = await svc.requireVenue(venueId)
      const problems = submissionProblems(v, await repo.courtsWithRules(venueId, true))
      if (problems.length)
        throw new BadRequestError('The venue is not ready to submit', 'SUBMIT_PREREQUISITES', {
          problems,
        })
      return transition(venueId, 'submit', { id: actorId, type: 'STAFF', ip })
    },

    openReview: (venueId: string, adminId: string, ip?: string | null) =>
      transition(venueId, 'open_review', admin(adminId, ip)),

    review(venueId: string, adminId: string, input: Review, ip?: string | null) {
      const action = reviewAction(input.decision, input.comments)
      return transition(venueId, action, admin(adminId, ip), input)
    },

    suspend: (venueId: string, adminId: string, reason: string, ip?: string | null) =>
      transition(venueId, 'suspend', admin(adminId, ip), {
        decision: 'SUSPENDED',
        comments: reason,
      }),

    reinstate: (venueId: string, adminId: string, reason: string, ip?: string | null) =>
      transition(venueId, 'reinstate', admin(adminId, ip), {
        decision: 'REINSTATED',
        comments: reason,
      }),
  }
}
