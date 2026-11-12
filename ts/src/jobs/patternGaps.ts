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
 * | was on the calendar on an earlier run, gone now | **left alone** — a person removed it |
 * | was on all its courts on an earlier run, on fewer now | **left alone** — a person narrowed it |
 *
 * ## It only repairs what has never been whole (daemon D-0315)
 *
 * Ron, 2026-11-12: "the 'missing' events are re-added. However, they aren't missing -- I've
 * either deleted them or altered them (moved them to 1 court instead of 2)". Three faults
 * were behind that sentence, all measured on the live calendar the same day:
 *
 * 1. **A session was recognised by its NAME.** Two Court Reserve events had been renamed
 *    while their standing rows kept the old name, so a session that was sitting on the
 *    calendar read as missing and got a SECOND copy every morning (Fri 11/13 11:00 six
 *    mornings running; duplicates standing on 11/20, 11/23 and 11/24). A session is now
 *    recognised by its Court Reserve event first — `isSession`.
 * 2. **A delete leaves nothing behind.** A cancel is visible and already respected; a
 *    delete is not, so the hole was booked straight back.
 * 3. **A session cut from two courts to one read as short** and was widened back.
 *
 * 2 and 3 cannot be told from real damage by looking at the calendar once, so the job
 * remembers: `SeenLedger` records, per session per date, whether it has EVER been seen on
 * the calendar and whether it has EVER held all its courts. It repairs a session the first
 * time it meets it; after that, whatever happens to it was done by a person and stays.
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fixedEventsStateDir, resolveFixedEvents } from '../fixedEvents'
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
  /**
   * The session IS on the calendar for this date, cancelled. A human took the court back
   * (D-0248). Never re-booked, never alarmed — it is not missing, it is withdrawn.
   */
  | 'withdrawn'
  /**
   * The session IS on the calendar for this date, at a different hour. A human moved it
   * (D-0248, 2026-10-28 addendum). Never re-booked — a move leaves nothing behind in Court Reserve, so without
   * this the sweep reads the old hour as empty and books the session a SECOND time.
   */
  | 'moved'

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
  /** True on the run that found no memory and started one: everything was left as found. */
  baseline?: boolean
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

/**
 * Is this calendar item an occurrence of THIS standing session?
 *
 * The Court Reserve event first, the name second. The name alone is what re-added sessions
 * every morning in November 2026: event 2316716 was retitled "Co-Ed Advanced Intermediate
 * Structured Play" while its standing row still said "Co-ed Intermediate Structured Play",
 * the two no longer contained one another, and a session holding two courts read as absent.
 * A title is something a person edits; the event behind it is not.
 *
 * Either one is enough. Matching MORE is the safe direction here — a false match leaves a
 * slot alone, a false miss books a duplicate in front of members.
 */
export function isSession(item: ScheduleItem, p: Pick<FixedEvent, 'name' | 'event_id'>): boolean {
  const itemEvent = Number(item.EventId)
  if (p.event_id && Number.isFinite(itemEvent) && itemEvent > 0 && itemEvent === Number(p.event_id)) {
    return true
  }
  return matchesPattern(item.EventName, p.name)
}

/** What the job remembers about one session on one date. */
export interface SeenEntry {
  /** It has been on the calendar, on at least one court, on some earlier read. */
  seen: boolean
  /** It has held every court its pattern asks for, on some earlier read. */
  whole: boolean
}

/** Keyed by `ledgerKey`. Only ever written from a calendar READ, never from a booking's reply. */
export type SeenLedger = Record<string, SeenEntry>

/** Where the memory lives. `load` returns null when there is none yet (or it is unreadable). */
export interface SeenMemory {
  load(): SeenLedger | null
  save(ledger: SeenLedger): void
}

export function ledgerKey(p: Pick<FixedEvent, 'name' | 'event_id' | 'start_time'>, date: NaiveDateTime): string {
  return `${date.formatYmd()}|${p.start_time}|${p.event_id ?? foldName(p.name)}`
}

/** Courts this session holds on this date at its own hour, and how many occurrences hold them. */
function holding(
  p: FixedEvent,
  date: NaiveDateTime,
  items: readonly ScheduleItem[],
  knownCourts: ReadonlySet<number>,
): { instances: number; courts: number } {
  const ymd = date.formatYmd()
  const hits = items.filter(
    (i) =>
      i.StartDateTime &&
      !isCancelled(i) &&
      NaiveDateTime.fromISO(i.StartDateTime).formatYmd() === ymd &&
      NaiveDateTime.fromISO(i.StartDateTime).formatHm() === p.start_time &&
      isSession(i, p),
  )
  const held = new Set<number>()
  for (const h of hits) for (const c of parseCourtNums(h.Courts ?? '')) if (knownCourts.has(c)) held.add(c)
  return { instances: hits.length, courts: held.size }
}

/**
 * Fold one calendar read into the memory. Pure: returns a new ledger.
 *
 * `baseline` is the first run, when there is no memory at all. Everything in the horizon is
 * then recorded as already settled — present or not, full or not — because the job cannot
 * tell which of today's holes a person made, and re-adding a session someone removed is the
 * expensive mistake (D-0248's asymmetry). Dates that enter the horizon afterwards are
 * repaired normally, so within a fortnight every date is under the ordinary rule.
 *
 * Entries for dates before the horizon's first day are dropped; nothing reads them again.
 */
export function recordSeen(
  ledger: SeenLedger,
  patterns: readonly FixedEvent[],
  items: readonly ScheduleItem[],
  dates: readonly NaiveDateTime[],
  opts: { baseline?: boolean; knownCourts?: ReadonlySet<number> } = {},
): SeenLedger {
  const knownCourts = opts.knownCourts ?? new Set(Object.keys(COURTS).map(Number))
  const first = dates.length ? dates[0].formatYmd() : ''
  const out: SeenLedger = {}
  for (const [k, v] of Object.entries(ledger)) if (k.slice(0, 10) >= first) out[k] = { ...v }
  for (const date of dates) {
    for (const p of patterns) {
      if (!isOnWeek(p, date)) continue
      const key = ledgerKey(p, date)
      const prior = out[key] ?? { seen: false, whole: false }
      if (opts.baseline) {
        out[key] = { seen: true, whole: true }
        continue
      }
      const now = holding(p, date, items, knownCourts)
      const seen = prior.seen || now.courts > 0
      const whole = prior.whole || (now.instances === 1 && now.courts >= (p.courts ?? 1))
      if (seen || whole) out[key] = { seen, whole }
    }
  }
  return out
}

/** The memory as a file beside the standing-pattern cache. Written whole, then renamed. */
export function fileSeenMemory(dir: string = fixedEventsStateDir(), log: (m: string) => void = () => {}): SeenMemory {
  const path = resolve(dir, 'pattern-gaps-seen.json')
  return {
    load() {
      if (!existsSync(path)) return null
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as { entries?: SeenLedger }
        if (data && typeof data.entries === 'object' && data.entries !== null) return data.entries
      } catch (e) {
        log(`memory file unreadable (${e instanceof Error ? e.message : String(e)})`)
      }
      // Unreadable is treated exactly like absent: a fresh baseline, which books nothing.
      return null
    },
    save(ledger) {
      mkdirSync(dir, { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, saved_at: new Date().toISOString(), entries: ledger }, null, 2))
      renameSync(tmp, path)
    },
  }
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
  /** What earlier runs saw. Omitted, the scan has no memory and every hole is a gap. */
  ledger: SeenLedger = {},
): PatternGap[] {
  const out: PatternGap[] = []
  for (const date of dates) {
    const ymd = date.formatYmd()
    const dow = date.weekdayName()
    // ⚠️ A cancelled occurrence is NOT an absence to repair (D-0248). Ron, 2026-10-28:
    // "during the week I may delete an event that is set to recurring because I need the
    // court -- we should not try and fix the missing recurring event." This job used to
    // filter cancellations out and then book the hole straight back, so taking a court
    // back by hand lasted until the next sweep. Both lists are kept: `onThisDate` is what
    // is actually holding court, `cancelledOnDate` is what a human deliberately removed.
    const sameDay = items.filter(
      (i) => i.StartDateTime && NaiveDateTime.fromISO(i.StartDateTime).formatYmd() === ymd,
    )
    const onThisDate = sameDay.filter((i) => !isCancelled(i))
    const cancelledOnDate = sameDay.filter((i) => isCancelled(i))
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
          isSession(i, p),
      )
      // Withdrawn beats missing: if this session is on the calendar for this date and
      // cancelled, a human took the court back and that is the end of it. Checked BEFORE
      // the court arithmetic so a withdrawn session is never counted as short either.
      if (
        hits.length === 0 &&
        cancelledOnDate.some(
          (i) =>
            NaiveDateTime.fromISO(i.StartDateTime as string).formatHm() === p.start_time &&
            isSession(i, p),
        )
      ) {
        continue
      }
      // Moved beats missing, for the same reason and a harder one (D-0248 addendum). Ron,
      // 2026-10-28: "Make it so that moves of an event on the same day count -- so its not
      // recreated during the sweep." A Court Reserve MOVE edits the occurrence in place and
      // leaves NOTHING behind at the old hour — no cancellation, no trace — so the rule
      // above cannot see it and the sweep books the session a second time. Measured:
      // Mens Advanced Plus was booked 10/29 17:00 on courts 1+2, then moved to 16:00 on
      // 3+4; the next sweep reported 17:00 missing and would have made a duplicate at
      // 08:45 the following morning.
      //
      // A candidate must not already belong to ANOTHER pattern's own hour — two patterns
      // of one name on one day (an early and a late sitting) would otherwise let the
      // present one silence the absent one.
      if (hits.length === 0) {
        const claimedHours = new Set(
          patterns
            .filter(
              (q) =>
                (q.name === p.name || (p.event_id !== undefined && q.event_id === p.event_id)) &&
                isOnWeek(q, date),
            )
            .map((q) => q.start_time),
        )
        const movedTo = onThisDate.find(
          (i) =>
            isSession(i, p) &&
            !claimedHours.has(NaiveDateTime.fromISO(i.StartDateTime as string).formatHm()),
        )
        if (movedTo) continue
      }
      const wants = p.courts ?? 1
      // Courts held across all of them, counted once each.
      const heldCourts = new Set<number>()
      for (const h of hits) {
        for (const c of parseCourtNums(h.Courts ?? '')) if (knownCourts.has(c)) heldCourts.add(c)
      }
      const has = heldCourts.size
      // One occurrence holding its courts is the healthy case and stays silent.
      if (hits.length === 1 && has >= wants) continue
      // Removed or narrowed by hand (D-0315). Ron, 2026-11-12: "they aren't missing -- I've
      // either deleted them or altered them (moved them to 1 court instead of 2)". A delete
      // leaves no cancellation behind and a narrowing looks exactly like a short booking, so
      // neither can be read off the calendar; what tells them from damage is that an earlier
      // run SAW this session here (or saw it on all its courts). A duplicate is not covered:
      // two copies at one hour is still reported.
      const known = ledger[ledgerKey(p, date)]
      if (hits.length === 0 && known?.seen) continue
      if (hits.length === 1 && has > 0 && known?.whole) continue
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
  /**
   * What earlier runs saw (D-0315). The scheduled job always passes the file-backed one;
   * without it the run has no memory and repairs every hole, which is only right in a test.
   */
  memory?: SeenMemory
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
  // Memory is only trusted alongside a live pattern set: a cached or seeded set could mark
  // a retired session's hole as "seen", and nothing is booked on such a run anyway.
  const prior = deps.memory?.load() ?? null
  const baseline = Boolean(deps.memory) && prior === null && patternsLive
  let ledger: SeenLedger = prior ?? {}
  if (baseline) {
    ledger = recordSeen({}, resolved.events, items, dates, { baseline: true })
    log(
      'no memory of earlier runs — recorded the calendar as it stands and left it alone; ' +
        'dates that come into range from tomorrow are repaired as usual',
    )
  }
  const gaps = scanPatternGaps(resolved.events, items, dates, undefined, ledger)
  if (deps.memory && patternsLive && !baseline) ledger = recordSeen(ledger, resolved.events, items, dates)

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
            isSession(i, pattern) &&
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

  if (deps.memory && patternsLive) {
    // What this run booked or widened is remembered only once the calendar SHOWS it — a
    // booking's "success" has been wrong before (the occurrence "could not be found
    // afterwards", 2026-10-29). Without this second read, a session booked at 8:45 and
    // removed by hand at 9:00 would never have been seen, and would be booked again tomorrow.
    if (gaps.some((g) => g.status === 'booked' || g.status === 'widened')) {
      try {
        const after = await cr.schedule(dates[0].formatDate(), dates[dates.length - 1].formatDate())
        ledger = recordSeen(ledger, resolved.events, after, dates)
      } catch (e) {
        log(`could not re-read the calendar after booking (${e instanceof Error ? e.message : String(e)}) — today's bookings are not remembered yet`)
      }
    }
    // A memory that cannot be written throws: the run exits non-zero, the heartbeat is
    // withheld and the watchdog alarms, rather than the job quietly forgetting every day.
    deps.memory.save(ledger)
  }

  const result: PatternGapsResult = {
    gaps,
    baseline,
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
