import { describe, it, expect } from 'vitest'
import {
  validateHours,
  slotStarts,
  resolvePrice,
  resolvePriceLocal,
  findPriceOverlap,
  findPricingGap,
  nextStatus,
  PriceRule,
  isWeekend,
  weekdayKey,
} from '../src/modules/venue/venue.domain'

const rule = (o: Partial<PriceRule>): PriceRule => ({
  dayType: 'ANY',
  fromTime: '06:00',
  toTime: '18:00',
  priceMinor: 200000n,
  priority: 0,
  tag: 'OFF_PEAK',
  ...o,
})
const ALL = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    [{ open: '06:00', close: '02:00' }],
  ]),
)

describe('opening hours', () => {
  it('accepts a normal and an overnight window', () => {
    expect(validateHours({ mon: [{ open: '06:00', close: '23:00' }] })).toBeNull()
    expect(validateHours(ALL)).toBeNull()
  })
  it('rejects bad input', () => {
    expect(validateHours({})).toMatch(/At least one/)
    expect(validateHours({ funday: [{ open: '06:00', close: '07:00' }] })).toMatch(/Unknown day/)
    expect(validateHours({ mon: [{ open: '6am', close: '07:00' }] })).toMatch(/HH:mm/)
    expect(validateHours({ mon: [{ open: '06:00', close: '06:00' }] })).toMatch(/equal/)
    expect(validateHours({ mon: 'x' })).toMatch(/list/)
    expect(validateHours(null)).toBeTruthy()
  })
  it('splits a window into slot starts, including past midnight', () => {
    expect(slotStarts({ open: '06:00', close: '09:00' }, 60)).toEqual([360, 420, 480])
    const overnight = slotStarts({ open: '22:00', close: '02:00' }, 60)
    expect(overnight).toEqual([1320, 1380, 1440, 1500]) // 22,23,00,01
    expect(slotStarts({ open: '06:00', close: '08:00' }, 90)).toEqual([360]) // 2nd slot would overrun
  })
})

describe('price resolution', () => {
  const rules = [
    rule({ fromTime: '06:00', toTime: '18:00', priceMinor: 200000n, tag: 'OFF_PEAK' }),
    rule({ fromTime: '18:00', toTime: '02:00', priceMinor: 300000n, tag: 'PEAK' }),
  ]
  it('picks the band by local time (Asia/Karachi)', () => {
    // 2026-10-12 is a Monday. 10:00 PKT = 05:00Z
    expect(resolvePrice(rules, new Date('2026-10-12T05:00:00Z'))).toEqual({
      priceMinor: 200000n,
      tag: 'OFF_PEAK',
    })
    // 20:00 PKT = 15:00Z
    expect(resolvePrice(rules, new Date('2026-10-12T15:00:00Z'))).toEqual({
      priceMinor: 300000n,
      tag: 'PEAK',
    })
  })
  it('overnight band covers after midnight (01:00 PKT = 20:00Z)', () => {
    expect(resolvePrice(rules, new Date('2026-10-12T20:00:00Z'))?.tag).toBe('PEAK')
  })
  it('band end is exclusive', () => {
    expect(resolvePriceLocal(rules, '2026-10-12', 17 * 60 + 59)?.tag).toBe('OFF_PEAK')
    expect(resolvePriceLocal(rules, '2026-10-12', 18 * 60)?.tag).toBe('PEAK')
    expect(resolvePriceLocal(rules, '2026-10-12', 2 * 60)).toBeNull() // 02:00 is closed, no band
  })
  it('weekend is Saturday and Sunday', () => {
    expect(isWeekend('2026-10-10')).toBe(true) // Sat
    expect(isWeekend('2026-10-11')).toBe(true) // Sun
    expect(isWeekend('2026-10-12')).toBe(false) // Mon
    expect(weekdayKey('2026-10-12')).toBe('mon')
  })
  it('higher priority wins; then the more specific day type', () => {
    const r = [
      rule({ priceMinor: 100n }),
      rule({ dayType: 'WEEKEND', priceMinor: 200n }),
      rule({
        dayType: 'DATE_RANGE',
        startDate: '2026-10-10',
        endDate: '2026-10-12',
        priceMinor: 300n,
      }),
    ]
    expect(resolvePriceLocal(r, '2026-10-13', 600)?.priceMinor).toBe(100n) // plain Tuesday
    expect(resolvePriceLocal(r, '2026-10-10', 600)?.priceMinor).toBe(300n) // date range beats weekend
    expect(resolvePriceLocal(r, '2026-10-17', 600)?.priceMinor).toBe(200n) // weekend beats ANY
    const withPriority = [...r, rule({ priceMinor: 999n, priority: 5 })]
    expect(resolvePriceLocal(withPriority, '2026-10-10', 600)?.priceMinor).toBe(999n)
  })
  it('after-midnight part of an overnight weekend band uses the previous day', () => {
    const r = [rule({ dayType: 'WEEKEND', fromTime: '18:00', toTime: '02:00', priceMinor: 500n })]
    expect(resolvePriceLocal(r, '2026-10-11', 60)?.priceMinor).toBe(500n) // 01:00 Sun belongs to Sat night
    expect(resolvePriceLocal(r, '2026-10-12', 60)?.priceMinor).toBe(500n) // 01:00 Mon belongs to Sun night
    expect(resolvePriceLocal(r, '2026-10-13', 60)).toBeNull() // 01:00 Tue belongs to Mon night
  })
  it('returns null when no rule matches', () => {
    expect(resolvePriceLocal([], '2026-10-12', 600)).toBeNull()
  })
})

describe('price overlap and gaps', () => {
  it('detects overlap at the same priority only', () => {
    const existing = [rule({ fromTime: '06:00', toTime: '18:00' })]
    expect(findPriceOverlap(existing, rule({ fromTime: '17:00', toTime: '20:00' }))).toMatch(
      /Overlaps/,
    )
    expect(findPriceOverlap(existing, rule({ fromTime: '18:00', toTime: '22:00' }))).toBeNull() // touching is fine
    expect(
      findPriceOverlap(existing, rule({ fromTime: '17:00', toTime: '20:00', priority: 1 })),
    ).toBeNull()
  })
  it('overnight bands overlap through midnight', () => {
    const existing = [rule({ fromTime: '22:00', toTime: '02:00' })]
    expect(findPriceOverlap(existing, rule({ fromTime: '00:30', toTime: '01:00' }))).toMatch(
      /Overlaps/,
    )
    expect(findPriceOverlap(existing, rule({ fromTime: '02:00', toTime: '06:00' }))).toBeNull()
  })
  it('WEEKDAY and WEEKEND bands do not collide; ANY collides with both', () => {
    const wd = [rule({ dayType: 'WEEKDAY' })]
    expect(findPriceOverlap(wd, rule({ dayType: 'WEEKEND' }))).toBeNull()
    expect(findPriceOverlap(wd, rule({ dayType: 'ANY' }))).toMatch(/Overlaps/)
  })
  it('date ranges collide only when the dates intersect', () => {
    const a = [rule({ dayType: 'DATE_RANGE', startDate: '2026-12-01', endDate: '2026-12-10' })]
    expect(
      findPriceOverlap(
        a,
        rule({ dayType: 'DATE_RANGE', startDate: '2026-12-10', endDate: '2026-12-20' }),
      ),
    ).toMatch(/Overlaps/)
    expect(
      findPriceOverlap(
        a,
        rule({ dayType: 'DATE_RANGE', startDate: '2026-12-11', endDate: '2026-12-20' }),
      ),
    ).toBeNull()
  })
  it('a rule does not overlap itself when editing', () => {
    const existing = [{ ...rule({}), id: 'a' }]
    expect(findPriceOverlap(existing, { ...rule({}), id: 'a' })).toBeNull()
  })
  it('finds a gap in coverage', () => {
    const half = [rule({ fromTime: '06:00', toTime: '18:00' })]
    expect(findPricingGap(ALL, 60, half)).toMatch(/No price for/)
    const full = [...half, rule({ fromTime: '18:00', toTime: '02:00', priceMinor: 300000n })]
    expect(findPricingGap(ALL, 60, full)).toBeNull()
  })
  it('date-range rules do not count as coverage', () => {
    const only = [
      rule({
        dayType: 'DATE_RANGE',
        startDate: '2026-12-01',
        endDate: '2026-12-31',
        fromTime: '06:00',
        toTime: '02:00',
      }),
    ]
    expect(findPricingGap(ALL, 60, only)).toMatch(/No price/)
  })
})

describe('venue state machine', () => {
  it('allows the documented path', () => {
    expect(nextStatus('DRAFT', 'submit')).toBe('SUBMITTED')
    expect(nextStatus('SUBMITTED', 'open_review')).toBe('UNDER_REVIEW')
    expect(nextStatus('UNDER_REVIEW', 'approve')).toBe('VERIFIED')
    expect(nextStatus('UNDER_REVIEW', 'request_changes')).toBe('CHANGES_REQUESTED')
    expect(nextStatus('CHANGES_REQUESTED', 'submit')).toBe('SUBMITTED')
    expect(nextStatus('UNDER_REVIEW', 'reject')).toBe('REJECTED')
    expect(nextStatus('VERIFIED', 'suspend')).toBe('SUSPENDED')
    expect(nextStatus('SUSPENDED', 'reinstate')).toBe('VERIFIED')
  })
  it('refuses every illegal move', () => {
    expect(nextStatus('DRAFT', 'approve')).toBeNull()
    expect(nextStatus('SUBMITTED', 'approve')).toBeNull() // must be opened first
    expect(nextStatus('REJECTED', 'submit')).toBeNull() // terminal
    expect(nextStatus('VERIFIED', 'submit')).toBeNull()
    expect(nextStatus('DRAFT', 'suspend')).toBeNull()
    expect(nextStatus('VERIFIED', 'reinstate')).toBeNull()
    expect(nextStatus('UNDER_REVIEW', 'submit')).toBeNull()
  })
})
