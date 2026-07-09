/**
 * Check in past attendees — port of `checkin_past.py`.
 *
 * Scans past occurrences with registrants via `courtreserve-api`
 * `GET /checkin/scan`; with `--execute`, checks each in via `POST /checkin`.
 * Dry-run by default (lists who would be checked in). Console job, no Discord.
 */
import 'dotenv/config'
import { CourtReserveClient } from '../cr/client'
import type { CheckinCandidate } from '../cr/types'
import { loadPolicy, type Policy } from '../policy'

interface ApprovedCfg {
  [id: string]: { name: string; level: string }
}

export interface CheckinSummary {
  candidates: CheckinCandidate[]
  occurrences_processed: number
  members_checked_in: number
}

export async function runCheckinPast(
  cr: CourtReserveClient,
  opts: { days?: number; execute?: boolean; eventId?: number; policy?: Policy; log?: (m: string) => void } = {},
): Promise<CheckinSummary> {
  const log = opts.log ?? (() => {})
  const policy = opts.policy ?? loadPolicy()
  const approved = policy.approved_events as unknown as ApprovedCfg
  const nameOf = (eid: number) => approved[String(eid)]?.name ?? `Event ${eid}`
  const daysBack = opts.days ?? 90
  const eventIds = opts.eventId ? [opts.eventId] : Object.keys(approved).map(Number)

  log(`Scanning past ${daysBack} days for occurrences with registrants…`)
  const candidates = await cr.checkinScan(eventIds, daysBack)
  log(`  ${candidates.length} occurrence(s) with registrants.`)

  let processed = 0
  let checkedIn = 0
  for (const c of candidates) {
    if (!opts.execute) {
      log(`  [DRY RUN] ${nameOf(c.event_id)}  ${c.date_text}  (${c.registrations})  res_id=${c.res_id}`)
      continue
    }
    const res = await cr.checkin(c.event_id, c.res_id)
    processed++
    checkedIn += res.checked_in
    const status = res.success ? '✅' : '⚠️'
    log(`  ${status} ${nameOf(c.event_id)} ${c.date_text}: checked in ${res.checked_in}/${res.total}` +
      (res.names.length ? ` (${res.names.join(', ')})` : '') + (res.error ? ` — ${res.error}` : ''))
  }

  if (!opts.execute) {
    log('Dry run — nobody checked in. Pass --execute to apply.')
  } else {
    log(`Done: checked in ${checkedIn} member(s) across ${processed} occurrence(s).`)
  }
  return { candidates, occurrences_processed: processed, members_checked_in: checkedIn }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const argv = process.argv.slice(2)
  const daysIdx = argv.indexOf('--days')
  const eventIdx = argv.indexOf('--event')
  const cr = new CourtReserveClient(
    process.env.CRAPI_URL ?? 'http://localhost:8787',
    process.env.CRAPI_KEY ?? '',
  )
  await runCheckinPast(cr, {
    days: daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 90,
    eventId: eventIdx >= 0 ? Number(argv[eventIdx + 1]) : undefined,
    execute: argv.includes('--execute'),
    log: (m) => console.log(m),
  })
}
