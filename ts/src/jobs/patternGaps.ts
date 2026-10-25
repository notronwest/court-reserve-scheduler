/**
 * Does every standing session actually exist on the calendar?
 *
 * ## Why this is not catch-up
 *
 * `catch-up` asks "is this DAY full enough?" — court-hours against a target, plus "did the
 * daily run finish?". It is the right question for the failure it was built for (#50: a dead
 * fetch loses a whole date) and it is blind to the one Ron hit on 2026-10-13: a single
 * standing session missing from an otherwise healthy day. Monday 10/19 read **OK, 19h of
 * 26.4h** while the Co-ed Intermediate Structured Play that should run 5–7pm was simply not
 * there. Nothing in the fleet noticed; Ron did, by looking.
 *
 * A sweep of the next two weeks that afternoon found **21 missing sessions and 5 on fewer
 * courts than their pattern asks for**, with every day reported OK.
 *
 * So this job asks the other question, per session rather than per day: for each standing
 * pattern in `courtreserve.fixed_events` (D-0056), on each date its weekday falls in the
 * horizon, is there an occurrence of that event at that time, on as many courts as the
 * pattern wants?
 *
 * ## What it does about it (Ron, 2026-10-13: "Book it, alarm on the rest")
 *
 * | what it found | what happens |
 * |---|---|
 * | missing, event known, court free | **booked** — one occurrence with ALL its courts |
 * | missing, pattern has no Court Reserve event | alarm — nothing can be booked against it |
 * | missing, every court busy | alarm — the club is full, a human decides what gives |
 * | present TWICE at one hour (the duplicate bug) | alarm — reported, never widened or booked |
 * | present but short of courts, one free | **widened** to the full court count |
 * | present but short, nothing free | the cap is scaled instead, and it is reported |
 * | present, right courts | silent |
 *
 * ## Fail-closed
 *
 * - The pattern set must be a **live** read. `resolveFixedEvents` falls back to a cache and
 *   then to policy.json's seed, and a stale set could book a session the club retired — so
 *   anything but `live` books NOTHING and alarms instead.
 * - A schedule fetch that fails throws: the run exits non-zero, the wrapper withholds the
 *   heartbeat, and the fleet watchdog turns that silence into an alarm (D-0052 §4).
 * - A booking that fails is an alarm line, never a shrug.
 * - Silent when there is nothing to say — an alarm that fires every morning is one nobody
 *   reads, which is the mistake this fleet has already made twice (the wedge alert, #399).
 */
import { CourtReserveClient } from '../cr/client'
import type { ScheduleItem } from '../cr/types'
import { DiscordRest } from '../discord/rest'
import { sendPatternGapReport } from '../discord/notify'
import { NaiveDateTime } from '../datetime'
import { resolveFixedEvents } from '../fixedEvents'
import { COURTS } from '../recommender'
import { freeCourts, isCancelled, occupiedSlots, parseCourtNums, type OccupiedSlot } from '../availability'
import { isOnWeek, type FixedEvent, type Policy } from '../policy'

export type GapStatus =
  | 'ok'
  | 'booked'
  | 'widened'
  | 'capped'
  | 'no_event'
  | 'no_court'
  | 'failed'
  /** More than one occurrence of this session at this hour — reported, never acted on. */
  | 'duplicate'

export interface PatternGap {
  date: string // M/D/YYYY
  day_of_week: string
  start_time: string // "HH:MM"
  end_time: string
  name: string
  event_id?: number
  wants_courts: number
  has_courts: number
  /** Occurrences of this session found at this hour. >1 is the duplicate bug. */
  instances?: number
  status: GapStatus
  /** Court numbers booked or added, when something was done. */
  courts?: number[]
  /** The cap written, when fewer courts than the pattern wanted forced one. */
  max_people?: number
  error?: string
}

export interface PatternGapsResult {
  /** Everything that was not already correct — `ok` sessions are not carried. */
  gaps: PatternGap[]
  /** True when the pattern set came from a live read; nothing is booked when false. */
  patternsLive: boolean
  patternsSource: 'live' | 'cache' | 'seed'
  patternsAlert?: string
  daysScanned: number
}

/** Fold a name to letters and digits, so punctuation and spacing cannot hide a match. */
export function foldName(s: string | undefined): string {
  return (s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Is this schedule item THIS standing session?
 *
 * Name containment in either direction, because the two sides are written by different
 * hands: `courtreserve.fixed_events` carries the club's name for the slot and Court Reserve
 * carries the event's own title, and they differ by a level prefix, a stray double space or
 * a trailing blank more often than they match exactly. The start time is the anchor — two
 * sessions of the same event at the same minute would be the duplicate bug, not a match
 * question.
 */
export function matchesPattern(itemName: string | undefined, patternName: string): boolean {
  const a = foldName(itemName)
  const b = foldName(patternName)
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

/** "17:00" → "5:00 PM", the spelling courtreserve-api's forms take. */
export function clockToAmPm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10))
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

/**
 * A cap for a session that got fewer courts than it wanted.
 *
 * Ron, 2026-10-13, looking at a two-court session that landed on one: "we can't have 13
 * people on one court. The max would be 5." A pattern with no cap of its own stays
 * uncapped — inventing one would be deciding something nobody asked for.
 */
export function scaledCap(pattern: FixedEvent, courtsObtained: number): number {
  const full = pattern.max_participants ?? 0
  const wants = pattern.courts ?? 1
  if (!full || courtsObtained >= wants) return full
  return Math.max(1, Math.round((full * courtsObtained) / wants))
}

/** The dates in the horizon, as M/D/YYYY, starting today. */
export function horizonDates(today: NaiveDateTime, days: number): NaiveDateTime[] {
  return Array.from({ length: days }, (_, i) => today.addHours(24 * i))
}

/**
 * The pure half: what is missing or short, given the patterns and the live schedule.
 * Nothing here books, so a test can state the whole truth table without a browser.
 */
export function scanPatternGaps(
  patterns: readonly FixedEvent[],
  items: readonly ScheduleItem[],
  dates: readonly NaiveDateTime[],
  knownCourts: ReadonlySet<number> = new Set(Object.keys(COURTS).map(Number)),
): PatternGap[] {
  const out: PatternGap[] = []
  for (const date of dates) {
    const ymd = date.formatYmd()
    const dow = date.weekdayName()
    // A cancelled reservation is not the session being present — it is the
    // session being gone, which is exactly what this job exists to notice.
    const onThisDate = items.filter(
      (i) =>
        i.StartDateTime &&
        NaiveDateTime.fromISO(i.StartDateTime).formatYmd() === ymd &&
        !isCancelled(i),
    )
    for (const p of patterns) {
      // An off-week (or an unplaceable two-week row) is never missing — D-0202.
      if (!isOnWeek(p, date)) continue
      // EVERY occurrence at this hour, not the first one the feed happens to list.
      // Taking only the first made the outcome depend on CR's ordering: with a
      // healthy two-court instance AND a one-court duplicate at one hour, matching
      // the duplicate first read as "short of courts" and the fixer below widened
      // the DUPLICATE onto a third court — spending more of the club on the bug.
      const hits = onThisDate.filter(
        (i) =>
          NaiveDateTime.fromISO(i.StartDateTime as string).formatHm() === p.start_time &&
          matchesPattern(i.EventName, p.name),
      )
      const wants = p.courts ?? 1
      // Courts held across all of them, counted once each.
      const heldCourts = new Set<number>()
      for (const h of hits) {
        for (const c of parseCourtNums(h.Courts ?? '')) if (knownCourts.has(c)) heldCourts.add(c)
      }
      const has = heldCourts.size
      // One occurrence holding its courts is the healthy case and stays silent.
      if (hits.length === 1 && has >= wants) continue
      out.push({
        date: date.formatDate(),
        day_of_week: dow,
        start_time: p.start_time,
        end_time: p.end_time,
        name: p.name,
        event_id: p.event_id,
        wants_courts: wants,
        has_courts: has,
        instances: hits.length,
        // Resolved by the acting half below; this is the shape of the problem, not its
        // fate — except a duplicate, which is decided here because nothing may act on it.
        status: hits.length > 1 ? 'duplicate' : p.event_id ? 'no_court' : 'no_event',
      })
    }
  }
  return out
}

export interface PatternGapsDeps {
  rest: DiscordRest
  policy: Policy
  log?: (msg: string) => void
}

export interface PatternGapsOptions {
  /** Book and widen what it can. Without it the job only reports. */
  fix?: boolean
  horizonDays?: number
  today?: NaiveDateTime
}

export async function runPatternGaps(
  cr: CourtReserveClient,
  deps: PatternGapsDeps,
  opts: PatternGapsOptions = {},
): Promise<PatternGapsResult> {
  const log = deps.log ?? (() => {})
  const horizon = opts.horizonDays ?? 14
  const today = opts.today ?? NaiveDateTime.parseDate(new Date().toLocaleDateString('en-US'))
  const dates = horizonDates(today, horizon)

  const resolved = await resolveFixedEvents(cr, deps.policy)
  const patternsLive = resolved.source === 'live'
  if (!patternsLive) {
    log(`standing patterns came from ${resolved.source}, not a live read — nothing will be booked`)
  }

  // One fetch for the whole horizon: 14 single-day calls would be 14 chances to half-fail.
  const items = await cr.schedule(dates[0].formatDate(), dates[dates.length - 1].formatDate())
  const gaps = scanPatternGaps(resolved.events, items, dates)

  const courtOrder = Object.keys(COURTS).map(Number)
  const byDate = new Map<string, OccupiedSlot[]>()
  const occupiedOn = (date: NaiveDateTime): OccupiedSlot[] => {
    const key = date.formatYmd()
    if (!byDate.has(key)) byDate.set(key, occupiedSlots(items, key, new Set(courtOrder)))
    return byDate.get(key)!
  }

  for (const gap of gaps) {
    const date = NaiveDateTime.parseDate(gap.date)
    const start = NaiveDateTime.fromYMDHM(date.formatYmd(), gap.start_time)
    const end = NaiveDateTime.fromYMDHM(date.formatYmd(), gap.end_time)
    const pattern = resolved.events.find(
      (p) => p.name === gap.name && isOnWeek(p, date) && p.start_time === gap.start_time,
    )!
    const free = freeCourts(occupiedOn(date), courtOrder, start, end)

    if (!gap.event_id) continue // no_event — nothing to book against, and that is the alarm
    // A session booked twice at one hour is not a court shortage, and widening one of
    // the copies would make it worse. Removing the extra copy is a Court Reserve
    // cancel and a human's call, so this is reported and alarmed, never acted on.
    if (gap.status === 'duplicate') {
      log(
        `DUPLICATE ${gap.date} ${gap.start_time} ${gap.name} — ${gap.instances} occurrences ` +
          `at one hour on ${gap.has_courts} court(s); not touched`,
      )
      continue
    }
    if (!opts.fix || !patternsLive) {
      if (free.length) gap.status = 'no_court' // reported, not acted on
      continue
    }

    const needed = gap.wants_courts - gap.has_courts
    const take = free.slice(0, needed)
    if (!take.length) {
      // Genuinely full. If it is on one court and its pattern caps for more, scale the cap
      // rather than leaving 13 spots on a single court.
      gap.status = 'no_court'
      continue
    }

    const cap = scaledCap(pattern, gap.has_courts + take.length)
    const courtIds = take.map((n) => String(COURTS[n].id))
    try {
      if (gap.has_courts === 0) {
        const res = (await cr.book({
          event_id: String(gap.event_id),
          date: gap.date,
          start_time: clockToAmPm(gap.start_time),
          end_time: clockToAmPm(gap.end_time),
          court_ids: courtIds,
          max_people: cap,
        })) as { success?: boolean; error?: string }
        if (res?.success === false) {
          gap.status = 'failed'
          gap.error = res.error ?? 'Court Reserve did not say why'
          log(`FAILED ${gap.date} ${gap.start_time} ${gap.name}: ${gap.error}`)
          continue
        }
        gap.status = 'booked'
      } else {
        // Already there on too few courts: widen the occurrence, never book a second one.
        const existing = items.find(
          (i) =>
            i.StartDateTime &&
            NaiveDateTime.fromISO(i.StartDateTime).formatYmd() === date.formatYmd() &&
            NaiveDateTime.fromISO(i.StartDateTime).formatHm() === gap.start_time &&
            matchesPattern(i.EventName, gap.name) &&
            !isCancelled(i),
        )
        if (!existing?.Id) {
          gap.status = 'failed'
          gap.error = 'could not find the occurrence to add a court to'
          continue
        }
        const all = [
          ...parseCourtNums(existing.Courts ?? '').map((n) => String(COURTS[n]?.id ?? n)),
          ...courtIds,
        ]
        const res = (await cr.setCourts({
          res_id: String(existing.Id),
          court_ids: all,
          max_people: cap,
          event_id: String(gap.event_id),
        })) as { success?: boolean; error?: string }
        if (res?.success === false) {
          gap.status = 'failed'
          gap.error = res.error ?? 'Court Reserve did not say why'
          continue
        }
        gap.status = 'widened'
      }
      gap.courts = take
      gap.max_people = cap || undefined
      log(`${gap.status} ${gap.date} ${gap.start_time} ${gap.name} on ${take.map((n) => `#${n}`).join(', ')}`)
    } catch (e) {
      gap.status = 'failed'
      gap.error = e instanceof Error ? e.message : String(e)
      log(`FAILED ${gap.date} ${gap.start_time} ${gap.name}: ${gap.error}`)
    }
  }

  const result: PatternGapsResult = {
    gaps,
    patternsLive,
    patternsSource: resolved.source,
    patternsAlert: resolved.alert ?? (patternsLive ? undefined : `standing patterns read from ${resolved.source}`),
    daysScanned: dates.length,
  }
  await sendPatternGapReport(deps.rest, result)
  return result
}

/** Did this run leave anything a human has to deal with? Drives the exit code. */
export function needsAttention(result: PatternGapsResult): boolean {
  if (!result.patternsLive) return true
  return result.gaps.some(
    (g) =>
      g.status === 'no_event' ||
      g.status === 'no_court' ||
      g.status === 'failed' ||
      g.status === 'duplicate',
  )
}
