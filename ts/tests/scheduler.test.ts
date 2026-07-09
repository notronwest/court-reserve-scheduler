import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { recommend, recommendLlm, toDict, type ScheduleItem } from '../src/recommender'
import type { Policy } from '../src/policy'
import { savePendingApproval, runScheduler } from '../src/scheduler'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(FX, name), 'utf8')) as T
const policy = readJson<Policy>('policy.json')
const DATE = '7/13/2026'
const noPop = new Map()

/** Fake Anthropic-like client that returns a fixed book_slots tool call. */
function fakeClient(bookings: unknown[]) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', name: 'book_slots', input: { bookings } }],
        stop_reason: 'tool_use',
      }),
    },
  } as never
}

function throwingClient() {
  return { messages: { create: async () => { throw new Error('api down') } } } as never
}

describe('recommendLlm', () => {
  it('falls back to the rule-based passes when the LLM throws', async () => {
    const ruleBased = recommend([], DATE, policy, { popularity: noPop })
    const llm = await recommendLlm([], DATE, policy, { popularity: noPop, client: throwingClient() })
    expect(llm.stats.rec_source).toBe('fallback')
    expect(llm.recommendations.map(toDict)).toEqual(ruleBased.recommendations.map(toDict))
  })

  it('tags source=llm and keeps only Pass 0 when the LLM returns no bookings', async () => {
    const llm = await recommendLlm([], DATE, policy, { popularity: noPop, client: fakeClient([]) })
    expect(llm.stats.rec_source).toBe('llm')
    // With no LLM bookings, only fixed-event (Pass 0) recs remain — never more than
    // the rule-based path, which additionally runs Pass 1+2.
    const ruleBased = recommend([], DATE, policy, { popularity: noPop })
    expect(llm.recommendations.length).toBeLessThanOrEqual(ruleBased.recommendations.length)
  })

  it('commits a valid LLM booking that survives re-validation', async () => {
    // Borrow a real free-slot placement from the rule-based path, feed it to the LLM.
    const ruleBased = recommend([], DATE, policy, { popularity: noPop })
    const pick = ruleBased.recommendations.find((r) => r.extra_court_nums.length === 0)
    if (!pick) return // date has no single-court rec — skip
    const booking = {
      event_id: pick.event_id,
      court_num: pick.court_num,
      start_time: pick.start.formatHm(),
    }
    const llm = await recommendLlm([], DATE, policy, { popularity: noPop, client: fakeClient([booking]) })
    expect(llm.stats.rec_source).toBe('llm')
    expect(
      llm.recommendations.some(
        (r) => r.event_id === pick.event_id && r.court_num === pick.court_num,
      ),
    ).toBe(true)
  })
})

describe('savePendingApproval', () => {
  let tmp: string
  beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'sched-'))))
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('writes the shape the listener reads', () => {
    const { recommendations, stats } = recommend([], DATE, policy, { popularity: noPop })
    const path = resolve(tmp, 'nested', 'pending_approval.json')
    savePendingApproval(path, DATE, recommendations, stats, 'msg-9')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    expect(data.target_date).toBe(DATE)
    expect(data.message_id).toBe('msg-9')
    expect(typeof data.posted_at).toBe('string')
    expect(data.recommendations).toEqual(recommendations.map(toDict))
    expect(data.stats.rec_source).toBe('rule_based')
  })
})

describe('runScheduler', () => {
  let tmp: string
  beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'sched-'))))
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const scheduleItems: ScheduleItem[] = []

  function deps(posted: unknown[]) {
    return {
      cr: { schedule: async () => scheduleItems } as never,
      rest: { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never,
      policy,
      pendingPath: resolve(tmp, 'pending_approval.json'),
    }
  }

  it('posts recommendations and saves pending (rule-based path, no API)', async () => {
    const posted: unknown[] = []
    const res = await runScheduler(DATE, deps(posted), { llm: false })
    expect(res.stats.rec_source).toBe('rule_based')
    expect(posted.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(resolve(tmp, 'pending_approval.json'))).toBe(true)
  })

  it('dry-run posts a preview but does NOT save pending', async () => {
    const posted: unknown[] = []
    await runScheduler(DATE, deps(posted), { llm: false, dryRun: true })
    expect(posted.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(resolve(tmp, 'pending_approval.json'))).toBe(false)
  })
})
