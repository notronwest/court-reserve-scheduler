/**
 * Recovery path for issue #50, now a scheduled job (8:30 AM, after the 8:00
 * daily run) rather than a hand-run command.
 *
 * The daily job's 14-day horizon moves forward every morning, so a date it
 * missed (a dead `/schedule` fetch, booking failures) stays missed forever
 * unless something re-runs it. `catch-up` walks today..today+14 and classifies
 * each date:
 *
 *   empty    — nothing at all on the live calendar
 *   missed   — the daily run never completed for this date (no booking log,
 *              or a log with 0 booked) AND there is room to fill
 *   thin     — the daily run completed, but the calendar carries less than
 *              half the policy target (someone cancelled, or bookings failed)
 *   ok       — nothing to do
 *   unknown  — the live fetch failed even after retries
 *
 * With `--book`, `empty` and `missed` dates are re-booked through the SAME
 * recommend+book engine the daily job uses. `thin` is reported, never booked:
 * a day Ron deliberately thinned must not be refilled every morning. A day
 * the rule-based recommender would leave alone (0 recommendations) is `ok`
 * whatever its booking log says — catch-up can never over-fill a full day.
 *
 * Why not the recommender's own appetite as the signal? Because it flags every
 * day: the live LLM path books fewer sessions than the rule-based path wants,
 * so on 2026-10-08 the old "short" test marked 15 of 15 days and the one real
 * hole (10/14, 4.5 h against 10–22 h everywhere else) was invisible in the
 * noise. The booking log is the precise signal: did the daily run finish?
 */
import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CourtReserveClient } from '../cr/client'
import { DiscordRest } from '../discord/rest'
import { sendCatchUpReport } from '../discord/notify'
import { loadPolicy, type Policy } from '../policy'
import { recommend } from '../recommender'
import { withRetry } from '../retry'
import { runScheduler, type SchedulerDeps } from '../scheduler'

export type CatchUpStatus = 'empty' | 'missed' | 'thin' | 'ok' | 'unknown'
export type BookingLogState = 'ok' | 'none' | 'zero_booked'

export interface CatchUpDay {
  date: string
  day_of_week: string
  status: CatchUpStatus
  existing_court_hours: number
  target_court_hours: number
  n_recommendations: number
  booking_log: BookingLogState
  /** Set when status is `unknown` (fetch failed) or a re-book threw. */
  error?: string
}

export interface CatchUpBooked {
  date: string
  status: CatchUpStatus
  booked: number
  failed: number
  error?: string
}

export interface CatchUpResult {
  days: CatchUpDay[]
  booked: CatchUpBooked[]
}

/** Below this fraction of the policy target a completed day is `thin`. */
export const THIN_FRACTION = 0.5

/** `M/D/YYYY` for `start + offsetDays`, computed in UTC so it's independent
 *  of the host's local timezone. */
function addDays(start: Date, offsetDays: number): string {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + offsetDays))
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
}

/** Today's LOCAL calendar date as a UTC-midnight Date, so `addDays` agrees with
 *  the daily wrapper's `date -v+14d` whatever the hour. */
function localToday(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

/** The daily run writes `booking_log_<date with / → ->.json` using the date
 *  string it was GIVEN — launchd passes `10/14/2026` (zero-padded, from
 *  `date +%m/%d/%Y`), a hand run may pass `10/5/2026`. Accept both spellings. */
export function bookingLogCandidates(logsDir: string, date: string): string[] {
  const [m, d, y] = date.split('/')
  const pad = (s: string) => s.padStart(2, '0')
  const unpad = (s: string) => String(Number(s))
  const spellings = new Set([
    `${pad(m)}-${pad(d)}-${y}`,
    `${unpad(m)}-${unpad(d)}-${y}`,
    `${pad(m)}-${unpad(d)}-${y}`,
    `${unpad(m)}-${pad(d)}-${y}`,
  ])
  return [...spellings].map((s) => resolve(logsDir, `booking_log_${s}.json`))
}

export function readBookingLogState(logsDir: string, date: string): BookingLogState {
  for (const p of bookingLogCandidates(logsDir, date)) {
    if (!existsSync(p)) continue
    try {
      const data = JSON.parse(readFileSync(p, 'utf8')) as { booked?: number }
      return (data.booked ?? 0) > 0 ? 'ok' : 'zero_booked'
    } catch {
      return 'zero_booked' // unreadable log = the run did not finish cleanly
    }
  }
  return 'none'
}

export interface ScanOpts {
  today?: Date
  horizonDays?: number
  /** Where `booking_log_*.json` live — the daily run writes them next to pending_approval.json. */
  logsDir: string
  /** Retry delays for a failed live fetch; tests pass []. */
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  log?: (m: string) => void
}

export function classify(
  stats: { existing_court_hours: number; target_court_hours: number },
  nRecommendations: number,
  bookingLog: BookingLogState,
): CatchUpStatus {
  if (stats.existing_court_hours === 0) return 'empty'
  // Nothing the engine would add → nothing to catch up, whatever the log says.
  if (nRecommendations === 0) return 'ok'
  if (bookingLog !== 'ok') return 'missed'
  if (stats.target_court_hours > 0 && stats.existing_court_hours < THIN_FRACTION * stats.target_court_hours) {
    return 'thin'
  }
  return 'ok'
}

/** Scan today..today+horizonDays and classify each date (report-only, no booking). */
export async function scanCatchUp(
  cr: CourtReserveClient,
  policy: Policy,
  opts: ScanOpts,
): Promise<CatchUpDay[]> {
  const log = opts.log ?? (() => {})
  const today = opts.today ?? localToday()
  const horizonDays = opts.horizonDays ?? 14
  const out: CatchUpDay[] = []

  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(today, i)
    const bookingLog = readBookingLogState(opts.logsDir, date)
    let items
    try {
      items = await withRetry(() => cr.schedule(date, date), {
        delaysMs: opts.retryDelaysMs,
        sleep: opts.sleep,
        label: `schedule fetch ${date}`,
        log,
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      const { stats } = recommend([], date, policy)
      out.push({
        date,
        day_of_week: stats.day_of_week,
        status: 'unknown',
        existing_court_hours: 0,
        target_court_hours: stats.target_court_hours,
        n_recommendations: 0,
        booking_log: bookingLog,
        error,
      })
      log(`  ${date} (${stats.day_of_week}): UNKNOWN — live fetch failed: ${error}`)
      continue
    }
    const { recommendations, stats } = recommend(items, date, policy)
    const status = classify(stats, recommendations.length, bookingLog)
    out.push({
      date,
      day_of_week: stats.day_of_week,
      status,
      existing_court_hours: stats.existing_court_hours,
      target_court_hours: stats.target_court_hours,
      n_recommendations: recommendations.length,
      booking_log: bookingLog,
    })
    log(
      `  ${date} (${stats.day_of_week}): ${status.toUpperCase()} — ` +
        `${stats.existing_court_hours}h of ${stats.target_court_hours}h target, ` +
        `booking log ${bookingLog}` +
        (status !== 'ok' ? `, ${recommendations.length} rec(s) available` : ''),
    )
  }
  return out
}

export interface RunOpts extends ScanOpts {
  /** Re-book `empty` and `missed` dates. */
  book?: boolean
  /** Also re-book `thin` dates (never the default — see the header). */
  bookThin?: boolean
  /** Post the Discord report when anything is not `ok`. Default true. */
  report?: boolean
}

/** Scan, re-book what the daily job missed, and report. Never touches an
 *  `ok` date; never books `thin` without `bookThin`; never books `unknown`. */
export async function runCatchUp(
  cr: CourtReserveClient,
  schedulerDeps: Omit<SchedulerDeps, 'cr'>,
  opts: RunOpts,
): Promise<CatchUpResult> {
  const log = opts.log ?? (() => {})
  const days = await scanCatchUp(cr, schedulerDeps.policy, opts)

  const flagged = days.filter((d) => d.status !== 'ok')
  const booked: CatchUpBooked[] = []
  if (flagged.length === 0) {
    log('No gaps in the horizon.')
    return { days, booked }
  }

  log(`${flagged.length} day(s) need attention: ${flagged.map((d) => `${d.date} (${d.status})`).join(', ')}`)

  const bookable = new Set<CatchUpStatus>(['empty', 'missed'])
  if (opts.bookThin) bookable.add('thin')
  const toBook = flagged.filter((d) => bookable.has(d.status))

  if (!opts.book) {
    log('Report only — pass --book to recommend+book the empty/missed dates.')
  } else {
    for (const d of toBook) {
      log(`Booking ${d.date} (${d.status})…`)
      try {
        const r = await runScheduler(d.date, { ...schedulerDeps, cr }, { llm: true, autoBook: true })
        booked.push({ date: d.date, status: d.status, booked: r.booked ?? 0, failed: r.failed ?? 0 })
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        log(`  ${d.date}: re-book failed — ${error}`)
        booked.push({ date: d.date, status: d.status, booked: 0, failed: 0, error })
      }
    }
  }

  if (opts.report !== false) {
    try {
      await sendCatchUpReport(schedulerDeps.rest, days, booked, { bookMode: !!opts.book })
    } catch (e) {
      log(`Catch-up report could not be posted: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { days, booked }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const argv = process.argv.slice(2)
  const logsDir = process.env.CR_LOGS_DIR ?? resolve(process.cwd(), '..', 'logs')
  const cr = new CourtReserveClient(process.env.CRAPI_URL ?? 'http://localhost:8787', process.env.CRAPI_KEY ?? '')
  const rest = new DiscordRest({
    botToken: process.env.DISCORD_BOT_TOKEN ?? '',
    channelId: process.env.DISCORD_CHANNEL_ID ?? '',
    webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
  })
  const result = await runCatchUp(
    cr,
    {
      rest,
      policy: loadPolicy(),
      pendingPath: resolve(logsDir, 'pending_approval.json'),
      historyPath: resolve(dirname(logsDir), 'history', 'history_latest.json'),
      log: (m) => console.log(m),
    },
    { book: argv.includes('--book'), bookThin: argv.includes('--book-thin'), logsDir, log: (m) => console.log(m) },
  )
  const flagged = result.days.filter((d) => d.status !== 'ok')
  console.log(`Done: ${flagged.length} day(s) flagged${result.booked.length ? `, ${result.booked.length} re-booked` : ''}.`)
}
