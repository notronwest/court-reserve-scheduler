import { describe, it, expect } from 'vitest'
import type { ScheduleItem } from '../src/cr/types'
import type { CourtReserveClient } from '../src/cr/client'
import { NaiveDateTime } from '../src/datetime'
import {
  planCheckpoint,
  releaseStreak,
  runContractTime,
  type ContractLedger,
  type ContractMemory,
} from '../src/jobs/contractTime'

/**
 * Ron, 2026-11-22: the 48h / 24h Contract Time court checks. A court is full at 4. 48h: not full →
 * the owner is emailed. 24h: a court that would hold NOBODY is given back; a part-filled court is
 * kept and the email says it is under 4 (Ron: "Keep it"). Three releases in a row → Ron, nothing else.
 */

const EVENT = 2342350
const NOW = NaiveDateTime.fromYMDHM('2026-11-23', '12:00')

describe('planCheckpoint', () => {
  it('48h with 3 of 4 → at-risk email', () => {
    const p = planCheckpoint(40, 3, 1, false)
    expect(p).toMatchObject({ checkpoint: '48h', action: 'notice_at_risk', at_risk: 1 })
  })
  it('48h with 8 of 8 → nothing', () => {
    expect(planCheckpoint(40, 8, 2, false).action).toBe('none')
  })
  it('outside 48h or already started → nothing', () => {
    expect(planCheckpoint(60, 0, 2, false).action).toBe('none')
    expect(planCheckpoint(-1, 0, 2, true).action).toBe('none')
  })
  it('24h with 4 of 8 → one court released', () => {
    expect(planCheckpoint(20, 4, 2, true)).toMatchObject({ action: 'release', released: 1, kept: 1, kept_under_4: 0 })
  })
  it('24h with 5 of 8 → no release, one under-4 email (part-filled court kept)', () => {
    expect(planCheckpoint(20, 5, 2, true)).toMatchObject({ action: 'notice_under_4', released: 0, kept: 2, kept_under_4: 1 })
  })
  it('24h with 0 of 8 → both courts released', () => {
    expect(planCheckpoint(20, 0, 2, true)).toMatchObject({ action: 'release', released: 2, kept: 0 })
  })
  it('a release never leaves more registrants than the new capacity', () => {
    for (let reg = 0; reg <= 12; reg++) {
      const p = planCheckpoint(20, reg, 3, true)
      if (p.kept > 0) expect(reg).toBeLessThanOrEqual(p.kept * 4)
      else expect(reg).toBe(0)
    }
  })
  it('24h release is withheld when the 48h warning was never sent', () => {
    expect(planCheckpoint(20, 4, 2, false).action).toBe('withheld_no_48h')
  })
})

describe('releaseStreak', () => {
  const e = (date: string, released?: number) => ({ event_id: EVENT, date, seen24: true as const, ...(released === undefined ? {} : { w24: { at: '', released, kept: 1, emailed: true } }) })
  it('counts trailing releases and a non-release breaks the run', () => {
    const l: ContractLedger = { 1: e('2026-11-02', 1), 2: e('2026-11-09', 1), 3: e('2026-11-16', 1) }
    expect(releaseStreak(l, EVENT).run).toBe(3)
    l[4] = e('2026-11-23')
    expect(releaseStreak(l, EVENT).run).toBe(0)
  })
})

interface Fake {
  cr: CourtReserveClient
  sent: Array<{ eventId: number; req: Record<string, unknown> }>
  setCourts: Array<Record<string, unknown>>
  cancels: Array<Record<string, unknown>>
  posts: unknown[]
  memory: ContractMemory
  ledger: ContractLedger
  rest: { postEmbed: (p: unknown) => Promise<string | null> }
}

function occ(id: number, startIso: string, courts: number[]): ScheduleItem {
  return {
    Id: id,
    EventId: EVENT,
    EventName: 'Contract Time – Ridgeline',
    StartDateTime: startIso,
    EndDateTime: startIso.replace(/T\d\d/, 'T21'),
    Courts: courts.map((n) => `Pickleball-Court #${n}`).join(', '),
  }
}

function fake(items: ScheduleItem[], registrants: number, owner: Record<string, unknown> = { owner_name: 'Pat Owner', member_id: 9, email: 'p@x.com', status: 'ok' }): Fake {
  const state = { items: [...items] }
  const f = { sent: [] as Fake['sent'], setCourts: [] as Fake['setCourts'], cancels: [] as Fake['cancels'], posts: [] as unknown[] }
  const ledger: ContractLedger = {}
  const cr = {
    schedule: async () => state.items,
    roster: async () => Array.from({ length: registrants }, (_, i) => ({ org_member_id: i, member_name: 'x', email: null, has_email: false })),
    contractOwner: async () => owner,
    sendContractOwnerNotice: async (eventId: number, req: Record<string, unknown>) => {
      f.sent.push({ eventId, req })
      return {}
    },
    setCourts: async (req: { res_id: string; court_ids: string[] }) => {
      f.setCourts.push(req)
      // 52349.. are courts 1..4
      const nums = req.court_ids.map((c) => Number(c) - 52348)
      state.items = state.items.map((i) => (String(i.Id) === req.res_id ? { ...i, Courts: nums.map((n) => `Pickleball-Court #${n}`).join(', ') } : i))
      return { success: true }
    },
    cancel: async (req: { res_id: string }) => {
      f.cancels.push(req)
      state.items = state.items.filter((i) => String(i.Id) !== req.res_id)
      return { success: true }
    },
    registrations: async () => [],
  } as unknown as CourtReserveClient
  return {
    cr,
    ...f,
    memory: { load: () => ledger, save: () => {} },
    ledger,
    rest: { postEmbed: async (p: unknown) => (f.posts.push(p), 'id') },
  }
}

const run = (f: Fake, live = true) =>
  runContractTime(f.cr, { live, rest: f.rest as never, memory: f.memory, log: () => {}, now: NOW })

describe('runContractTime', () => {
  const in40h = '2026-11-25T04:00:00' // 40h after NOW → 48h window
  const in20h = '2026-11-24T08:00:00' // 20h after NOW → 24h window

  it('48h with 3 of 4 → one at-risk email; a re-run sends none', async () => {
    const f = fake([occ(1, in40h, [1])], 3)
    await run(f)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].req).toMatchObject({ checkpoint: '48h', players_signed_up: 3, courts: 1, courts_at_risk: 1 })
    await run(f)
    expect(f.sent).toHaveLength(1)
  })

  it('48h with 8 of 8 → no email', async () => {
    const f = fake([occ(1, in40h, [1, 2])], 8)
    await run(f)
    expect(f.sent).toHaveLength(0)
  })

  it('24h with 4 of 8 → one court released and a release email', async () => {
    const f = fake([occ(1, in20h, [1, 2])], 4)
    f.ledger['1'] = { event_id: EVENT, date: '2026-11-24', n48: { at: 'x' } }
    const r = await run(f)
    expect(f.setCourts).toEqual([{ res_id: '1', court_ids: ['52349'], max_people: 4, event_id: String(EVENT) }])
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].req).toMatchObject({ checkpoint: '24h', courts_released: 1 })
    expect(r.failures).toBe(0)
  })

  it('24h with 5 of 8 → no release, one under-4 email', async () => {
    const f = fake([occ(1, in20h, [1, 2])], 5)
    await run(f)
    expect(f.setCourts).toHaveLength(0)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].req).toMatchObject({ courts_released: 0, courts_kept_under_4: 1 })
  })

  it('24h with 0 of 8 → every court given back (the occurrence is cancelled) and one email', async () => {
    const f = fake([occ(1, in20h, [1, 2])], 0)
    f.ledger['1'] = { event_id: EVENT, date: '2026-11-24', n48: { at: 'x' } }
    await run(f)
    expect(f.cancels).toHaveLength(1)
    expect(f.sent[0].req).toMatchObject({ courts_released: 2 })
  })

  it('24h release is withheld, and Ron told once, when no 48h warning went out', async () => {
    const f = fake([occ(1, in20h, [1, 2])], 4)
    await run(f)
    await run(f)
    expect(f.setCourts).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
    expect(f.posts).toHaveLength(1)
  })

  it('an empty or ambiguous owner → an alert, no email, no release', async () => {
    for (const status of ['empty', 'ambiguous']) {
      const f = fake([occ(1, in20h, [1, 2])], 4, { owner_name: 'Pat', status })
      f.ledger['1'] = { event_id: EVENT, date: '2026-11-24', n48: { at: 'x' } }
      await run(f)
      expect(f.sent).toHaveLength(0)
      expect(f.setCourts).toHaveLength(0)
      expect(f.posts).toHaveLength(1)
    }
  })

  it('an unreadable roster does nothing and counts as a failure', async () => {
    const f = fake([occ(1, in20h, [1, 2])], 0)
    ;(f.cr as unknown as { roster: () => Promise<never> }).roster = async () => {
      throw new Error('boom')
    }
    const r = await run(f)
    expect(r.failures).toBe(1)
    expect(f.cancels).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  })

  it('dry run lists but neither emails nor releases', async () => {
    const f = fake([occ(1, in20h, [1, 2])], 4)
    f.ledger['1'] = { event_id: EVENT, date: '2026-11-24', n48: { at: 'x' } }
    const r = await run(f, false)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].outcome).toContain('give back 1')
    expect(f.sent).toHaveLength(0)
    expect(f.setCourts).toHaveLength(0)
    expect(f.posts).toHaveLength(0)
  })

  it('three consecutive releases → one card to Ron', async () => {
    const f = fake([occ(9, in20h, [1, 2])], 4)
    const done = (d: string) => ({ event_id: EVENT, date: d, n48: { at: 'x' }, seen24: true as const, w24: { at: 'x', released: 1, kept: 1, emailed: true } })
    f.ledger['5'] = done('2026-11-10')
    f.ledger['6'] = done('2026-11-17')
    f.ledger['9'] = { event_id: EVENT, date: '2026-11-24', n48: { at: 'x' } }
    const r = await run(f)
    expect(r.streakAlerts).toHaveLength(1)
    expect(f.posts).toHaveLength(1)
    await run(f)
    expect(f.posts).toHaveLength(1)
  })
})
