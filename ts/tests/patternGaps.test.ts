/**
 * The question catch-up cannot answer: does every STANDING session exist?
 *
 * The case that produced this job, verbatim from 2026-10-13: Monday 10/19 reported **OK,
 * 19h of 26.4h** while the Co-ed Intermediate Structured Play that runs 5–7pm was not on
 * the calendar at all. A sweep of the fortnight found 21 missing sessions and 5 on fewer
 * courts than their pattern asks for — with every day reported fine.
 */
import { describe, it, expect } from 'vitest'
import {
  clockToAmPm,
  foldName,
  horizonDates,
  matchesPattern,
  needsAttention,
  scaledCap,
  scanPatternGaps,
  type PatternGapsResult,
} from '../src/jobs/patternGaps'
import { NaiveDateTime } from '../src/datetime'
import type { FixedEvent } from '../src/policy'
import type { ScheduleItem } from '../src/cr/types'

const MON = NaiveDateTime.parseDate('10/19/2026') // a Monday
const dates = [MON]

const intermediate: FixedEvent = {
  name: 'Co-ed Intermediate Structured Play',
  event_id: 2316716,
  day_of_week: 'Monday',
  start_time: '17:00',
  end_time: '19:00',
  courts: 2,
}

const item = (over: Partial<ScheduleItem>): ScheduleItem => ({
  Id: 1,
  EventId: 2316716,
  EventName: 'Co-ed Intermediate Structured Play',
  StartDateTime: '2026-10-19T17:00:00',
  EndDateTime: '2026-10-19T19:00:00',
  Courts: 'Court #2, Court #3',
  ...over,
})

describe('scanPatternGaps', () => {
  it('says nothing when the session is there on all its courts', () => {
    expect(scanPatternGaps([intermediate], [item({})], dates)).toEqual([])
  })

  it('catches the session that is simply not there — the 10/19 case', () => {
    // A day that LOOKS healthy: four other things booked, none of them this.
    const elsewhere = [
      item({ Id: 9, EventId: 1, EventName: 'Co-ed Intermediate Open Play', StartDateTime: '2026-10-19T16:00:00', EndDateTime: '2026-10-19T18:00:00', Courts: 'Court #1' }),
    ]
    const gaps = scanPatternGaps([intermediate], elsewhere, dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      date: '10/19/2026', name: 'Co-ed Intermediate Structured Play',
      wants_courts: 2, has_courts: 0, status: 'no_court',
    })
  })

  // ── A court taken back by hand stays taken back (D-0234) ──────────────────
  // Ron, 2026-10-28: "during the week I may delete an event that is set to recurring
  // because I need the court -- we should not try and fix the missing recurring event."
  // This job used to filter cancellations out and book the hole straight back, so a court
  // reclaimed by hand lasted until the next sweep.
  it('a cancelled occurrence is withdrawn, not missing — nothing is reported and nothing books', () => {
    const cancelled = item({ EventName: 'Co-ed Intermediate Structured Play (Cancelled)' })
    expect(scanPatternGaps([intermediate], [cancelled], dates)).toEqual([])
  })

  it('withdrawn beats SHORT of courts, so a cancelled one-court copy is not widened either', () => {
    const cancelled = item({ EventName: 'Cancelled - Co-ed Intermediate Structured Play', Courts: 'Court #4' })
    expect(scanPatternGaps([intermediate], [cancelled], dates)).toEqual([])
  })

  it('a cancellation at ANOTHER hour does not silence the real gap', () => {
    const elsewhere = item({
      EventName: 'Co-ed Intermediate Structured Play (Cancelled)',
      StartDateTime: '2026-10-19T09:00:00', EndDateTime: '2026-10-19T11:00:00',
    })
    const gaps = scanPatternGaps([intermediate], [elsewhere], dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ status: 'no_court', has_courts: 0 })
  })

  it('a cancellation of a DIFFERENT session does not silence this one', () => {
    const other = item({ Id: 7, EventId: 1, EventName: 'Co-ed Intermediate Open Play (Cancelled)' })
    const gaps = scanPatternGaps([intermediate], [other], dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ status: 'no_court' })
  })

  it('a LIVE occurrence beside a cancelled one is still judged on its courts', () => {
    const live = item({ Courts: 'Court #2, Court #3' })
    const cancelled = item({ Id: 8, EventName: 'Co-ed Intermediate Structured Play (Cancelled)' })
    expect(scanPatternGaps([intermediate], [live, cancelled], dates)).toEqual([])
  })

  // ── A session MOVED on the same day is not missing (D-0249) ───────────────
  // Ron, 2026-10-28: "Make it so that moves of an event on the same day count -- so its
  // not recreated during the sweep." A Court Reserve move edits the occurrence in place
  // and leaves nothing at the old hour, so the cancellation rule above cannot see it.
  // Measured live: Mens Advanced Plus booked 10/29 17:00 on courts 1+2, moved to 16:00 on
  // 3+4, and the next sweep reported 17:00 missing.
  it('a session moved to another hour the same day is not missing — nothing books', () => {
    const moved = item({ StartDateTime: '2026-10-19T16:00:00', EndDateTime: '2026-10-19T18:00:00' })
    expect(scanPatternGaps([intermediate], [moved], dates)).toEqual([])
  })

  it('a move onto FEWER courts is still a move — his choice, not a shortage to widen', () => {
    const moved = item({ StartDateTime: '2026-10-19T16:00:00', EndDateTime: '2026-10-19T18:00:00', Courts: 'Court #4' })
    expect(scanPatternGaps([intermediate], [moved], dates)).toEqual([])
  })

  it('the same session on ANOTHER day does not silence this day', () => {
    const elsewhere = item({ StartDateTime: '2026-10-20T16:00:00', EndDateTime: '2026-10-20T18:00:00' })
    const gaps = scanPatternGaps([intermediate], [elsewhere], dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ status: 'no_court', has_courts: 0 })
  })

  it('two sittings of one session in a day: the present one does not silence the absent one', () => {
    const early: FixedEvent = { ...intermediate, start_time: '09:00', end_time: '11:00' }
    const late = intermediate // 17:00
    // Only the 09:00 sitting is on the calendar, at its OWN hour — so 17:00 is genuinely missing.
    const onlyEarly = item({ StartDateTime: '2026-10-19T09:00:00', EndDateTime: '2026-10-19T11:00:00' })
    const gaps = scanPatternGaps([early, late], [onlyEarly], dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ start_time: '17:00', status: 'no_court' })
  })

  it('catches the session that is there on too few courts', () => {
    const gaps = scanPatternGaps([intermediate], [item({ Courts: 'Court #4' })], dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ has_courts: 1, wants_courts: 2 })
  })

  it('a pattern with no Court Reserve event is a DIFFERENT problem and says so', () => {
    const orphan: FixedEvent = { ...intermediate, event_id: undefined, name: 'Co-Ed 3.25-3.5 Level Play' }
    const gaps = scanPatternGaps([orphan], [], dates)
    expect(gaps[0].status).toBe('no_event')
  })

  it('only looks at the weekday the pattern runs on', () => {
    const tue = [NaiveDateTime.parseDate('10/20/2026')]
    expect(scanPatternGaps([intermediate], [], tue)).toEqual([])
  })

  it('matches a session at the same start whose title is spelled differently', () => {
    // The two sides are written by different hands: the club's name for the slot and
    // Court Reserve's own title. A double space cost real time before this.
    const spelled = item({ EventName: '  Co-ed  Intermediate Structured Play ' })
    expect(scanPatternGaps([intermediate], [spelled], dates)).toEqual([])
  })

  it('does NOT match a different session at the same hour', () => {
    const other = item({ EventId: 1135589, EventName: 'Co-Ed Advanced Structured Play' })
    const gaps = scanPatternGaps([intermediate], [other], dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].has_courts).toBe(0)
  })

  it('does not count a court the club does not have', () => {
    const gaps = scanPatternGaps([intermediate], [item({ Courts: 'Court #2, Pickleball-Court #9' })], dates)
    expect(gaps[0].has_courts).toBe(1)
  })
})

describe('the rules the gaps are judged by', () => {
  it('scales the cap when a session gets fewer courts than it wants', () => {
    // Ron: "we can't have 13 people on one court. The max would be 5."
    expect(scaledCap({ ...intermediate, max_participants: 10 }, 1)).toBe(5)
    expect(scaledCap({ ...intermediate, max_participants: 10 }, 2)).toBe(10)
  })

  it('never invents a cap for a pattern that has none', () => {
    expect(scaledCap(intermediate, 1)).toBe(0)
  })

  it('writes the clock the way Court Reserve\'s forms take it', () => {
    expect(clockToAmPm('17:00')).toBe('5:00 PM')
    expect(clockToAmPm('09:30')).toBe('9:30 AM')
    expect(clockToAmPm('00:15')).toBe('12:15 AM')
    expect(clockToAmPm('12:00')).toBe('12:00 PM')
  })

  it('folds a name past punctuation, case and spacing', () => {
    expect(foldName('Co-Ed  3.25-3.5 Level Play ')).toBe('coed32535levelplay')
    expect(matchesPattern(undefined, 'anything')).toBe(false)
    expect(matchesPattern('Intro to Pickleball ', 'Intro to Pickleball')).toBe(true)
  })

  it('walks the whole horizon from today', () => {
    const d = horizonDates(MON, 14)
    expect(d).toHaveLength(14)
    expect(d[0].formatDate()).toBe('10/19/2026')
    expect(d[13].formatDate()).toBe('11/1/2026') // across a month boundary
  })
})

describe('needsAttention — what makes the run exit non-zero', () => {
  const base = (gaps: PatternGapsResult['gaps']): PatternGapsResult => ({
    gaps, patternsLive: true, patternsSource: 'live', daysScanned: 14,
  })
  const gap = (status: string) =>
    ({ date: '10/19/2026', day_of_week: 'Monday', start_time: '17:00', end_time: '19:00',
       name: 'x', wants_courts: 2, has_courts: 0, status } as PatternGapsResult['gaps'][number])

  it('is quiet when everything it found got fixed', () => {
    expect(needsAttention(base([gap('booked'), gap('widened')]))).toBe(false)
  })

  it('fires on anything a human has to deal with', () => {
    for (const s of ['no_event', 'no_court', 'failed']) {
      expect(needsAttention(base([gap(s)])), s).toBe(true)
    }
  })

  it('fires when the standing patterns were not read live, whatever the gaps say', () => {
    // A cached or seeded pattern set could book a session the club retired, so the run
    // books nothing and must not pass silently.
    expect(needsAttention({ ...base([]), patternsLive: false, patternsSource: 'cache' })).toBe(true)
  })
})
