import { Court, PricingRule, Venue } from '@prisma/client'
import { BadRequestError, ConflictError, ForbiddenError } from '../../utils/errors'
import {
  findPriceOverlap,
  findPricingGap,
  nextStatus,
  OperatingHours,
  OWNER_EDITABLE,
  PriceRule,
  validateHours,
  VenueAction,
} from './venue.domain'
import { toRule } from './venue.view'

const MATERIAL_FIELDS = ['lat', 'lng', 'address', 'cancellationCutoffHours', 'city', 'areaId']
const MANAGER_EDITABLE = [
  'operatingHours',
  'amenities',
  'whatsappNumber',
  'contactPhone',
  'contactEmail',
]

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'venue'

export function assertHours(hours: unknown) {
  const err = validateHours(hours as OperatingHours)
  if (err) throw new BadRequestError(err, 'INVALID_HOURS')
}

export function assertEditable(v: Venue) {
  if (OWNER_EDITABLE.includes(v.verificationStatus)) return
  throw new ConflictError(
    v.verificationStatus === 'SUSPENDED' || v.verificationStatus === 'REJECTED'
      ? 'This venue cannot be edited'
      : 'The venue is being reviewed and cannot be edited now',
    'VENUE_LOCKED',
  )
}

/** Who may change which fields, and which changes a verified venue must send to review. */
export function assertVenueEdit(v: Venue, role: string, input: Record<string, unknown>) {
  assertEditable(v)
  const keys = Object.keys(input)
  if (role === 'MANAGER' && keys.some((k) => !MANAGER_EDITABLE.includes(k))) {
    throw new ForbiddenError(
      'Managers can only change hours, amenities and contacts',
      'OWNER_ONLY_FIELD',
    )
  }
  if (v.verificationStatus === 'VERIFIED' && keys.some((k) => MATERIAL_FIELDS.includes(k))) {
    throw new ConflictError(
      'Location, address, area and cancellation policy changes need admin review. Contact support.',
      'MATERIAL_EDIT_REQUIRES_REVIEW',
    )
  }
  if (input.operatingHours) assertHours(input.operatingHours)
}

export function assertRuleShape(input: any) {
  if (input.fromTime === input.toTime)
    throw new BadRequestError('fromTime and toTime cannot be equal', 'INVALID_PRICING_RULE')
  if (input.dayType === 'DATE_RANGE') {
    if (!input.startDate || !input.endDate || input.startDate > input.endDate) {
      throw new BadRequestError('DATE_RANGE needs startDate <= endDate', 'INVALID_PRICING_RULE')
    }
  } else if (input.startDate || input.endDate) {
    throw new BadRequestError('Dates are only allowed for DATE_RANGE rules', 'INVALID_PRICING_RULE')
  }
}

/**
 * Checks price bands that are created together with a court (shape, and no overlap between them)
 * and returns them ready to insert. Same rules as adding the bands one by one.
 */
export function planPricingRules(list: any[]) {
  const accepted: PriceRule[] = []
  return list.map((input) => {
    assertRuleShape(input)
    const rule: PriceRule = {
      dayType: input.dayType,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      fromTime: input.fromTime,
      toTime: input.toTime,
      priceMinor: BigInt(input.priceMinor),
      priority: input.priority ?? 0,
      tag: input.tag,
    }
    const overlap = findPriceOverlap(accepted, rule)
    if (overlap) throw new ConflictError(overlap, 'PRICING_OVERLAP')
    accepted.push(rule)
    return { ...rule, name: input.name as string }
  })
}

/** What stops a venue from being submitted (empty = ready). */
export function submissionProblems(
  v: Venue,
  courts: (Court & { pricingRules: PricingRule[] })[],
): string[] {
  const problems: string[] = []
  if (courts.length === 0) problems.push('Add at least one active court')
  const hoursErr = validateHours(v.operatingHours as unknown as OperatingHours)
  if (hoursErr) problems.push(hoursErr)
  if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) problems.push('Confirm the map pin')
  for (const c of courts) {
    const hours = (c.hoursOverride ?? v.operatingHours) as unknown as OperatingHours
    const gap = findPricingGap(hours, c.slotMinutes, c.pricingRules.map(toRule))
    if (gap) problems.push(`Court "${c.name}": ${gap}`)
  }
  return problems
}

/** Maps an admin's review decision to the state machine action. */
export function reviewAction(decision: string, comments?: string): VenueAction {
  if (decision !== 'APPROVED' && !comments?.trim()) {
    throw new BadRequestError('Comments are required unless approving', 'COMMENTS_REQUIRED')
  }
  return decision === 'APPROVED'
    ? 'approve'
    : decision === 'REJECTED'
      ? 'reject'
      : 'request_changes'
}

/** The next status for an action, or a conflict when the venue is in the wrong state. */
export function targetStatus(from: string, action: VenueAction) {
  const to = nextStatus(from, action)
  if (!to) {
    throw new ConflictError(
      `Cannot ${action.replace('_', ' ')} a venue that is ${from}`,
      'INVALID_VENUE_TRANSITION',
    )
  }
  return to
}
