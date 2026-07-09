/**
 * Scheduling recommender for White Mountain Pickleball — TypeScript port of the
 * rule-based path in `recommender.py`. Pure logic, no I/O beyond the injected
 * policy + popularity scores. The LLM path (Pass 1+2 replacement) lands in a
 * later phase; this covers Pass 0 (fixed events), Pass 1 (level coverage), and
 * Pass 2 (utilization fill), which is what the parity tests assert against.
 */
import { NaiveDateTime, overlaps, pyRound } from './datetime'
import type { Policy } from './policy'
import { loadPopularity, popularityScore, type PopularityScores } from './history'
// Type-only import — no runtime cycle (ranker.ts imports values from here).
import type { LlmRankerInput } from './llm/ranker'

// ── Static configuration (mirrors recommender.py) ────────────────────────────

export const COURTS: Record<number, { id: number; label: string }> = {
  1: { id: 52349, label: 'Pickleball-Court #1' },
  2: { id: 52350, label: 'Pickleball-Court #2' },
  3: { id: 52351, label: 'Pickleball-Court #3' },
  4: { id: 52352, label: 'Pickleball-Court #4' },
}

export interface ApprovedEvent {
  id: number
  name: string
  level: string
}

// Insertion order matters for stable-sort tie-breaks — keep this list ordered.
export const APPROVED_EVENTS_ORDER: ApprovedEvent[] = [
  { id: 1717147, name: 'Co-Ed Beginner Open Play', level: 'Beginner' },
  { id: 1717131, name: 'Co-Ed Advanced Beginner Open Play', level: 'Advanced Beginner' },
  { id: 1931656, name: 'Co-ed Intermediate Open Play', level: 'Intermediate' },
  { id: 1672774, name: 'Co-ed Advanced Intermediate Open Play', level: 'Advanced Intermediate' },
  { id: 1633147, name: 'Co-ed Advanced Open Play', level: 'Advanced' },
]
export const APPROVED_EVENTS = new Map(APPROVED_EVENTS_ORDER.map((e) => [e.id, e]))

export const LEVEL_ORDER = [
  'Beginner',
  'Advanced Beginner',
  'Intermediate',
  'Advanced Intermediate',
  'Advanced',
] as const

const LEVEL_TO_EVENT_ID: Record<string, number> = Object.fromEntries(
  APPROVED_EVENTS_ORDER.map((e) => [e.level, e.id]),
)

// ── Data structures ───────────────────────────────────────────────────────────

export interface Recommendation {
  event_id: number
  event_name: string
  level: string
  court_num: number
  court_id: number
  court_label: string
  start: NaiveDateTime
  end: NaiveDateTime
  extra_court_ids: number[]
  extra_court_nums: number[]
  max_participants: number
}

export interface RecommendationDict {
  event_id: number
  event_name: string
  level: string
  court_num: number
  court_id: number
  court_label: string
  extra_court_ids: number[]
  extra_court_nums: number[]
  max_participants: number
  date: string
  start_time: string
  end_time: string
}

export function toDict(r: Recommendation): RecommendationDict {
  return {
    event_id: r.event_id,
    event_name: r.event_name,
    level: r.level,
    court_num: r.court_num,
    court_id: r.court_id,
    court_label: r.court_label,
    extra_court_ids: r.extra_court_ids,
    extra_court_nums: r.extra_court_nums,
    max_participants: r.max_participants,
    date: r.start.formatDate(),
    start_time: r.start.formatTime(),
    end_time: r.end.formatTime(),
  }
}

export interface ScheduleItem {
  Id?: number
  EventId?: number
  StartDateTime?: string
  EndDateTime?: string
  Courts?: string
  EventName?: string
  [k: string]: unknown
}

export interface Stats {
  target_date: string
  day_of_week: string
  existing_court_hours: number
  recommended_court_hours: number
  achieved_court_hours: number
  target_court_hours: number
  achieved_pct: number
  target_pct: number
  gap_court_hours: number
  gap_pct_points: number
  levels_covered: string[]
  levels_missing: string[]
  min_recommendations_met: boolean
  n_recommendations: number
  popularity_used: boolean
  existing_level_counts: Record<string, number>
  rec_source: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCourtNums(courtsStr: string): number[] {
  const out: number[] = []
  const re = /Court #(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(courtsStr || '')) !== null) out.push(Number(m[1]))
  return out
}

interface ExistingEvent {
  court_num: number
  start: NaiveDateTime
  end: NaiveDateTime
  event_id: number | undefined
  name: string
}

interface Slot {
  cn: number
  ss: NaiveDateTime
  se: NaiveDateTime
}

// ── Main recommender ──────────────────────────────────────────────────────────

/**
 * Shared recommender state after setup + Pass 0 (fixed events). Both the
 * rule-based tail (`applyRuleBasedPasses`) and the LLM tail (`recommendLlm`)
 * operate on this, so the two paths share identical setup/Pass-0 logic — exactly
 * as the Python `recommend()` branches internally on `llm`.
 */
export interface RecoContext {
  policy: Policy
  td: NaiveDateTime
  dateStr: string
  dayName: string
  nCourts: number
  winHours: number
  existingCourtHours: number
  targetCourtHours: number
  neededCourtHours: number
  minGapHours: number
  saturationThreshold: number
  popSize: number
  recommendations: Recommendation[]
  used: Slot[]
  eventCounts: Map<number, number>
  levelCounts: Record<string, number>
  levelsCovered: Set<string>
  freeSlots: Slot[]
  maxOccFor: (eid: number) => number
  pop: (eid: number, slotStart: NaiveDateTime) => number
  timePref: (slotStart: NaiveDateTime) => number
  recFree: (courtNum: number, ss: NaiveDateTime, se: NaiveDateTime) => boolean
  eventGapOk: (eid: number, ss: NaiveDateTime, se: NaiveDateTime) => boolean
  add: (
    eid: number,
    cn: number,
    ss: NaiveDateTime,
    se: NaiveDateTime,
    extraCourtNums?: number[],
    maxParticipants?: number,
  ) => void
}

/** Sync rule-based recommender — Pass 0 + rule-based Pass 1 + Pass 2. Unchanged behaviour. */
export function recommend(
  scheduleItems: ScheduleItem[],
  targetDate: string,
  policy: Policy,
  opts: { popularity?: PopularityScores } = {},
): { recommendations: Recommendation[]; stats: Stats } {
  const ctx = buildContext(scheduleItems, targetDate, policy, opts)
  applyRuleBasedPasses(ctx)
  return finalize(ctx, 'rule_based')
}

function buildContext(
  scheduleItems: ScheduleItem[],
  targetDate: string,
  policy: Policy,
  opts: { popularity?: PopularityScores } = {},
): RecoContext {
  const td = NaiveDateTime.parseDate(targetDate)
  const dateStr = td.formatYmd()
  const dayName = td.weekdayName()

  // Operating window
  const weekdays = policy.operating_windows.weekday.days
  const window = weekdays.includes(dayName)
    ? policy.operating_windows.weekday
    : policy.operating_windows.weekend

  const winStart = NaiveDateTime.fromYMDHM(dateStr, window.start)
  const winEnd = NaiveDateTime.fromYMDHM(dateStr, window.end)
  const winHours = window.hours

  // ── Parse existing events for target date ──────────────────────────────────
  const existing: ExistingEvent[] = []
  for (const item of scheduleItems) {
    if (!item.StartDateTime) continue
    const itemStart = NaiveDateTime.fromISO(item.StartDateTime)
    if (itemStart.formatYmd() !== dateStr) continue
    const itemEnd = NaiveDateTime.fromISO(item.EndDateTime as string)
    const courtNums = parseCourtNums(item.Courts ?? '')
    const eid = item.EventId
    for (const cn of courtNums) {
      if (cn in COURTS) {
        existing.push({
          court_num: cn,
          start: itemStart,
          end: itemEnd,
          event_id: eid,
          name: (item.EventName ?? '').trim(),
        })
      }
    }
  }

  // ── Utilization baseline ────────────────────────────────────────────────────
  const nCourts = policy.utilization.baseline_courts
  const targetPct = policy.utilization.target_pct / 100.0

  let existingCourtHours = 0.0
  for (const e of existing) {
    const s = e.start.ms > winStart.ms ? e.start : winStart
    const end = e.end.ms < winEnd.ms ? e.end : winEnd
    if (end.ms > s.ms) existingCourtHours += end.diffHours(s)
  }

  const targetCourtHours = targetPct * nCourts * winHours
  const neededCourtHours = Math.max(0.0, targetCourtHours - existingCourtHours)

  // ── Occurrence limits + gap ─────────────────────────────────────────────────
  const occConstraint = policy.hard_constraints['3_max_occurrences_per_event_per_day']
  const maxOcc = occConstraint.limit
  const occOverrides = new Map<number, number>()
  for (const [k, v] of Object.entries(occConstraint.per_event_overrides ?? {})) {
    occOverrides.set(Number(k), v.limit)
  }
  const maxOccFor = (eid: number): number => occOverrides.get(eid) ?? maxOcc

  const minGapHours = policy.hard_constraints['3b_min_gap_same_event_hours'].hours

  const eventCounts = new Map<number, number>()
  const eventSessions = new Map<number, Array<[NaiveDateTime, NaiveDateTime]>>()
  for (const e of APPROVED_EVENTS_ORDER) {
    eventCounts.set(e.id, 0)
    eventSessions.set(e.id, [])
  }
  for (const e of existing) {
    if (e.event_id !== undefined && eventCounts.has(e.event_id)) {
      eventCounts.set(e.event_id, (eventCounts.get(e.event_id) ?? 0) + 1)
      eventSessions.get(e.event_id)!.push([e.start, e.end])
    }
  }

  // ── Existing level saturation ───────────────────────────────────────────────
  const levelCounts: Record<string, number> = {}
  for (const level of LEVEL_ORDER) levelCounts[level] = 0

  const approvedIds = new Set(APPROVED_EVENTS.keys())
  for (const item of scheduleItems) {
    if (!item.StartDateTime) continue
    const itemDt = NaiveDateTime.fromISO(item.StartDateTime)
    if (itemDt.formatYmd() !== dateStr) continue
    const eid = item.EventId
    if (eid !== undefined && approvedIds.has(eid)) {
      levelCounts[APPROVED_EVENTS.get(eid)!.level] += 1
    }
  }
  for (const fe of policy.fixed_events?.events ?? []) {
    if (fe.day_of_week === dayName && fe.level && fe.level in levelCounts) {
      levelCounts[fe.level] += 1
    }
  }

  // ── Generate all free candidate slots ───────────────────────────────────────
  const preferredCourt = policy.recommendation_rules.preferred_court_when_free ?? 4
  const courtOrder = [
    preferredCourt,
    ...Object.keys(COURTS)
      .map(Number)
      .sort((a, b) => a - b)
      .filter((c) => c !== preferredCourt),
  ]

  const BLOCK_H = 2 // all open play is exactly 2 hours (hard rule)

  const existingFree = (courtNum: number, ss: NaiveDateTime, se: NaiveDateTime): boolean => {
    for (const e of existing) {
      if (e.court_num === courtNum && overlaps(ss, se, e.start, e.end)) return false
    }
    return true
  }

  const maxConcurrent = policy.hard_constraints['6_max_concurrent_courts']?.limit ?? 4

  const courtsOccupiedAt = (ss: NaiveDateTime, se: NaiveDateTime): number => {
    let n = 0
    for (const e of existing) if (overlaps(ss, se, e.start, e.end)) n += 1
    return n
  }

  let freeSlots: Slot[] = []
  let t = winStart
  while (t.addHours(BLOCK_H).ms <= winEnd.ms) {
    const se = t.addHours(BLOCK_H)
    const availableSlots = maxConcurrent - courtsOccupiedAt(t, se)
    let added = 0
    for (const cn of courtOrder) {
      if (added >= availableSlots) break
      if (existingFree(cn, t, se)) {
        freeSlots.push({ cn, ss: t, se })
        added += 1
      }
    }
    t = t.addHours(BLOCK_H)
  }

  // ── Spread: bucket free slots into time bands ───────────────────────────────
  const spreadCfg = policy.recommendation_rules.spread_throughout_day ?? {}
  const spreadEnabled = spreadCfg.enabled ?? false

  const bandOf = (slotStart: NaiveDateTime): number => {
    const bandList: Array<[string, string]> = [
      ['09:00', '12:00'],
      ['12:00', '15:00'],
      ['15:00', '18:00'],
      ['18:00', '20:00'],
    ]
    const ymd = slotStart.formatYmd()
    for (let i = 0; i < bandList.length; i++) {
      const bS = NaiveDateTime.fromYMDHM(ymd, bandList[i][0])
      const bE = NaiveDateTime.fromYMDHM(ymd, bandList[i][1])
      if (bS.ms <= slotStart.ms && slotStart.ms < bE.ms) return i
    }
    return 99
  }

  if (spreadEnabled) {
    const bands = new Map<number, Slot[]>()
    for (const slot of freeSlots) {
      const b = bandOf(slot.ss)
      const arr = bands.get(b)
      if (arr) arr.push(slot)
      else bands.set(b, [slot])
    }
    const bandKeys = [...bands.keys()].sort((a, b) => a - b)
    const maxLen = Math.max(0, ...[...bands.values()].map((v) => v.length))
    const spreadOrder: Slot[] = []
    for (let i = 0; i < maxLen; i++) {
      for (const bk of bandKeys) {
        const arr = bands.get(bk)!
        if (i < arr.length) spreadOrder.push(arr[i])
      }
    }
    freeSlots = spreadOrder
  }

  // ── Popularity + time-of-day preference ─────────────────────────────────────
  const popScores = opts.popularity ?? loadPopularity()
  const pop = (eid: number, slotStart: NaiveDateTime): number =>
    popularityScore(popScores, eid, dayName, slotStart)

  const timePref = (slotStart: NaiveDateTime): number => {
    const h = slotStart.hour + slotStart.minute / 60
    if (h < 9) return 0.0
    if (h < 10) return 0.4
    if (h < 12) return 0.7
    if (h < 17) return 1.0
    if (h < 19) return 0.7
    return 0.3
  }

  // ── Build recommendations ───────────────────────────────────────────────────
  const recommendations: Recommendation[] = []
  const used: Slot[] = []
  const levelsCovered = new Set<string>()

  const recFree = (courtNum: number, ss: NaiveDateTime, se: NaiveDateTime): boolean => {
    for (const u of used) {
      if (u.cn === courtNum && overlaps(ss, se, u.ss, u.se)) return false
    }
    return true
  }

  const eventGapOk = (eid: number, ss: NaiveDateTime, se: NaiveDateTime): boolean => {
    for (const [us, ue] of eventSessions.get(eid) ?? []) {
      if (!(se.addHours(minGapHours).ms <= us.ms || ue.addHours(minGapHours).ms <= ss.ms)) {
        return false
      }
    }
    return true
  }

  const alreadyOnSchedule = (courtNum: number, ss: NaiveDateTime, se: NaiveDateTime): boolean => {
    for (const e of existing) {
      if (e.court_num === courtNum && overlaps(ss, se, e.start, e.end)) return true
    }
    return false
  }

  const add = (
    eid: number,
    cn: number,
    ss: NaiveDateTime,
    se: NaiveDateTime,
    extraCourtNums: number[] = [],
    maxParticipants = 0,
  ): void => {
    const ev = APPROVED_EVENTS.get(eid)!
    recommendations.push({
      event_id: eid,
      event_name: ev.name,
      level: ev.level,
      court_num: cn,
      court_id: COURTS[cn].id,
      court_label: COURTS[cn].label,
      start: ss,
      end: se,
      extra_court_ids: extraCourtNums.map((c) => COURTS[c].id),
      extra_court_nums: [...extraCourtNums],
      max_participants: maxParticipants,
    })
    used.push({ cn, ss, se })
    for (const ecn of extraCourtNums) used.push({ cn: ecn, ss, se })
    eventCounts.set(eid, (eventCounts.get(eid) ?? 0) + 1)
    eventSessions.get(eid)!.push([ss, se])
    levelsCovered.add(ev.level)
  }

  // ── Pass 0: fixed recurring events ──────────────────────────────────────────
  for (const fe of policy.fixed_events?.events ?? []) {
    if (fe.day_of_week !== dayName) continue

    const feStart = NaiveDateTime.fromYMDHM(dateStr, fe.start_time)
    const feEnd = NaiveDateTime.fromYMDHM(dateStr, fe.end_time)

    const feLevel = fe.level ?? ''
    const eid = LEVEL_TO_EVENT_ID[feLevel]
    if (eid === undefined) continue

    const nCourtsNeeded = fe.courts ?? 1
    const preferred = fe.preferred_courts ?? []
    let courtsAssigned: number[] = []

    if (nCourtsNeeded === 2 && preferred.length === 0) {
      const pairs =
        policy.recommendation_rules.two_court_priority_pairs ?? [[4, 3], [4, 1], [1, 2], [2, 3]]
      for (const pair of pairs) {
        if (
          pair.every(
            (cn) => cn in COURTS && !alreadyOnSchedule(cn, feStart, feEnd) && recFree(cn, feStart, feEnd),
          )
        ) {
          courtsAssigned = [...pair]
          break
        }
      }
    } else if (preferred.length > 0) {
      courtsAssigned = preferred
        .filter(
          (cn) => cn in COURTS && !alreadyOnSchedule(cn, feStart, feEnd) && recFree(cn, feStart, feEnd),
        )
        .slice(0, nCourtsNeeded)
    } else {
      for (const cn of courtOrder) {
        if (courtsAssigned.length >= nCourtsNeeded) break
        if (cn in COURTS && !alreadyOnSchedule(cn, feStart, feEnd) && recFree(cn, feStart, feEnd)) {
          courtsAssigned.push(cn)
        }
      }
    }

    if (courtsAssigned.length === 0) continue

    if ((eventCounts.get(eid) ?? 0) < maxOccFor(eid)) {
      const primary = courtsAssigned[0]
      const extras = courtsAssigned.slice(1)
      const maxP = fe.max_participants ?? 0
      add(eid, primary, feStart, feEnd, extras, maxP)
    }
  }

  const saturationThreshold =
    policy.hard_constraints['4_required_level_coverage'].saturation_threshold ?? 2

  return {
    policy, td, dateStr, dayName, nCourts, winHours,
    existingCourtHours, targetCourtHours, neededCourtHours,
    minGapHours, saturationThreshold, popSize: popScores.size,
    recommendations, used, eventCounts, levelCounts, levelsCovered, freeSlots,
    maxOccFor, pop, timePref, recFree, eventGapOk, add,
  }
}

/** Rule-based Pass 1 (level coverage) + Pass 2 (utilization fill). Mutates ctx. */
export function applyRuleBasedPasses(ctx: RecoContext): void {
  const {
    freeSlots, eventCounts, levelCounts, levelsCovered, saturationThreshold,
    maxOccFor, recFree, eventGapOk, pop, timePref, add, neededCourtHours, used,
  } = ctx

  // ── Pass 1: ensure all 5 levels are represented ─────────────────────────────
  for (const level of LEVEL_ORDER) {
    if (levelsCovered.has(level)) continue
    if (saturationThreshold > 0 && (levelCounts[level] ?? 0) >= saturationThreshold) {
      levelsCovered.add(level)
      continue
    }
    const eid = LEVEL_TO_EVENT_ID[level]
    if ((eventCounts.get(eid) ?? 0) >= maxOccFor(eid)) continue
    const candidates = freeSlots.filter((s) => recFree(s.cn, s.ss, s.se) && eventGapOk(eid, s.ss, s.se))
    if (candidates.length === 0) continue
    candidates.sort((a, b) => {
      const pd = pop(eid, b.ss) - pop(eid, a.ss)
      if (pd !== 0) return pd
      const tp = timePref(b.ss) - timePref(a.ss)
      if (tp !== 0) return tp
      return a.ss.ms - b.ss.ms
    })
    const c = candidates[0]
    add(eid, c.cn, c.ss, c.se)
  }

  // ── Pass 2: fill toward utilization target ──────────────────────────────────
  const addedHrs = used.reduce((acc, u) => acc + u.se.diffHours(u.ss), 0)
  let remainingNeeded = neededCourtHours - addedHrs

  const fillSlots = [...freeSlots].sort((a, b) => {
    const tp = timePref(b.ss) - timePref(a.ss)
    if (tp !== 0) return tp
    return a.ss.ms - b.ss.ms
  })
  for (const { cn, ss, se } of fillSlots) {
    if (remainingNeeded <= 0) break
    if (!recFree(cn, ss, se)) continue
    const eligible = LEVEL_ORDER.filter(
      (l) =>
        (eventCounts.get(LEVEL_TO_EVENT_ID[l]) ?? 0) < maxOccFor(LEVEL_TO_EVENT_ID[l]) &&
        eventGapOk(LEVEL_TO_EVENT_ID[l], ss, se),
    ).map((l) => LEVEL_TO_EVENT_ID[l])
    if (eligible.length === 0) break
    eligible.sort((a, b) => {
      const ka =
        levelCounts[APPROVED_EVENTS.get(a)!.level] + (eventCounts.get(a) ?? 0)
      const kb =
        levelCounts[APPROVED_EVENTS.get(b)!.level] + (eventCounts.get(b) ?? 0)
      if (ka !== kb) return ka - kb
      const pd = pop(b, ss) - pop(a, ss)
      if (pd !== 0) return pd
      const tp = timePref(ss) - timePref(ss)
      if (tp !== 0) return tp
      return (eventCounts.get(a) ?? 0) - (eventCounts.get(b) ?? 0)
    })
    const eid = eligible[0]
    const slotHrs = se.diffHours(ss)
    add(eid, cn, ss, se)
    remainingNeeded -= slotHrs
  }
}

/** Sort recommendations and compute the stats block. `recSource` tags provenance. */
function finalize(
  ctx: RecoContext,
  recSource: 'rule_based' | 'llm' | 'fallback',
): { recommendations: Recommendation[]; stats: Stats } {
  const {
    recommendations, policy, td, dayName, existingCourtHours, targetCourtHours,
    nCourts, winHours, levelsCovered, levelCounts, popSize,
  } = ctx

  // Sort by time, then court
  recommendations.sort((a, b) => (a.start.ms - b.start.ms) || (a.court_num - b.court_num))

  const recHrs = (r: Recommendation): number =>
    r.end.diffHours(r.start) * (1 + r.extra_court_ids.length)

  const addedTotal = recommendations.reduce((acc, r) => acc + recHrs(r), 0)
  const achieved = existingCourtHours + addedTotal
  const maxPossible = nCourts * winHours

  const stats: Stats = {
    target_date: td.formatDate(),
    day_of_week: dayName,
    existing_court_hours: pyRound(existingCourtHours, 1),
    recommended_court_hours: pyRound(addedTotal, 1),
    achieved_court_hours: pyRound(achieved, 1),
    target_court_hours: pyRound(targetCourtHours, 1),
    achieved_pct: pyRound((achieved / maxPossible) * 100, 1),
    target_pct: policy.utilization.target_pct,
    gap_court_hours: pyRound(Math.max(0.0, targetCourtHours - achieved), 1),
    gap_pct_points: pyRound(Math.max(0.0, ((targetCourtHours - achieved) / maxPossible) * 100), 1),
    levels_covered: [...levelsCovered].sort(),
    levels_missing: LEVEL_ORDER.filter((l) => !levelsCovered.has(l)),
    min_recommendations_met:
      recommendations.length >= policy.recommendation_rules.min_recommendations,
    n_recommendations: recommendations.length,
    popularity_used: popSize > 0,
    existing_level_counts: levelCounts,
    rec_source: recSource,
  }

  return { recommendations, stats }
}

// ── LLM path: Pass 0 + Claude ranker (replaces Pass 1+2), rule-based fallback ──

export interface RecommendLlmOpts {
  popularity?: PopularityScores
  historyPath?: string
  apiKey?: string
  /** Injectable Anthropic-like client for tests. */
  client?: LlmRankerInput['client']
}

/**
 * Async recommender that replaces Pass 1+2 with the Claude `book_slots` ranker,
 * re-validating each returned booking, and falls back to the rule-based passes if
 * the LLM call throws. Port of `recommend(..., llm=True)`.
 */
export async function recommendLlm(
  scheduleItems: ScheduleItem[],
  targetDate: string,
  policy: Policy,
  opts: RecommendLlmOpts = {},
): Promise<{ recommendations: Recommendation[]; stats: Stats }> {
  const ctx = buildContext(scheduleItems, targetDate, policy, { popularity: opts.popularity })

  try {
    const { callLlmRanker } = await import('./llm/ranker') // local import avoids a static cycle
    const currentFree = ctx.freeSlots.filter((s) => ctx.recFree(s.cn, s.ss, s.se))
    const llmRecs = await callLlmRanker({
      pass0Recs: [...ctx.recommendations],
      freeSlots: currentFree,
      policy,
      dateStr: ctx.dateStr,
      dayName: ctx.dayName,
      eventCounts: new Map(ctx.eventCounts),
      levelCounts: { ...ctx.levelCounts },
      targetCourtHours: ctx.targetCourtHours,
      existingCourtHours: ctx.existingCourtHours,
      historyPath: opts.historyPath,
      apiKey: opts.apiKey,
      client: opts.client,
    })
    for (const rec of llmRecs) {
      // Re-validate before committing — guard against hallucinations.
      if (
        ctx.recFree(rec.court_num, rec.start, rec.end) &&
        (ctx.eventCounts.get(rec.event_id) ?? 0) < ctx.maxOccFor(rec.event_id) &&
        ctx.eventGapOk(rec.event_id, rec.start, rec.end)
      ) {
        ctx.add(rec.event_id, rec.court_num, rec.start, rec.end)
      }
    }
    return finalize(ctx, 'llm')
  } catch {
    applyRuleBasedPasses(ctx)
    return finalize(ctx, 'fallback')
  }
}
