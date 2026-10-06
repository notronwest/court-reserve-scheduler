/**
 * Resolves the standing weekly fixed-events pattern (D-0056: now Postgres-backed,
 * written by the mini on a dashboard confirm) over `courtreserve-api`'s
 * `GET /fixed-events`, with a local cache so a transient read failure doesn't drop
 * the pattern. On failure, falls back to the last good cache, then to policy.json's
 * seed — the caller gets back an `alert` string whenever it did NOT use a live read,
 * so a stale fallback is never silent.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CourtReserveClient } from './cr/client'
import type { FixedEvent, Policy } from './policy'

export interface FixedEventsResult {
  events: FixedEvent[]
  source: 'live' | 'cache' | 'seed'
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

export async function resolveFixedEvents(
  cr: CourtReserveClient,
  policy: Policy,
  opts: { dir?: string; log?: (m: string) => void } = {},
): Promise<FixedEventsResult> {
  const dir = opts.dir ?? fixedEventsStateDir()
  const log = opts.log ?? (() => {})
  const cachePath = resolve(dir, 'fixed-events.json')

  try {
    const events = await cr.fixedEvents()
    mkdirSync(dir, { recursive: true })
    const cache: FixedEventsCache = { fetched_at: new Date().toISOString(), events }
    writeFileSync(cachePath, JSON.stringify(cache, null, 2))
    return { events, source: 'live' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log(`fixed-events fetch failed: ${message}`)

    if (existsSync(cachePath)) {
      const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as FixedEventsCache
      return {
        events: cache.events,
        source: 'cache',
        alert: `fixed events read failed — booked from cache dated ${cache.fetched_at}`,
      }
    }

    return {
      events: policy.fixed_events?.events ?? [],
      source: 'seed',
      alert: 'fixed events read failed — no cache available, booked from policy.json seed',
    }
  }
}
