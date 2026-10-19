/**
 * All instants are UTC. Venue-local dates are computed with an IANA zone (default Asia/Karachi).
 */
export const DEFAULT_TZ = 'Asia/Karachi'

/** Local parts of an instant in a zone. */
export function localParts(instant: Date, tz = DEFAULT_TZ) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]))
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
  }
}

export function prevDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Business date of a slot: the venue-local day the opening window started.
 * For a window that crosses midnight (close <= open, e.g. 06:00-02:00) the after-midnight part
 * belongs to the previous day, so a 1 AM slot belongs to the day before.
 */
export function businessDate(
  startAt: Date,
  window: { open: string; close: string },
  tz = DEFAULT_TZ,
): string {
  const { date, hour, minute } = localParts(startAt, tz)
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  const open = toMin(window.open)
  const close = toMin(window.close)
  const crossesMidnight = close <= open
  const mins = hour * 60 + minute
  return crossesMidnight && mins < open && mins < close ? prevDay(date) : date
}

/** Offset (ms) of a zone from UTC at a given instant: local wall clock minus UTC. */
function zoneOffsetMs(instant: Date, tz: string): number {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The UTC instant of a local wall-clock time: `date` (yyyy-mm-dd, venue-local) plus `minutes`
 * since local midnight (may exceed 1440 for after-midnight slots). Uses the IANA zone rules, so
 * zones with daylight saving are handled; no fixed offsets.
 */
export function zonedTimeToUtc(date: string, minutes: number, tz = DEFAULT_TZ): Date {
  const [y, m, d] = date.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d, 0, minutes)
  let guess = wall - zoneOffsetMs(new Date(wall), tz)
  // the offset may differ at the corrected instant (daylight saving boundary): refine once
  guess = wall - zoneOffsetMs(new Date(guess), tz)
  return new Date(guess)
}

/** Today's date in a zone (yyyy-mm-dd). */
export function todayIn(tz = DEFAULT_TZ, now = new Date()): string {
  return localParts(now, tz).date
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
