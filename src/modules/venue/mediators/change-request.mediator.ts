import { AppError, ConflictError, NotFoundError } from '../../../utils/errors'
import { ChangeOp, MAX_PENDING_CHANGES, needsReview, summarizeChange } from '../venue.change'
import { venueMails } from '../venue.mail'
import { VenueNotifier } from '../venue.notifier'
import { VenueQueries, VenueRepository } from '../venue.repository'
import { assertVenueEdit } from '../venue.rules'
import { VenueService } from '../venue.service'
import { changeJson } from '../venue.view'
import { courtMediator } from './court.mediator'
import { pricingRuleMediator } from './pricing-rule.mediator'
import { updateVenueMediator } from './update-venue.mediator'

type Row = NonNullable<Awaited<ReturnType<VenueQueries['changeById']>>>
type Params = Record<string, any>

class DryRun extends Error {}

/**
 * Edits to a VERIFIED venue that change what players pay or can book wait here for an admin.
 * `gate` stores the request after running the real edit in a transaction that is rolled back (so
 * the validation is exactly the real one). `approve` runs the stored edit for real, inside the
 * approval's transaction, so it is applied exactly once or not at all.
 */
export const changeRequestMediator = (
  repo: VenueRepository,
  svc: VenueService,
  courts: ReturnType<typeof courtMediator>,
  rules: ReturnType<typeof pricingRuleMediator>,
  updateVenue: ReturnType<typeof updateVenueMediator>,
  notify: VenueNotifier,
) => {
  const apply = (
    op: ChangeOp,
    q: VenueQueries,
    venueId: string,
    actor: string,
    p: Params,
    body: any,
  ) => {
    switch (op) {
      case 'court.add':
        return courts.add(venueId, actor, body, q)
      case 'court.update':
        return courts.update(venueId, p.courtId, actor, body, q)
      case 'rule.add':
        return rules.add(venueId, actor, body, q)
      case 'rule.delete':
        return rules.remove(venueId, p.ruleId, actor, q)
      case 'venue.update_hours':
        return updateVenue(venueId, 'OWNER', actor, { operatingHours: body.operatingHours }, q)
    }
  }

  async function describe(venueId: string, op: ChangeOp, params: Params, body: any) {
    const out: Params = { ...params }
    const courtId = op === 'rule.add' ? body.courtId : params.courtId
    if (courtId) out.courtName = (await repo.courtOfVenue(venueId, courtId))?.name
    if (op === 'rule.delete') {
      const r = await repo.ruleOfVenue(venueId, params.ruleId)
      if (r) {
        out.ruleName = r.name
        out.courtName = (await repo.courtOfVenue(venueId, r.courtId))?.name
      }
    }
    return out
  }

  const mustBePending = async (q: VenueQueries, id: string) => {
    const row = await q.lockPendingChange(id)
    if (!row) throw new ConflictError('This change was already decided', 'CHANGE_NOT_PENDING')
    return row
  }

  return {
    /**
     * null = the edit does not need review, carry on as normal. Otherwise the edit is validated,
     * stored as a pending request and returned.
     */
    async gate(
      op: ChangeOp,
      venueId: string,
      role: string,
      actorId: string,
      params: Params,
      body: any,
    ) {
      const v = await svc.requireVenue(venueId)
      const court = op === 'court.update' ? await repo.courtOfVenue(venueId, params.courtId) : null
      if (!needsReview(v, op, body, court)) return null
      if (op === 'venue.update_hours')
        assertVenueEdit(v, role, { operatingHours: body.operatingHours })
      if ((await repo.pendingChangeCount(venueId)) >= MAX_PENDING_CHANGES) {
        throw new ConflictError(
          'Too many changes are waiting for review',
          'TOO_MANY_PENDING_CHANGES',
        )
      }
      // same checks as the real edit, then undo everything it wrote
      await repo
        .transaction(async (q) => {
          await apply(op, q, venueId, actorId, params, body)
          throw new DryRun()
        })
        .catch((e) => {
          if (!(e instanceof DryRun)) throw e
        })
      const described = await describe(venueId, op, params, body)
      const row = await repo.transaction(async (q) => {
        const r = await q.createChange({
          venueId,
          op,
          params: described,
          payload: body,
          summary: summarizeChange(op, described, body),
          requestedBy: actorId,
        })
        await q.audit({
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'VENUE_CHANGE_REQUESTED',
          entity: 'venue_change',
          entityId: r.id,
          after: { op, summary: r.summary },
        })
        return r
      })
      return changeJson(row)
    },

    async approve(id: string, adminId: string, note?: string, ip?: string | null) {
      const existing = await repo.changeById(id)
      if (!existing) throw new NotFoundError('Change request not found', 'CHANGE_NOT_FOUND')
      let out: { done: Row; applied: unknown }
      try {
        out = await repo.transaction(async (q) => {
          const row = await mustBePending(q, id)
          const applied = await apply(
            row.op as ChangeOp,
            q,
            row.venueId,
            row.requestedBy,
            row.params as Params,
            row.payload,
          )
          const d = await q.updateChange(id, {
            status: 'APPROVED',
            decidedBy: adminId,
            decidedAt: new Date(),
            decisionNote: note ?? null,
          })
          await q.audit({
            actorId: adminId,
            actorType: 'ADMIN',
            venueId: row.venueId,
            action: 'VENUE_CHANGE_APPROVED',
            entity: 'venue_change',
            entityId: id,
            after: { op: row.op, summary: row.summary },
            ip,
          })
          return { done: d, applied }
        })
      } catch (e) {
        // the data moved on since the request (for example a price band now overlaps)
        if (e instanceof AppError && e.code !== 'CHANGE_NOT_PENDING') {
          await repo.failChange(id, adminId, e.message)
        }
        throw e
      }
      const { done, applied } = out
      const v = await svc.requireVenue(done.venueId)
      await notify.toOwner(v, venueMails.changeDecided(v.name, done.summary, true, note))
      return changeJson(done, { applied })
    },

    async reject(id: string, adminId: string, note: string, ip?: string | null) {
      if (!(await repo.changeById(id)))
        throw new NotFoundError('Change request not found', 'CHANGE_NOT_FOUND')
      const done = await repo.transaction(async (q) => {
        const row = await mustBePending(q, id)
        const d = await q.updateChange(id, {
          status: 'REJECTED',
          decidedBy: adminId,
          decidedAt: new Date(),
          decisionNote: note,
        })
        await q.audit({
          actorId: adminId,
          actorType: 'ADMIN',
          venueId: row.venueId,
          action: 'VENUE_CHANGE_REJECTED',
          entity: 'venue_change',
          entityId: id,
          after: { op: row.op, note },
          ip,
        })
        return d
      })
      const v = await svc.requireVenue(done.venueId)
      await notify.toOwner(v, venueMails.changeDecided(v.name, done.summary, false, note))
      return changeJson(done)
    },

    async withdraw(venueId: string, id: string, actorId: string) {
      const existing = await repo.changeById(id)
      if (!existing || existing.venueId !== venueId)
        throw new NotFoundError('Change request not found', 'CHANGE_NOT_FOUND')
      const done = await repo.transaction(async (q) => {
        await mustBePending(q, id)
        const d = await q.updateChange(id, {
          status: 'WITHDRAWN',
          decidedBy: actorId,
          decidedAt: new Date(),
        })
        await q.audit({
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'VENUE_CHANGE_WITHDRAWN',
          entity: 'venue_change',
          entityId: id,
        })
        return d
      })
      return changeJson(done)
    },
  }
}
