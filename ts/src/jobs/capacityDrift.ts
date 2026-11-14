/**
 * Capacity heal — every play session's cap matches the courts it holds.
 *
 * Ron, 2026-11-13: "The Court Reserve Scheduling has an issue where we either
 * have too few or too many courts for the maximum participants … make sure
 * this gets fixed and that we add this into the healing process in case
 * something gets accidentally modified that doesn't meet this criteria."
 *
 * The rule lives in `policy.json` `participant_limits` and is read through ONE
 * function (`capacity.ts`). This job is its enforcement: it reads what the
 * calendar is actually carrying and writes the table's answer back.
 *
 * Why it is a sweep and not only a booking-time rule: a cap is edited by hand
 * in Court Reserve, by a club admin widening a session or trimming one, and a
 * booking-time fix cannot see that. On the day this was written, 51 of the 109
 * occurrences in the next fortnight disagreed with the table — a two-court
 * Advanced Open Play capped at 4 (six of them), two-court Structured Play at 8
 * (eleven), a four-court Open Play Unleashed at 20 (five), a one-court Women's
 * Intermediate at 10 (two).
 *
 * THE TWO GUARDRAILS, both from shapes on that same live calendar:
 *
 * 1. A cap is never lowered BELOW the number already registered. A four-court
 *    session held 20 people against a table value of 18. Twenty people in an
 *    eighteen-person session is a roster problem, not a cap problem, and
 *    shrinking the cap under them hides it. Reported, never written.
 * 2. A cap is never RAISED on an occurrence that has a waitlist. Court Reserve
 *    notifies waitlisted members itself when room appears — that is a send to a
 *    member, which belongs to the waitlist-expansion path Ron approves by hand
 *    (`executeExpand`), not to a job that runs unattended five times a day.
 *
 * It also only touches the events the table governs — the club's play sessions.
 * A clinic capped at 4, a contract-time rental at 6 and a town hall at 100 each
 * carry a number chosen for that event, and a court count says nothing about
 * it. Those are counted and named in the report, never changed.
 */
import type { CourtReserveClient } from '../cr/client'
import type { RegistrationOccurrence, ScheduleItem } from '../cr/types'
import type { DiscordRest } from '../discord/rest'
import { loadPolicy, type Policy } from '../policy'
import {
  capForCourts,
  countCourts,
  governedByLimits,
  loadParticipantLimits,
  type ParticipantLimits,
} from '../capacity'

export type DriftVerdict =
  | 'compliant'
  | 'fixable'
  | 'not_governed'
  | 'below_roster'
  | 'waitlist_holds'
  | 'courts_unknown'

export interface DriftRow {
  res_id: string
  event_id: number
  event_name: string
  date: string
  date_text: string
  time_text: string
  courts: number
  courts_text: string
  current_max: number
  wanted_max: number
  registered: number
  waitlist: number
  verdict: DriftVerdict
  /** Set once the write has been attempted. */
  fixed?: boolean
  error?: string
}

/**
 * The pure half: what every occurrence should be carrying, and why.
 *
 * No network, so the whole truth table is testable without a browser — the same
 * split `scanPatternGaps` uses. `names` maps a Court Reserve event id to its
 * name; an id missing from it gets `courts_unknown`-grade treatment rather than
 * being judged against a blank name, because `governedByLimits('')` is false
 * and that would quietly read as "not a play session".
 */
export function scanCapacityDrift(
  limits: ParticipantLimits,
  occurrences: RegistrationOccurrence[],
  names: Map<number, string>,
): DriftRow[] {
  const rows: DriftRow[] = []
  for (const occ of occurrences) {
    const courts = countCourts(occ.courts_text)
    const name = names.get(occ.event_id) ?? ''
    const wanted = capForCourts(limits, courts)
    const row: DriftRow = {
      res_id: occ.res_id,
      event_id: occ.event_id,
      event_name: name || `Event ${occ.event_id}`,
      date: occ.date,
      date_text: occ.date_text,
      time_text: occ.time_text,
      courts,
      courts_text: occ.courts_text,
      current_max: occ.max_people,
      wanted_max: wanted,
      registered: occ.registered,
      waitlist: occ.waitlist,
      verdict: 'compliant',
    }
    // An occurrence whose courts could not be read, or whose name we never saw,
    // is not evidence of compliance. Say so instead of guessing.
    if (!courts || !name || !wanted) row.verdict = 'courts_unknown'
    else if (!governedByLimits(limits, name)) row.verdict = 'not_governed'
    else if (occ.max_people === wanted) row.verdict = 'compliant'
    else if (limits.neverLowerBelowRegistered && wanted < occ.registered) row.verdict = 'below_roster'
    else if (limits.neverRaiseWithWaitlist && wanted > occ.max_people && occ.waitlist > 0)
      row.verdict = 'waitlist_holds'
    else row.verdict = 'fixable'
    rows.push(row)
  }
  return rows
}

/** Court Reserve event ids and names for every EVENT in the window. */
export function eventNamesFromSchedule(items: ScheduleItem[]): Map<number, string> {
  const names = new Map<number, string>()
  for (const item of items) {
    if (!item.IsEvent) continue
    const eid = Number(item.EventId ?? 0)
    if (!eid) continue
    // `||`, not `??`: Court Reserve sends an EMPTY EventName on some rows and the
    // reservation type carries the name there. `??` keeps the empty string, and an
    // event with no name is dropped from this map — which makes every one of its
    // occurrences read as `courts_unknown` and never gets healed.
    const name = String(item.EventName || item.ReservationType || '').trim()
    if (name && !names.has(eid)) names.set(eid, name)
  }
  return names
}

/** Court ids for the court numbers an occurrence already holds. */
function courtIdsFor(policy: Policy, courtsText: string): string[] {
  const courts = policy.courts as unknown as Record<string, { number: number }>
  const nums = new Set((String(courtsText ?? '').match(/#(\d+)/g) ?? []).map((s) => Number(s.slice(1))))
  const ids: string[] = []
  for (const [cid, info] of Object.entries(courts)) if (nums.has(info.number)) ids.push(cid)
  return ids
}

export interface CapacityHealResult {
  rows: DriftRow[]
  fixed: DriftRow[]
  failed: DriftRow[]
  reported: DriftRow[]
  scannedEvents: number
}

/**
 * Read the calendar, write the table's answer back where it is safe to.
 *
 * `fix: false` is a full dry run: it reads and reports and writes nothing, which
 * is how this is run before it is trusted.
 */
export async function runCapacityHeal(
  cr: CourtReserveClient,
  rest: DiscordRest | null,
  opts: {
    days?: number
    fix?: boolean
    policy?: Policy
    log?: (m: string) => void
    /** Post the Discord report even when nothing drifted (default: only when something did). */
    alwaysReport?: boolean
  } = {},
): Promise<CapacityHealResult> {
  const log = opts.log ?? (() => {})
  const policy = opts.policy ?? loadPolicy()
  const limits = loadParticipantLimits(policy)
  const days = opts.days ?? limits.horizonDays

  // The names come from the schedule feed and the caps from the occurrences
  // grid: two reads, because neither carries both. The schedule is also what
  // tells us WHICH events to scan — a list of event ids in policy would stop
  // covering a play session booked under a new Court Reserve event.
  const today = new Date()
  const end = new Date(today.getTime() + days * 86_400_000)
  const mdy = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
  const items = await cr.schedule(mdy(today), mdy(end))
  const names = eventNamesFromSchedule(items)
  const eventIds = [...names.keys()]
  log(`Capacity: ${eventIds.length} event(s) on the next ${days} days; reading their caps…`)

  const occurrences = await cr.registrations(eventIds, days)
  const rows = scanCapacityDrift(limits, occurrences, names)
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1
    return acc
  }, {})
  log(
    `Capacity: ${rows.length} occurrence(s) — ` +
      Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', '),
  )

  const fixable = rows.filter((r) => r.verdict === 'fixable')
  const reported = rows.filter((r) => r.verdict === 'below_roster' || r.verdict === 'waitlist_holds')

  if (!opts.fix) {
    for (const r of fixable) {
      log(`  would set ${r.date} ${r.time_text} ${r.event_name}: ${r.current_max} → ${r.wanted_max} (${r.courts} court(s))`)
    }
    for (const r of reported) log(`  held back (${r.verdict}) ${r.date} ${r.time_text} ${r.event_name}`)
    return { rows, fixed: [], failed: [], reported, scannedEvents: eventIds.length }
  }

  const fixed: DriftRow[] = []
  const failed: DriftRow[] = []
  for (const r of fixable) {
    const courtIds = courtIdsFor(policy, r.courts_text)
    // The write is the SAME courts plus the right cap. `/events/courts` is the
    // only path that reaches MaxPeople (it is not on the add form), and it ticks
    // EditOnlyCurrentOccurrence — so a heal rewrites one occurrence and never
    // the series behind it.
    if (courtIds.length !== r.courts) {
      r.error = `could not map ${r.courts_text} to court ids`
      r.fixed = false
      failed.push(r)
      log(`  FAILED ${r.date} ${r.time_text} ${r.event_name}: ${r.error}`)
      continue
    }
    try {
      const res = (await cr.setCourts({
        res_id: r.res_id,
        court_ids: courtIds,
        max_people: r.wanted_max,
        event_id: String(r.event_id),
      })) as { success?: boolean; error?: string }
      if (res?.success === false) {
        r.fixed = false
        r.error = res.error ?? 'Court Reserve did not say why'
        failed.push(r)
        log(`  FAILED ${r.date} ${r.time_text} ${r.event_name}: ${r.error}`)
        continue
      }
      r.fixed = true
      fixed.push(r)
      log(`  set ${r.date} ${r.time_text} ${r.event_name}: ${r.current_max} → ${r.wanted_max}`)
    } catch (e) {
      r.fixed = false
      r.error = e instanceof Error ? e.message : String(e)
      failed.push(r)
      log(`  FAILED ${r.date} ${r.time_text} ${r.event_name}: ${r.error}`)
    }
  }

  if (rest && (opts.alwaysReport || fixed.length || failed.length || reported.length)) {
    await rest.postEmbed(buildCapacityEmbed({ rows, fixed, failed, reported, scannedEvents: eventIds.length }, limits, days))
  }
  return { rows, fixed, failed, reported, scannedEvents: eventIds.length }
}

/** The Discord report. Plain language: what a session now holds, not a field name. */
export function buildCapacityEmbed(
  result: CapacityHealResult,
  limits: ParticipantLimits,
  days: number,
): unknown {
  const { rows, fixed, failed, reported } = result
  const table = [...limits.maxByCourts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, m]) => `${c}→${m}`)
    .join('  ·  ')
  const lines: string[] = [
    `Checked **${rows.length}** session${rows.length === 1 ? '' : 's'} over the next ${days} days ` +
      `against the court limits (${table}, minimum ${limits.min}).`,
  ]
  if (fixed.length) {
    lines.push(
      '',
      `✅  **${fixed.length} put right**`,
      ...fixed.slice(0, 12).map(
        (r) => `• ${r.date_text} ${r.time_text} — ${r.event_name}: ${r.current_max} → **${r.wanted_max}** on ${r.courts} court${r.courts === 1 ? '' : 's'}`,
      ),
      ...(fixed.length > 12 ? [`• …and ${fixed.length - 12} more`] : []),
    )
  }
  if (reported.length) {
    lines.push(
      '',
      `👀  **${reported.length} left alone on purpose**`,
      ...reported.slice(0, 8).map((r) =>
        r.verdict === 'below_roster'
          ? `• ${r.date_text} ${r.time_text} — ${r.event_name}: ${r.registered} already signed up, more than the ${r.wanted_max} the courts allow`
          : `• ${r.date_text} ${r.time_text} — ${r.event_name}: ${r.waitlist} waiting, so raising the cap is the expansion approval, not this`,
      ),
    )
  }
  if (failed.length) {
    lines.push(
      '',
      `❌  **${failed.length} could not be saved**`,
      ...failed.slice(0, 8).map((r) => `• ${r.date_text} ${r.time_text} — ${r.event_name}: ${r.error}`),
    )
  }
  if (!fixed.length && !failed.length && !reported.length) lines.push('', 'Every play session matches its courts.')
  return {
    embeds: [
      {
        title: '🎾  Session sizes — court limits',
        color: failed.length ? 0xe74c3c : fixed.length ? 0x2ecc71 : 0x95a5a6,
        description: lines.join('\n'),
        footer: { text: 'White Mountain Pickleball • Court Reserve Scheduler' },
      },
    ],
  }
}
