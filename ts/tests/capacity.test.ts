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
  type DriftRow,
} from '../src/jobs/capacityDrift'
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
