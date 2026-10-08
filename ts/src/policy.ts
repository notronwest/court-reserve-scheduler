/**
 * Policy types + loader. Mirrors `policy_loader.py` — `policy.json` stays the
 * single source of business rules (data, not code). Only the fields the
 * recommender reads are typed; the rest is permitted via an index signature.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

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
