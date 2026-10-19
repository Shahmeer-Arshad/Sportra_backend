import { describe, expect, it } from 'vitest'
import {
  PassVerificationError,
  REF_PATTERN,
  SLOT_STATUSES,
  SlotStatus,
  canTransition,
  checkConsecutive,
  checkInWindow,
  cityCode,
  computeCancelPreview,
  effectiveStatus,
  isLikelyNoShow,
  makeBookingRef,
  normalizePhone,
  planSlots,
  publicStatus,
  signPass,
  verifyPass,
} from '../src/modules/booking/booking.domain'
import { classifyRoom, routeHotMessage } from '../src/modules/booking/booking.realtime'
import { addDays, todayIn, zonedTimeToUtc } from '../src/lib/time'
import { ALL_DAYS } from './helpers'

const H = 3_600_000
const hours = (open: string, close: string) =>
  Object.fromEntries(ALL_DAYS.map((d) => [d, [{ open, close }]]))
const rule = (fromTime: string, toTime: string, price: number, tag: 'PEAK' | 'OFF_PEAK') => ({
  dayType: 'ANY' as const,
  fromTime,
  toTime,
  priceMinor: BigInt(price),
  priority: 0,
  tag,
})

describe('slot state machine', () => {
  // the legal moves from Backend_Docs/03 section 8.1; everything else is illegal
  const legal: Array<[SlotStatus, SlotStatus]> = [
    ['AVAILABLE', 'HELD'],
    ['AVAILABLE', 'BOOKED_WALKIN'],
    ['AVAILABLE', 'BLOCKED'],
    ['HELD', 'BOOKED_APP'],
    ['HELD', 'AVAILABLE'],
    ['BOOKED_APP', 'AVAILABLE'],
    ['BOOKED_APP', 'BLOCKED'],
    ['BOOKED_WALKIN', 'AVAILABLE'],
    ['BLOCKED', 'AVAILABLE'],
  ]
  it('allows exactly the documented transitions (all 25 pairs checked)', () => {
    for (const from of SLOT_STATUSES)
      for (const to of SLOT_STATUSES) {
        const expected = legal.some(([f, t]) => f === from && t === to)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected)
      }
  })
  it('shows players only held / booked / blocked / available', () => {
    expect(publicStatus('BOOKED_APP')).toBe('BOOKED')
    expect(publicStatus('BOOKED_WALKIN')).toBe('BOOKED')
    expect(publicStatus('HELD')).toBe('HELD')
    expect(publicStatus('BLOCKED')).toBe('BLOCKED')
    expect(publicStatus('AVAILABLE')).toBe('AVAILABLE')
  })
  it('treats an expired hold as available (lazy reclaim), a live hold as held', () => {
    const now = new Date('2026-10-20T10:00:00Z')
    expect(
      effectiveStatus({ status: 'HELD', holdExpiresAt: new Date(now.getTime() - 1) }, now),
    ).toBe('AVAILABLE')
    expect(effectiveStatus({ status: 'HELD', holdExpiresAt: new Date(now.getTime()) }, now)).toBe(
      'AVAILABLE',
    )
    expect(
      effectiveStatus({ status: 'HELD', holdExpiresAt: new Date(now.getTime() + 1000) }, now),
    ).toBe('HELD')
    expect(effectiveStatus({ status: 'BOOKED_APP', holdExpiresAt: null }, now)).toBe('BOOKED_APP')
  })
})

describe('consecutive hours', () => {
  const mk = (id: string, court: string, h: number) => ({
    id,
    courtId: court,
    startAt: new Date(Date.UTC(2026, 9, 20, h)),
    endAt: new Date(Date.UTC(2026, 9, 20, h + 1)),
  })
  it('accepts 1 to 4 adjacent hours, in any order', () => {
    expect(checkConsecutive([mk('a', 'c', 10)], 4)).toBeNull()
    expect(checkConsecutive([mk('c', 'c', 12), mk('a', 'c', 10), mk('b', 'c', 11)], 4)).toBeNull()
    expect(
      checkConsecutive(
        [10, 11, 12, 13].map((h) => mk(`s${h}`, 'c', h)),
        4,
      ),
    ).toBeNull()
  })
  it('rejects empty, too many, duplicates, mixed courts and gaps', () => {
    expect(checkConsecutive([], 4)).toBe('NO_SLOTS')
    expect(
      checkConsecutive(
        [10, 11, 12, 13, 14].map((h) => mk(`s${h}`, 'c', h)),
        4,
      ),
    ).toBe('TOO_MANY_SLOTS')
    expect(checkConsecutive([mk('a', 'c', 10), mk('a', 'c', 11)], 4)).toBe('DUPLICATE_SLOTS')
    expect(checkConsecutive([mk('a', 'c1', 10), mk('b', 'c2', 11)], 4)).toBe('DIFFERENT_COURTS')
    expect(checkConsecutive([mk('a', 'c', 10), mk('b', 'c', 12)], 4)).toBe('NOT_CONSECUTIVE')
  })
})

describe('zonedTimeToUtc', () => {
  it('converts Karachi wall time (UTC+5, no daylight saving)', () => {
    expect(zonedTimeToUtc('2026-10-20', 6 * 60, 'Asia/Karachi').toISOString()).toBe(
      '2026-10-20T01:00:00.000Z',
    )
    expect(zonedTimeToUtc('2026-01-05', 0, 'Asia/Karachi').toISOString()).toBe(
      '2026-01-04T19:00:00.000Z',
    )
  })
  it('after-midnight minutes roll into the next calendar day', () => {
    // 25:00 on the 20th is 01:00 on the 21st, local
    expect(zonedTimeToUtc('2026-10-20', 25 * 60, 'Asia/Karachi').toISOString()).toBe(
      '2026-10-20T20:00:00.000Z',
    )
  })
  it('follows IANA daylight-saving rules, not a fixed offset', () => {
    expect(zonedTimeToUtc('2026-07-01', 12 * 60, 'America/New_York').toISOString()).toBe(
      '2026-07-01T16:00:00.000Z',
    )
    expect(zonedTimeToUtc('2026-12-01', 12 * 60, 'America/New_York').toISOString()).toBe(
      '2026-12-01T17:00:00.000Z',
    )
  })
})

describe('planSlots', () => {
  const rules = [rule('06:00', '18:00', 200000, 'OFF_PEAK'), rule('18:00', '02:00', 300000, 'PEAK')]

  it('06:00-02:00 gives 20 hourly slots per day with the right prices and tags', () => {
    const plan = planSlots({
      hours: hours('06:00', '02:00'),
      slotMinutes: 60,
      tz: 'Asia/Karachi',
      rules,
      fromDate: '2026-10-20',
      toDate: '2026-10-20',
    })
    expect(plan).toHaveLength(20)
    expect(plan[0].startAt.toISOString()).toBe('2026-10-20T01:00:00.000Z') // 06:00 local
    expect(plan[0].priceMinor).toBe(200000n)
    expect(plan[0].priceTag).toBe('OFF_PEAK')
    const evening = plan.find((p) => p.startAt.toISOString() === '2026-10-20T13:00:00.000Z') // 18:00 local
    expect(evening?.priceTag).toBe('PEAK')
    expect(evening?.priceMinor).toBe(300000n)
  })

  it('a 1 AM slot belongs to the PREVIOUS business date', () => {
    const plan = planSlots({
      hours: hours('06:00', '02:00'),
      slotMinutes: 60,
      tz: 'Asia/Karachi',
      rules,
      fromDate: '2026-10-20',
      toDate: '2026-10-20',
    })
    const oneAm = plan.find((p) => p.startAt.toISOString() === '2026-10-20T20:00:00.000Z') // 01:00 on the 21st, local
    expect(oneAm).toBeTruthy()
    expect(oneAm!.businessDate).toBe('2026-10-20')
    expect(plan.every((p) => p.businessDate === '2026-10-20')).toBe(true)
  })

  it('is deterministic and never overlaps itself across days', () => {
    const args = {
      hours: hours('06:00', '02:00'),
      slotMinutes: 60,
      tz: 'Asia/Karachi',
      rules,
      fromDate: '2026-10-20',
      toDate: '2026-12-18', // 60 days
    }
    const a = planSlots(args)
    const b = planSlots(args)
    expect(a).toEqual(b)
    expect(a).toHaveLength(60 * 20)
    for (let i = 1; i < a.length; i++)
      expect(a[i].startAt.getTime()).toBeGreaterThanOrEqual(a[i - 1].endAt.getTime())
  })

  it('supports 90 minute slots and per-weekday hours', () => {
    const plan = planSlots({
      hours: { mon: [{ open: '10:00', close: '13:00' }] },
      slotMinutes: 90,
      tz: 'Asia/Karachi',
      rules: [rule('00:00', '23:59', 100000, 'OFF_PEAK')],
      fromDate: '2026-10-19', // a Monday
      toDate: '2026-10-25',
    })
    expect(plan).toHaveLength(2) // only Monday is open: 10:00 and 11:30
    expect(plan[1].startAt.getTime() - plan[0].startAt.getTime()).toBe(90 * 60_000)
  })

  it('skips hours that have no price rule instead of inventing a price', () => {
    const plan = planSlots({
      hours: hours('06:00', '10:00'),
      slotMinutes: 60,
      tz: 'Asia/Karachi',
      rules: [rule('06:00', '08:00', 100000, 'OFF_PEAK')],
      fromDate: '2026-10-20',
      toDate: '2026-10-20',
    })
    expect(plan).toHaveLength(2)
  })

  it('handles a daylight-saving zone: no overlapping or duplicated instants', () => {
    for (const day of ['2026-03-08', '2026-11-01']) {
      // US clocks change on these days
      const plan = planSlots({
        hours: hours('00:00', '06:00'),
        slotMinutes: 60,
        tz: 'America/New_York',
        rules: [rule('00:00', '23:59', 100000, 'OFF_PEAK')],
        fromDate: day,
        toDate: day,
      })
      expect(plan.length).toBeGreaterThanOrEqual(5)
      expect(new Set(plan.map((p) => p.startAt.getTime())).size).toBe(plan.length)
      for (let i = 1; i < plan.length; i++)
        expect(plan[i].startAt.getTime()).toBeGreaterThanOrEqual(plan[i - 1].endAt.getTime())
    }
  })

  it('addDays / todayIn work across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(todayIn('Asia/Karachi', new Date('2026-10-20T20:30:00Z'))).toBe('2026-10-21') // already tomorrow in Karachi
  })
})

describe('cancellation amounts (pure)', () => {
  const now = new Date('2026-10-20T10:00:00Z')
  const item = (id: string, startsInH: number, price: number, paid: number, dep: number) => ({
    id,
    startAt: new Date(now.getTime() + startsInH * H),
    priceMinor: BigInt(price),
    onlinePaidMinor: BigInt(paid),
    depositShareMinor: BigInt(dep),
  })

  it('20% prepaid, before the cutoff: everything paid for that hour comes back', () => {
    const p = computeCancelPreview([item('a', 30, 200000, 40000, 40000)], {
      cancelledBy: 'USER',
      cutoffHours: 12,
      now,
    })
    expect(p.refundDueMinor).toBe(40000n)
    expect(p.forfeitMinor).toBe(0n)
    expect(p.lines[0].fullRefund).toBe(true)
  })
  it('20% prepaid, after the cutoff: the deposit is forfeited', () => {
    const p = computeCancelPreview([item('a', 5, 200000, 40000, 40000)], {
      cancelledBy: 'USER',
      cutoffHours: 12,
      now,
    })
    expect(p.refundDueMinor).toBe(0n)
    expect(p.forfeitMinor).toBe(40000n)
  })
  it('100% prepaid, after the cutoff: deposit share kept, the rest refunded', () => {
    const p = computeCancelPreview([item('a', 5, 200000, 200000, 40000)], {
      cancelledBy: 'USER',
      cutoffHours: 12,
      now,
    })
    expect(p.refundDueMinor).toBe(160000n)
    expect(p.forfeitMinor).toBe(40000n)
  })
  it('judges each hour on its own start time', () => {
    const p = computeCancelPreview(
      [item('early', 5, 200000, 40000, 40000), item('late', 30, 200000, 40000, 40000)],
      { cancelledBy: 'USER', cutoffHours: 12, now },
    )
    expect(p.lines.find((l) => l.itemId === 'early')!.forfeitMinor).toBe(40000n)
    expect(p.lines.find((l) => l.itemId === 'late')!.refundDueMinor).toBe(40000n)
    expect(p.refundDueMinor).toBe(40000n)
    expect(p.forfeitMinor).toBe(40000n)
  })
  it('a venue or system cancellation is always a full refund, even after the cutoff', () => {
    for (const by of ['VENUE', 'SYSTEM'] as const) {
      const p = computeCancelPreview([item('a', 1, 200000, 40000, 40000)], {
        cancelledBy: by,
        cutoffHours: 12,
        now,
      })
      expect(p.refundDueMinor).toBe(40000n)
      expect(p.forfeitMinor).toBe(0n)
    }
  })
  it('a player cannot cancel an hour that has already started', () => {
    const p = computeCancelPreview([item('a', -1, 200000, 0, 0)], {
      cancelledBy: 'USER',
      cutoffHours: 12,
      now,
    })
    expect(p.allCancellable).toBe(false)
    const v = computeCancelPreview([item('a', -1, 200000, 0, 0)], {
      cancelledBy: 'VENUE',
      cutoffHours: 12,
      now,
    })
    expect(v.allCancellable).toBe(true)
  })
  it('exactly at the cutoff is already too late for a full refund', () => {
    const p = computeCancelPreview([item('a', 12, 200000, 40000, 40000)], {
      cancelledBy: 'USER',
      cutoffHours: 12,
      now,
    })
    expect(p.forfeitMinor).toBe(40000n)
  })
  it('pay-at-venue (nothing paid online) always previews zero', () => {
    const p = computeCancelPreview([item('a', 1, 200000, 0, 0)], {
      cancelledBy: 'USER',
      cutoffHours: 12,
      now,
    })
    expect(p.refundDueMinor).toBe(0n)
    expect(p.forfeitMinor).toBe(0n)
  })
})

describe('booking reference', () => {
  it('looks like KHI-7F3K2 and avoids look-alike characters', () => {
    for (let i = 0; i < 500; i++) {
      const ref = makeBookingRef('Karachi')
      expect(ref).toMatch(REF_PATTERN)
      expect(ref.startsWith('KHI-')).toBe(true)
      expect(ref.slice(4)).not.toMatch(/[01ILOU]/)
    }
  })
  it('maps cities to codes and falls back to the first three letters', () => {
    expect(cityCode('Lahore')).toBe('LHE')
    expect(cityCode('  islamabad ')).toBe('ISB')
    expect(cityCode('Sialkot')).toBe('SIA')
    expect(cityCode('Ab')).toBe('ABX')
  })
  it('refs are well spread (no obvious collisions in 20,000)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20000; i++) seen.add(makeBookingRef('Karachi'))
    expect(seen.size).toBeGreaterThan(19900) // 30^5 = 24M combinations
  })
})

describe('QR entry pass', () => {
  const secret = 'test-secret-0123456789'
  const nowS = Math.floor(Date.now() / 1000)
  const claims = {
    bid: 'b1',
    vid: 'v1',
    ref: 'KHI-AAAAA',
    nbf: nowS - 100,
    exp: nowS + 100,
    jti: 'j1',
  }

  it('round-trips a valid pass', () => {
    expect(verifyPass(signPass(claims, secret), secret)).toEqual(claims)
  })
  it('rejects a tampered payload, a different secret and garbage', () => {
    const t = signPass(claims, secret)
    const [h, , s] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, bid: 'other' })).toString('base64url')
    for (const bad of [
      `${h}.${forged}.${s}`,
      t.slice(0, -2) + 'xx',
      'abc',
      '',
      'a.b.c',
      `${t}.extra`,
    ]) {
      expect(() => verifyPass(bad, secret)).toThrow(PassVerificationError)
    }
    expect(() => verifyPass(t, 'a-different-secret-0123')).toThrow(PassVerificationError)
  })
  it('enforces the time window', () => {
    const early = signPass({ ...claims, nbf: nowS + 3600 }, secret)
    const late = signPass({ ...claims, exp: nowS - 5 }, secret)
    expect(() => verifyPass(early, secret)).toThrow(/NOT_YET_VALID/)
    expect(() => verifyPass(late, secret)).toThrow(/EXPIRED/)
  })
  it('holds no personal data', () => {
    const payload = JSON.parse(
      Buffer.from(signPass(claims, secret).split('.')[1], 'base64url').toString(),
    )
    expect(Object.keys(payload).sort()).toEqual(['bid', 'exp', 'jti', 'nbf', 'ref', 'vid'])
  })
  it('check-in opens 2 hours before the start and closes 2 hours after the end', () => {
    const w = checkInWindow(new Date('2026-10-20T10:00:00Z'), new Date('2026-10-20T12:00:00Z'))
    expect(w.from.toISOString()).toBe('2026-10-20T08:00:00.000Z')
    expect(w.until.toISOString()).toBe('2026-10-20T14:00:00.000Z')
  })
})

describe('small rules', () => {
  it('flags a likely no-show only for CONFIRMED bookings 20 minutes after the start', () => {
    const start = new Date('2026-10-20T10:00:00Z')
    const at = (min: number) => new Date(start.getTime() + min * 60_000)
    expect(isLikelyNoShow({ status: 'CONFIRMED', startAt: start }, at(19), 20)).toBe(false)
    expect(isLikelyNoShow({ status: 'CONFIRMED', startAt: start }, at(20), 20)).toBe(true)
    expect(isLikelyNoShow({ status: 'CHECKED_IN', startAt: start }, at(60), 20)).toBe(false)
  })
  it('normalises Pakistani phone numbers to one shape', () => {
    expect(normalizePhone('0300 1234567')).toBe('+923001234567')
    expect(normalizePhone('+92-300-1234567')).toBe('+923001234567')
    expect(normalizePhone('923001234567')).toBe('+923001234567')
  })
})

describe('real-time routing', () => {
  const venueId = '0198a000-0000-7000-8000-000000000001'
  const base = {
    type: 'slot.updated',
    venueId,
    courtId: 'c',
    slotId: 's',
    businessDate: '2026-10-20',
    status: 'BOOKED_WALKIN',
    version: 7,
    bookingId: 'secret-booking',
    blockReason: 'RAIN',
    holdExpiresAt: null,
    committedAt: '2026-10-20T10:00:00.000Z',
  }
  it('sends staff the full detail and the public room a reduced payload without customer data', () => {
    const routed = routeHotMessage(base)
    const pos = routed.find((r) => r.room === `pos:${venueId}`)!
    const pub = routed.find((r) => r.room === `venue:${venueId}:date:2026-10-20`)!
    expect(pos.payload.bookingId).toBe('secret-booking')
    expect(pos.payload.status).toBe('BOOKED_WALKIN')
    expect(pub.payload.status).toBe('BOOKED')
    expect(JSON.stringify(pub.payload)).not.toMatch(/secret-booking|RAIN|bookingId|blockReason/)
    expect(pub.payload.version).toBe(7)
  })
  it('routes booking changes to staff and to the booking owner only', () => {
    const r = routeHotMessage({
      type: 'booking.updated',
      bookingId: 'b',
      ref: 'KHI-AAAAA',
      venueId,
      userId: 'u1',
      status: 'CONFIRMED',
    })
    expect(r.map((x) => x.room).sort()).toEqual([`pos:${venueId}`, 'user:u1'].sort())
  })
  it('ignores unknown message types and messages with no venue', () => {
    expect(routeHotMessage({ type: 'nope' })).toEqual([])
    expect(routeHotMessage({ type: 'slot.updated' })).toEqual([])
  })
  it('classifies rooms and rejects anything else', () => {
    expect(classifyRoom(`venue:${venueId}:date:2026-10-20`).kind).toBe('public')
    expect(classifyRoom(`venue:${venueId}`).kind).toBe('public')
    expect(classifyRoom(`pos:${venueId}`)).toEqual({ kind: 'pos', venueId })
    expect(classifyRoom(`user:${venueId}`)).toEqual({ kind: 'user', userId: venueId })
    for (const bad of [
      'pos:*',
      'pos:../x',
      'admin',
      `pos:${venueId}:x`,
      `venue:${venueId}:date:tomorrow`,
      '',
    ]) {
      expect(classifyRoom(bad).kind, bad).toBe('invalid')
    }
  })
})
