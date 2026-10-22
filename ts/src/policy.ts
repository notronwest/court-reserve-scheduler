/**
 * Policy types + loader. Mirrors `policy_loader.py` — `policy.json` stays the
 * single source of business rules (data, not code). Only the fields the
 * recommender reads are typed; the rest is permitted via an index signature.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { NaiveDateTime } from './datetime'

export interface OperatingWindow {
  days: string[]
  start: string // "HH:MM"
  end: string // "HH:MM"
  hours: number
}

export interface FixedEvent {
  name: string
  /** Real Court Reserve EventId. When set, Pass 0 books this distinct event
   *  instead of mapping the slot to the level's generic Open Play event. */
  event_id?: number
  day_of_week: string
  start_time: string // "HH:MM"
  end_time: string // "HH:MM"
  courts?: number
  preferred_courts?: number[]
  max_participants?: number
  level?: string
  /** Last date this pattern runs, `YYYY-MM-DD`, from `courtreserve.fixed_events.until`
   *  (D-0056). The retirement switch: the dashboard stamps it rather than deleting the
   *  row. On or before today means retired — see `dropExpired` in `fixedEvents.ts`. */
  until?: string | null
  /** Cadence, from `courtreserve.fixed_events.every_weeks` (D-0202). 1 or 2; absent/null
   *  reads as weekly. Whether a date is a session is answered ONLY by `onWeekStatus`. */
  every_weeks?: number | null
  /** A real on-week date on `day_of_week`, `YYYY-MM-DD`. Required when `every_weeks` is 2. */
  anchor_date?: string | null
}

export type OnWeek = 'on' | 'off' | 'invalid'

/**
 * Is `date` a session of this standing pattern? The ONE copy of the every-other-week
 * arithmetic (D-0202): Pass 0, the per-day level tally, the pattern-gap scan and its fixer
 * all ask here, so they cannot disagree about which dates are sessions.
 *
 * A date is an on-week iff it falls on `day_of_week`, is on or after `anchor_date`, and
 * the whole weeks between them divide by `every_weeks`. `invalid` is a two-week row whose
 * anchor is missing, malformed or on the wrong weekday (or a cadence other than 1/2) —
 * never guessed at, never booked weekly; callers skip it and `fixedEvents` alerts.
 */
export function onWeekStatus(fe: FixedEvent, date: NaiveDateTime): OnWeek {
  if (fe.day_of_week !== date.weekdayName()) return 'off'
  if (invalidCadence(fe)) return 'invalid'
  if (fe.every_weeks == null || Number(fe.every_weeks) === 1) return 'on'
  const days = Math.round((date.ms - NaiveDateTime.parseDate(String(fe.anchor_date).slice(0, 10)).ms) / 86_400_000)
  if (days < 0) return 'off'
  return (days / 7) % 2 === 0 ? 'on' : 'off'
}

export function isOnWeek(fe: FixedEvent, date: NaiveDateTime): boolean {
  return onWeekStatus(fe, date) === 'on'
}

/** Two-week (or unsupported-cadence) rows that `onWeekStatus` cannot place on a calendar. */
export function invalidCadence(fe: FixedEvent): boolean {
  const every = fe.every_weeks == null ? 1 : Number(fe.every_weeks)
  if (every === 1) return false
  if (every !== 2) return true
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(fe.anchor_date ?? ''))
  if (!m) return true
  try {
    const a = NaiveDateTime.parseDate(m[1])
    return a.formatYmd() !== m[1] || a.weekdayName() !== fe.day_of_week
  } catch {
    return true
  }
}

export interface Policy {
  operating_windows: { weekday: OperatingWindow; weekend: OperatingWindow }
  utilization: { target_pct: number; baseline_courts: number }
  fixed_events?: { events?: FixedEvent[] }
  recommendation_rules: {
    min_recommendations: number
    preferred_block_duration_hours: { weekday: number; weekend: number }
    preferred_court_when_free?: number
    two_court_priority_pairs?: number[][]
    spread_throughout_day?: {
      enabled?: boolean
      time_bands?: Record<string, { start: string; end: string }>
    }
    [k: string]: unknown
  }
  hard_constraints: {
    '3_max_occurrences_per_event_per_day': {
      limit: number
      per_event_overrides?: Record<string, { limit: number }>
    }
    '3b_min_gap_same_event_hours': { hours: number }
    '4_required_level_coverage': { saturation_threshold?: number }
    '6_max_concurrent_courts'?: { limit: number }
    [k: string]: unknown
  }
  [k: string]: unknown
}

/** Default: `policy.json` at the repo root (one level above `ts/`). */
const DEFAULT_POLICY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'policy.json',
)

export function loadPolicy(policyPath: string = DEFAULT_POLICY_PATH): Policy {
  return JSON.parse(readFileSync(policyPath, 'utf8')) as Policy
}
