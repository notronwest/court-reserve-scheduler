import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  capForCourts,
  countCourts,
  governedByLimits,
  loadParticipantLimits,
  type ParticipantLimits,
} from '../src/capacity'
import {
  eventNamesFromSchedule,
  scanCapacityDrift,
  buildCapacityEmbed,
  runCapacityHeal,
  CapacityMemoryError,
  type CapacityLedger,
  type CapacityMemory,
  type DriftRow,
} from '../src/jobs/capacityDrift'
import type { CourtReserveClient } from '../src/cr/client'
import type { DiscordRest } from '../src/discord/rest'
import type { RegistrationOccurrence, ScheduleItem } from '../src/cr/types'
import type { Policy } from '../src/policy'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const policy = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy
const limits = loadParticipantLimits(policy)

const names = new Map<number, string>([
  [1, 'Co-ed Advanced Open Play'],
  [2, 'Co-Ed Advanced Structured Play'],
  [3, 'Third Shot Academy · Dinking Clinic, Level 1'],
  [4, 'Town Hall Meeting'],
  [5, 'Saturday Afternoon Advanced Mixed Contract Time'],
])

function occ(over: Partial<RegistrationOccurrence> = {}): RegistrationOccurrence {
  return {
    res_id: '100',
    event_id: 1,
    date: '2026-11-20',
    date_text: 'Fri, Nov 20th',
    time_text: '2:00 PM-4:00 PM',
    courts_text: 'Court #1, Court #2',
    registered: 0,
    max_people: 10,
    open_slots: 10,
    waitlist: 0,
    is_full: false,
    status: 'Upcoming',
    ...over,
  }
}

const verdict = (o: Partial<RegistrationOccurrence>): DriftRow =>
  scanCapacityDrift(limits, [occ(o)], names)[0]

describe('the court → capacity table (Ron, 2026-11-13)', () => {
  it('is the numbers he gave', () => {
    expect(capForCourts(limits, 1)).toBe(5)
    expect(capForCourts(limits, 2)).toBe(10)
    expect(capForCourts(limits, 3)).toBe(14)
    expect(capForCourts(limits, 4)).toBe(18)
    expect(limits.min).toBe(4)
  })

  it('says nothing about a court count the club does not have', () => {
    // 0 is "the table does not cover this", which every caller already treats as
    // "leave Court Reserve's own default alone".
    expect(capForCourts(limits, 0)).toBe(0)
    expect(capForCourts(limits, 5)).toBe(0)
  })

  it('refuses a policy with no table rather than reading as permissive', () => {
    // A table that silently came back empty would cap every session at 0, which
    // reads as "no cap" to /book and as "compliant" to the heal.
    const broken = { participant_limits: { max_by_courts: {} } } as unknown as Policy
    expect(() => loadParticipantLimits(broken)).toThrow(/max_by_courts is empty/)
  })

  it('governs the club play sessions and nothing else', () => {
    expect(governedByLimits(limits, 'Co-ed Advanced Open Play')).toBe(true)
    expect(governedByLimits(limits, 'Co-Ed Advanced Structured Play')).toBe(true)
    expect(governedByLimits(limits, 'Open Play Unleashed')).toBe(true)
    expect(governedByLimits(limits, "Caryns' Dink Divas Open Play")).toBe(true)
    expect(governedByLimits(limits, 'Third Shot Academy · Dinking Clinic, Level 1')).toBe(false)
    expect(governedByLimits(limits, 'Town Hall Meeting')).toBe(false)
    expect(governedByLimits(limits, 'Sunday Evening Contract Time')).toBe(false)
    expect(governedByLimits(limits, 'Intro to Pickleball')).toBe(false)
  })

  it('counts the courts in a Court Reserve courts string', () => {
    expect(countCourts('Court #1')).toBe(1)
    expect(countCourts('Court #1, Court #2')).toBe(2)
    expect(countCourts('Court #1, #2, #3, #4')).toBe(4)
    expect(countCourts('')).toBe(0)
    // Court Reserve has listed the same court twice on a malformed row.
    expect(countCourts('Court #4, Court #4')).toBe(1)
  })
})

describe('what the heal decides, occurrence by occurrence', () => {
  it('leaves a session that already matches its courts', () => {
    expect(verdict({ courts_text: 'Court #1, Court #2', max_people: 10 }).verdict).toBe('compliant')
  })

  it('raises a two-court session capped at 4', () => {
    // Six of these were on the live calendar on 2026-11-13.
    const row = verdict({ courts_text: 'Court #1, Court #2', max_people: 4 })
    expect(row.verdict).toBe('fixable')
    expect(row.wanted_max).toBe(10)
  })

  it('lowers a four-court session capped at 20', () => {
    const row = verdict({ courts_text: 'Court #1, #2, #3, #4', max_people: 20 })
    expect(row.verdict).toBe('fixable')
    expect(row.wanted_max).toBe(18)
  })

  it('never lowers a cap below the people already signed up', () => {
    // The live shape: 20 registered on four courts against a table value of 18.
    // Twenty people in an eighteen-person session is a roster problem, and
    // shrinking the cap under them would hide it.
    const row = verdict({ courts_text: 'Court #1, #2, #3, #4', max_people: 20, registered: 20 })
    expect(row.verdict).toBe('below_roster')
  })

  it('never raises a cap on a session with somebody waiting', () => {
    // Court Reserve notifies waitlisted members itself when room appears, so this
    // is a send to a member — the expansion approval's business, not an unattended job's.
    const row = verdict({ courts_text: 'Court #1', max_people: 4, registered: 4, waitlist: 3 })
    expect(row.verdict).toBe('waitlist_holds')
  })

  it('still LOWERS a cap on a session with a waitlist', () => {
    // Nobody is promoted by a cap coming down, so the waitlist guard does not apply.
    const row = verdict({ courts_text: 'Court #1', max_people: 9, registered: 0, waitlist: 2 })
    expect(row.verdict).toBe('fixable')
    expect(row.wanted_max).toBe(5)
  })

  it('reports a clinic, a rental and a town hall without touching them', () => {
    expect(verdict({ event_id: 3, courts_text: 'Court #1', max_people: 4 }).verdict).toBe('not_governed')
    expect(verdict({ event_id: 4, courts_text: 'Court #1', max_people: 100 }).verdict).toBe('not_governed')
    expect(verdict({ event_id: 5, courts_text: 'Court #1', max_people: 7 }).verdict).toBe('not_governed')
  })

  it('does not read an unreadable occurrence as compliant', () => {
    expect(verdict({ courts_text: '' }).verdict).toBe('courts_unknown')
    expect(verdict({ event_id: 999 }).verdict).toBe('courts_unknown')
  })
})

describe('the event names the heal judges against', () => {
  const items = [
    { IsEvent: true, EventId: 7, EventName: 'Co-ed Advanced Open Play' },
    { IsEvent: true, EventId: 7, EventName: 'Co-ed Advanced Open Play' },
    { IsEvent: false, EventId: 0, ReservationType: 'Private Drill Session' },
    { IsEvent: true, EventId: 8, EventName: '', ReservationType: 'Open Play Unleashed!' },
  ] as unknown as ScheduleItem[]

  it('takes one name per event and skips member court bookings', () => {
    const got = eventNamesFromSchedule(items)
    expect(got.size).toBe(2)
    expect(got.get(7)).toBe('Co-ed Advanced Open Play')
    // A row with no EventName falls back to what Court Reserve calls the reservation.
    expect(got.get(8)).toBe('Open Play Unleashed!')
  })
})

describe('the report', () => {
  it('says what each session now holds, in plain words', () => {
    const rows = scanCapacityDrift(
      limits,
      [
        occ({ res_id: '1', max_people: 4 }),
        occ({ res_id: '2', event_id: 4, courts_text: 'Court #1', max_people: 100 }),
      ],
      names,
    )
    const fixed = [{ ...rows[0], fixed: true }]
    const embed = buildCapacityEmbed(
      { rows, fixed, failed: [], reported: [], scannedEvents: 2 },
      limits as ParticipantLimits,
      14,
    ) as { embeds: Array<{ description: string }> }
    const text = embed.embeds[0].description
    expect(text).toContain('4 → **10**')
    expect(text).toContain('2 courts')
    expect(text).not.toContain('MaxPeople')
    expect(text).not.toContain('participant_limits')
  })
})

describe('Structured Play has its own table (Ron, 2026-11-14: 4 / 8 / 12 / 16)', () => {
  it('reads the per-name table for a Structured Play session, the general table otherwise', () => {
    for (const name of ['Co-Ed Advanced Structured Play', 'Co-ed Intermediate Structured Play']) {
      expect(capForCourts(limits, 1, name)).toBe(4)
      expect(capForCourts(limits, 2, name)).toBe(8)
      expect(capForCourts(limits, 3, name)).toBe(12)
      expect(capForCourts(limits, 4, name)).toBe(16)
    }
    expect(capForCourts(limits, 2, 'Co-ed Advanced Open Play')).toBe(10)
    expect(capForCourts(limits, 2)).toBe(10)
  })

  it('the shipped policy carries the same rule', () => {
    const live = loadParticipantLimits()
    expect(capForCourts(live, 2, 'Co-Ed Advanced Structured Play')).toBe(8)
    expect(capForCourts(live, 2, 'Co-ed Advanced Open Play')).toBe(10)
  })

  it('the heal leaves a two-court Structured Play at 8 and corrects one at 10 back to 8', () => {
    const rows = scanCapacityDrift(
      limits,
      [occ({ event_id: 2, max_people: 8, res_id: 'a' }), occ({ event_id: 2, max_people: 10, res_id: 'b', registered: 1 })],
      names,
    )
    expect(rows[0].verdict).toBe('compliant')
    expect(rows[1].verdict).toBe('fixable')
    expect(rows[1].wanted_max).toBe(8)
  })
})

describe('the sweep leaves a size set by hand (D-0337)', () => {
  const future = '2999-01-01'
  type Mem = { ledger: CapacityLedger | null; saves: number }
  const memory = (m: Mem, failSave = false): CapacityMemory => ({
    load: () => m.ledger,
    save: (l) => {
      if (failSave) throw new Error('disk full')
      m.ledger = l
      m.saves++
    },
  })
  const schedule = [{ IsEvent: true, EventId: 1, EventName: 'Co-ed Advanced Open Play' }] as unknown as ScheduleItem[]
  function fakeCr(reads: RegistrationOccurrence[][]) {
    const calls = { setCourts: [] as unknown[] }
    let i = 0
    const cr = {
      schedule: async () => schedule,
      registrations: async () => reads[Math.min(i++, reads.length - 1)],
      setCourts: async (req: unknown) => {
        calls.setCourts.push(req)
        return { success: true }
      },
    }
    return { cr: cr as unknown as CourtReserveClient, calls }
  }
  const one = (over: Partial<RegistrationOccurrence> = {}) =>
    occ({ date: future, courts_text: 'Court #1', max_people: 4, res_id: '9', ...over })
  const run = (cr: CourtReserveClient, mem: CapacityMemory, fix = true) =>
    runCapacityHeal(cr, null, { fix, policy, memory: mem, log: () => {} })

  it('calls a remembered one-court session carrying 4 hand_set and does not write it', async () => {
    const m: Mem = { ledger: { '9': { date: future, courts: 1 } }, saves: 0 }
    const { cr, calls } = fakeCr([[one()]])
    const res = await run(cr, memory(m))
    expect(res.rows[0].verdict).toBe('hand_set')
    expect(calls.setCourts).toHaveLength(0)
    expect(res.fixed).toHaveLength(0)
  })

  it('judges it afresh when the court count changed (two courts → one, still 10)', async () => {
    const m: Mem = { ledger: { '9': { date: future, courts: 2 } }, saves: 0 }
    const { cr, calls } = fakeCr([[one({ max_people: 10 })], [one({ max_people: 5 })]])
    const res = await run(cr, memory(m))
    expect(res.rows[0].verdict).toBe('fixable')
    expect(calls.setCourts).toHaveLength(1)
    expect((calls.setCourts[0] as { max_people: number }).max_people).toBe(5)
  })

  it('with no memory, --fix writes nothing and records every occurrence at its court count', async () => {
    const m: Mem = { ledger: null, saves: 0 }
    const { cr, calls } = fakeCr([[one(), one({ res_id: '10', courts_text: 'Court #1, Court #2', max_people: 7 })]])
    await run(cr, memory(m))
    expect(calls.setCourts).toHaveLength(0)
    expect(m.ledger).toEqual({ '9': { date: future, courts: 1 }, '10': { date: future, courts: 2 } })
  })

  it('a dry run neither baselines nor writes the memory, and reports hand_set rows', async () => {
    const m: Mem = { ledger: null, saves: 0 }
    const { cr, calls } = fakeCr([[one()]])
    const res = await run(cr, memory(m), false)
    expect(m.saves).toBe(0)
    expect(calls.setCourts).toHaveLength(0)
    expect(res.rows[0].verdict).toBe('fixable')
    const m2: Mem = { ledger: { '9': { date: future, courts: 1 } }, saves: 0 }
    expect((await run(fakeCr([[one()]]).cr, memory(m2), false)).rows[0].verdict).toBe('hand_set')
    expect(m2.saves).toBe(0)
  })

  it('does not remember a write whose follow-up read still shows the old number', async () => {
    const m: Mem = { ledger: {}, saves: 0 }
    const { cr } = fakeCr([[one()], [one()]])
    const res = await run(cr, memory(m))
    expect(res.fixed).toHaveLength(1)
    expect(m.ledger).toEqual({})
  })

  it('remembers a write that landed', async () => {
    const m: Mem = { ledger: {}, saves: 0 }
    const { cr } = fakeCr([[one()], [one({ max_people: 5 })]])
    await run(cr, memory(m))
    expect(m.ledger).toEqual({ '9': { date: future, courts: 1 } })
  })

  it('does not remember below_roster or waitlist_holds occurrences', async () => {
    const m: Mem = { ledger: null, saves: 0 }
    const { cr } = fakeCr([[
      one({ res_id: '1', courts_text: 'Court #1', max_people: 6, registered: 6 }),
      one({ res_id: '2', waitlist: 2 }),
    ]])
    await run(cr, memory(m))
    expect(m.ledger).toEqual({})
  })

  it('fails the run when the memory cannot be written', async () => {
    const m: Mem = { ledger: {}, saves: 0 }
    await expect(run(fakeCr([[one({ max_people: 5 })]]).cr, memory(m, true))).rejects.toThrow(CapacityMemoryError)
  })

  it('a hand_set occurrence does not post to Discord', async () => {
    const m: Mem = { ledger: { '9': { date: future, courts: 1 } }, saves: 0 }
    const posts: unknown[] = []
    const rest = { postEmbed: async (e: unknown) => void posts.push(e) } as unknown as DiscordRest
    await runCapacityHeal(fakeCr([[one()]]).cr, rest, { fix: true, policy, memory: memory(m), log: () => {} })
    expect(posts).toHaveLength(0)
  })
})
