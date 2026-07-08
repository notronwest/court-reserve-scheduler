/**
 * LLM-powered recommendation engine (Pass 1 + Pass 2) — TypeScript port of
 * `llm_ranker.py`. Replaces the rule-based level-coverage and utilization-fill
 * passes with a single Claude tool call (`book_slots`) that reasons over all
 * constraints at once, then re-validates every returned booking.
 *
 * Model is kept identical to the Python (`claude-sonnet-4-6`) so the TS path can
 * be shadow-run and diffed against the Python during cutover (see the rewrite
 * plan). Override with CR_RANKER_MODEL if needed.
 */
import Anthropic from '@anthropic-ai/sdk'
import { NaiveDateTime } from '../datetime'
import type { Policy } from '../policy'
import { loadPopularityFull, loadTimePatterns } from '../history'
import {
  APPROVED_EVENTS,
  APPROVED_EVENTS_ORDER,
  COURTS,
  LEVEL_ORDER,
  type Recommendation,
} from '../recommender'

const MODEL = process.env.CR_RANKER_MODEL ?? 'claude-sonnet-4-6'
const MAX_TOKENS = 1500

const ABBREV: Record<string, string> = {
  Beginner: 'B',
  'Advanced Beginner': 'AB',
  Intermediate: 'I',
  'Advanced Intermediate': 'AI',
  Advanced: 'A',
}

/** The forced tool the model must call. Enums pin event/court IDs to the approved sets. */
export const BOOK_SLOTS_TOOL = {
  name: 'book_slots',
  description:
    'Return the open play events to book into the available court slots. ' +
    'Only reference exact court# and start-time combinations from the FREE SLOTS list. ' +
    'Never double-book a court/time. Respect the occurrence limit per event_id.',
  input_schema: {
    type: 'object',
    properties: {
      bookings: {
        type: 'array',
        description: 'Slots to book, ordered earliest-first.',
        items: {
          type: 'object',
          properties: {
            event_id: {
              type: 'integer',
              description: 'One of the 5 approved event IDs',
              enum: APPROVED_EVENTS_ORDER.map((e) => e.id),
            },
            court_num: {
              type: 'integer',
              description: 'Court number (1–4)',
              enum: Object.keys(COURTS).map(Number),
            },
            start_time: {
              type: 'string',
              description: "24h HH:MM matching a FREE SLOT start, e.g. '09:00'",
            },
            reasoning: { type: 'string', description: 'One-line reason for this choice' },
          },
          required: ['event_id', 'court_num', 'start_time'],
          additionalProperties: false,
        },
      },
      summary: {
        type: 'string',
        description: 'Brief description of the overall scheduling strategy used.',
      },
    },
    required: ['bookings'],
    additionalProperties: false,
  },
} as const

export interface FreeSlot {
  cn: number
  ss: NaiveDateTime
  se: NaiveDateTime
}

export interface LlmRankerInput {
  pass0Recs: Recommendation[]
  freeSlots: FreeSlot[]
  policy: Policy
  dateStr: string // "YYYY-MM-DD"
  dayName: string // "Monday" … "Sunday"
  eventCounts: Map<number, number>
  levelCounts: Record<string, number>
  targetCourtHours: number
  existingCourtHours: number
  historyPath?: string
  apiKey?: string
  /** Inject a client (or a stub) — defaults to a real Anthropic client. */
  client?: Pick<Anthropic, 'messages'>
}

interface Booking {
  event_id?: number
  court_num?: number
  start_time?: string
  reasoning?: string
}

/**
 * Call Claude to select recommendations for Pass 1 + Pass 2. Returns the picks
 * (does NOT include pass0Recs). Throws on API failure or a missing tool call —
 * the caller falls back to the rule-based path, mirroring the Python.
 */
export async function callLlmRanker(input: LlmRankerInput): Promise<Recommendation[]> {
  const client =
    input.client ??
    new Anthropic({ apiKey: input.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '' })

  const systemMsg = systemPrompt(input.policy, input.dayName)
  const userMsg = userPrompt(input)

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemMsg,
    tools: [BOOK_SLOTS_TOOL as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'book_slots' },
    messages: [{ role: 'user', content: userMsg }],
  })

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'book_slots',
  )
  if (!toolBlock) {
    throw new Error(`No book_slots call in response; stop_reason=${response.stop_reason}`)
  }

  const inputObj = toolBlock.input as { bookings?: Booking[]; summary?: string }
  return parseBookings(inputObj.bookings ?? [], input.freeSlots, input.eventCounts, input.policy)
}

// ── Prompt construction ───────────────────────────────────────────────────────

export function systemPrompt(policy: Policy, dayName: string): string {
  const hc = policy.hard_constraints
  const maxOcc = hc['3_max_occurrences_per_event_per_day'].limit
  const minGap = hc['3b_min_gap_same_event_hours'].hours
  const satThr = hc['4_required_level_coverage'].saturation_threshold ?? 2
  const tgtPct = policy.utilization.target_pct
  const nCourts = policy.utilization.baseline_courts

  const spread = policy.recommendation_rules.spread_throughout_day ?? {}
  const bands = spread.time_bands ?? {}
  const bandStr =
    Object.entries(bands)
      .map(([name, b]) => `${name} (${b.start}–${b.end})`)
      .join(', ') || 'morning, midday, afternoon, evening'
  const prefWin =
    ((policy.recommendation_rules.time_of_day_preference as { preferred_window?: string } | undefined)
      ?.preferred_window) ?? '12:00–17:00'

  return (
    `You are the head scheduler for White Mountain Pickleball Club. ` +
    `You've been running this club for years and you know your members well.\n\n` +
    `Your job is to build the best possible open-play schedule for the day — ` +
    `'best' means the most members actually show up and have a good experience. ` +
    `You have 3 months of real attendance data. Use it as your primary guide.\n\n` +
    `HOW TO USE THE HISTORY:\n` +
    `- avg attendance tells you how popular a slot typically is\n` +
    `- peak attendance shows the ceiling — how many can show up when conditions are right\n` +
    `- session count shows how reliable the pattern is (10 sessions is solid; 2 is a hint)\n` +
    `- A level with avg=8 is genuinely in demand; avg=1 means members aren't interested ` +
    `in that slot regardless of whether we schedule it\n` +
    `- If a level has almost no history, it means it rarely gets scheduled — ` +
    `don't automatically skip it, but don't force it if better options exist\n\n` +
    `REASONING APPROACH:\n` +
    `Think like a club manager, not an algorithm. Ask yourself:\n` +
    `- Which levels do members actually want today based on past ${dayName} data?\n` +
    `- What times have historically drawn the biggest crowds for each level?\n` +
    `- If I only have room for one more slot, which level and time will get the most people on court?\n` +
    `- Am I giving a popular level a second session because demand justifies it, ` +
    `or just to fill court-hours?\n\n` +
    `HARD RULES (always enforce — no exceptions):\n` +
    `1. Never double-book a court/time slot\n` +
    `2. Each booking is exactly 2 hours on one court\n` +
    `3. Each event_id may appear at most ${maxOcc}x total (existing + new); ` +
    `Advanced Intermediate (event 1672774) is capped at 1x per day — ` +
    `everyone self-identifies as AI so fewer AI sessions drives members toward Intermediate\n` +
    `4. Two bookings of the SAME event_id must be ≥${minGap}h apart (end-to-start)\n` +
    `5. Only use the 5 approved event IDs\n` +
    `6. Never fill all 4 courts at the same time — at least 1 court must stay free ` +
    `at every time slot across the whole day\n\n` +
    `SOFT TARGETS (use judgment):\n` +
    `- Aim to cover all 5 skill levels when attendance history supports it; ` +
    `skip a level only if history shows consistently low demand on this day\n` +
    `- A level already at ${satThr}+ sessions today is saturated — don't add more\n` +
    `- Fill toward ${tgtPct}% court utilization across ${nCourts} courts, ` +
    `but never schedule a low-demand slot just to hit a number\n` +
    `- SPREAD ACROSS THE DAY — this is important. The day has these time bands: ` +
    `${bandStr}. Give the schedule reach: cover as many bands as the free slots ` +
    `allow BEFORE placing a second session in any single band. Do not front-load ` +
    `the morning and leave the afternoon/evening empty when free slots exist there. ` +
    `If a band has free slots but weak history, a modest session there still beats ` +
    `stacking another morning slot — members can't attend a session that was never offered.\n` +
    `- When history is equal or absent, prefer the ${prefWin} window over early morning\n` +
    `- Prioritize Intermediate (event 1931656): target 2 sessions per day when slots allow — ` +
    `Intermediate is under-served because members over-report their level as Advanced Intermediate\n` +
    `- ALWAYS pair Intermediate with Advanced Intermediate: whenever you recommend AI (event 1672774), ` +
    `also recommend Intermediate (event 1931656) at the exact same start time on a different court — ` +
    `this lets the over-classified AI players self-select into Intermediate when they see it running alongside\n` +
    `- For Advanced Intermediate: vary start times across days rather than always using the same hour; ` +
    `this intentionally builds data about which AI times actually draw members\n` +
    `- Respect scheduling patterns when free slots allow it: members build habits ` +
    `around consistent start times — a Tuesday group expecting noon will show up at noon`
  )
}

export function userPrompt(input: LlmRankerInput): string {
  const { pass0Recs, freeSlots, policy, dateStr, dayName, eventCounts, levelCounts } = input
  const weekdays = policy.operating_windows.weekday.days
  const win = weekdays.includes(dayName)
    ? policy.operating_windows.weekday
    : policy.operating_windows.weekend
  const maxOcc = policy.hard_constraints['3_max_occurrences_per_event_per_day'].limit
  const satThr = policy.hard_constraints['4_required_level_coverage'].saturation_threshold ?? 2

  const pass0Hrs = pass0Recs.reduce(
    (acc, r) => acc + r.end.diffHours(r.start) * (1 + r.extra_court_ids.length),
    0,
  )
  const alreadyHrs = input.existingCourtHours + pass0Hrs
  const neededHrs = Math.max(0.0, input.targetCourtHours - alreadyHrs)
  const neededSlots = Math.max(0, Math.ceil(Math.trunc(neededHrs) / 2))

  const lines: string[] = []

  lines.push(
    `DATE: ${dayName}, ${dateStr}`,
    `WINDOW: ${win.start}–${win.end}  (${win.hours}h, 4 courts)`,
    `ALREADY BOOKED: ${alreadyHrs.toFixed(1)} court-hrs  |  STILL NEEDED: ${neededHrs.toFixed(1)} court-hrs (~${neededSlots} slots)`,
    '',
  )

  lines.push('APPROVED EVENTS (id, abbrev, level):')
  for (const e of APPROVED_EVENTS_ORDER) {
    lines.push(`  ${e.id}  ${ABBREV[e.level]}  ${e.level}`)
  }
  lines.push('')

  lines.push(`LEVEL COVERAGE (saturated at ${satThr}+):`)
  for (const level of LEVEL_ORDER) {
    const cnt = levelCounts[level] ?? 0
    const status = cnt >= satThr ? 'COVERED' : 'NEEDED'
    lines.push(`  ${ABBREV[level].padStart(2)}  ${cnt} existing  [${status}]`)
  }
  lines.push('')

  const occParts = APPROVED_EVENTS_ORDER.map(
    (e) => `${ABBREV[e.level]}(${e.id})=${eventCounts.get(e.id) ?? 0}/${maxOcc}`,
  )
  lines.push('OCCURRENCE COUNTS used/limit:  ' + occParts.join('  '))
  lines.push('')

  if (pass0Recs.length > 0) {
    lines.push('ALREADY BOOKED — do NOT re-book:')
    const sorted = [...pass0Recs].sort(
      (a, b) => a.start.ms - b.start.ms || a.court_num - b.court_num,
    )
    for (const r of sorted) {
      lines.push(
        `  Court#${r.court_num}  ${r.start.formatHm()}–${r.end.formatHm()}  ${ABBREV[r.level]}(${r.event_id})`,
      )
    }
    lines.push('')
  }

  lines.push('FREE SLOTS — only choose from this list (court#, HH:MM-HH:MM):')
  const byTime = new Map<string, number[]>()
  for (const { cn, ss, se } of freeSlots) {
    const key = `${ss.formatHm()}-${se.formatHm()}`
    const arr = byTime.get(key)
    if (arr) arr.push(cn)
    else byTime.set(key, [cn])
  }
  for (const tkey of [...byTime.keys()].sort()) {
    const courtsStr = [...byTime.get(tkey)!].sort((a, b) => a - b).map((c) => `C${c}`).join('  ')
    lines.push(`  ${tkey}  [${courtsStr}]`)
  }
  lines.push('')

  // Time-band coverage
  const bandDefs = policy.recommendation_rules.spread_throughout_day?.time_bands ?? {}
  if (Object.keys(bandDefs).length > 0) {
    const bandOf = (dt: NaiveDateTime): string | null => {
      const hm = dt.formatHm()
      for (const [name, b] of Object.entries(bandDefs)) {
        if (b.start <= hm && hm < b.end) return name
      }
      return null
    }
    const freeByBand = new Map<string, number>()
    for (const { ss } of freeSlots) {
      const b = bandOf(ss)
      if (b) freeByBand.set(b, (freeByBand.get(b) ?? 0) + 1)
    }
    const picksByBand = new Map<string, number>()
    for (const r of pass0Recs) {
      const b = bandOf(r.start)
      if (b) picksByBand.set(b, (picksByBand.get(b) ?? 0) + 1)
    }
    lines.push('TIME-BAND SPREAD (open = free slots available in this band):')
    const bandsWithRoom: string[] = []
    for (const [name, b] of Object.entries(bandDefs)) {
      const free = freeByBand.get(name) ?? 0
      const picks = picksByBand.get(name) ?? 0
      if (free > 0) bandsWithRoom.push(name)
      const note = free > 0 && picks === 0 ? '  ← open, spread here' : ''
      lines.push(`  ${name.padEnd(9)} ${b.start}–${b.end}:  ${free} open slots${note}`)
    }
    if (bandsWithRoom.length > 1) {
      lines.push(
        '→ Give at least one session to each band that has open slots ' +
          "before placing a 2nd session in any single band — don't front-load the morning.",
      )
    }
    lines.push('')
  }

  // Historical attendance — full profile per level for this day
  const fullStats = loadPopularityFull(input.historyPath)
  const dayData = new Map<number, Array<{ band: string; avg: number; peak: number; sessions: number }>>()
  for (const e of APPROVED_EVENTS_ORDER) dayData.set(e.id, [])
  for (const entry of fullStats) {
    if (entry.dayOfWeek === dayName && APPROVED_EVENTS.has(entry.eventId)) {
      dayData.get(entry.eventId)!.push({ band: entry.band, ...entry.stats })
    }
  }
  const hasHistory = [...dayData.values()].some((rows) => rows.length > 0)
  if (hasHistory) {
    lines.push(`ATTENDANCE HISTORY — ${dayName}s (avg / peak / sessions):`)
    for (const e of APPROVED_EVENTS_ORDER) {
      const abbr = ABBREV[e.level]
      const rows = [...dayData.get(e.id)!].sort((a, b) => b.avg - a.avg)
      if (rows.length === 0) {
        lines.push(`  ${abbr.padStart(2)} (${e.id})  ${e.level}: NO DATA for ${dayName}s — schedule with caution`)
        continue
      }
      const totalSessions = rows.reduce((a, r) => a + r.sessions, 0)
      const bestAvg = rows[0].avg
      const bestPeak = Math.max(...rows.map((r) => r.peak))
      lines.push(
        `  ${abbr.padStart(2)} (${e.id})  ${e.level}  ` +
          `[${totalSessions} sessions tracked, best avg=${bestAvg.toFixed(1)}, peak=${bestPeak}]`,
      )
      for (const r of rows) {
        const h = Math.trunc(Number(r.band) / 100)
        const timeLabel = `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`
        lines.push(
          `      ${timeLabel.padStart(6)} start  avg=${r.avg.toFixed(1)}  peak=${r.peak}  (${r.sessions} sessions)`,
        )
      }
    }
    lines.push('')
    lines.push(
      'Use this data to decide: which levels draw well on this day, ' +
        'and which specific time slots get the most members on court.\n' +
        'NOTE: Historical start hours may not align exactly with the free slot boundaries — ' +
        'map each to the nearest available slot in the FREE SLOTS list above.',
    )
  } else {
    lines.push('ATTENDANCE HISTORY: No data available yet — use general scheduling judgment.')
  }
  lines.push('')

  // Time patterns
  const timePatterns = loadTimePatterns(input.historyPath)
  const dayPatterns = timePatterns.filter(
    (p) => p.dayOfWeek === dayName && APPROVED_EVENTS.has(p.eventId),
  )
  if (dayPatterns.length > 0) {
    lines.push(`SCHEDULING PATTERNS — ${dayName} tendencies (not hard rules, but worth preserving):`)
    lines.push(
      'Members build habits. If a level has consistently started at the same time, ' +
        'try to match it — schedule predictability matters for member experience.',
    )
    const sorted = [...dayPatterns].sort((a, b) => {
      const la = APPROVED_EVENTS.get(a.eventId)!.level
      const lb = APPROVED_EVENTS.get(b.eventId)!.level
      return la < lb ? -1 : la > lb ? 1 : 0
    })
    for (const { eventId, pattern } of sorted) {
      const level = APPROVED_EVENTS.get(eventId)!.level
      const abbr = ABBREV[level]
      const h = pattern.modalHour
      const strength = pattern.consistencyPct >= 80 ? 'strong' : 'moderate'
      const timeLabel = `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`
      lines.push(
        `  ${abbr.padStart(2)}  ${level}: usually ${timeLabel}  ` +
          `(${pattern.consistencyPct.toFixed(0)}% of ${pattern.nSessions} sessions — ${strength} pattern, ` +
          `avg ${pattern.avgAtModal.toFixed(1)} members)`,
      )
    }
    lines.push('')
  }

  lines.push('Call book_slots with your selections.')
  return lines.join('\n')
}

// ── Response parsing ────────────────────────────────────────────────────────

/** Convert raw bookings to Recommendations, re-validating each (drops hallucinations). */
export function parseBookings(
  bookings: Booking[],
  freeSlots: FreeSlot[],
  eventCounts: Map<number, number>,
  policy: Policy,
): Recommendation[] {
  const maxOcc = policy.hard_constraints['3_max_occurrences_per_event_per_day'].limit
  const minGapH = policy.hard_constraints['3b_min_gap_same_event_hours'].hours

  const slotLookup = new Map<string, { ss: NaiveDateTime; se: NaiveDateTime }>()
  for (const { cn, ss, se } of freeSlots) {
    slotLookup.set(`${cn}|${ss.formatHm()}`, { ss, se })
  }

  const usedSlots = new Set<string>()
  const localCounts = new Map(eventCounts)
  const localSessions = new Map<number, Array<[NaiveDateTime, NaiveDateTime]>>()
  for (const e of APPROVED_EVENTS_ORDER) localSessions.set(e.id, [])
  const results: Recommendation[] = []

  for (const b of bookings) {
    const eid = b.event_id
    const courtNum = b.court_num
    const startHhmm = b.start_time ?? ''

    if (eid === undefined || !APPROVED_EVENTS.has(eid)) continue
    if (courtNum === undefined || !(courtNum in COURTS)) continue

    const slotKey = `${courtNum}|${startHhmm}`
    if (!slotLookup.has(slotKey)) continue
    if (usedSlots.has(slotKey)) continue
    if ((localCounts.get(eid) ?? 0) >= maxOcc) continue

    const { ss, se } = slotLookup.get(slotKey)!

    const gapOk = (localSessions.get(eid) ?? []).every(
      ([us, ue]) => se.addHours(minGapH).ms <= us.ms || ue.addHours(minGapH).ms <= ss.ms,
    )
    if (!gapOk) continue

    const ev = APPROVED_EVENTS.get(eid)!
    results.push({
      event_id: eid,
      event_name: ev.name,
      level: ev.level,
      court_num: courtNum,
      court_id: COURTS[courtNum].id,
      court_label: COURTS[courtNum].label,
      start: ss,
      end: se,
      extra_court_ids: [],
      extra_court_nums: [],
      max_participants: 0,
    })
    usedSlots.add(slotKey)
    localCounts.set(eid, (localCounts.get(eid) ?? 0) + 1)
    localSessions.get(eid)!.push([ss, se])
  }

  return results
}
