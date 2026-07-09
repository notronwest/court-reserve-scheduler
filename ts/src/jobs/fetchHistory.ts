/**
 * Fetch the rolling attendance history — port of `fetch_history.py`.
 *
 * Pulls the last N months of schedule via `courtreserve-api` `/schedule`, writes
 * a datestamped archive + `history_latest.json` (what the recommender/ranker
 * read), and prunes archives older than 60 days. Runs weekly via launchd.
 */
import 'dotenv/config'
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { CourtReserveClient } from '../cr/client'
import type { ScheduleItem } from '../cr/types'

const PRUNE_DAYS = 60

/** "%-m/%-d/%Y" — no leading zeros, matching Python's strftime. */
function mdy(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}
/** "%Y-%m-%d" for filenames. */
function ymd(d: Date): string {
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mo}-${day}`
}

export function historyDir(): string {
  return process.env.CR_HISTORY_DIR ?? resolve(process.cwd(), '..', 'history')
}

export async function fetchHistory(
  cr: CourtReserveClient,
  opts: { months?: number; dir?: string; today?: Date; log?: (m: string) => void } = {},
): Promise<ScheduleItem[]> {
  const months = opts.months ?? 3
  const dir = opts.dir ?? historyDir()
  const today = opts.today ?? new Date()
  const log = opts.log ?? (() => {})
  mkdirSync(dir, { recursive: true })

  const start = new Date(today)
  start.setDate(start.getDate() - months * 30)
  log(`Fetching history: ${mdy(start)} → ${mdy(today)} (${months} months)…`)

  const items = await cr.schedule(mdy(start), mdy(today))
  log(`  ${items.length} records fetched.`)

  const stamped = resolve(dir, `history_${ymd(today)}.json`)
  writeFileSync(stamped, JSON.stringify(items, null, 2))
  const latest = resolve(dir, 'history_latest.json')
  writeFileSync(latest, JSON.stringify(items, null, 2))
  log(`  Saved: ${stamped}`)
  log(`  Updated: ${latest}`)

  pruneOld(dir, today, log)
  return items
}

/** Remove history_YYYY-MM-DD.json archives older than PRUNE_DAYS (keep latest). */
export function pruneOld(dir: string, today: Date, log: (m: string) => void = () => {}): void {
  const cutoff = new Date(today)
  cutoff.setDate(cutoff.getDate() - PRUNE_DAYS)
  for (const name of readdirSync(dir)) {
    const m = /^history_(\d{4}-\d{2}-\d{2})\.json$/.exec(name)
    if (!m) continue // skips history_latest.json and anything else
    const fileDate = new Date(`${m[1]}T00:00:00`)
    if (Number.isFinite(fileDate.getTime()) && fileDate < cutoff) {
      unlinkSync(resolve(dir, name))
      log(`  Pruned old file: ${name}`)
    }
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const monthsArg = process.argv.indexOf('--months')
  const months = monthsArg >= 0 ? Number(process.argv[monthsArg + 1]) : 3
  const cr = new CourtReserveClient(
    process.env.CRAPI_URL ?? 'http://localhost:8787',
    process.env.CRAPI_KEY ?? '',
  )
  await fetchHistory(cr, { months, log: (m) => console.log(m) })
}
