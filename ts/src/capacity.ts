/**
 * How many people fit, given how many courts the session holds.
 *
 * Ron, 2026-11-13: "all single courts have 5 maximum, 2 courts has 10 maximum,
 * 3 courts has 14 maximum and 4 courts has 18 maximum. All have 4 minimum."
 *
 * ONE function, because the calendar used to carry three answers at once. The
 * fixed-event rows stored a cap per slot (8 for a pair of courts), the
 * pattern-gap fixer scaled that number proportionally when a slot landed on
 * fewer courts than it wanted, and the waitlist expansion divided it by the
 * court count and multiplied back up — so the same two-court session was 4, 5,
 * 8 or 10 depending on which code path last touched it. Measured on the live
 * 14-day calendar on 2026-11-13: 51 of 109 occurrences disagreed with the table.
 *
 * The cap is DERIVED, never stored: a session that holds two courts is 10,
 * whatever number sits in its `fixed_events` row. That is what makes the heal
 * in `jobs/capacityDrift.ts` able to state a single right answer.
 */
import { loadPolicy, type Policy } from './policy'

export interface ParticipantLimits {
  min: number
  /** Court count → max people. */
  maxByCourts: Map<number, number>
  /**
   * Per-name overrides of `maxByCourts`, first match wins. Structured Play is 4 per
   * court (Ron, 2026-11-14) while every other play session follows the general table.
   */
  byName: { pattern: string; maxByCourts: Map<number, number> }[]
  /** Lower-cased substrings of the event name the table governs. */
  namePatterns: string[]
  horizonDays: number
  neverLowerBelowRegistered: boolean
  neverRaiseWithWaitlist: boolean
}

interface RawLimits {
  min_participants?: number
  max_by_courts?: Record<string, number>
  by_name?: { name_pattern?: string; max_by_courts?: Record<string, number> }[]
  governs?: { name_patterns?: string[] }
  heal?: {
    horizon_days?: number
    never_lower_below_registered?: boolean
    never_raise_with_waitlist?: boolean
  }
}

/**
 * Read the table out of `policy.json`.
 *
 * FAILS LOUD on a missing or empty table. A silent `{}` here would make
 * `capForCourts` return 0 for every court count, and 0 is not "no opinion" to
 * the callers — `/book` reads a falsy cap as "leave it at Court Reserve's
 * default" and the healer would read every occurrence as compliant. A policy
 * file without the rule is a broken deploy, not a permissive one.
 *
 * A policy OBJECT that does not carry the block falls back to the file on disk
 * rather than throwing. Several tests hand a deliberately tiny policy —
 * `{ fixed_events: { events: [] } }` — to exercise one code path, and the club's
 * capacity rule is not the subject of those tests. The guarantee is unchanged
 * where it matters: the fallback reads the real `policy.json`, so a shipped
 * policy file with no rule in it still throws, from the same line.
 */
export function loadParticipantLimits(policy?: Policy): ParticipantLimits {
  let raw = (policy as { participant_limits?: RawLimits } | undefined)?.participant_limits
  if (!raw) raw = (loadPolicy() as { participant_limits?: RawLimits }).participant_limits
  if (!raw) throw new Error('policy.json has no participant_limits block — the court→capacity rule is missing')
  const maxByCourts = parseTable(raw.max_by_courts, 'max_by_courts')
  const byName = (raw.by_name ?? []).map((o, i) => {
    const pattern = String(o.name_pattern ?? '').trim().toLowerCase()
    if (!pattern) throw new Error(`participant_limits.by_name[${i}] has no name_pattern`)
    return { pattern, maxByCourts: parseTable(o.max_by_courts, `by_name[${i}].max_by_courts`) }
  })
  const min = raw.min_participants ?? 0
  const heal = raw.heal ?? {}
  return {
    min,
    maxByCourts,
    byName,
    namePatterns: (raw.governs?.name_patterns ?? []).map((p) => p.toLowerCase()),
    horizonDays: heal.horizon_days ?? 14,
    neverLowerBelowRegistered: heal.never_lower_below_registered !== false,
    neverRaiseWithWaitlist: heal.never_raise_with_waitlist !== false,
  }
}

function parseTable(table: Record<string, number> | undefined, label: string): Map<number, number> {
  const entries = Object.entries(table ?? {})
  if (!entries.length) throw new Error(`policy.json participant_limits.${label} is empty`)
  const out = new Map<number, number>()
  for (const [courts, max] of entries) {
    const n = Number(courts)
    if (!Number.isInteger(n) || n < 1) throw new Error(`participant_limits.${label} has a non-court key: ${courts}`)
    if (!Number.isInteger(max) || max < 1) throw new Error(`participant_limits.${label}[${courts}] is not a count: ${max}`)
    out.set(n, max)
  }
  return out
}

/**
 * The cap for a session on `courts` courts, or 0 when the table has nothing to
 * say about that many.
 *
 * `eventName` selects a per-name table (`by_name`) when one matches — Structured
 * Play is 4 / 8 / 12 / 16, not the general 5 / 10 / 14 / 18. A caller that does not
 * know the name gets the general table, which is what every caller got before.
 *
 * 0 means "the table does not cover this", and every caller treats it the same
 * way it always has: `/book` omits MaxPeople and Court Reserve's own default
 * stands. The club has four courts, so in practice only a 0-court call — a
 * booking that got no court at all, which is already a failure — lands here.
 */
export function capForCourts(limits: ParticipantLimits, courts: number, eventName = ''): number {
  return tableFor(limits, eventName).get(courts) ?? 0
}

/** The court→cap table that applies to an event name. */
export function tableFor(limits: ParticipantLimits, eventName = ''): Map<number, number> {
  const name = (eventName ?? '').toLowerCase()
  if (name) for (const o of limits.byName ?? []) if (name.includes(o.pattern)) return o.maxByCourts
  return limits.maxByCourts
}

/**
 * Does the court→capacity table govern this event?
 *
 * The club's play sessions — Open Play, Structured Play, Level Play — where the
 * courts ARE the capacity. A coached clinic, a contract-time rental, a school
 * group and a town hall each carry a number chosen for that event (4, 6, 100),
 * and how many courts they booked says nothing about it. Matching on the name
 * rather than on a list of event ids is deliberate: a new level of Open Play
 * appears on the calendar under a new Court Reserve event id every few months,
 * and a list would silently stop covering it.
 */
export function governedByLimits(limits: ParticipantLimits, eventName: string): boolean {
  const name = (eventName ?? '').toLowerCase()
  return limits.namePatterns.some((p) => name.includes(p))
}

/** Court numbers in a Court Reserve courts string ("Court #1, Court #3" → [1, 3]). */
export function countCourts(courtsText: string): number {
  const m = String(courtsText ?? '').match(/#\d+/g)
  return m ? new Set(m).size : 0
}
