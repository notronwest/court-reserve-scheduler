/**
 * Resolves the standing weekly fixed-events pattern (D-0056: now Postgres-backed,
 * written by the mini on a dashboard confirm) over `courtreserve-api`'s
 * `GET /fixed-events`, with a local cache so a transient read failure doesn't drop
 * the pattern. On failure, falls back to the last good cache, then to policy.json's
 * seed — the caller gets back an `alert` string whenever it did NOT use a live read,
 * so a stale fallback is never silent.
 *
 * Two things here exist because of specific failures, not for tidiness:
 *
 * 1. **The `until` cutoff is applied to every source, not just the live feed.**
 *    The service filters retired rows out server-side, but a cache written days ago
 *    and policy.json's committed seed do not — so a pattern retired yesterday would
 *    be booked from a stale cache. That is exactly how four retired Level Play slots
 *    kept getting treated as live.
 * 2. **An empty pattern alerts.** "Zero standing events" and "the read quietly
 *    returned nothing" look identical to the recommender, and the second one has
 *    already happened (see `CourtReserveClient.fixedEvents`). Never silent.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CourtReserveClient } from './cr/client'
import type { FixedEvent, Policy } from './policy'

export interface FixedEventsResult {
  events: FixedEvent[]
  source: 'live' | 'cache' | 'seed'
  /** Patterns dropped because their `until` is on or before today. */
  expired: FixedEvent[]
  alert?: string
}

interface FixedEventsCache {
  fetched_at: string
  events: FixedEvent[]
}

/** Defaults to `../state` (one level above `ts/`), mirroring `historyDir()`. */
export function fixedEventsStateDir(): string {
  return process.env.CR_STATE_DIR ?? resolve(process.cwd(), '..', 'state')
}

/** Local calendar date as `YYYY-MM-DD` — the clock the `until` cutoff compares
 *  against, matching the `current_date` the service's own filter uses. */
export function localTodayIso(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Split patterns into the ones still running and the ones whose run has ended.
 * A row whose `until` is on or before `today` is retired and must not be booked;
 * a null/absent `until` runs indefinitely. Dates compare as `YYYY-MM-DD` strings,
 * which sort chronologically, so no Date parsing is involved.
 */
export function dropExpired(
  events: FixedEvent[],
  today: string,
): { kept: FixedEvent[]; expired: FixedEvent[] } {
  const kept: FixedEvent[] = []
  const expired: FixedEvent[] = []
  for (const fe of events) {
    const until = fe.until ?? null
    // Normalise a timestamp ("2026-10-07T00:00:00Z") down to its date part.
    const untilDate = until ? String(until).slice(0, 10) : null
    if (untilDate && untilDate <= today) expired.push(fe)
    else kept.push(fe)
  }
  return { kept, expired }
}

/** Shared tail: apply the `until` cutoff and describe what came back. */
function finish(
  events: FixedEvent[],
  source: FixedEventsResult['source'],
  today: string,
  readAlert: string | undefined,
  log: (m: string) => void,
): FixedEventsResult {
  const { kept, expired } = dropExpired(events, today)
  if (expired.length > 0) {
    log(
      `fixed-events: ${expired.length} retired pattern(s) skipped (until <= ${today}): ` +
        expired.map((e) => `${e.name} ${e.day_of_week} ${e.start_time}`).join(', '),
    )
  }
  // An empty pattern is indistinguishable from a read that quietly returned
  // nothing, so it is always reported even on a clean live read.
  const emptyAlert =
    kept.length === 0
      ? `fixed events resolved to ZERO active standing patterns (source=${source}) — ` +
        'no recurring slot will be booked. Check courtreserve-api GET /fixed-events ' +
        'and courtreserve.fixed_events.'
      : undefined

  const alert = [readAlert, emptyAlert].filter(Boolean).join(' · ') || undefined
  return { events: kept, source, expired, alert }
}

export async function resolveFixedEvents(
  cr: CourtReserveClient,
  policy: Policy,
  opts: { dir?: string; log?: (m: string) => void; today?: string } = {},
): Promise<FixedEventsResult> {
  const dir = opts.dir ?? fixedEventsStateDir()
  const log = opts.log ?? (() => {})
  const today = opts.today ?? localTodayIso()
  const cachePath = resolve(dir, 'fixed-events.json')

  try {
    const events = await cr.fixedEvents()
    mkdirSync(dir, { recursive: true })
    // Cache the rows as fetched, unfiltered: the `until` cutoff is re-applied on
    // every read, so tomorrow's fallback judges them against tomorrow's date.
    const cache: FixedEventsCache = { fetched_at: new Date().toISOString(), events }
    writeFileSync(cachePath, JSON.stringify(cache, null, 2))
    return finish(events, 'live', today, undefined, log)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log(`fixed-events fetch failed: ${message}`)

    if (existsSync(cachePath)) {
      try {
        const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as FixedEventsCache
        if (Array.isArray(cache?.events)) {
          return finish(
            cache.events,
            'cache',
            today,
            `fixed events read failed — booked from cache dated ${cache.fetched_at}`,
            log,
          )
        }
        log('fixed-events cache is present but malformed — falling through to the seed')
      } catch (cacheErr) {
        log(
          'fixed-events cache could not be read: ' +
            (cacheErr instanceof Error ? cacheErr.message : String(cacheErr)),
        )
      }
    }

    return finish(
      policy.fixed_events?.events ?? [],
      'seed',
      today,
      'fixed events read failed — no cache available, booked from policy.json seed',
      log,
    )
  }
}
