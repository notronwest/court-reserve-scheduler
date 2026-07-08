/**
 * Naive (timezone-free) datetime — mirrors Python's `datetime` as used by the
 * recommender. All Court Reserve timestamps are wall-clock with no offset, and
 * the Python code compares/formats them naively. We represent an instant as UTC
 * epoch milliseconds built from the wall-clock components, so arithmetic and
 * comparison are exact and free of any local-timezone drift.
 */

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const

export class NaiveDateTime {
  /** UTC epoch ms of the wall-clock components (never involves a real zone). */
  readonly ms: number

  private constructor(ms: number) {
    this.ms = ms
  }

  /** Parse ISO like `2026-07-09T17:00:00` (or space-separated). Ignores any
   *  fractional seconds / offset — CR data is naive. */
  static fromISO(s: string): NaiveDateTime {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
    if (!m) throw new Error(`Cannot parse ISO datetime: ${JSON.stringify(s)}`)
    const [, y, mo, d, h, mi, se] = m
    return new NaiveDateTime(
      Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0),
    )
  }

  /** Build from a `YYYY-MM-DD` date and `HH:MM` time (strptime "%Y-%m-%d %H:%M"). */
  static fromYMDHM(dateYmd: string, hm: string): NaiveDateTime {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd)
    const tm = /^(\d{1,2}):(\d{2})$/.exec(hm)
    if (!dm || !tm) throw new Error(`Cannot parse "${dateYmd} ${hm}"`)
    return new NaiveDateTime(Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]))
  }

  /** Parse a target date: `M/D/YYYY`, `MM/DD/YYYY`, or `YYYY-MM-DD` → midnight. */
  static parseDate(dateStr: string): NaiveDateTime {
    if (dateStr.includes('/')) {
      const p = dateStr.split('/')
      if (p.length !== 3) throw new Error(`Cannot parse date: ${JSON.stringify(dateStr)}`)
      const [mo, d, y] = p
      return new NaiveDateTime(Date.UTC(+y, +mo - 1, +d))
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
    if (!m) throw new Error(`Cannot parse date: ${JSON.stringify(dateStr)}`)
    return new NaiveDateTime(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  }

  addHours(h: number): NaiveDateTime {
    return new NaiveDateTime(this.ms + h * 3_600_000)
  }

  /** Difference in hours (this - other). */
  diffHours(other: NaiveDateTime): number {
    return (this.ms - other.ms) / 3_600_000
  }

  private get d(): Date {
    return new Date(this.ms)
  }

  get hour(): number {
    return this.d.getUTCHours()
  }

  get minute(): number {
    return this.d.getUTCMinutes()
  }

  /** Full weekday name, e.g. "Monday" (Python strftime "%A"). */
  weekdayName(): string {
    return WEEKDAYS[this.d.getUTCDay()]
  }

  /** "%Y-%m-%d" */
  formatYmd(): string {
    const dt = this.d
    const mo = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const day = String(dt.getUTCDate()).padStart(2, '0')
    return `${dt.getUTCFullYear()}-${mo}-${day}`
  }

  /** "%-m/%-d/%Y" — no leading zeros on month/day. */
  formatDate(): string {
    const dt = this.d
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}/${dt.getUTCFullYear()}`
  }

  /** "%-I:%M %p" — 12-hour, no leading zero on hour, uppercase AM/PM. */
  formatTime(): string {
    const h24 = this.hour
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12
    const mm = String(this.minute).padStart(2, '0')
    const ap = h24 < 12 ? 'AM' : 'PM'
    return `${h12}:${mm} ${ap}`
  }
}

/** Half-open overlap test — matches Python `_overlaps`. */
export function overlaps(
  s1: NaiveDateTime, e1: NaiveDateTime, s2: NaiveDateTime, e2: NaiveDateTime,
): boolean {
  return s1.ms < e2.ms && e1.ms > s2.ms
}

/**
 * Round half-to-even to `ndigits` decimals, matching Python's built-in `round`.
 * Used for the stats block so numeric output matches the Python recommender.
 */
export function pyRound(x: number, ndigits = 0): number {
  const m = 10 ** ndigits
  const scaled = x * m
  const floor = Math.floor(scaled)
  const frac = scaled - floor
  const EPS = 1e-9
  let rounded: number
  if (Math.abs(frac - 0.5) < EPS) {
    rounded = floor % 2 === 0 ? floor : floor + 1 // tie → even
  } else {
    rounded = Math.round(scaled)
  }
  return rounded / m
}
