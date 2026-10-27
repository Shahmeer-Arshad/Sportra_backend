import { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError } from '../../../utils/errors'
import { SuspensionMode, VenueAction } from '../venue.domain'
import { venueEvent } from '../venue.events'
import { venueMails } from '../venue.mail'
import { VenueNotifier } from '../venue.notifier'
import { VenueRepository } from '../venue.repository'
import { venueJson } from '../venue.view'
import { reviewAction, submissionProblems, targetStatus } from '../venue.rules'
import { buildSnapshot } from '../venue.snapshot'
import { VenueService } from '../venue.service'

type Actor = { id: string; type: 'STAFF' | 'ADMIN'; ip?: string | null }
type Review = { decision: string; comments?: string; fieldFlags?: unknown[] }
type State = NonNullable<Awaited<ReturnType<VenueRepository['lockVenueState']>>>
type Options = {
  review?: Review
  /** Extra checks on the locked row (who holds the review, ...). */
  guard?: (s: State) => void
  /** Extra columns to write with the status change. */
  data?: (now: Date) => Prisma.VenueUncheckedUpdateInput
}

const CLEAR_CLAIM = { reviewClaimedBy: null, reviewClaimedAt: null }

/** Every verification state change: submit, open review, decide, suspend, reinstate. */
export const transitionVenueMediator = (
  repo: VenueRepository,
  svc: VenueService,
  notify: VenueNotifier,
) => {
  const transition = (venueId: string, action: VenueAction, actor: Actor, opts: Options = {}) =>
    repo.transaction(async (q) => {
      const state = await q.lockVenueState(venueId)
      if (state === null) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      if (action === 'open_review' && state.status === 'UNDER_REVIEW' && state.claimedBy) {
        throw new ConflictError('Another admin is already reviewing this venue', 'REVIEW_CLAIMED')
      }
      const to = targetStatus(state.status, action)
      opts.guard?.(state)
      const now = new Date()
      const v = await q.updateVenue(venueId, {
        verificationStatus: to,
        version: { increment: 1 },
        ...(action === 'submit' && { submittedAt: now }),
        ...(action === 'approve' && { verifiedAt: now, verifiedBy: actor.id }),
        ...opts.data?.(now),
      })
      if (action === 'submit') {
        const courts = await q.courtsWithRules(venueId, true)
        await q.createSubmission(
          venueId,
          buildSnapshot(v, courts) as unknown as Prisma.InputJsonValue,
        )
      }
      if (opts.review) {
        await q.createReview({
          venueId,
          submissionNo: await q.nextSubmissionNo(venueId),
          reviewerId: actor.id,
          decision: opts.review.decision,
          comments: opts.review.comments ?? null,
          fieldFlags: (opts.review.fieldFlags ?? []) as Prisma.InputJsonValue,
        })
      }
      await q.audit({
        actorId: actor.id,
        actorType: actor.type,
        venueId,
        action: `VENUE_${action.toUpperCase()}`,
        entity: 'venue',
        entityId: venueId,
        before: { status: state.status },
        after: { status: to, comments: opts.review?.comments },
        ip: actor.ip,
      })
      await q.emit(venueEvent(v))
      if (to === 'VERIFIED') await q.emit(venueEvent(v, 'venue.verified'))
      if (to === 'SUSPENDED') await q.emit(venueEvent(v, 'venue.suspended'))
      return v
    })

  const admin = (id: string, ip?: string | null): Actor => ({ id, type: 'ADMIN', ip })
  /** Only the admin who opened the review may decide or release it. */
  const mustHold = (adminId: string) => (s: State) => {
    if (s.claimedBy && s.claimedBy !== adminId) {
      throw new ConflictError('This review is held by another admin', 'REVIEW_NOT_YOURS')
    }
  }

  return {
    async submit(venueId: string, actorId: string, ip?: string | null) {
      const v = await svc.requireVenue(venueId)
      const problems = submissionProblems(v, await repo.courtsWithRules(venueId, true))
      if (problems.length)
        throw new BadRequestError('The venue is not ready to submit', 'SUBMIT_PREREQUISITES', {
          problems,
        })
      const sent = await transition(
        venueId,
        'submit',
        { id: actorId, type: 'STAFF', ip },
        {
          data: () => CLEAR_CLAIM,
        },
      )
      await notify.toOwner(sent, venueMails.submitted(sent.name))
      return venueJson(sent)
    },

    async openReview(venueId: string, adminId: string, ip?: string | null) {
      const v = await transition(venueId, 'open_review', admin(adminId, ip), {
        data: (now) => ({ reviewClaimedBy: adminId, reviewClaimedAt: now }),
      })
      return venueJson(v)
    },

    async releaseReview(venueId: string, adminId: string, ip?: string | null) {
      const v = await transition(venueId, 'release_review', admin(adminId, ip), {
        guard: mustHold(adminId),
        data: () => CLEAR_CLAIM,
      })
      return venueJson(v)
    },

    async review(venueId: string, adminId: string, input: Review, ip?: string | null) {
      const action = reviewAction(input.decision, input.comments)
      const v = await transition(venueId, action, admin(adminId, ip), {
        review: input,
        guard: mustHold(adminId),
        data: () => CLEAR_CLAIM,
      })
      await notify.toOwner(
        v,
        action === 'approve'
          ? venueMails.approved(v.name)
          : action === 'reject'
            ? venueMails.rejected(v.name, input.comments)
            : venueMails.changesRequested(v.name, input.comments),
      )
      return venueJson(v)
    },

    /** Plain suspend. For STOP_ALL the suspend mediator calls this and then starts the refunds. */
    async suspend(
      venueId: string,
      adminId: string,
      input: { reason: string; mode: SuspensionMode },
      ip?: string | null,
    ) {
      const v = await transition(venueId, 'suspend', admin(adminId, ip), {
        review: { decision: 'SUSPENDED', comments: input.reason },
        data: (now) => ({ suspensionMode: input.mode, suspendedAt: now }),
      })
      await notify.toOwner(v, venueMails.suspended(v.name, input.mode, input.reason))
      return v
    },

    async reinstate(venueId: string, adminId: string, reason: string, ip?: string | null) {
      const v = await transition(venueId, 'reinstate', admin(adminId, ip), {
        review: { decision: 'REINSTATED', comments: reason },
        data: () => ({ suspensionMode: null, suspendedAt: null, suspensionLockId: null }),
      })
      await notify.toOwner(v, venueMails.reinstated(v.name, reason))
      return venueJson(v)
    },
  }
}
export type TransitionMediator = ReturnType<typeof transitionVenueMediator>
