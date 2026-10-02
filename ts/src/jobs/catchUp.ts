/**
 * Recovery path for issue #50: the daily job's 14-day horizon moves forward
 * every morning, so a date it silently missed (a dead `/schedule` fetch,
 * booking failures) stays missed forever unless someone notices and re-runs
 * it by hand. `catch-up` walks today..today+14, flags any date that's empty
 * or short against what the rule-based recommender thinks a normal day
 * should carry, and — with `--book` — re-runs the normal recommend+book path
 * (the same engine the daily job uses) for just the flagged dates. An
 * already-full day is never touched: it's simply not in the flagged list.
 */
import 'dotenv/config'
import { resolve } from 'node:path'
import { CourtReserveClient } from '../cr/client'
import { DiscordRest } from '../discord/rest'
import { loadPolicy, type Policy } from '../policy'
import { recommend } from '../recommender'
import { runScheduler, type SchedulerDeps } from '../scheduler'

export interface CatchUpDay {
  date: string
  day_of_week: string
  status: 'empty' | 'short' | 'ok'
  existing_court_hours: number
  n_recommendations: number
}

/** `M/D/YYYY` for `start + offsetDays`, computed in UTC so it's independent
 *  of the host's local timezone. */
function addDays(start: Date, offsetDays: number): string {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + offsetDays))
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
}

/** Scan today..today+horizonDays and classify each date (report-only, no booking). */
export async function scanCatchUp(
  cr: CourtReserveClient,
  policy: Policy,
  opts: { today?: Date; horizonDays?: number; log?: (m: string) => void } = {},
): Promise<CatchUpDay[]> {
  const log = opts.log ?? (() => {})
  const today = opts.today ?? new Date()
  const horizonDays = opts.horizonDays ?? 14
  const out: CatchUpDay[] = []

  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(today, i)
    const items = await cr.schedule(date, date)
    const { recommendations, stats } = recommend(items, date, policy)
    const status: CatchUpDay['status'] =
      stats.existing_court_hours === 0 ? 'empty' : recommendations.length > 0 ? 'short' : 'ok'
    out.push({
      date,
      day_of_week: stats.day_of_week,
      status,
      existing_court_hours: stats.existing_court_hours,
      n_recommendations: recommendations.length,
    })
    log(
      `  ${date} (${stats.day_of_week}): ${status.toUpperCase()}` +
        (status !== 'ok'
          ? ` — ${stats.existing_court_hours}h existing, ${recommendations.length} rec(s) to fill`
          : ''),
    )
  }
  return out
}

export interface CatchUpResult {
  days: CatchUpDay[]
  booked: string[]
}

/** Scan, and with `opts.book` re-run the daily recommend+book path for every
 *  flagged (empty or short) date. Never touches an 'ok' (already-full) date. */
export async function runCatchUp(
  cr: CourtReserveClient,
  schedulerDeps: Omit<SchedulerDeps, 'cr'>,
  opts: { book?: boolean; today?: Date; horizonDays?: number; log?: (m: string) => void } = {},
): Promise<CatchUpResult> {
  const log = opts.log ?? (() => {})
  const days = await scanCatchUp(cr, schedulerDeps.policy, {
    today: opts.today,
    horizonDays: opts.horizonDays,
    log,
  })

  const flagged = days.filter((d) => d.status !== 'ok')
  const booked: string[] = []
  if (flagged.length === 0) {
    log('No gaps in the horizon.')
    return { days, booked }
  }

  log(`${flagged.length} day(s) need attention: ${flagged.map((d) => `${d.date} (${d.status})`).join(', ')}`)
  if (!opts.book) {
    log('Report only — pass --book to recommend+book these dates.')
    return { days, booked }
  }

  for (const d of flagged) {
    log(`Booking ${d.date} (${d.status})…`)
    await runScheduler(d.date, { ...schedulerDeps, cr }, { llm: true, autoBook: true })
    booked.push(d.date)
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
      historyPath: resolve(logsDir, '..', 'history', 'history_latest.json'),
      log: (m) => console.log(m),
    },
    { book: argv.includes('--book'), log: (m) => console.log(m) },
  )
  const flagged = result.days.filter((d) => d.status !== 'ok')
  console.log(`Done: ${flagged.length} day(s) flagged${result.booked.length ? `, ${result.booked.length} re-booked` : ''}.`)
}
