/**
 * Discord embeds + reply parsers — TypeScript port of `discord_notify.py`.
 *
 * Pure builders/parsers are exported for tests; the `send*` helpers wrap a
 * `DiscordRest` for I/O. Sending is via webhook; the message id comes back when
 * a bot token is configured (needed for reply/reaction tracking).
 */
import os from 'node:os'
import { NaiveDateTime } from '../datetime'
import type { Stats, Recommendation, RecommendationDict } from '../recommender'
import type { DiscordRest } from './rest'

const HOSTNAME = os.hostname().split('.')[0]

export const LEVEL_EMOJI: Record<string, string> = {
  Beginner: '🟢',
  'Advanced Beginner': '🔵',
  Intermediate: '🟡',
  'Advanced Intermediate': '🟠',
  Advanced: '🔴',
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "%A, %B %-d %Y" from an M/D/YYYY (or already-friendly) string. */
export function dayLabel(targetDate: string): string {
  if (!targetDate.includes('/')) return targetDate
  const d = NaiveDateTime.parseDate(targetDate)
  return `${d.weekdayName()}, ${MONTHS[monthIndex(d)]} ${dayOfMonth(d)} ${year(d)}`
}

// NaiveDateTime exposes hour/minute but not date parts publicly; derive from its ms.
function monthIndex(d: NaiveDateTime): number {
  return new Date(d.ms).getUTCMonth()
}
function dayOfMonth(d: NaiveDateTime): number {
  return new Date(d.ms).getUTCDate()
}
function year(d: NaiveDateTime): number {
  return new Date(d.ms).getUTCFullYear()
}

function isMultiCourt(r: Recommendation): boolean {
  return (r.extra_court_ids?.length ?? 0) > 0
}

// ── Progress bar ───────────────────────────────────────────────────────────────

export function progressBar(pct: number, target: number, width = 20): string {
  const filled = Math.round((pct / 100) * width)
  const bar = ('█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))).split('')
  const marker = Math.round((target / 100) * width)
  if (marker >= 0 && marker < width) bar[marker] = '│'
  return `\`[${bar.join('')}]\` ${pct}%  (target: ${target}%)`
}

// ── Recommendations embed ──────────────────────────────────────────────────────

export interface EmbedField {
  name: string
  value: string
  inline: boolean
}

export function buildRecommendationsEmbed(
  targetDate: string,
  recs: Recommendation[],
  stats: Stats,
  previewOnly = false,
): unknown {
  const label = dayLabel(targetDate)
  const fields: EmbedField[] = []

  const recLines = recs.map((r, i) => {
    const emoji = LEVEL_EMOJI[r.level] ?? '⚪'
    const allCourts = [r.court_num, ...(r.extra_court_nums ?? [])].sort((a, b) => a - b)
    const courtStr =
      allCourts.length > 1 ? 'Courts #' + allCourts.join(' & #') : `Court #${r.court_num}`
    const suffix = isMultiCourt(r) ? '  *(max 8)*' : ''
    return (
      `\`${i + 1}.\` ${emoji} **${r.start.formatTime()} – ${r.end.formatTime()}** ` +
      `${courtStr} — ${r.event_name}${suffix}`
    )
  })
  fields.push({
    name: '📋 Recommendations',
    value: recLines.length ? recLines.join('\n') : '_None_',
    inline: false,
  })

  const bar = progressBar(stats.achieved_pct, stats.target_pct)
  fields.push({
    name: '📊 Utilization',
    value:
      `${bar}\n` +
      `Existing: **${stats.existing_court_hours}** hrs  ` +
      `+ Recommended: **${stats.recommended_court_hours}** hrs  ` +
      `= **${stats.achieved_court_hours}** / ${stats.target_court_hours} target ` +
      `(**${stats.achieved_pct}%** vs ${stats.target_pct}% goal)`,
    inline: false,
  })

  const covered = stats.levels_covered.map((l) => `${LEVEL_EMOJI[l] ?? '⚪'} ${l}`)
  const missing = (stats.levels_missing ?? []).map((l) => `❌ ${l}`)
  const levelLines = [...covered, ...missing]
  fields.push({
    name: '🎯 Skill Level Coverage',
    value: levelLines.length ? levelLines.join('  ') : '_None_',
    inline: false,
  })

  if (previewOnly) {
    fields.push({
      name: '👀 Preview — not booking',
      value: '_This is a dry run. Run with `--book` to book these recommendations._',
      inline: false,
    })
  } else {
    fields.push({
      name: '✅ How to approve',
      value:
        'Reply in this channel with:\n' +
        '`all` — book all recommendations\n' +
        '`1,3,5` — book specific numbers\n' +
        '`none` — skip all\n\n' +
        '_This message will be monitored until you reply._',
      inline: false,
    })
  }

  const color = (stats.levels_missing?.length ?? 0) === 0 ? 0x2ecc71 : 0xf39c12
  return {
    embeds: [
      {
        title: `🏓 Schedule Recommendations — ${label}`,
        color,
        fields,
        footer: { text: `White Mountain Pickleball • Court Reserve Scheduler • ${HOSTNAME}` },
        timestamp: new Date().toISOString(),
      },
    ],
  }
}

// ── Booking results embed ──────────────────────────────────────────────────────

/** Pack lines into embed fields, each value <= limit chars (Discord's 1024 cap). */
export function packLinesIntoFields(name: string, lines: string[], limit = 1024): EmbedField[] {
  const chunks: string[] = []
  let chunk: string[] = []
  let length = 0
  for (const line of lines) {
    const add = line.length + (chunk.length ? 1 : 0)
    if (chunk.length && length + add > limit) {
      chunks.push(chunk.join('\n'))
      chunk = [line]
      length = line.length
    } else {
      chunk.push(line)
      length += add
    }
  }
  if (chunk.length) chunks.push(chunk.join('\n'))
  return chunks.map((val, i) => ({
    name: i === 0 ? name : `${name} (cont.)`,
    value: val.slice(0, limit),
    inline: false,
  }))
}

export interface BookingResult {
  recommendation: RecommendationDict
  result: { success?: boolean; occurrence_id?: number; error?: string }
}

export function buildBookingResultsEmbed(
  results: BookingResult[],
  targetDate: string,
  attempt = 1,
  maxAttempts = 3,
): unknown {
  const label = dayLabel(targetDate)
  const lines: string[] = []
  let nOk = 0
  let nFail = 0
  for (const r of results) {
    const rec = r.recommendation
    const res = r.result
    const emoji = LEVEL_EMOJI[rec.level ?? ''] ?? '⚪'
    const timeS = `${rec.start_time} – ${rec.end_time}`
    const court = `Court #${rec.court_num}`
    if (res.success) {
      lines.push(`✅ ${emoji} **${timeS}** ${court} — ${rec.event_name}`)
      nOk++
    } else {
      let err = (res.error ?? 'unknown error').replace(/\n/g, ' ').trim()
      if (err.length > 220) err = err.slice(0, 217) + '…'
      lines.push(`❌ ${emoji} **${timeS}** ${court} — ${rec.event_name}\n  ↳ _${err}_`)
      nFail++
    }
  }

  const color = nFail === 0 ? 0x2ecc71 : nOk === 0 ? 0xe74c3c : 0xf39c12
  let footerText = `White Mountain Pickleball • Court Reserve Scheduler • ${HOSTNAME}`

  const fields = packLinesIntoFields(
    `Results — ${nOk} booked, ${nFail} failed`,
    lines.length ? lines : ['_No events processed._'],
  )

  if (nFail > 0 && attempt < maxAttempts) {
    const failedNums = results
      .map((r, i) => (!r.result.success ? String(i + 1) : null))
      .filter((x): x is string => x !== null)
    fields.push({
      name: `🔄 Retry? (attempt ${attempt}/${maxAttempts})`,
      value:
        `Failed events: **${failedNums.join(', ')}**\n\n` +
        'Reply with:\n' +
        '`retry` — retry all failed\n' +
        `\`retry ${failedNums.join(',')}\` — retry specific ones\n` +
        '`skip` — finish without retrying\n\n' +
        '_Monitoring for 3 minutes._',
      inline: false,
    })
    footerText += ' • Retry window closes in 3 min'
  }

  return {
    embeds: [
      {
        title: `📋 Booking Results — ${label}`,
        color,
        fields,
        footer: { text: footerText },
        timestamp: new Date().toISOString(),
      },
    ],
  }
}

// ── Reply parsers ──────────────────────────────────────────────────────────────

/**
 * Parse a webhook-mode booking reply. Returns 'all', 'none', a list of 0-based
 * indices, or null if unrecognised. Anything starting with 'skip' means none.
 */
export function parseBookingReply(content: string): 'all' | 'none' | number[] | null {
  let text = content.trim().toLowerCase()
  if (text.startsWith('skip')) return 'none'
  if (text.startsWith('book')) text = text.slice(4).trim()
  if (text === 'all' || text === '') return 'all'
  if (text === 'none' || text === 'no') return 'none'
  const parts = text.split(',').map((x) => x.trim()).filter(Boolean)
  const nums = parts.map((x) => Number(x))
  if (nums.some((n) => !Number.isInteger(n))) return null
  return nums.map((n) => n - 1)
}

/**
 * Parse a retry reply relative to the failed list. Returns 0-based positions in
 * the failed list, 'skip', or null if unrecognised.
 */
export function parseRetryReply(content: string, nFailed: number): number[] | 'skip' | null {
  const text = content.trim().toLowerCase()
  if (['skip', 'done', 'no', 'none'].includes(text)) return 'skip'
  if (text.startsWith('retry')) {
    const rest = text.slice(5).trim()
    if (!rest || rest === 'all') return Array.from({ length: nFailed }, (_, i) => i)
    const parts = rest.split(',').map((x) => x.trim()).filter(Boolean)
    const nums = parts.map((x) => Number(x))
    if (nums.some((n) => !Number.isInteger(n))) return null
    return nums.map((n) => n - 1).filter((i) => i >= 0 && i < nFailed)
  }
  return null
}

// ── Fixed-events reminder ──────────────────────────────────────────────────────

interface FixedEventsPolicy {
  fixed_events?: { status?: string; events?: unknown[]; pending_since?: string }
}

function fixedEventsPending(policy: FixedEventsPolicy): boolean {
  const fe = policy.fixed_events ?? {}
  return (fe.status ?? '').startsWith('PENDING') || !(fe.events && fe.events.length)
}

export function buildFixedEventsReminderEmbed(pendingSince: string, daysPending: number): unknown {
  const plural = daysPending !== 1 ? 's' : ''
  return {
    embeds: [
      {
        title: '📌 Action Required — Fixed Events List',
        color: 0xe74c3c,
        description:
          'The **fixed events list** has not been defined yet.\n\n' +
          'Fixed events are sessions that should **always** appear on the schedule ' +
          "regardless of utilization (e.g. *'Saturday morning Beginner Open Play'*).\n\n" +
          `Pending for **${daysPending} day${plural}** (since ${pendingSince}).`,
        fields: [
          {
            name: 'What to provide for each fixed event',
            value:
              '• Which event (from the approved list)\n' +
              '• Day(s) of week\n• Start & end time\n• Preferred court #',
            inline: false,
          },
          {
            name: 'How to add them',
            value:
              'Tell Claude Code: *"Add fixed event: Beginner Open Play, ' +
              'Saturdays 9–11 AM, Court #4"* and it will update `policy.json`.',
            inline: false,
          },
        ],
        footer: {
          text: `White Mountain Pickleball • This reminder posts daily until the list is complete • ${HOSTNAME}`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  }
}

// ── Send helpers ───────────────────────────────────────────────────────────────

export function sendRecommendations(
  rest: DiscordRest,
  targetDate: string,
  recs: Recommendation[],
  stats: Stats,
  previewOnly = false,
): Promise<string | null> {
  return rest.postEmbed(buildRecommendationsEmbed(targetDate, recs, stats, previewOnly))
}

export function sendBookingResults(
  rest: DiscordRest,
  results: BookingResult[],
  targetDate: string,
  attempt = 1,
  maxAttempts = 3,
): Promise<string | null> {
  return rest.postEmbed(buildBookingResultsEmbed(results, targetDate, attempt, maxAttempts))
}

export async function maybeSendFixedEventsReminder(
  rest: DiscordRest,
  policy: FixedEventsPolicy,
): Promise<boolean> {
  if (!fixedEventsPending(policy)) return false
  const pendingSince = policy.fixed_events?.pending_since ?? 'unknown'
  let daysPending = 0
  if (pendingSince !== 'unknown') {
    const since = NaiveDateTime.parseDate(pendingSince).ms
    daysPending = Math.floor((Date.now() - since) / 86_400_000)
  }
  await rest.postEmbed(buildFixedEventsReminderEmbed(pendingSince, daysPending))
  return true
}
