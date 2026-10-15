import { describe, it, expect } from 'vitest'
import { uuidv7 } from '../src/lib/id'
import { ceilToRupee, depositFor, splitExact, formatPKR } from '../src/lib/money'
import { businessDate, localParts } from '../src/lib/time'
import { ConflictError, NotFoundError, AppError } from '../src/utils/errors'

describe('uuidv7', () => {
  it('is a valid v7 uuid and time-ordered', () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_001_000)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a < b).toBe(true)
  })
})

describe('money', () => {
  it('deposit is 20% rounded UP to a whole rupee', () => {
    expect(depositFor(200000n)).toBe(40000n) // Rs 2000 -> Rs 400
    expect(depositFor(150050n)).toBe(30100n) // 30010 paisa -> up to Rs 301
    expect(depositFor(1n)).toBe(1n) // never above the total
    expect(depositFor(0n)).toBe(0n)
  })
  it('ceilToRupee', () => {
    expect(ceilToRupee(101n)).toBe(200n)
    expect(ceilToRupee(100n)).toBe(100n)
  })
  it('splitExact always sums to the total (random property test)', () => {
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(Math.random() * 6)
      const weights = Array.from({ length: n }, () =>
        BigInt(1 + Math.floor(Math.random() * 500000)),
      )
      const total = BigInt(Math.floor(Math.random() * 10_000_000))
      const parts = splitExact(total, weights)
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total)
      expect(parts.every((p) => p >= 0n)).toBe(true)
    }
  })
  it('splitExact is deterministic on ties', () => {
    expect(splitExact(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n])
  })
  it('rejects negatives and floats', () => {
    expect(() => ceilToRupee(-1n)).toThrow()
    expect(() => depositFor(1.5 as unknown as bigint)).toThrow()
  })
  it('formats PKR', () => {
    expect(formatPKR(150000n)).toBe('Rs 1,500')
    expect(formatPKR(150050n)).toBe('Rs 1,500.50')
  })
})

describe('time', () => {
  it('shows Karachi local time (UTC+5)', () => {
    expect(localParts(new Date('2026-10-12T19:30:00Z'))).toEqual({
      date: '2026-10-13',
      hour: 0,
      minute: 30,
    })
  })
  it('a 1 AM slot in a 06:00-02:00 window belongs to the previous business day', () => {
    const oneAm = new Date('2026-10-12T20:00:00Z') // 01:00 on 13 Oct in Karachi
    expect(businessDate(oneAm, { open: '06:00', close: '02:00' })).toBe('2026-10-12')
  })
  it('an evening slot keeps its own date', () => {
    const evening = new Date('2026-10-12T15:00:00Z') // 20:00 on 12 Oct
    expect(businessDate(evening, { open: '06:00', close: '02:00' })).toBe('2026-10-12')
  })
  it('a same-day window never shifts the date', () => {
    const morning = new Date('2026-10-12T03:00:00Z') // 08:00
    expect(businessDate(morning, { open: '06:00', close: '23:00' })).toBe('2026-10-12')
  })
})

describe('errors', () => {
  it('carry a stable machine code', () => {
    expect(new NotFoundError().code).toBe('NOT_FOUND')
    const e = new ConflictError('Slot is held', 'SLOT_HELD', { secondsRemaining: 40 })
    expect(e).toBeInstanceOf(AppError)
    expect(e.code).toBe('SLOT_HELD')
    expect(e.statusCode).toBe(409)
    expect(e.details).toEqual({ secondsRemaining: 40 })
  })
})

describe('money edge cases', () => {
  it('splitExact handles zero total and zero weights', () => {
    expect(splitExact(0n, [5n, 5n])).toEqual([0n, 0n])
    expect(splitExact(0n, [0n, 0n])).toEqual([0n, 0n])
    expect(() => splitExact(10n, [0n, 0n])).toThrow()
    expect(() => splitExact(10n, [])).toThrow()
    expect(() => splitExact(10n, [-1n, 2n])).toThrow()
  })
  it('splitExact is proportional for a real 3-hour booking', () => {
    // 3 hours: Rs 1500, 2000, 2500 with a Rs 1200 deposit
    const parts = splitExact(120000n, [150000n, 200000n, 250000n])
    expect(parts).toEqual([30000n, 40000n, 50000n])
  })
  it('deposit covers the documented example from the design (Rs 2000 -> Rs 400)', () => {
    expect(depositFor(200000n)).toBe(40000n)
    // matches the SQL formula ((total + 499) / 500) * 100 for many totals
    for (let t = 0n; t < 5000n; t += 7n) {
      const sql = ((t + 499n) / 500n) * 100n
      expect(depositFor(t)).toBe(sql > t ? t : sql)
    }
  })
})

describe('uuidv7 uniqueness', () => {
  it('generates 10k unique ids', () => {
    const s = new Set(Array.from({ length: 10000 }, () => uuidv7()))
    expect(s.size).toBe(10000)
  })
})

describe('time edge cases', () => {
  it('window crossing midnight: slot exactly at opening and last slot before close', () => {
    const w = { open: '06:00', close: '02:00' }
    expect(businessDate(new Date('2026-10-12T01:00:00Z'), w)).toBe('2026-10-12') // 06:00 local
    expect(businessDate(new Date('2026-10-12T20:59:00Z'), w)).toBe('2026-10-12') // 01:59 local 13th
    expect(businessDate(new Date('2026-10-12T21:00:00Z'), w)).toBe('2026-10-13') // 02:00 local: new day
  })
  it('month boundary: 1 AM on the 1st belongs to the last day of previous month', () => {
    expect(businessDate(new Date('2026-10-31T20:00:00Z'), { open: '06:00', close: '02:00' })).toBe(
      '2026-10-31',
    )
  })
})
