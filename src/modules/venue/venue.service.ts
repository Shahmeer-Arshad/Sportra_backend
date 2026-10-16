import { Prisma, PrismaClient, Venue, Court, PricingRule } from '@prisma/client'
import { audit } from '../../lib/audit'
import { uuidv7 } from '../../lib/id'
import { addOutbox } from '../../lib/outbox'
import { localParts } from '../../lib/time'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors'
import { addOwnerMembership } from '../identity/identity.membership'
import {
  findPriceOverlap,
  findPricingGap,
  nextStatus,
  OperatingHours,
  OWNER_EDITABLE,
  PriceRule,
  resolvePriceLocal,
  slotStarts,
  validateHours,
  VenueAction,
  weekdayKey,
} from './venue.domain'

const MATERIAL_FIELDS = [
  'lat',
  'lng',
  'address',
  'cancellationCutoffHours',
  'city',
  'areaId',
] as const
const MANAGER_EDITABLE = [
  'operatingHours',
  'amenities',
  'whatsappNumber',
  'contactPhone',
  'contactEmail',
]
const PRODUCER = 'venue'

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'venue'

export const toRule = (r: PricingRule): PriceRule => ({
  id: r.id,
  dayType: r.dayType as PriceRule['dayType'],
  startDate: r.startDate,
  endDate: r.endDate,
  fromTime: r.fromTime,
  toTime: r.toTime,
  priceMinor: r.priceMinor,
  priority: r.priority,
  tag: r.tag as PriceRule['tag'],
})

/** BigInt is not JSON-safe; paisa fits easily inside a JS number (max Rs 1,000,000 per slot). */
export const ruleJson = (r: PricingRule) => ({ ...r, priceMinor: Number(r.priceMinor) })

export function createVenueService(prisma: PrismaClient) {
  async function venueUpserted(tx: Prisma.TransactionClient, v: Venue, type = 'venue.upserted') {
    await addOutbox(tx, {
      type,
      routingKey: type,
      producer: PRODUCER,
      version: v.version,
      data: {
        venueId: v.id,
        version: v.version,
        name: v.name,
        city: v.city,
        areaId: v.areaId,
        timezone: v.timezone,
        cancellationCutoffHours: v.cancellationCutoffHours,
        commissionBps: v.commissionBps,
        status: v.verificationStatus,
        isActive: v.isActive,
      },
    })
  }
  async function courtUpserted(tx: Prisma.TransactionClient, c: Court) {
    await addOutbox(tx, {
      type: 'court.upserted',
      routingKey: 'court.upserted',
      producer: PRODUCER,
      version: c.version,
      data: {
        courtId: c.id,
        venueId: c.venueId,
        version: c.version,
        name: c.name,
        sport: c.sport,
        slotMinutes: c.slotMinutes,
        isActive: c.isActive,
        hoursOverride: c.hoursOverride,
      },
    })
  }
  async function pricingUpdated(tx: Prisma.TransactionClient, courtId: string, venueId: string) {
    const rules = await tx.pricingRule.findMany({ where: { courtId } })
    await addOutbox(tx, {
      type: 'pricing.updated',
      routingKey: 'pricing.updated',
      producer: PRODUCER,
      data: { courtId, venueId, rules: rules.map(ruleJson) },
    })
  }

  async function getVenueOr404(venueId: string) {
    const v = await prisma.venue.findUnique({ where: { id: venueId } })
    if (!v) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
    return v
  }
  async function ownedCourt(venueId: string, courtId: string) {
    const c = await prisma.court.findFirst({ where: { id: courtId, venueId } })
    if (!c) throw new NotFoundError('Court not found', 'COURT_NOT_FOUND')
    return c
  }
  function assertEditable(v: Venue) {
    if (!OWNER_EDITABLE.includes(v.verificationStatus)) {
      throw new ConflictError(
        v.verificationStatus === 'SUSPENDED' || v.verificationStatus === 'REJECTED'
          ? 'This venue cannot be edited'
          : 'The venue is being reviewed and cannot be edited now',
        'VENUE_LOCKED',
      )
    }
  }

  const venueJson = (v: Venue) => ({ ...v, location: undefined })

  async function transition(
    venueId: string,
    action: VenueAction,
    actor: { id: string; type: 'STAFF' | 'ADMIN'; ip?: string | null },
    review?: { decision: string; comments?: string; fieldFlags?: unknown[] },
  ) {
    return prisma.$transaction(async (tx) => {
      // Lock the row so two admins cannot decide at once
      const rows = await tx.$queryRaw<
        { verification_status: string }[]
      >`SELECT verification_status FROM venues WHERE id = ${venueId}::uuid FOR UPDATE`
      if (rows.length === 0) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      const from = rows[0].verification_status
      const to = nextStatus(from, action)
      if (!to)
        throw new ConflictError(
          `Cannot ${action.replace('_', ' ')} a venue that is ${from}`,
          'INVALID_VENUE_TRANSITION',
        )
      const now = new Date()
      const v = await tx.venue.update({
        where: { id: venueId },
        data: {
          verificationStatus: to,
          version: { increment: 1 },
          ...(action === 'submit' && { submittedAt: now }),
          ...(action === 'approve' && { verifiedAt: now, verifiedBy: actor.id }),
        },
      })
      if (review) {
        // A new submission always follows a "changes requested" decision
        const submissionNo =
          1 + (await tx.venueReview.count({ where: { venueId, decision: 'CHANGES_REQUESTED' } }))
        await tx.venueReview.create({
          data: {
            id: uuidv7(),
            venueId,
            submissionNo,
            reviewerId: actor.id,
            decision: review.decision,
            comments: review.comments ?? null,
            fieldFlags: (review.fieldFlags ?? []) as Prisma.InputJsonValue,
          },
        })
      }
      await audit(tx, {
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
      await venueUpserted(tx, v)
      if (to === 'VERIFIED') await venueUpserted(tx, v, 'venue.verified')
      if (to === 'SUSPENDED') await venueUpserted(tx, v, 'venue.suspended')
      return v
    })
  }

  return {
    // ───────────────────────── owner: onboarding ─────────────────────────
    async createVenue(userId: string, input: any) {
      const hoursErr = validateHours(input.operatingHours)
      if (hoursErr) throw new BadRequestError(hoursErr, 'INVALID_HOURS')
      if (input.areaId) await this.assertArea(input.areaId)
      const id = uuidv7()
      const v = await prisma.$transaction(async (tx) => {
        const v = await tx.venue.create({
          data: {
            id,
            ownerUserId: userId,
            name: input.name.trim(),
            slug: `${slugify(input.name)}-${id.slice(-6)}`,
            city: input.city.trim(),
            areaId: input.areaId ?? null,
            address: input.address.trim(),
            lat: input.lat,
            lng: input.lng,
            amenities: input.amenities ?? [],
            whatsappNumber: input.whatsappNumber ?? null,
            contactPhone: input.contactPhone ?? null,
            contactEmail: input.contactEmail?.toLowerCase() ?? null,
            operatingHours: input.operatingHours,
            cancellationCutoffHours: input.cancellationCutoffHours ?? 12,
          },
        })
        await addOwnerMembership(tx, userId, id)
        await audit(tx, {
          actorId: userId,
          actorType: 'STAFF',
          venueId: id,
          action: 'VENUE_CREATED',
          entity: 'venue',
          entityId: id,
        })
        await venueUpserted(tx, v, 'venue.created')
        return v
      })
      return venueJson(v)
    },

    async assertArea(areaId: string) {
      if (!(await prisma.area.findUnique({ where: { id: areaId } }))) {
        throw new BadRequestError('Unknown area', 'AREA_NOT_FOUND')
      }
    },

    async myVenues(userId: string) {
      const rows = await prisma.venueMembership.findMany({ where: { userId, isActive: true } })
      const venues = await prisma.venue.findMany({
        where: { id: { in: rows.map((r) => r.venueId) } },
        orderBy: { createdAt: 'desc' },
      })
      return venues.map((v) => ({
        ...venueJson(v),
        myRole: rows.find((r) => r.venueId === v.id)!.role,
      }))
    },

    async getForStaff(venueId: string) {
      const v = await getVenueOr404(venueId)
      const courts = await prisma.court.findMany({
        where: { venueId },
        orderBy: { createdAt: 'asc' },
        include: { pricingRules: true },
      })
      return {
        ...venueJson(v),
        courts: courts.map((c) => ({ ...c, pricingRules: c.pricingRules.map(ruleJson) })),
      }
    },

    async updateVenue(venueId: string, role: string, actorId: string, input: any) {
      const v = await getVenueOr404(venueId)
      assertEditable(v)
      const keys = Object.keys(input)
      if (role === 'MANAGER' && keys.some((k) => !MANAGER_EDITABLE.includes(k))) {
        throw new ForbiddenError(
          'Managers can only change hours, amenities and contacts',
          'OWNER_ONLY_FIELD',
        )
      }
      if (
        v.verificationStatus === 'VERIFIED' &&
        keys.some((k) => (MATERIAL_FIELDS as readonly string[]).includes(k))
      ) {
        throw new ConflictError(
          'Location, address, area and cancellation policy changes need admin review. Contact support.',
          'MATERIAL_EDIT_REQUIRES_REVIEW',
        )
      }
      if (input.operatingHours) {
        const e = validateHours(input.operatingHours)
        if (e) throw new BadRequestError(e, 'INVALID_HOURS')
      }
      if (input.areaId) await this.assertArea(input.areaId)
      const updated = await prisma.$transaction(async (tx) => {
        const n = await tx.venue.update({
          where: { id: venueId },
          data: {
            ...(input.name && { name: input.name.trim() }),
            ...(input.city && { city: input.city.trim() }),
            ...(input.areaId !== undefined && { areaId: input.areaId }),
            ...(input.address && { address: input.address.trim() }),
            ...(input.lat !== undefined && { lat: input.lat }),
            ...(input.lng !== undefined && { lng: input.lng }),
            ...(input.amenities && { amenities: input.amenities }),
            ...(input.whatsappNumber && { whatsappNumber: input.whatsappNumber }),
            ...(input.contactPhone && { contactPhone: input.contactPhone }),
            ...(input.contactEmail && { contactEmail: input.contactEmail.toLowerCase() }),
            ...(input.operatingHours && { operatingHours: input.operatingHours }),
            ...(input.cancellationCutoffHours && {
              cancellationCutoffHours: input.cancellationCutoffHours,
            }),
            ...(input.onboardingStep && { onboardingStep: input.onboardingStep }),
            version: { increment: 1 },
          },
        })
        await audit(tx, {
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'VENUE_UPDATED',
          entity: 'venue',
          entityId: venueId,
          after: input,
        })
        await venueUpserted(tx, n)
        return n
      })
      return venueJson(updated)
    },

    // ───────────────────────── courts ─────────────────────────
    async addCourt(venueId: string, actorId: string, input: any) {
      const v = await getVenueOr404(venueId)
      assertEditable(v)
      if (input.hoursOverride) {
        const e = validateHours(input.hoursOverride)
        if (e) throw new BadRequestError(e, 'INVALID_HOURS')
      }
      return prisma.$transaction(async (tx) => {
        const c = await tx.court.create({
          data: {
            id: uuidv7(),
            venueId,
            name: input.name.trim(),
            sport: input.sport,
            surface: input.surface,
            capacity: input.capacity ?? null,
            slotMinutes: input.slotMinutes ?? 60,
            hoursOverride: input.hoursOverride ?? undefined,
          },
        })
        await audit(tx, {
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'COURT_CREATED',
          entity: 'court',
          entityId: c.id,
          after: input,
        })
        await courtUpserted(tx, c)
        return c
      })
    },

    async listCourts(venueId: string) {
      return prisma.court.findMany({ where: { venueId }, orderBy: { createdAt: 'asc' } })
    },

    async updateCourt(venueId: string, courtId: string, actorId: string, input: any) {
      const v = await getVenueOr404(venueId)
      assertEditable(v)
      await ownedCourt(venueId, courtId)
      if (input.hoursOverride) {
        const e = validateHours(input.hoursOverride)
        if (e) throw new BadRequestError(e, 'INVALID_HOURS')
      }
      return prisma.$transaction(async (tx) => {
        const c = await tx.court.update({
          where: { id: courtId },
          data: {
            ...(input.name && { name: input.name.trim() }),
            ...(input.sport && { sport: input.sport }),
            ...(input.surface && { surface: input.surface }),
            ...(input.capacity !== undefined && { capacity: input.capacity }),
            ...(input.slotMinutes && { slotMinutes: input.slotMinutes }),
            ...(input.hoursOverride && { hoursOverride: input.hoursOverride }),
            ...(input.isActive !== undefined && { isActive: input.isActive }),
            version: { increment: 1 },
          },
        })
        await audit(tx, {
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'COURT_UPDATED',
          entity: 'court',
          entityId: courtId,
          after: input,
        })
        await courtUpserted(tx, c)
        return c
      })
    },

    // ───────────────────────── pricing ─────────────────────────
    async addPricingRule(venueId: string, actorId: string, input: any) {
      const v = await getVenueOr404(venueId)
      assertEditable(v)
      await ownedCourt(venueId, input.courtId)
      this.assertRuleShape(input)
      const existing = (
        await prisma.pricingRule.findMany({ where: { courtId: input.courtId } })
      ).map(toRule)
      const overlap = findPriceOverlap(existing, {
        ...input,
        priceMinor: BigInt(input.priceMinor),
        priority: input.priority ?? 0,
      })
      if (overlap) throw new ConflictError(overlap, 'PRICING_OVERLAP')
      return prisma.$transaction(async (tx) => {
        const r = await tx.pricingRule.create({
          data: {
            id: uuidv7(),
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
          },
        })
        await audit(tx, {
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'PRICING_RULE_CREATED',
          entity: 'pricing_rule',
          entityId: r.id,
          after: input,
        })
        await pricingUpdated(tx, input.courtId, venueId)
        return ruleJson(r)
      })
    },

    assertRuleShape(input: any) {
      if (input.fromTime === input.toTime)
        throw new BadRequestError('fromTime and toTime cannot be equal', 'INVALID_PRICING_RULE')
      if (input.dayType === 'DATE_RANGE') {
        if (!input.startDate || !input.endDate || input.startDate > input.endDate) {
          throw new BadRequestError('DATE_RANGE needs startDate <= endDate', 'INVALID_PRICING_RULE')
        }
      } else if (input.startDate || input.endDate) {
        throw new BadRequestError(
          'Dates are only allowed for DATE_RANGE rules',
          'INVALID_PRICING_RULE',
        )
      }
    },

    async listPricingRules(venueId: string, courtId?: string) {
      const rules = await prisma.pricingRule.findMany({
        where: { court: { venueId }, ...(courtId && { courtId }) },
        orderBy: [{ courtId: 'asc' }, { priority: 'desc' }],
      })
      return rules.map(ruleJson)
    },

    async deletePricingRule(venueId: string, ruleId: string, actorId: string) {
      const v = await getVenueOr404(venueId)
      assertEditable(v)
      const r = await prisma.pricingRule.findFirst({ where: { id: ruleId, court: { venueId } } })
      if (!r) throw new NotFoundError('Pricing rule not found', 'PRICING_RULE_NOT_FOUND')
      await prisma.$transaction(async (tx) => {
        await tx.pricingRule.delete({ where: { id: ruleId } })
        await audit(tx, {
          actorId,
          actorType: 'STAFF',
          venueId,
          action: 'PRICING_RULE_DELETED',
          entity: 'pricing_rule',
          entityId: ruleId,
          before: ruleJson(r),
        })
        await pricingUpdated(tx, r.courtId, venueId)
      })
    },

    /** Price preview grid for one court and day (what slots will cost). */
    async pricingPreview(venueId: string, courtId: string, date: string) {
      const v = await getVenueOr404(venueId)
      const court = await ownedCourt(venueId, courtId)
      const rules = (await prisma.pricingRule.findMany({ where: { courtId } })).map(toRule)
      const hours = (court.hoursOverride ?? v.operatingHours) as unknown as OperatingHours
      const slots: Array<{
        start: string
        end: string
        priceMinor: number | null
        tag: string | null
      }> = []
      const fmt = (m: number) =>
        `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
      for (const w of hours[weekdayKey(date)] ?? []) {
        for (const start of slotStarts(w, court.slotMinutes)) {
          let day = date
          if (start >= 1440) {
            const d = new Date(`${date}T00:00:00Z`)
            d.setUTCDate(d.getUTCDate() + 1)
            day = d.toISOString().slice(0, 10)
          }
          const p = resolvePriceLocal(rules, day, start % 1440)
          slots.push({
            start: fmt(start),
            end: fmt(start + court.slotMinutes),
            priceMinor: p ? Number(p.priceMinor) : null,
            tag: p?.tag ?? null,
          })
        }
      }
      return { courtId, date, slotMinutes: court.slotMinutes, slots }
    },

    // ───────────────────────── submit and review ─────────────────────────
    async submit(venueId: string, actorId: string, ip?: string | null) {
      const v = await getVenueOr404(venueId)
      const courts = await prisma.court.findMany({
        where: { venueId, isActive: true },
        include: { pricingRules: true },
      })
      const problems: string[] = []
      if (courts.length === 0) problems.push('Add at least one active court')
      const hoursErr = validateHours(v.operatingHours)
      if (hoursErr) problems.push(hoursErr)
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) problems.push('Confirm the map pin')
      for (const c of courts) {
        const hours = (c.hoursOverride ?? v.operatingHours) as unknown as OperatingHours
        const gap = findPricingGap(hours, c.slotMinutes, c.pricingRules.map(toRule))
        if (gap) problems.push(`Court "${c.name}": ${gap}`)
      }
      if (problems.length)
        throw new BadRequestError('The venue is not ready to submit', 'SUBMIT_PREREQUISITES', {
          problems,
        })
      const out = await transition(venueId, 'submit', { id: actorId, type: 'STAFF', ip })
      return venueJson(out)
    },

    async verificationStatus(venueId: string) {
      const v = await getVenueOr404(venueId)
      const reviews = await prisma.venueReview.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
      return {
        status: v.verificationStatus,
        submittedAt: v.submittedAt,
        verifiedAt: v.verifiedAt,
        reviews,
      }
    },

    // ───────────────────────── admin ─────────────────────────
    async adminList(q: { status?: string; city?: string; limit: number; offset: number }) {
      const where: Prisma.VenueWhereInput = {
        ...(q.status && { verificationStatus: q.status }),
        ...(q.city && { city: q.city }),
      }
      const [items, total] = await Promise.all([
        prisma.venue.findMany({
          where,
          orderBy: { submittedAt: 'asc' },
          take: q.limit,
          skip: q.offset,
        }),
        prisma.venue.count({ where }),
      ])
      const now = Date.now()
      return {
        total,
        items: items.map((v) => ({
          ...venueJson(v),
          hoursInQueue: v.submittedAt
            ? Math.floor((now - v.submittedAt.getTime()) / 3600_000)
            : null,
        })),
      }
    },

    async adminGet(venueId: string) {
      const base = await this.getForStaff(venueId)
      const v = await getVenueOr404(venueId)
      let pinDistanceKm: number | null = null
      if (v.areaId) {
        const rows = await prisma.$queryRaw<{ km: number | null }[]>`
          SELECT ST_Distance(v.location, ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326)::geography) / 1000 AS km
          FROM venues v JOIN areas a ON a.id = v.area_id WHERE v.id = ${venueId}::uuid AND a.lat IS NOT NULL`
        pinDistanceKm = rows[0]?.km ?? null
      }
      const reviews = await prisma.venueReview.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
      })
      return {
        ...base,
        reviews,
        pinDistanceKm,
        // Sanity check for the reviewer: the pin should be near the claimed area
        pinWarning:
          pinDistanceKm !== null && pinDistanceKm > 15
            ? `Pin is ${pinDistanceKm.toFixed(1)} km from the claimed area`
            : null,
      }
    },

    async openReview(venueId: string, adminId: string, ip?: string | null) {
      return venueJson(await transition(venueId, 'open_review', { id: adminId, type: 'ADMIN', ip }))
    },

    async review(
      venueId: string,
      adminId: string,
      input: { decision: string; comments?: string; fieldFlags?: unknown[] },
      ip?: string | null,
    ) {
      if (input.decision !== 'APPROVED' && !input.comments?.trim()) {
        throw new BadRequestError('Comments are required unless approving', 'COMMENTS_REQUIRED')
      }
      const action: VenueAction =
        input.decision === 'APPROVED'
          ? 'approve'
          : input.decision === 'REJECTED'
            ? 'reject'
            : 'request_changes'
      return venueJson(await transition(venueId, action, { id: adminId, type: 'ADMIN', ip }, input))
    },

    async suspend(venueId: string, adminId: string, reason: string, ip?: string | null) {
      return venueJson(
        await transition(
          venueId,
          'suspend',
          { id: adminId, type: 'ADMIN', ip },
          { decision: 'SUSPENDED', comments: reason },
        ),
      )
    },
    async reinstate(venueId: string, adminId: string, reason: string, ip?: string | null) {
      return venueJson(
        await transition(
          venueId,
          'reinstate',
          { id: adminId, type: 'ADMIN', ip },
          { decision: 'REINSTATED', comments: reason },
        ),
      )
    },

    // ───────────────────────── areas ─────────────────────────
    async createArea(input: any) {
      const slug = slugify(input.name)
      try {
        return await prisma.area.create({
          data: {
            id: uuidv7(),
            city: input.city.trim(),
            name: input.name.trim(),
            slug,
            aliases: input.aliases ?? [],
            lat: input.lat ?? null,
            lng: input.lng ?? null,
          },
        })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ConflictError('This area already exists in that city', 'AREA_EXISTS')
        throw e
      }
    },
    async updateArea(id: string, input: any) {
      if (!(await prisma.area.findUnique({ where: { id } })))
        throw new NotFoundError('Area not found', 'AREA_NOT_FOUND')
      return prisma.area.update({
        where: { id },
        data: {
          ...(input.name && { name: input.name.trim(), slug: slugify(input.name) }),
          ...(input.city && { city: input.city.trim() }),
          ...(input.aliases && { aliases: input.aliases }),
          ...(input.lat !== undefined && { lat: input.lat }),
          ...(input.lng !== undefined && { lng: input.lng }),
        },
      })
    },
    async deleteArea(id: string) {
      const used = await prisma.venue.count({ where: { areaId: id } })
      if (used > 0) throw new ConflictError('Area is used by venues', 'AREA_IN_USE')
      await prisma.area.delete({ where: { id } }).catch(() => {
        throw new NotFoundError('Area not found', 'AREA_NOT_FOUND')
      })
    },

    localParts,
  }
}

export type VenueService = ReturnType<typeof createVenueService>
