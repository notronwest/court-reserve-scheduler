/**
 * Daily scheduler flow — port of the `run.py <date> --llm --book` path (and its
 * `--dry-run`). Fetches the live schedule, generates recommendations (LLM ranker
 * with rule-based fallback), posts them to Discord, and — unless dry-run — saves
 * `pending_approval.json` for the listener to book on approval.
 *
 * This is what the daily launchd job runs and what the listener's `!schedule`
 * command spawns, replacing the Python `run.py`.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { CourtReserveClient } from './cr/client'
import type { Policy } from './policy'
import { recommendLlm, recommend, toDict, type Recommendation, type Stats } from './recommender'
import {
  sendRecommendations,
  maybeSendFixedEventsReminder,
  sendAutoBookSummary,
  sendFailureAlert,
} from './discord/notify'
import type { AutoBookResult } from './discord/execute'
import type { DiscordRest } from './discord/rest'
import { resolvePolicyProvenance, type PolicyProvenance } from './policyProvenance'
import { withRetry } from './retry'
import { resolveFixedEvents as resolveFixedEventsDefault, type FixedEventsResult } from './fixedEvents'

export interface SchedulerDeps {
  cr: CourtReserveClient
  rest: DiscordRest
  policy: Policy
  pendingPath: string
  historyPath?: string
  /** Where the fixed-events cache lives — defaults to `CR_STATE_DIR` / `../state`. */
  stateDir?: string
  log?: (m: string) => void
  /** Overridable for tests — defaults to resolving against the real git checkout. */
  resolveProvenance?: () => PolicyProvenance
  /** Overridable for tests — defaults to resolveFixedEvents(deps.cr, deps.policy). */
  resolveFixedEvents?: () => Promise<FixedEventsResult>
}

export interface SchedulerResult {
  recommendations: Recommendation[]
  stats: Stats
  messageId: string | null
  booked?: number
  failed?: number
}

/** Write pending_approval.json in the exact shape the listener + Python read. */
export function savePendingApproval(
  pendingPath: string,
  targetDate: string,
  recs: Recommendation[],
  stats: Stats,
  messageId: string | null,
): void {
  mkdirSync(dirname(pendingPath), { recursive: true })
  const payload = {
    target_date: targetDate,
    message_id: messageId,
    posted_at: new Date().toISOString(),
    stats,
    recommendations: recs.map(toDict),
  }
  writeFileSync(pendingPath, JSON.stringify(payload, null, 2))
}

/** Durable audit log of an auto-book run — one file per day, like the Python `booking_log_*.json`. */
export function saveBookingLog(
  logPath: string,
  targetDate: string,
  booked: number,
  failed: number,
  results: AutoBookResult[],
  policyProvenance?: PolicyProvenance | null,
  fixedEvents?: {
    source: FixedEventsResult['source']
    skipped: Stats['skipped_fixed_events']
    expired: number
  } | null,
): void {
  mkdirSync(dirname(logPath), { recursive: true })
  const payload = {
    target_date: targetDate,
    ran_at: new Date().toISOString(),
    booked,
    failed,
    policy_provenance: policyProvenance ?? null,
    // Where the standing pattern came from and which slots it could not place
    // (D-0056). Without this an unbooked fixed event left no durable trace at
    // all: `stats` is not written on the auto-book path.
    fixed_events: fixedEvents ?? null,
    results: results.map((r) => ({
      ...r.recommendation,
      success: r.success,
      occurrence_id: r.occurrence_id ?? null,
      error: r.error ?? null,
    })),
  }
  writeFileSync(logPath, JSON.stringify(payload, null, 2))
}

export async function runScheduler(
  targetDate: string,
  deps: SchedulerDeps,
  opts: {
    dryRun?: boolean
    llm?: boolean
    autoBook?: boolean
    /** Retry delays for the live schedule fetch (default 20 s, 60 s); tests pass []. */
    fetchRetryDelaysMs?: number[]
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<SchedulerResult> {
  const log = deps.log ?? (() => {})
  const useLlm = opts.llm ?? true
  const resolveProvenance = deps.resolveProvenance ?? resolvePolicyProvenance
  const provenance = resolveProvenance()

  const resolveFixed =
    deps.resolveFixedEvents ??
    (() => resolveFixedEventsDefault(deps.cr, deps.policy, { dir: deps.stateDir, log }))
  const fixedResult = await resolveFixed()
  log(
    `Standing pattern: ${fixedResult.events.length} active slot(s) from ${fixedResult.source}` +
      (fixedResult.expired.length > 0 ? `, ${fixedResult.expired.length} retired (until passed)` : ''),
  )
  const policy: Policy = {
    ...deps.policy,
    fixed_events: { ...deps.policy.fixed_events, events: fixedResult.events },
  }
  if (fixedResult.alert) {
    log(fixedResult.alert)
    try {
      await sendFailureAlert(deps.rest, targetDate, 'Fixed events read failed', fixedResult.alert)
    } catch (alertErr) {
      log(`Alert could not be posted: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`)
    }
  }

  log(`Fetching schedule for ${targetDate}…`)
  let items
  try {
    // One flaky browser page-load at 8:00:04 cost the whole day three times
    // (10/05, 10/06, 10/14). The read is idempotent — retry it before alerting.
    items = await withRetry(() => deps.cr.schedule(targetDate, targetDate), {
      delaysMs: opts.fetchRetryDelaysMs,
      sleep: opts.sleep,
      label: `schedule fetch ${targetDate}`,
      log,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log(`Schedule fetch failed: ${message}`)
    try {
      await sendFailureAlert(
        deps.rest,
        targetDate,
        'Schedule fetch failed — nothing booked',
        `Could not fetch the live Court Reserve schedule:\n\`${message}\``,
      )
    } catch (alertErr) {
      log(`Alert could not be posted: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`)
    }
    throw e
  }

  const { recommendations, stats } = useLlm
    ? await recommendLlm(items, targetDate, policy, { historyPath: deps.historyPath })
    : recommend(items, targetDate, policy)
  log(`Generated ${recommendations.length} recommendation(s) [source=${stats.rec_source}]`)

  // A fixed event is policy-mandated, so one that did not book is never dropped
  // silently — including the case this PR enables: every court pinned via
  // `preferred_courts` was already taken, which lands here as `no_court`.
  for (const s of stats.skipped_fixed_events) {
    log(
      `Fixed event NOT booked: ${s.name} ${s.day_of_week ?? '?'} ${s.start_time ?? '?'} ` +
        `(event ${s.event_id}) — reason=${s.reason}`,
    )
  }

  if (recommendations.length === 0 && opts.autoBook && !opts.dryRun) {
    try {
      await sendFailureAlert(
        deps.rest,
        targetDate,
        'Zero recommendations generated',
        'The recommender produced no bookings for this date — nothing was booked. ' +
          'This is unusual; check `policy.json` and the live schedule for this date.',
      )
    } catch (alertErr) {
      log(`Alert could not be posted: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`)
    }
  }

  // Auto-book mode: book directly, no approval gate. Keep a durable booking log,
  // and post a Discord confirmation of the run (green = all booked, amber/red on
  // failures) so there's positive proof each reservation landed.
  if (opts.autoBook && !opts.dryRun) {
    log(`Auto-booking ${recommendations.length} event(s) for ${targetDate}…`)
    const { bookAll } = await import('./discord/execute')
    const results = await bookAll(deps.cr, recommendations.map(toDict), log)
    const booked = results.filter((r) => r.success).length
    const failed = results.length - booked

    const logPath = resolve(
      dirname(deps.pendingPath),
      `booking_log_${targetDate.replace(/\//g, '-')}.json`,
    )
    saveBookingLog(logPath, targetDate, booked, failed, results, provenance, {
      source: fixedResult.source,
      skipped: stats.skipped_fixed_events,
      expired: fixedResult.expired.length,
    })

    try {
      await sendAutoBookSummary(
        deps.rest,
        targetDate,
        results.map((r) => ({
          event_name: r.recommendation.event_name,
          level: r.recommendation.level,
          start_time: r.recommendation.start_time,
          end_time: r.recommendation.end_time,
          court_num: r.recommendation.court_num,
          success: r.success,
          error: r.error,
        })),
        provenance,
      )
    } catch (e) {
      log(`Confirmation could not be posted: ${e instanceof Error ? e.message : String(e)}`)
    }

    return { recommendations, stats, messageId: null, booked, failed }
  }

  await maybeSendFixedEventsReminder(deps.rest, policy)
  const messageId = await sendRecommendations(
    deps.rest,
    targetDate,
    recommendations,
    stats,
    opts.dryRun ?? false,
    provenance,
  )
  log(opts.dryRun ? 'Preview posted (dry-run — not saving pending).' : `Recommendations posted (msg=${messageId}).`)

  if (!opts.dryRun) {
    savePendingApproval(deps.pendingPath, targetDate, recommendations, stats, messageId)
    log('Pending approval saved — listener will book on Discord approval.')
  }

  return { recommendations, stats, messageId }
}
