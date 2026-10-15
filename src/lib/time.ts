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

function prevDay(date: string): string {
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
