import { NotFoundError, ConflictError } from '../../../utils/errors'
import { findPriceOverlap } from '../venue.domain'
import { pricingEvent } from '../venue.events'
import { inTx, VenueQueries, VenueRepository } from '../venue.repository'
import { ruleJson, toRule } from '../venue.view'
import { assertEditable, assertRuleShape } from '../venue.rules'
import { createVenueService, VenueService } from '../venue.service'

/** Pricing rule add and delete: overlap rules first, then rule, audit and event commit together. */
export const pricingRuleMediator = (repo: VenueRepository, svc: VenueService) => ({
  async add(venueId: string, actorId: string, input: any, tx?: VenueQueries) {
    const s = tx ? createVenueService(tx) : svc
    assertEditable(await s.requireVenue(venueId))
    await s.requireCourt(venueId, input.courtId)
    assertRuleShape(input)
    const existing = (await (tx ?? repo).rulesOfCourt(input.courtId)).map(toRule)
    const overlap = findPriceOverlap(existing, {
      ...input,
      priceMinor: BigInt(input.priceMinor),
      priority: input.priority ?? 0,
    })
    if (overlap) throw new ConflictError(overlap, 'PRICING_OVERLAP')
    return inTx(repo, tx, async (q) => {
      const r = await q.createRule({
        courtId: input.courtId,
        name: input.name,
        dayType: input.dayType,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        fromTime: input.fromTime,
        toTime: input.toTime,
        priceMinor: BigInt(input.priceMinor),
        priority: input.priority ?? 0,
        tag: input.tag,
      })
      await q.audit({
        actorId,
        actorType: 'STAFF',
        venueId,
        action: 'PRICING_RULE_CREATED',
        entity: 'pricing_rule',
        entityId: r.id,
        after: input,
      })
      await q.emit(pricingEvent(input.courtId, venueId, await q.rulesOfCourt(input.courtId)))
      return ruleJson(r)
    })
  },

  async remove(venueId: string, ruleId: string, actorId: string, tx?: VenueQueries) {
    const s = tx ? createVenueService(tx) : svc
    assertEditable(await s.requireVenue(venueId))
    const r = await (tx ?? repo).ruleOfVenue(venueId, ruleId)
    if (!r) throw new NotFoundError('Pricing rule not found', 'PRICING_RULE_NOT_FOUND')
    await inTx(repo, tx, async (q) => {
      await q.deleteRule(ruleId)
      await q.audit({
        actorId,
        actorType: 'STAFF',
        venueId,
        action: 'PRICING_RULE_DELETED',
        entity: 'pricing_rule',
        entityId: ruleId,
        before: ruleJson(r),
      })
      await q.emit(pricingEvent(r.courtId, venueId, await q.rulesOfCourt(r.courtId)))
    })
  },
})
