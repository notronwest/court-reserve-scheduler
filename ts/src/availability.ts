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

// ── Duplicate occurrences of one event at one hour ────────────────────────────
//
// Ron, 2026-10-24: "There are a lot of double booked courts and same sessions
// booked at the same time (e.g Advanced Open Play on 2 courts but two different
// instances)." The recommender no longer creates these, but the ones already on
// the calendar need finding, and the standing-pattern scan can only see the
// slots that are IN the pattern — keyed on the club's name for the slot, which
// is a different question from "is any event on the calendar booked twice".
// This keys on what Court Reserve itself reports: the same `EventId` at the same
// `StartDateTime`.

/** One occurrence of an event, as the schedule feed reports it. */
export interface EventOccurrence {
  /** The reservation/occurrence id — what a cancel is addressed to. */
  occurrence_id: number
  event_id: number
  name: string
  start: NaiveDateTime
  end: NaiveDateTime
  court_nums: number[]
  /** Registrants Court Reserve reports for this occurrence. */
  members: number
}

/** Several occurrences of ONE event at ONE start time: the duplicate. */
export interface DuplicateGroup {
  event_id: number
  name: string
  /** `M/D/YYYY`, for messages and for addressing a day. */
  date: string
  start: NaiveDateTime
  /** Every occurrence at this slot, the one to keep FIRST. */
  occurrences: EventOccurrence[]
}

/**
 * Which occurrence survives, given the rest are candidates to remove.
 *
 * An occurrence with registrants outranks an empty one, because removing it
 * means moving people. Among equals, the one holding more courts is the
 * healthier booking, and the lowest occurrence id breaks the tie so two runs
 * over the same calendar never disagree about which one to keep.
 */
export function rankForKeeping(a: EventOccurrence, b: EventOccurrence): number {
  if ((b.members > 0 ? 1 : 0) !== (a.members > 0 ? 1 : 0)) {
    return (b.members > 0 ? 1 : 0) - (a.members > 0 ? 1 : 0)
  }
  return (
    b.court_nums.length - a.court_nums.length ||
    b.members - a.members ||
    a.occurrence_id - b.occurrence_id
  )
}

/**
 * Read the feed into one entry per occurrence. Cancelled rows are not
 * occurrences (`isCancelled`), and a row with no id cannot be addressed, so
 * neither can take part in a duplicate decision.
 */
export function readOccurrences(
  items: readonly ScheduleItem[],
  knownCourts: ReadonlySet<number>,
): EventOccurrence[] {
  const out: EventOccurrence[] = []
  for (const item of items) {
    if (!item.StartDateTime || !item.EndDateTime) continue
    if (isCancelled(item)) continue
    const occurrenceId = Number(item.Id ?? NaN)
    const eventId = Number(item.EventId ?? NaN)
    if (!Number.isFinite(occurrenceId) || !Number.isFinite(eventId)) continue
    out.push({
      occurrence_id: occurrenceId,
      event_id: eventId,
      name: (item.EventName ?? '').trim(),
      start: NaiveDateTime.fromISO(item.StartDateTime),
      end: NaiveDateTime.fromISO(item.EndDateTime as string),
      court_nums: parseCourtNums(item.Courts ?? '').filter((c) => knownCourts.has(c)),
      members: Number((item as { MembersCount?: number | string | null }).MembersCount ?? 0) || 0,
    })
  }
  return out
}

/**
 * Every slot where one event has more than one occurrence, each group ordered
 * with the keeper first. Groups are returned in calendar order so a report and
 * a cleanup walk the days the same way.
 */
export function findDuplicateOccurrences(
  items: readonly ScheduleItem[],
  knownCourts: ReadonlySet<number>,
): DuplicateGroup[] {
  const groups = new Map<string, EventOccurrence[]>()
  for (const occ of readOccurrences(items, knownCourts)) {
    const key = `${occ.event_id}|${occ.start.ms}`
    const arr = groups.get(key)
    if (arr) arr.push(occ)
    else groups.set(key, [occ])
  }

  const out: DuplicateGroup[] = []
  for (const occurrences of groups.values()) {
    if (occurrences.length < 2) continue
    const ordered = [...occurrences].sort(rankForKeeping)
    out.push({
      event_id: ordered[0].event_id,
      name: ordered[0].name,
      date: ordered[0].start.formatDate(),
      start: ordered[0].start,
      occurrences: ordered,
    })
  }
  return out.sort((a, b) => a.start.ms - b.start.ms)
}
