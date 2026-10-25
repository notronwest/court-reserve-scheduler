/**
 * Court availability — who is already on which court, and when.
 *
 * The daily recommender has always enforced hard constraint #1 ("no same-court
 * overlap with existing events") by parsing the live schedule itself. The ad-hoc
 * `!book` path never did: `parseBookCommand` is a pure text parser that only
 * ever sees `policy.json`, so a request that omitted a court got whatever court
 * the LLM felt like naming — and it was booked without anyone checking whether
 * that court was free. This module is the shared answer both paths use.
 */
import { NaiveDateTime, overlaps } from './datetime'
import type { ScheduleItem } from './cr/types'

/** One court-hour block already taken on the live schedule. */
export interface OccupiedSlot {
  court_num: number
  start: NaiveDateTime
  end: NaiveDateTime
  event_id: number | undefined
  name: string
}

/**
 * A Court Reserve row for a CANCELLED reservation.
 *
 * The `/schedule` feed can carry them, which is why `jobs/fixImbalance.ts` has
 * skipped them since it was written — it was the only reader that did, by its own
 * copy of this test. That mattered more once the recommender started counting
 * every live occurrence toward the no-repeat constraints: a cancelled occurrence
 * left in the tally reads as the session still being there, so cancelling one of
 * two duplicates would also stop the real one from ever being re-booked, and the
 * court it used to hold would stay blocked for everything else forever. One
 * predicate, used by every reader of the feed, rather than a second copy.
 *
 * The heuristic is Court Reserve's own spelling: the word appears in the event
 * name or in `ReservationType`. Keep it here, so a better signal from the service
 * is adopted in one place.
 */
export function isCancelled(item: ScheduleItem): boolean {
  const name = String(item.EventName ?? '').toLowerCase()
  const resType = String((item as { ReservationType?: string }).ReservationType ?? '').toLowerCase()
  return name.includes('cancel') || resType.includes('cancel')
}

/** Court numbers named in a CR `Courts` string, e.g. "Court #3, Court #4" → [3, 4]. */
export function parseCourtNums(courtsStr: string): number[] {
  const out: number[] = []
  const re = /Court #(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(courtsStr || '')) !== null) out.push(Number(m[1]))
  return out
}

/**
 * Flatten a CR schedule into one entry per (court, time-block) on `dateYmd`
 * (`YYYY-MM-DD`). A two-court event yields two entries. Courts outside
 * `knownCourts` are dropped — CR returns non-pickleball resources too, and a
 * cancelled reservation holds no court.
 */
export function occupiedSlots(
  items: ScheduleItem[],
  dateYmd: string,
  knownCourts: ReadonlySet<number>,
): OccupiedSlot[] {
  const out: OccupiedSlot[] = []
  for (const item of items) {
    if (!item.StartDateTime || !item.EndDateTime) continue
    if (isCancelled(item)) continue
    const start = NaiveDateTime.fromISO(item.StartDateTime)
    if (start.formatYmd() !== dateYmd) continue
    const end = NaiveDateTime.fromISO(item.EndDateTime as string)
    for (const cn of parseCourtNums(item.Courts ?? '')) {
      if (!knownCourts.has(cn)) continue
      out.push({
        court_num: cn,
        start,
        end,
        event_id: item.EventId,
        name: (item.EventName ?? '').trim(),
      })
    }
  }
  return out
}

/** Every occupied slot that collides with `[start, end)` on one of `courtNums`. */
export function conflictsFor(
  occupied: readonly OccupiedSlot[],
  courtNums: readonly number[],
  start: NaiveDateTime,
  end: NaiveDateTime,
): OccupiedSlot[] {
  const wanted = new Set(courtNums)
  return occupied.filter((o) => wanted.has(o.court_num) && overlaps(start, end, o.start, o.end))
}

/**
 * Courts with nothing on them for `[start, end)`, in `courtOrder`. Used to fill
 * in a court when the `!book` request didn't name one.
 */
export function freeCourts(
  occupied: readonly OccupiedSlot[],
  courtOrder: readonly number[],
  start: NaiveDateTime,
  end: NaiveDateTime,
): number[] {
  return courtOrder.filter((cn) => conflictsFor(occupied, [cn], start, end).length === 0)
}

/** "Court #1 5:00 PM – 7:00 PM Mens Advanced Plus Open Play" — for error text. */
export function describeConflict(o: OccupiedSlot): string {
  const label = o.name || 'an existing booking'
  return `Court #${o.court_num} ${o.start.formatTime()} – ${o.end.formatTime()} ${label}`
}
