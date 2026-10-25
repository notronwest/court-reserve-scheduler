import { describe, it, expect } from 'vitest'
import type { ScheduleItem } from '../src/cr/types'
import { NaiveDateTime } from '../src/datetime'
import { findDuplicateOccurrences, readOccurrences } from '../src/availability'
import {
  buildDuplicateEmbed,
  localNow,
  planDuplicateCleanup,
  resolveDuplicate,
  runDuplicateCleanup,
} from '../src/jobs/duplicateEvents'

/**
 * Ron, 2026-10-24: "add a check in that for any duplicate events running at the
 * same time on the same day and delete one of them if they don't have any
 * registrants -- if both have registrants keep one and move the registrants over
 * to the one that is kept".
 *
 * The removals are irreversible, so these tests state the whole truth table —
 * above all the cases that must NOT cancel anything.
 */

const COURTS = new Set([1, 2, 3, 4])
const STRUCTURED_PLAY = 1135589
/** Midday on 10/25 — so "earlier today" and "later today" are both expressible. */
const NOW = NaiveDateTime.fromYMDHM('2026-10-25', '12:00')

let nextId = 7000
function occ(
  eventId: number,
  ymd: string,
  startHm: string,
  endHm: string,
  courtNums: number[],
  members = 0,
  extra: Partial<ScheduleItem> = {},
): ScheduleItem {
  return {
    Id: nextId++,
    EventId: eventId,
    EventName: 'Co-Ed Advanced Structured Play',
    StartDateTime: `${ymd}T${startHm}:00`,
    EndDateTime: `${ymd}T${endHm}:00`,
    Courts: courtNums.map((n) => `Pickleball-Court #${n}`).join(', '),
    MembersCount: members,
    ...extra,
  }
}

/** A CR client double that records what it was asked to cancel. */
function fakeCr(items: ScheduleItem[], failOn: number[] = []) {
  const cancelled: string[] = []
  return {
    cancelled,
    cr: {
      schedule: async () => items,
      cancel: async ({ res_id }: { res_id: string }) => {
        if (failOn.includes(Number(res_id))) throw new Error('503 Court Reserve browser busy')
        cancelled.push(res_id)
        return { success: true }
      },
    } as never,
  }
}

describe('finding duplicates', () => {
  it('groups two occurrences of one event at one start time', () => {
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 8),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
    ]
    const groups = findDuplicateOccurrences(items, COURTS)
    expect(groups).toHaveLength(1)
    expect(groups[0].occurrences).toHaveLength(2)
    // Keeper first: the one with registrants.
    expect(groups[0].occurrences[0].members).toBe(8)
    expect(groups[0].date).toBe('10/27/2026')
  })

  it('is not fooled by the same event at a DIFFERENT hour, or a different event at the same hour', () => {
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-27', '09:00', '11:00', [4]),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4]),
      occ(1633147, '2026-10-27', '17:00', '19:00', [3]),
    ]
    expect(findDuplicateOccurrences(items, COURTS)).toHaveLength(0)
  })

  it('ignores a cancelled copy, so a slot already cleaned up is not duplicated again', () => {
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 8),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, {
        EventName: 'Co-Ed Advanced Structured Play (Cancelled)',
      }),
    ]
    expect(findDuplicateOccurrences(items, COURTS)).toHaveLength(0)
  })

  it('ignores a row with no occurrence id — nothing could be addressed to it', () => {
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4]),
      { ...occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2]), Id: undefined },
    ]
    expect(findDuplicateOccurrences(items, COURTS)).toHaveLength(0)
  })

  it('reads the registrant count Court Reserve reports', () => {
    const read = readOccurrences([occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 11)], COURTS)
    expect(read[0].members).toBe(11)
    expect(read[0].court_nums).toEqual([4])
  })
})

describe('choosing what to keep', () => {
  it('keeps the copy with registrants and offers the empty one for removal', () => {
    const [a, b] = [
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 6),
    ]
    const r = resolveDuplicate(findDuplicateOccurrences([a, b], COURTS)[0])
    expect(r.keep.members).toBe(6)
    expect(r.removable.map((o) => o.members)).toEqual([0])
    expect(r.blocked).toHaveLength(0)
  })

  it('when both are empty, keeps the one on more courts and removes the other', () => {
    const r = resolveDuplicate(
      findDuplicateOccurrences(
        [
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 0),
        ],
        COURTS,
      )[0],
    )
    expect(r.keep.court_nums).toEqual([4, 3])
    expect(r.removable).toHaveLength(1)
    expect(r.removable[0].court_nums).toEqual([2])
  })

  it('when BOTH have registrants, removes nothing and marks it as needing a human', () => {
    const r = resolveDuplicate(
      findDuplicateOccurrences(
        [
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 5),
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 3),
        ],
        COURTS,
      )[0],
    )
    expect(r.removable).toHaveLength(0)
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0].members).toBe(3)
  })

  it('with three copies, keeps one and removes only the empty ones', () => {
    const r = resolveDuplicate(
      findDuplicateOccurrences(
        [
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 5),
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [1], 2),
        ],
        COURTS,
      )[0],
    )
    expect(r.keep.members).toBe(5)
    expect(r.removable).toHaveLength(1)
    expect(r.blocked.map((o) => o.members)).toEqual([2])
  })
})

describe('the window', () => {
  it('leaves a PAST duplicate alone — attendance is read off it', () => {
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-20', '17:00', '19:00', [4], 8),
      occ(STRUCTURED_PLAY, '2026-10-20', '17:00', '19:00', [2], 0),
    ]
    expect(planDuplicateCleanup(items, COURTS, NOW)).toHaveLength(0)
  })

  it('acts on a future duplicate', () => {
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
    ]
    expect(planDuplicateCleanup(items, COURTS, NOW)).toHaveLength(1)
  })

  it('leaves a duplicate that already ran EARLIER TODAY alone', () => {
    // The cutoff carries the time of day. With a midnight-today cutoff this
    // session, played at 9am, reads as still to come, and the 1pm run would
    // cancel a copy of something that has already happened.
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-25', '09:00', '11:00', [4], 8),
      occ(STRUCTURED_PLAY, '2026-10-25', '09:00', '11:00', [2], 0),
    ]
    expect(planDuplicateCleanup(items, COURTS, NOW)).toHaveLength(0)
  })

  it('acts on a duplicate still to come LATER TODAY', () => {
    const items = [
      occ(STRUCTURED_PLAY, '2026-10-25', '17:00', '19:00', [4], 8),
      occ(STRUCTURED_PLAY, '2026-10-25', '17:00', '19:00', [2], 0),
    ]
    expect(planDuplicateCleanup(items, COURTS, NOW)).toHaveLength(1)
  })

  it('localNow carries the wall-clock time, not just the date', () => {
    const t = localNow(new Date(2026, 9, 25, 14, 37))
    expect(t.formatYmd()).toBe('2026-10-25')
    expect(t.formatHm()).toBe('14:37')
  })
})

describe('running it', () => {
  it('cancels the empty copy and nothing else', async () => {
    const empty = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0)
    const keeper = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 8)
    const { cr, cancelled } = fakeCr([keeper, empty])
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(cancelled).toEqual([String(empty.Id)])
    expect(out[0].cancelled).toEqual([empty.Id])
  })

  it('cancels NOTHING when both copies have registrants', async () => {
    const { cr, cancelled } = fakeCr([
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 5),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 3),
    ])
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(cancelled).toEqual([])
    expect(out[0].blocked).toHaveLength(1)
    expect(out[0].cancelled).toBeUndefined()
  })

  it('cancels nothing on a dry run', async () => {
    const { cr, cancelled } = fakeCr([
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
    ])
    await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW, dryRun: true })
    expect(cancelled).toEqual([])
  })

  it('records a failed cancel rather than claiming it worked', async () => {
    const empty = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0)
    const { cr } = fakeCr([occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8), empty], [
      empty.Id as number,
    ])
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(out[0].cancelled).toBeUndefined()
    expect(out[0].failed?.[0].occurrence_id).toBe(empty.Id)
  })

  it('throws rather than treating an unreadable calendar as duplicate-free', async () => {
    const cr = {
      schedule: async () => {
        throw new Error('courtreserve-api GET /schedule -> 500: boom')
      },
      cancel: async () => ({ success: true }),
    } as never
    await expect(runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })).rejects.toThrow('500')
  })

  it('posts a report naming what it removed and what it left', async () => {
    const posted: unknown[] = []
    const rest = { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never
    const { cr } = fakeCr([
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 8),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
      occ(1633147, '2026-10-28', '10:00', '12:00', [4], 5),
      occ(1633147, '2026-10-28', '10:00', '12:00', [1], 4),
    ])
    await runDuplicateCleanup(cr, rest, COURTS, { days: 7, now: NOW })
    const embed = posted[0] as { embeds: { title: string; description: string }[] }
    expect(embed.embeds[0].title).toContain('1 removed')
    expect(embed.embeds[0].title).toContain('1 need')
    expect(embed.embeds[0].description).toContain('by hand')
  })

  it('says nothing when there is nothing to say', async () => {
    const posted: unknown[] = []
    const rest = { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never
    const { cr } = fakeCr([occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8)])
    await runDuplicateCleanup(cr, rest, COURTS, { days: 7, now: NOW })
    expect(posted).toEqual([])
  })
})

describe('buildDuplicateEmbed', () => {
  it('goes green when everything was cleaned and amber when something was left', () => {
    const groups = findDuplicateOccurrences(
      [
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8),
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
      ],
      COURTS,
    )
    const clean = resolveDuplicate(groups[0])
    clean.cancelled = [clean.removable[0].occurrence_id]
    const green = buildDuplicateEmbed([clean]) as { embeds: { color: number }[] }
    expect(green.embeds[0].color).toBe(0x2ecc71)

    const blockedGroups = findDuplicateOccurrences(
      [
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8),
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 2),
      ],
      COURTS,
    )
    const amber = buildDuplicateEmbed([resolveDuplicate(blockedGroups[0])]) as {
      embeds: { color: number }[]
    }
    expect(amber.embeds[0].color).toBe(0xf39c12)
  })
})
