/**
 * Two scheduling rules Ron agreed on 2026-11-16, both in `policy.json`
 * `hard_constraints` and mirrored by `recommender.py`:
 *
 *  - `7_no_noon_start_mon_thu` — no event of any type starts at 12:00 Monday–Thursday.
 *  - `8_morning_crew_window_not_mixed` — Court Reserve holds ONE Morning Crew price per
 *    event ($0 for a session starting Mon–Thu 08:00–11:59, $12 outside it), so a recurring
 *    Open Play series never mixes inside and outside sessions; they are separate events.
 *
 * Window membership is decided by the START time alone: an 11:00 session that runs to 13:00
 * is inside. A rule absent from the policy is off (the fixture policies predate it).
 */
import type { Policy } from './policy'

export interface NoNoonRule {
  enabled?: boolean
  days: string[]
  start_time: string
}
export interface MorningCrewRule {
  enabled?: boolean
  days: string[]
  window_start: string
  window_end: string
}

function rule<T extends { enabled?: boolean }>(policy: Policy, name: string): T | undefined {
  const r = policy.hard_constraints[name] as T | undefined
  return r && r.enabled !== false ? r : undefined
}

/** True when an event on `day` starting at `startTime` ("HH:MM") breaks the no-noon rule. */
export function startsAtForbiddenNoon(policy: Policy, day: string, startTime: string): boolean {
  const r = rule<NoNoonRule>(policy, '7_no_noon_start_mon_thu')
  return !!r && r.days.includes(day) && startTime.slice(0, 5) === r.start_time
}

/** True when a session starting at `startTime` on `day` is inside the Morning Crew free window. */
export function inMorningCrewWindow(policy: Policy, day: string, startTime: string): boolean {
  const r = rule<MorningCrewRule>(policy, '8_morning_crew_window_not_mixed')
  if (!r || !r.days.includes(day)) return false
  const t = startTime.slice(0, 5)
  return t >= r.window_start && t <= r.window_end
}

export interface PatternRow {
  day_of_week?: string
  start_time: string
}

/**
 * Split one recurring pattern's occurrences into the events it must be booked as:
 * `[inside, outside]` with empty groups dropped. One group means the series is fine as is.
 */
export function splitByMorningCrewWindow<T extends PatternRow>(policy: Policy, rows: T[]): T[][] {
  const inside: T[] = []
  const outside: T[] = []
  for (const r of rows) {
    ;(inMorningCrewWindow(policy, r.day_of_week ?? '', r.start_time) ? inside : outside).push(r)
  }
  return [inside, outside].filter((g) => g.length > 0)
}

/**
 * The standing-pattern series (rows sharing an event id, else level, else name) whose
 * occurrences fall both inside and outside the Morning Crew window — each needs splitting
 * into separate events. Reported by name; the pattern itself is never rewritten here.
 */
export function mixedMorningCrewSeries(
  policy: Policy,
  rows: Array<PatternRow & { name: string; event_id?: number; level?: string }>,
): string[] {
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = String(r.event_id ?? r.level ?? r.name)
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: string[] = []
  for (const g of groups.values()) {
    if (splitByMorningCrewWindow(policy, g).length > 1) out.push(g[0].name)
  }
  return out
}
