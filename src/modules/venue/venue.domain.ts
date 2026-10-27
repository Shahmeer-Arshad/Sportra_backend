/**
 * Pure venue rules (no database, no I/O): opening hours, pricing resolution, price-band
 * validation and the onboarding state machine. Unit-tested on their own.
 */
import { localParts, prevDay } from '../../lib/time'

export const SPORTS = [
  'FUTSAL_5V5',
  'BOX_CRICKET',
  'HARDBALL_CRICKET',
  'PADEL',
  'BADMINTON',
  'NET_PRACTICE',
] as const
export const SURFACES = [
  'SYNTHETIC_TURF',
  'NATURAL_GRASS',
  'INDOOR_ACRYLIC',
  'WOODEN_FLOOR',
  'GLASS_PADEL',
] as const
export const AMENITIES = [
  'PARKING',
  'FLOODLIGHTS',
  'WASHROOMS',
  'CHANGING_ROOMS',
  'CAFE',
  'WIFI',
  'FIRST_AID',
  'SEATING',
  'LOCKERS',
  'PRAYER_AREA',
  'AC',
  'EQUIPMENT_RENTAL',
] as const
export const RADII_KM = [3, 5, 10, 20] as const

// ───────────── time helpers ─────────────
export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number]

/** 0 = Sunday ... 6 = Saturday, for a yyyy-mm-dd date. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()
export const weekdayKey = (date: string): WeekdayKey => WEEKDAY_KEYS[weekdayOf(date)]
export const isWeekend = (date: string) => [0, 6].includes(weekdayOf(date)) // Saturday + Sunday

// ───────────── opening hours ─────────────
export interface HoursWindow {
  open: string
  close: string
}
export type OperatingHours = Partial<Record<WeekdayKey, HoursWindow[]>>

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** Returns an error message, or null if the hours are valid. close <= open means "after midnight". */
export function validateHours(h: unknown): string | null {
  if (!h || typeof h !== 'object') return 'operatingHours must be an object'
  let windows = 0
  for (const [day, list] of Object.entries(h as Record<string, unknown>)) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(day)) return `Unknown day "${day}"`
    if (!Array.isArray(list)) return `${day} must be a list of windows`
    for (const w of list as HoursWindow[]) {
      if (!w || !HHMM.test(w.open) || !HHMM.test(w.close)) return `${day}: times must be HH:mm`
      if (w.open === w.close) return `${day}: open and close cannot be equal`
      windows++
    }
  }
  return windows === 0 ? 'At least one opening window is required' : null
}

/** Start times (minutes since local midnight of the opening day, may exceed 1440) of every slot. */
export function slotStarts(window: HoursWindow, slotMinutes: number): number[] {
  const open = toMinutes(window.open)
  let close = toMinutes(window.close)
  if (close <= open) close += 1440
  const out: number[] = []
  for (let t = open; t + slotMinutes <= close; t += slotMinutes) out.push(t)
  return out
}

// ───────────── pricing ─────────────
export interface PriceRule {
  id?: string
  dayType: 'ANY' | 'WEEKDAY' | 'WEEKEND' | 'DATE_RANGE'
  startDate?: string | null
  endDate?: string | null
  fromTime: string
  toTime: string
  priceMinor: bigint
  priority: number
  tag: 'PEAK' | 'OFF_PEAK'
}
export interface ResolvedPrice {
  priceMinor: bigint
  tag: 'PEAK' | 'OFF_PEAK'
}

const SPECIFICITY = { DATE_RANGE: 3, WEEKDAY: 2, WEEKEND: 2, ANY: 1 } as const

/** Segments of a band inside one day [0,1440). An overnight band splits in two. */
function segments(r: Pick<PriceRule, 'fromTime' | 'toTime'>): Array<[number, number]> {
  const f = toMinutes(r.fromTime)
  const t = toMinutes(r.toTime)
  if (t > f) return [[f, t]]
  return [[f, 1440], ...(t > 0 ? ([[0, t]] as Array<[number, number]>) : [])]
}

function dayMatches(r: PriceRule, date: string): boolean {
  switch (r.dayType) {
    case 'ANY':
      return true
    case 'WEEKDAY':
      return !isWeekend(date)
    case 'WEEKEND':
      return isWeekend(date)
    case 'DATE_RANGE':
      return !!r.startDate && !!r.endDate && date >= r.startDate && date <= r.endDate
  }
}

/**
 * Price of a slot starting at local `date` + `minute` of the day. The after-midnight part of an
 * overnight band belongs to the previous business day, so day type is judged on that day.
 * Highest priority wins, then the more specific day type. Returns null if nothing matches.
 */
export function resolvePriceLocal(
  rules: PriceRule[],
  date: string,
  minute: number,
): ResolvedPrice | null {
  const matches = rules.filter((r) => {
    const f = toMinutes(r.fromTime)
    const t = toMinutes(r.toTime)
    const overnight = t <= f
    if (!overnight) return minute >= f && minute < t && dayMatches(r, date)
    if (minute >= f) return dayMatches(r, date)
    if (minute < t) return dayMatches(r, prevDay(date))
    return false
  })
  if (matches.length === 0) return null
  matches.sort((a, b) => b.priority - a.priority || SPECIFICITY[b.dayType] - SPECIFICITY[a.dayType])
  return { priceMinor: matches[0].priceMinor, tag: matches[0].tag }
}

/** Same, for a UTC instant in a venue time zone. */
export function resolvePrice(
  rules: PriceRule[],
  startAt: Date,
  tz = 'Asia/Karachi',
): ResolvedPrice | null {
  const p = localParts(startAt, tz)
  return resolvePriceLocal(rules, p.date, p.hour * 60 + p.minute)
}

/** Returns an error message if the new rule overlaps an existing rule of the same priority. */
export function findPriceOverlap(existing: PriceRule[], candidate: PriceRule): string | null {
  for (const r of existing) {
    if (r.id && r.id === candidate.id) continue
    if (r.priority !== candidate.priority) continue
    const daysCollide =
      r.dayType === 'ANY' || candidate.dayType === 'ANY'
        ? true
        : r.dayType === 'DATE_RANGE' && candidate.dayType === 'DATE_RANGE'
          ? r.startDate! <= candidate.endDate! && candidate.startDate! <= r.endDate!
          : r.dayType === candidate.dayType
    if (!daysCollide) continue
    for (const [a1, a2] of segments(r)) {
      for (const [b1, b2] of segments(candidate)) {
        if (a1 < b2 && b1 < a2)
          return `Overlaps price band "${r.fromTime}-${r.toTime}" at the same priority`
      }
    }
  }
  return null
}

/**
 * Every slot of every opening day must have a price from a recurring rule (date-range rules are
 * ignored here, they are exceptions). Returns the first gap found, or null.
 */
export function findPricingGap(
  hours: OperatingHours,
  slotMinutes: number,
  rules: PriceRule[],
): string | null {
  const recurring = rules.filter((r) => r.dayType !== 'DATE_RANGE')
  // 2030-01-06 is a Sunday; walking 7 days covers each weekday once
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.UTC(2030, 0, 6 + i)).toISOString().slice(0, 10)
    for (const w of hours[weekdayKey(date)] ?? []) {
      for (const start of slotStarts(w, slotMinutes)) {
        const minute = start % 1440
        // after-midnight slots of a window opened on `date` belong to `date`'s business day
        const price =
          start >= 1440
            ? resolveAfterMidnight(recurring, date, minute)
            : resolvePriceLocal(recurring, date, minute)
        if (!price)
          return `No price for ${weekdayKey(date)} at ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
      }
    }
  }
  return null
}

function resolveAfterMidnight(rules: PriceRule[], businessDate: string, minute: number) {
  // the slot happens on the next calendar day, but belongs to businessDate
  const next = new Date(`${businessDate}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return resolvePriceLocal(rules, next.toISOString().slice(0, 10), minute)
}

// ───────────── onboarding state machine ─────────────
export type VenueStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'SUSPENDED'

const TRANSITIONS: Record<string, VenueStatus[]> = {
  submit: ['DRAFT', 'CHANGES_REQUESTED'],
  open_review: ['SUBMITTED'],
  approve: ['UNDER_REVIEW'],
  request_changes: ['UNDER_REVIEW'],
  reject: ['UNDER_REVIEW'],
  suspend: ['VERIFIED'],
  reinstate: ['SUSPENDED'],
  release_review: ['UNDER_REVIEW'],
}
const RESULT: Record<string, VenueStatus> = {
  submit: 'SUBMITTED',
  open_review: 'UNDER_REVIEW',
  approve: 'VERIFIED',
  request_changes: 'CHANGES_REQUESTED',
  reject: 'REJECTED',
  suspend: 'SUSPENDED',
  reinstate: 'VERIFIED',
  release_review: 'SUBMITTED',
}
export type VenueAction = keyof typeof TRANSITIONS

/** PAUSE_ONLINE: players cannot book, the venue's own POS keeps working. STOP_ALL: everything stops. */
export const SUSPENSION_MODES = ['PAUSE_ONLINE', 'STOP_ALL'] as const
export type SuspensionMode = (typeof SUSPENSION_MODES)[number]

export function nextStatus(from: string, action: VenueAction): VenueStatus | null {
  return TRANSITIONS[action].includes(from as VenueStatus) ? RESULT[action] : null
}

/** Statuses in which the owner may edit venue details. */
export const OWNER_EDITABLE: string[] = ['DRAFT', 'CHANGES_REQUESTED', 'VERIFIED']
