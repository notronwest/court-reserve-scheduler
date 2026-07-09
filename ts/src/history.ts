/**
 * Historical popularity scoring — port of the parts of `history_analysis.py`
 * the recommender uses (`load_popularity` + `popularity_score`).
 *
 * A popularity score is the average MembersCount for a given
 * (canonical_event_id, day_of_week, time_band). Falls back to empty (all zeros)
 * when no history file is present, exactly like the Python.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { NaiveDateTime, pyRound } from './datetime'

const DEFAULT_HISTORY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'history',
  'history_latest.json',
)

// 1-hour bands, matching Python TIME_BANDS (name, lo, hi) with lo <= h < hi.
const TIME_BANDS: ReadonlyArray<readonly [string, number, number]> = [
  ['0600', 6, 7], ['0700', 7, 8], ['0800', 8, 9], ['0900', 9, 10],
  ['1000', 10, 11], ['1100', 11, 12], ['1200', 12, 13], ['1300', 13, 14],
  ['1400', 14, 15], ['1500', 15, 16], ['1600', 16, 17], ['1700', 17, 18],
  ['1800', 18, 19], ['1900', 19, 20], ['2000', 20, 24],
]

// Canonical approved event IDs → level. Must stay in sync with recommender.
const APPROVED_EVENT_IDS: Record<number, string> = {
  1717147: 'Beginner',
  1717131: 'Advanced Beginner',
  1931656: 'Intermediate',
  1672774: 'Advanced Intermediate',
  1633147: 'Advanced',
}
const LEVEL_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(APPROVED_EVENT_IDS).map(([id, lvl]) => [lvl, Number(id)]),
)
// Level keywords, longest first so "Advanced Intermediate" beats "Advanced".
const LEVEL_KEYWORDS = Object.values(APPROVED_EVENT_IDS).sort(
  (a, b) => b.length - a.length,
)

interface HistoryItem {
  EventName?: string
  EventId?: number | string | null
  StartDateTime: string
  DayOfTheWeek?: string
  MembersCount?: number | string | null
}

function canonicalEventId(rawEid: unknown, eventName: string): number | null {
  const eid =
    rawEid === null || rawEid === undefined || rawEid === ''
      ? null
      : Number(rawEid)
  if (eid !== null && Number.isInteger(eid) && eid in APPROVED_EVENT_IDS) {
    return eid
  }
  const nameLower = (eventName || '').toLowerCase()
  if (!nameLower.includes('open play')) return null
  for (const level of LEVEL_KEYWORDS) {
    if (nameLower.includes(level.toLowerCase())) return LEVEL_TO_ID[level]
  }
  return null
}

function timeBand(dt: NaiveDateTime): string {
  const h = dt.hour
  for (const [name, lo, hi] of TIME_BANDS) {
    if (h >= lo && h < hi) return name
  }
  return '2000'
}

function popKey(eventId: number, dayOfWeek: string, band: string): string {
  return `${eventId}|${dayOfWeek}|${band}`
}

export type PopularityScores = Map<string, number>

/** Load history → Map of "eid|dow|band" → avg MembersCount. Empty if no file. */
export function loadPopularity(
  historyPath: string = DEFAULT_HISTORY_PATH,
): PopularityScores {
  if (!existsSync(historyPath)) return new Map()

  const items = JSON.parse(readFileSync(historyPath, 'utf8')) as HistoryItem[]
  const buckets = new Map<string, number[]>()

  for (const item of items) {
    const eid = canonicalEventId(item.EventId, item.EventName ?? '')
    if (eid === null) continue
    const dt = NaiveDateTime.fromISO(item.StartDateTime)
    const dow = item.DayOfTheWeek || dt.weekdayName()
    const band = timeBand(dt)
    const count = Number(item.MembersCount ?? 0) || 0
    const key = popKey(eid, dow, band)
    const arr = buckets.get(key)
    if (arr) arr.push(count)
    else buckets.set(key, [count])
  }

  const scores: PopularityScores = new Map()
  for (const [key, vals] of buckets) {
    const avg = pyRound(vals.reduce((a, b) => a + b, 0) / vals.length, 1)
    scores.set(key, avg)
  }
  return scores
}

/** Avg attendance for this event/day/time-band, or 0 when unknown. */
export function popularityScore(
  scores: PopularityScores,
  eventId: number,
  dayOfWeek: string,
  slotStart: NaiveDateTime,
): number {
  return scores.get(popKey(eventId, dayOfWeek, timeBand(slotStart))) ?? 0
}

// ── Full stats + time patterns (used by the LLM ranker prompt) ────────────────

export interface PopularityStats {
  avg: number
  peak: number
  sessions: number
}

export interface PopularityFullEntry {
  eventId: number
  dayOfWeek: string
  band: string
  stats: PopularityStats
}

/** Load history → per (event, day, band) avg/peak/session-count. Empty if no file.
 *  Port of `history_analysis.load_popularity_full`. */
export function loadPopularityFull(
  historyPath: string = DEFAULT_HISTORY_PATH,
): PopularityFullEntry[] {
  if (!existsSync(historyPath)) return []

  const items = JSON.parse(readFileSync(historyPath, 'utf8')) as HistoryItem[]
  // Preserve insertion order (mirrors Python dict/defaultdict) for determinism.
  const buckets = new Map<string, { eventId: number; dayOfWeek: string; band: string; vals: number[] }>()

  for (const item of items) {
    const eid = canonicalEventId(item.EventId, item.EventName ?? '')
    if (eid === null) continue
    const dt = NaiveDateTime.fromISO(item.StartDateTime)
    const dow = item.DayOfTheWeek || dt.weekdayName()
    const band = timeBand(dt)
    const count = Number(item.MembersCount ?? 0) || 0
    const key = popKey(eid, dow, band)
    const b = buckets.get(key)
    if (b) b.vals.push(count)
    else buckets.set(key, { eventId: eid, dayOfWeek: dow, band, vals: [count] })
  }

  return [...buckets.values()].map(({ eventId, dayOfWeek, band, vals }) => ({
    eventId,
    dayOfWeek,
    band,
    stats: {
      avg: pyRound(vals.reduce((a, b) => a + b, 0) / vals.length, 1),
      peak: Math.max(...vals),
      sessions: vals.length,
    },
  }))
}

export interface TimePattern {
  modalHour: number
  consistencyPct: number
  nSessions: number
  avgAtModal: number
}

export interface TimePatternEntry {
  eventId: number
  dayOfWeek: string
  pattern: TimePattern
}

/** Recurring start-time tendencies strong enough to surface. Port of
 *  `history_analysis.load_time_patterns`. */
export function loadTimePatterns(
  historyPath: string = DEFAULT_HISTORY_PATH,
  minSessions = 3,
  minConsistency = 0.6,
): TimePatternEntry[] {
  if (!existsSync(historyPath)) return []

  const items = JSON.parse(readFileSync(historyPath, 'utf8')) as HistoryItem[]
  // (eid|dow|hour) → attendance counts, and (eid|dow) → total sessions.
  const hourCounts = new Map<string, number[]>()
  const sessionTotals = new Map<string, { eventId: number; dayOfWeek: string; total: number }>()

  for (const item of items) {
    const eid = canonicalEventId(item.EventId, item.EventName ?? '')
    if (eid === null) continue
    const dt = NaiveDateTime.fromISO(item.StartDateTime)
    const dow = item.DayOfTheWeek || dt.weekdayName()
    const hour = dt.hour
    const count = Number(item.MembersCount ?? 0) || 0
    const hk = `${eid}|${dow}|${hour}`
    const arr = hourCounts.get(hk)
    if (arr) arr.push(count)
    else hourCounts.set(hk, [count])
    const sk = `${eid}|${dow}`
    const st = sessionTotals.get(sk)
    if (st) st.total += 1
    else sessionTotals.set(sk, { eventId: eid, dayOfWeek: dow, total: 1 })
  }

  const out: TimePatternEntry[] = []
  for (const { eventId, dayOfWeek, total } of sessionTotals.values()) {
    if (total < minSessions) continue
    // Modal hour: most-frequent start hour; ties resolve to the first inserted
    // (matches Python max() over the defaultdict's insertion order).
    let modalHour = -1
    let modalN = -1
    for (const [hk, counts] of hourCounts) {
      const [e, d, h] = hk.split('|')
      if (Number(e) !== eventId || d !== dayOfWeek) continue
      if (counts.length > modalN) {
        modalN = counts.length
        modalHour = Number(h)
      }
    }
    const consistency = modalN / total
    if (consistency < minConsistency) continue
    const modalCounts = hourCounts.get(`${eventId}|${dayOfWeek}|${modalHour}`)!
    const avgAtModal = modalCounts.reduce((a, b) => a + b, 0) / modalN
    out.push({
      eventId,
      dayOfWeek,
      pattern: {
        modalHour,
        consistencyPct: pyRound(consistency * 100, 0),
        nSessions: total,
        avgAtModal: pyRound(avgAtModal, 1),
      },
    })
  }
  return out
}
