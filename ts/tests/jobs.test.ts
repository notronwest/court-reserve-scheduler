import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchHistory, pruneOld } from '../src/jobs/fetchHistory'
import { buildCtx, analyseDay, planChanges, findFreeCourt } from '../src/jobs/fixImbalance'
import { NaiveDateTime } from '../src/datetime'
import type { Policy } from '../src/policy'
import type { ScheduleItem } from '../src/cr/types'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const policy = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy
const ctx = buildCtx(policy)

const AI = ctx.aiEventId
const INT = ctx.intEventId

let tmp: string
beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'jobs-'))))
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// ── fetchHistory ────────────────────────────────────────────────────────────

describe('fetchHistory', () => {
  it('writes a datestamped archive + history_latest.json', async () => {
    const cr = { schedule: async () => [{ Id: 1 }, { Id: 2 }] } as never
    const items = await fetchHistory(cr, { dir: tmp, today: new Date(2026, 6, 13), months: 3 })
    expect(items).toHaveLength(2)
    expect(existsSync(resolve(tmp, 'history_2026-07-13.json'))).toBe(true)
    expect(existsSync(resolve(tmp, 'history_latest.json'))).toBe(true)
  })

  it('prunes archives older than 60 days but keeps latest + recent', () => {
    writeFileSync(resolve(tmp, 'history_2020-01-01.json'), '[]')
    writeFileSync(resolve(tmp, 'history_2026-07-10.json'), '[]')
    writeFileSync(resolve(tmp, 'history_latest.json'), '[]')
    pruneOld(tmp, new Date(2026, 6, 13))
    expect(existsSync(resolve(tmp, 'history_2020-01-01.json'))).toBe(false) // old → pruned
    expect(existsSync(resolve(tmp, 'history_2026-07-10.json'))).toBe(true) // recent → kept
    expect(existsSync(resolve(tmp, 'history_latest.json'))).toBe(true) // never pruned
  })
})

// ── fixImbalance ──────────────────────────────────────────────────────────────

const DATE = '7/13/2026' // Monday (weekday window)
const YMD = '2026-07-13'
function item(eid: number, id: number, hour: number, court: number, members = 0): ScheduleItem {
  const h = String(hour).padStart(2, '0')
  const h2 = String(hour + 2).padStart(2, '0')
  return {
    EventId: eid,
    Id: id,
    StartDateTime: `${YMD}T${h}:00:00`,
    EndDateTime: `${YMD}T${h2}:00:00`,
    Courts: `#${court}`,
    MembersCount: members,
  } as ScheduleItem
}

describe('analyseDay', () => {
  it('classifies AI vs Intermediate by level', () => {
    const day = analyseDay(ctx, DATE, [item(AI, 1, 9, 3, 2), item(INT, 2, 11, 1)])
    expect(day.ai_events).toHaveLength(1)
    expect(day.int_events).toHaveLength(1)
    expect(day.ai_events[0].members).toBe(2)
  })
})

describe('findFreeCourt', () => {
  it('returns the preferred free court (4 first) avoiding occupied ones', () => {
    const items = [item(AI, 1, 9, 3)]
    const start = NaiveDateTime.fromISO(`${YMD}T09:00:00`)
    const end = NaiveDateTime.fromISO(`${YMD}T11:00:00`)
    const cid = findFreeCourt(ctx, items, start, end)
    // court 4's id is preferred and free
    expect(ctx.courts[String(cid)].number).toBe(4)
  })

  it('returns null when 3 courts are already occupied at that time', () => {
    const items = [item(AI, 1, 9, 1), item(INT, 2, 9, 2), item(INT, 3, 9, 3)]
    const start = NaiveDateTime.fromISO(`${YMD}T09:00:00`)
    const end = NaiveDateTime.fromISO(`${YMD}T11:00:00`)
    expect(findFreeCourt(ctx, items, start, end)).toBeNull()
  })
})

describe('planChanges', () => {
  it('cancels a memberless extra AI but keeps the one with members', () => {
    const analyses = [analyseDay(ctx, DATE, [item(AI, 1001, 9, 3, 2), item(AI, 1002, 11, 3, 0)])]
    const changes = planChanges(ctx, analyses)
    const cancels = changes.filter((c) => c.action === 'cancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0].action === 'cancel' && cancels[0].occurrence_id).toBe(1002) // the 0-member one
  })

  it('never cancels an AI that has members (2 AI both with members)', () => {
    const analyses = [analyseDay(ctx, DATE, [item(AI, 1, 9, 3, 3), item(AI, 2, 11, 3, 1)])]
    const changes = planChanges(ctx, analyses)
    expect(changes.filter((c) => c.action === 'cancel')).toHaveLength(0)
  })

  it('pairs an Intermediate with an AI session at the same hour', () => {
    const analyses = [analyseDay(ctx, DATE, [item(AI, 1, 13, 3, 0)])]
    const changes = planChanges(ctx, analyses)
    const books = changes.filter((c) => c.action === 'book')
    expect(books.length).toBeGreaterThanOrEqual(1)
    expect(
      books.some((c) => c.action === 'book' && c.event_id === INT && c.start_time === '1:00 PM'),
    ).toBe(true)
  })
})
