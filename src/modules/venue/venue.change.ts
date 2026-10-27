import { Venue } from '@prisma/client'

/** Edits to a VERIFIED venue that wait for an admin before they reach players. */
export const CHANGE_OPS = [
  'court.add',
  'court.update',
  'rule.add',
  'rule.delete',
  'venue.update_hours',
] as const
export type ChangeOp = (typeof CHANGE_OPS)[number]

export const MAX_PENDING_CHANGES = 20

/**
 * Does this edit need admin approval? Only for a VERIFIED venue: before that the whole venue is
 * reviewed anyway. Opening hours, slot length, new courts and price bands change what players
 * pay or can book; photos, names, amenities and contacts do not.
 */
export function needsReview(
  v: Pick<Venue, 'verificationStatus'>,
  op: ChangeOp,
  input: Record<string, any>,
  court?: { isActive: boolean } | null,
): boolean {
  if (v.verificationStatus !== 'VERIFIED') return false
  if (op !== 'court.update') return true
  if (input.schedule !== undefined || input.slotMinutes !== undefined) return true
  // turning a hidden court on publishes it
  return input.isBookable === true && court?.isActive === false
}

/** One line for the admin queue. */
export function summarizeChange(op: ChangeOp, params: Record<string, any>, payload: any): string {
  switch (op) {
    case 'court.add':
      return `Add court "${payload.name}" (${payload.sport}, ${payload.pricing?.length ?? 0} price band(s))`
    case 'court.update': {
      const keys = Object.keys(payload).filter((k) => payload[k] !== undefined)
      return `Edit court ${params.courtName ?? params.courtId}: ${keys.join(', ')}`
    }
    case 'rule.add':
      return `Add price band "${payload.name}" ${payload.fromTime}-${payload.toTime} at Rs ${
        Number(payload.priceMinor) / 100
      } (${payload.dayType}) on court ${params.courtName ?? payload.courtId}`
    case 'rule.delete':
      return `Delete price band "${params.ruleName ?? params.ruleId}" on court ${params.courtName ?? ''}`.trim()
    case 'venue.update_hours':
      return 'Change the venue opening hours'
  }
}
