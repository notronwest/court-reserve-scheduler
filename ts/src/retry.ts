/**
 * Bounded retry for read-only calls into courtreserve-api.
 *
 * Every live Court Reserve read drives a real browser on the mini, and that
 * browser times out now and then (Playwright `Page.goto: Timeout 30000ms` is
 * the most common line in the service's error log). A single such timeout at
 * 8:00:04 AM killed the daily booking for 10/05, 10/06 and 10/14 — the fetch
 * had no retry, so one flaky page load cost a whole day of open play.
 *
 * `withRetry` runs `fn` up to `delaysMs.length + 1` times, sleeping the given
 * delay between attempts and logging each failure. It is only for idempotent
 * reads (schedule fetches); booking retries live in `discord/execute.ts`.
 */
export interface RetryOpts {
  /** Sleep before each retry; attempts = delaysMs.length + 1. Default 20 s, then 60 s. */
  delaysMs?: number[]
  /** Human label for the log line ("schedule fetch 10/14/2026"). */
  label?: string
  log?: (m: string) => void
  /** Overridable for tests. */
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_READ_RETRY_DELAYS_MS = [20_000, 60_000]

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_READ_RETRY_DELAYS_MS
  const log = opts.log ?? (() => {})
  const sleep = opts.sleep ?? realSleep
  const label = opts.label ?? 'call'
  const attempts = delays.length + 1
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      if (i < delays.length) {
        log(`${label} failed (attempt ${i + 1}/${attempts}): ${msg} — retrying in ${Math.round(delays[i] / 1000)}s`)
        await sleep(delays[i])
      } else {
        log(`${label} failed (attempt ${i + 1}/${attempts}): ${msg} — giving up`)
      }
    }
  }
  throw lastErr
}
