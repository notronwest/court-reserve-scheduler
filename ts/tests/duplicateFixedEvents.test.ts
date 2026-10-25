import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPolicy, type FixedEvent, type Policy } from '../src/policy'
import { recommend, type ScheduleItem } from '../src/recommender'
import { isCancelled, occupiedSlots } from '../src/availability'
import { NaiveDateTime } from '../src/datetime'
import { dedupeRecommendations } from '../src/discord/execute'
import { buildPatternGapsEmbed } from '../src/discord/notify'
import { needsAttention, scanPatternGaps } from '../src/jobs/patternGaps'
import { resolveFixedEvents } from '../src/fixedEvents'
import { runScheduler } from '../src/scheduler'

/**
 * Ron, 2026-10-24: "There are a lot of double booked courts and same sessions
 * booked at the same time (e.g Advanced Open Play on 2 courts but two different
 * instances)."
 *
 * One session at one hour is ONE occurrence holding however many courts it
 * needs. Two occurrences of it are the bug. These tests pin the places that let
 * it happen.
 */

const STRUCTURED_PLAY = 1135589 // "Co-Ed Advanced Structured Play" — its own CR event
const ADVANCED_OPEN_PLAY = 1633147 // generic, one of the five approved ids
const noPop = new Map()

/** Structured Play's real standing slot: Tuesday 17:00–19:00, two courts. */
const TUE_PATTERN: FixedEvent[] = [
  {
    name: 'Co-Ed Advanced Structured Play',
    event_id: STRUCTURED_PLAY,
    day_of_week: 'Tuesday',
    start_time: '17:00',
    end_time: '19:00',
    courts: 2,
    max_participants: 10,
    level: 'Advanced',
  },
]

/** A CR schedule row for one occurrence, courts spelled the way CR spells them. */
function occurrence(
  eventId: number,
  name: string,
  ymd: string,
  startHm: string,
  endHm: string,
  courtNums: number[],
): ScheduleItem {
  return {
    Id: 900000 + eventId,
    EventId: eventId,
    EventName: name,
    StartDateTime: `${ymd}T${startHm}:00`,
    EndDateTime: `${ymd}T${endHm}:00`,
    Courts: courtNums.map((n) => `Pickleball-Court #${n}`).join(', '),
  }
}

describe('a standing session already on the live calendar is never booked twice', () => {
  // Tuesday 17:00–19:00 is Structured Play's standing slot in policy.json, on 2 courts.
  const TUESDAY = '10/13/2026'

  it('does not re-book a distinct-event session that is already there (the catch-up duplicate)', () => {
    const policy = loadPolicy()
    const items = [
      occurrence(STRUCTURED_PLAY, 'Co-Ed Advanced Structured Play', '2026-10-13', '17:00', '19:00', [4, 3]),
    ]
    const { recommendations, stats } = recommend(items, TUESDAY, policy, { popularity: noPop })

    expect(
      recommendations.filter((r) => r.event_id === STRUCTURED_PLAY && r.start.formatHm() === '17:00'),
    ).toHaveLength(0)
    // And it says why, rather than dropping the slot without a word.
    expect(
      stats.skipped_fixed_events.some(
        (s) => s.event_id === STRUCTURED_PLAY && s.start_time === '17:00' && s.reason === 'min_gap',
      ),
    ).toBe(true)
  })

  it('treats a generic approved session the same way (the case that already worked)', () => {
    const policy = loadPolicy()
    const items = [
      occurrence(ADVANCED_OPEN_PLAY, 'Co-ed Advanced Open Play', '2026-10-17', '10:00', '12:00', [4]),
    ]
    const { recommendations } = recommend(items, '10/17/2026', policy, { popularity: noPop })
    expect(
      recommendations.filter((r) => r.event_id === ADVANCED_OPEN_PLAY && r.start.formatHm() === '10:00'),
    ).toHaveLength(0)
  })

  it('counts a two-court occurrence once, so the standing slot later that day still books', () => {
    // `occupiedSlots` yields one row per COURT. Counted raw, this one two-court
    // occurrence spends the whole 2-per-day allowance by itself, and Saturday's
    // standing 10:00 Advanced Open Play is skipped as `max_occurrences` — a
    // session lost to a miscount. Counted as one occurrence, it books: the
    // 06:00–08:00 block clears constraint 3b's two-hour gap.
    const policy = loadPolicy()
    const items = [
      occurrence(ADVANCED_OPEN_PLAY, 'Co-ed Advanced Open Play', '2026-10-17', '06:00', '08:00', [1, 2]),
    ]
    const { recommendations, stats } = recommend(items, '10/17/2026', policy, { popularity: noPop })

    expect(
      recommendations.some((r) => r.event_id === ADVANCED_OPEN_PLAY && r.start.formatHm() === '10:00'),
    ).toBe(true)
    expect(stats.skipped_fixed_events.some((s) => s.reason === 'max_occurrences')).toBe(false)
  })
})

describe('cancelling one duplicate holds, and frees only that court', () => {
  // The cleanup that follows this fix: two instances of one session at one hour,
  // the extra one cancelled. The next morning's run must leave the survivor
  // alone, must not re-book the slot, and must stop treating the cancelled
  // instance's court as taken.
  const TUESDAY = '10/13/2026'
  const survivor = occurrence(
    STRUCTURED_PLAY, 'Co-Ed Advanced Structured Play', '2026-10-13', '17:00', '19:00', [4, 3],
  )
  const cancelled: ScheduleItem = {
    ...occurrence(STRUCTURED_PLAY, 'Co-Ed Advanced Structured Play', '2026-10-13', '17:00', '19:00', [2]),
    Id: 900999,
    EventName: 'Co-Ed Advanced Structured Play (Cancelled)',
  }

  it('does not re-book the slot the survivor still covers', () => {
    const { recommendations } = recommend([survivor, cancelled], TUESDAY, loadPolicy(), {
      popularity: noPop,
    })
    expect(
      recommendations.filter((r) => r.event_id === STRUCTURED_PLAY && r.start.formatHm() === '17:00'),
    ).toHaveLength(0)
  })

  it('counts the cancelled instance as holding nothing, so its court is usable again', () => {
    const occupied = occupiedSlots([survivor, cancelled], '2026-10-13', new Set([1, 2, 3, 4]))
    expect(occupied.map((o) => o.court_num).sort()).toEqual([3, 4])
    expect(isCancelled(cancelled)).toBe(true)
    expect(isCancelled(survivor)).toBe(false)
  })

  it('pattern-gaps reads a slot whose ONLY instance was cancelled as missing, not present', () => {
    const gaps = scanPatternGaps(TUE_PATTERN, [cancelled], [NaiveDateTime.parseDate(TUESDAY)])
    expect(gaps).toHaveLength(1)
    expect(gaps[0].has_courts).toBe(0)
    expect(gaps[0].status).toBe('no_court')
  })
})

describe('the gap-filler reports a duplicated slot instead of widening one of the copies', () => {
  // Whether the old code noticed anything depended on which copy Court Reserve
  // listed first: matching the one-court duplicate ahead of the healthy two-court
  // instance read as "short of courts", and the fixer then widened the DUPLICATE
  // onto a third court — spending more of the club on the bug.
  const TUESDAY = '10/13/2026'
  const dates = [NaiveDateTime.parseDate(TUESDAY)]
  const healthy = occurrence(
    STRUCTURED_PLAY, 'Co-Ed Advanced Structured Play', '2026-10-13', '17:00', '19:00', [4, 3],
  )
  const dupe: ScheduleItem = {
    ...occurrence(STRUCTURED_PLAY, 'Co-Ed Advanced Structured Play', '2026-10-13', '17:00', '19:00', [2]),
    Id: 900777,
  }

  it.each([
    ['healthy copy listed first', [healthy, dupe]],
    ['duplicate listed first', [dupe, healthy]],
  ])('flags it as a duplicate whichever order the feed lists them (%s)', (_label, items) => {
    const gaps = scanPatternGaps(TUE_PATTERN, items as ScheduleItem[], dates)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].status).toBe('duplicate')
    expect(gaps[0].instances).toBe(2)
    // Courts counted across both copies, each once.
    expect(gaps[0].has_courts).toBe(3)
  })

  it('stays silent on the healthy case: one occurrence holding its courts', () => {
    expect(scanPatternGaps(TUE_PATTERN, [healthy], dates)).toHaveLength(0)
  })

  it('a duplicate counts as needing a human, so the run exits non-zero', () => {
    const gaps = scanPatternGaps(TUE_PATTERN, [healthy, dupe], dates)
    expect(
      needsAttention({ gaps, patternsLive: true, patternsSource: 'live', daysScanned: 1 }),
    ).toBe(true)
  })

  it('the Discord report names it as booked twice, not as missing', () => {
    const gaps = scanPatternGaps(TUE_PATTERN, [healthy, dupe], dates)
    const embed = buildPatternGapsEmbed(gaps, { daysScanned: 14, patternsLive: true }) as {
      embeds: { title: string; description: string }[]
    }
    expect(embed.embeds[0].title).toContain('booked twice')
    expect(embed.embeds[0].title).not.toContain('missing')
    expect(embed.embeds[0].description).toContain('yours to approve')
  })
})

describe('dedupeRecommendations', () => {
  const rec = (eventId: number, startTime: string, courtNum: number) => ({
    event_id: eventId,
    event_name: 'Co-Ed Advanced Structured Play',
    level: 'Advanced',
    court_num: courtNum,
    court_id: 52348 + courtNum,
    court_label: `Pickleball-Court #${courtNum}`,
    extra_court_ids: [],
    extra_court_nums: [],
    max_participants: 0,
    date: '10/13/2026',
    start_time: startTime,
    end_time: '7:00 PM',
  })

  it('drops a second booking of the same event at the same date and time, and logs it', () => {
    const lines: string[] = []
    const out = dedupeRecommendations(
      [rec(STRUCTURED_PLAY, '5:00 PM', 4), rec(STRUCTURED_PLAY, '5:00 PM', 2)],
      (m) => lines.push(m),
    )
    expect(out).toHaveLength(1)
    expect(out[0].court_num).toBe(4)
    expect(lines.join('\n')).toContain('duplicate')
  })

  it('keeps two occurrences of one event at different hours', () => {
    const out = dedupeRecommendations([rec(STRUCTURED_PLAY, '9:00 AM', 4), rec(STRUCTURED_PLAY, '1:00 PM', 4)])
    expect(out).toHaveLength(2)
  })
})

describe('`until` retires a pattern on every source, not only the live feed', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(resolve(tmpdir(), 'fe-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const retired: FixedEvent = {
    name: 'Co-Ed 3.75+ Level Play',
    day_of_week: 'Monday',
    start_time: '17:00',
    end_time: '19:00',
    courts: 1,
    level: 'Advanced',
    until: '2026-10-07',
  }
  const live: FixedEvent = {
    name: 'Co-ed Intermediate Structured Play',
    day_of_week: 'Monday',
    start_time: '17:00',
    end_time: '19:00',
    courts: 2,
    level: 'Intermediate',
  }
  const TODAY = '2026-10-25'
  const seedPolicy = { fixed_events: { events: [retired, live] } } as unknown as Policy

  it('drops it on a live read', async () => {
    const cr = { fixedEvents: async () => [retired, live] } as never
    const r = await resolveFixedEvents(cr, seedPolicy, { dir, today: TODAY })
    expect(r.source).toBe('live')
    expect(r.events.map((e) => e.name)).toEqual([live.name])
    expect(r.expired.map((e) => e.name)).toEqual([retired.name])
  })

  it('drops it on a cache read, judged against today and not the day it was written', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, 'fixed-events.json'),
      JSON.stringify({ fetched_at: '2026-10-01T08:00:00Z', events: [retired, live] }),
    )
    const cr = {
      fixedEvents: async () => {
        throw new Error('service down')
      },
    } as never
    const r = await resolveFixedEvents(cr, seedPolicy, { dir, today: TODAY })
    expect(r.source).toBe('cache')
    expect(r.events.map((e) => e.name)).toEqual([live.name])
    expect(r.alert).toBeTruthy()
  })

  it('drops it on the policy.json seed', async () => {
    const cr = {
      fixedEvents: async () => {
        throw new Error('service down')
      },
    } as never
    const r = await resolveFixedEvents(cr, seedPolicy, { dir, today: TODAY })
    expect(r.source).toBe('seed')
    expect(r.events.map((e) => e.name)).toEqual([live.name])
    expect(r.alert).toBeTruthy()
  })
})

describe('a booking run will not book a standing pattern it could not verify', () => {
  let tmp: string
  beforeEach(() => (tmp = mkdtempSync(resolve(tmpdir(), 'sched-'))))
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const MONDAY = '10/26/2026'
  const FAKE_PROVENANCE = { policy_sha: 'abc1234def', head_sha: 'abc1234def', behind_origin_main: 0 }
  const pattern: FixedEvent[] = [
    {
      name: 'Co-ed Intermediate Structured Play',
      event_id: 1931656,
      day_of_week: 'Monday',
      start_time: '17:00',
      end_time: '19:00',
      courts: 2,
      max_participants: 10,
      level: 'Intermediate',
    },
  ]

  function deps(posted: { embeds?: { title?: string; description?: string }[] }[], booked: unknown[]) {
    return {
      cr: {
        schedule: async () => [],
        book: async (r: unknown) => {
          booked.push(r)
          return { success: true, occurrence_id: 1 }
        },
      } as never,
      rest: {
        postEmbed: async (p: unknown) => {
          posted.push(p as never)
          return 'm1'
        },
      } as never,
      policy: { ...loadPolicy(), fixed_events: { events: pattern } } as Policy,
      pendingPath: resolve(tmp, 'pending_approval.json'),
      stateDir: resolve(tmp, 'state'),
      resolveProvenance: () => FAKE_PROVENANCE,
      resolveFixedEvents: async () => ({
        events: pattern,
        source: 'cache' as const,
        expired: [],
        alert: 'fixed events read failed — booked from cache dated 2026-10-18T08:00:00Z',
      }),
    }
  }

  it('books none of it, and the Discord alert says so', async () => {
    const posted: { embeds?: { title?: string; description?: string }[] }[] = []
    const booked: unknown[] = []
    const res = await runScheduler(MONDAY, deps(posted, booked), { llm: false, autoBook: true })

    expect(res.recommendations.some((r) => r.start.formatHm() === '17:00' && r.event_id === 1931656)).toBe(false)
    expect(booked.some((b) => (b as { start_time?: string }).start_time === '5:00 PM')).toBe(false)
    const alert = posted.find((p) => p.embeds?.[0].description?.includes('not a live read'))
    expect(alert).toBeDefined()
    expect(alert!.embeds![0].description).toContain('NOT booked')

    // The booking log keeps the trace: the source it fell back to.
    const logged = JSON.parse(readFileSync(resolve(tmp, 'booking_log_10-26-2026.json'), 'utf8'))
    expect(logged.fixed_events.source).toBe('cache')
  })

  it('still SHOWS the fallback pattern on a dry run — nothing is written there', async () => {
    const posted: { embeds?: { title?: string; description?: string }[] }[] = []
    const booked: unknown[] = []
    const res = await runScheduler(MONDAY, deps(posted, booked), { llm: false, dryRun: true })
    expect(res.recommendations.some((r) => r.start.formatHm() === '17:00' && r.event_id === 1931656)).toBe(true)
    expect(booked).toHaveLength(0)
  })
})
