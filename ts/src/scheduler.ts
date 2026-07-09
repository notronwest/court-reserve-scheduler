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
import { dirname } from 'node:path'
import type { CourtReserveClient } from './cr/client'
import type { Policy } from './policy'
import { recommendLlm, recommend, toDict, type Recommendation, type Stats } from './recommender'
import { sendRecommendations, maybeSendFixedEventsReminder } from './discord/notify'
import type { DiscordRest } from './discord/rest'

export interface SchedulerDeps {
  cr: CourtReserveClient
  rest: DiscordRest
  policy: Policy
  pendingPath: string
  historyPath?: string
  log?: (m: string) => void
}

export interface SchedulerResult {
  recommendations: Recommendation[]
  stats: Stats
  messageId: string | null
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

export async function runScheduler(
  targetDate: string,
  deps: SchedulerDeps,
  opts: { dryRun?: boolean; llm?: boolean } = {},
): Promise<SchedulerResult> {
  const log = deps.log ?? (() => {})
  const useLlm = opts.llm ?? true

  log(`Fetching schedule for ${targetDate}…`)
  const items = await deps.cr.schedule(targetDate, targetDate)

  const { recommendations, stats } = useLlm
    ? await recommendLlm(items, targetDate, deps.policy, { historyPath: deps.historyPath })
    : recommend(items, targetDate, deps.policy)
  log(`Generated ${recommendations.length} recommendation(s) [source=${stats.rec_source}]`)

  await maybeSendFixedEventsReminder(deps.rest, deps.policy)
  const messageId = await sendRecommendations(
    deps.rest,
    targetDate,
    recommendations,
    stats,
    opts.dryRun ?? false,
  )
  log(opts.dryRun ? 'Preview posted (dry-run — not saving pending).' : `Recommendations posted (msg=${messageId}).`)

  if (!opts.dryRun) {
    savePendingApproval(deps.pendingPath, targetDate, recommendations, stats, messageId)
    log('Pending approval saved — listener will book on Discord approval.')
  }

  return { recommendations, stats, messageId }
}
