import { describe, it, expect } from 'vitest'
import type { ScheduleItem } from '../src/cr/types'
import { NaiveDateTime } from '../src/datetime'
import { findDuplicateOccurrences, readMemberCount, readOccurrences } from '../src/availability'
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

interface FakeOpts {
  /** Occurrence ids whose cancel should fail. */
  failCancel?: number[]
  /** occurrence_id -> member ids on it, consumed as moves succeed. */
  rosters?: Record<number, number[]>
  /** Member ids whose move should be refused, with the message to throw. */
  refuseMove?: Record<number, string>
  /** Occurrence ids whose roster read should fail. */
  failRoster?: number[]
}

/** A CR client double recording cancels and moves, with mutable rosters. */
function fakeCr(items: ScheduleItem[], opts: FakeOpts = {}) {
  const cancelled: string[] = []
  const moves: Array<{ from: number; to: number; member: number; notify?: boolean }> = []
  const rosters: Record<number, number[]> = JSON.parse(JSON.stringify(opts.rosters ?? {}))
  return {
    cancelled,
    moves,
    rosters,
    cr: {
      schedule: async () => items,
      roster: async (_eventId: number, occurrenceId: number) => {
        if (opts.failRoster?.includes(occurrenceId)) {
          throw new Error('courtreserve-api GET roster -> 500: boom')
        }
        return (rosters[occurrenceId] ?? []).map((id) => ({
          org_member_id: id,
          member_name: `Member ${id}`,
          email: null,
          has_email: false,
        }))
      },
      moveRegistrant: async (req: {
        from_res_id: number
        to_res_id: number
        org_member_id: number
        notify?: boolean
      }) => {
        const refusal = opts.refuseMove?.[req.org_member_id]
        if (refusal) throw new Error(refusal)
        moves.push({
          from: req.from_res_id,
          to: req.to_res_id,
          member: req.org_member_id,
          notify: req.notify,
        })
        rosters[req.from_res_id] = (rosters[req.from_res_id] ?? []).filter(
          (id) => id !== req.org_member_id,
        )
        rosters[req.to_res_id] = [...(rosters[req.to_res_id] ?? []), req.org_member_id]
        return { ok: true }
      },
      // Shaped like the REAL endpoint, which needs the parent event and the date
      // as well as the occurrence. The earlier double took `{ res_id }` alone, so
      // 44 tests passed while every live cancel came back 422.
      cancel: async (req: { res_id: string; event_id?: string; date?: string }) => {
        if (!req.event_id || !req.date) {
          throw new Error(
            `POST /cancel -> 422: event_id and date are required; got ${JSON.stringify(req)}`,
          )
        }
        if (opts.failCancel?.includes(Number(req.res_id))) {
          throw new Error('503 Court Reserve browser busy')
        }
        cancelled.push(req.res_id)
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

describe('an unknown registrant count is never permission to cancel', () => {
  // The ONLY thing authorising a cancel is a reported count of zero.
  // `MembersCount` is reached through a cast and this range read has never been
  // exercised live for it, so absent / null / non-numeric must all read as
  // unknown. Folding any of them into zero deletes a session with people on it.
  const keeper = () => occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 8)

  it.each([
    ['absent', {}],
    ['null', { MembersCount: null }],
    ['an empty string', { MembersCount: '' }],
    ['a non-numeric string', { MembersCount: 'n/a' }],
    ['negative', { MembersCount: -1 }],
  ])('reads a %s count as unknown, not zero', (_label, extra) => {
    const row = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, {
      MembersCount: undefined,
      ...extra,
    })
    expect(readMemberCount(row)).toBeNull()
    expect(readOccurrences([row], COURTS)[0].members).toBeNull()
  })

  it('still reads a real zero as zero, and a numeric string as a number', () => {
    const zero = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0)
    expect(readMemberCount(zero)).toBe(0)
    const asString = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, {
      MembersCount: '6',
    })
    expect(readMemberCount(asString)).toBe(6)
  })

  it.each([
    ['absent', {}],
    ['null', { MembersCount: null }],
    ['a non-numeric string', { MembersCount: 'n/a' }],
  ])('cancels NOTHING when the extra copy has %s count', async (_label, extra) => {
    const mystery = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, {
      MembersCount: undefined,
      ...extra,
    })
    const { cr, cancelled } = fakeCr([keeper(), mystery])
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(cancelled).toEqual([])
    expect(out[0].removable).toHaveLength(0)
    expect(out[0].unknown).toHaveLength(1)
    expect(out[0].cancelled).toBeUndefined()
  })

  it('an unknown count outranks a known-empty one for keeping, and the empty one still goes', async () => {
    const mystery = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, {
      MembersCount: null,
    })
    const knownEmpty = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [1], 0)
    const { cr, cancelled } = fakeCr([knownEmpty, mystery])
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(out[0].keep.occurrence_id).toBe(mystery.Id)
    expect(cancelled).toEqual([String(knownEmpty.Id)])
  })

  it('names the unknown case in the report rather than going quiet', async () => {
    const posted: unknown[] = []
    const rest = { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never
    const mystery = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, {
      MembersCount: null,
    })
    const { cr } = fakeCr([keeper(), mystery])
    await runDuplicateCleanup(cr, rest, COURTS, { days: 7, now: NOW })
    const embed = posted[0] as { embeds: { title: string; description: string }[] }
    expect(embed.embeds[0].title).toContain('need you')
    expect(embed.embeds[0].description).toContain('did not say how many are signed up')
  })
})

describe('ids that cannot be grouped or addressed', () => {
  it('ignores a row whose event id is an empty string — Number("") is 0, which is finite', () => {
    const items = [
      { ...occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4]), EventId: '' as never },
      { ...occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2]), EventId: '' as never },
    ]
    expect(readOccurrences(items, COURTS)).toHaveLength(0)
    expect(findDuplicateOccurrences(items, COURTS)).toHaveLength(0)
  })

  it('ignores a row whose occurrence id is zero or empty', () => {
    const items = [
      { ...occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4]), Id: 0 },
      { ...occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2]), Id: '' as never },
    ]
    expect(readOccurrences(items, COURTS)).toHaveLength(0)
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
    expect(r.mergeable).toHaveLength(0)
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
    expect(r.mergeable).toHaveLength(1)
    expect(r.mergeable[0].members).toBe(3)
    expect(r.unknown).toHaveLength(0)
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
    expect(r.mergeable.map((o) => o.members)).toEqual([2])
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

  it('identifies the copy with players as one to merge, not one to drop', async () => {
    const { cr } = fakeCr([
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 5),
      occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 3),
    ])
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(out[0].removable).toHaveLength(0)
    expect(out[0].mergeable).toHaveLength(1)
    expect(out[0].mergeable[0].members).toBe(3)
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
    const { cr } = fakeCr([occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8), empty], {
      failCancel: [empty.Id as number],
    })
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

  it('posts one report covering what it removed and what it merged', async () => {
    const posted: unknown[] = []
    const rest = { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never
    const keeper = occ(1633147, '2026-10-28', '10:00', '12:00', [4], 5)
    const withPeople = occ(1633147, '2026-10-28', '10:00', '12:00', [1], 4)
    const { cr } = fakeCr(
      [
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 8),
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0),
        keeper,
        withPeople,
      ],
      { rosters: { [withPeople.Id as number]: [11, 12, 13, 14], [keeper.Id as number]: [1, 2, 3, 4, 5] } },
    )
    await runDuplicateCleanup(cr, rest, COURTS, { days: 7, now: NOW })
    const embed = posted[0] as { embeds: { title: string; description: string } [] }
    expect(embed.embeds[0].title).toContain('1 removed')
    expect(embed.embeds[0].title).toContain('1 merged')
    expect(embed.embeds[0].description).toContain('4 moved, not emailed')
  })

  it('says nothing when there is nothing to say', async () => {
    const posted: unknown[] = []
    const rest = { postEmbed: async (p: unknown) => { posted.push(p); return 'm1' } } as never
    const { cr } = fakeCr([occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8)])
    await runDuplicateCleanup(cr, rest, COURTS, { days: 7, now: NOW })
    expect(posted).toEqual([])
  })
})

describe('merging two copies that both have players', () => {
  const keeper = () => occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4, 3], 5)
  const other = () => occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 3)

  it('moves every player onto the keeper, then cancels the emptied copy', async () => {
    const keep = keeper()
    const src = other()
    const { cr, cancelled, moves, rosters } = fakeCr([keep, src], {
      rosters: { [src.Id as number]: [11, 12, 13], [keep.Id as number]: [1, 2, 3, 4, 5] },
    })
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })

    expect(moves.map((m) => m.member)).toEqual([11, 12, 13])
    expect(moves.every((m) => m.from === src.Id && m.to === keep.Id)).toBe(true)
    expect(rosters[keep.Id as number]).toEqual([1, 2, 3, 4, 5, 11, 12, 13])
    expect(cancelled).toEqual([String(src.Id)])
    expect(out[0].merged).toEqual([{ occurrence_id: src.Id, moved: [11, 12, 13] }])
  })

  it('never emails the players it moves', async () => {
    const src = other()
    const { cr, moves } = fakeCr([keeper(), src], { rosters: { [src.Id as number]: [11, 12] } })
    await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(moves).toHaveLength(2)
    expect(moves.every((m) => m.notify === false)).toBe(true)
  })

  it('stops at the first refusal and does NOT cancel the copy', async () => {
    const src = other()
    const { cr, cancelled, moves } = fakeCr([keeper(), src], {
      rosters: { [src.Id as number]: [11, 12, 13] },
      refuseMove: { 12: '9 of 10 places are taken, 1 open, and 1 were named — refusing' },
    })
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })

    expect(moves.map((m) => m.member)).toEqual([11])
    expect(cancelled).toEqual([])
    expect(out[0].mergeFailed?.[0].moved).toEqual([11])
    expect(out[0].mergeFailed?.[0].half_moved).toBe(false)
    expect(out[0].mergeFailed?.[0].error).toContain('refusing')
  })

  it('flags a half-finished move, where somebody is on both copies', async () => {
    const src = other()
    const { cr, cancelled } = fakeCr([keeper(), src], {
      rosters: { [src.Id as number]: [11, 12] },
      refuseMove: {
        12: 'courtreserve-api POST /events/registrations/move -> 409: HALF MOVED: member 12 IS now registered on 900002',
      },
    })
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(cancelled).toEqual([])
    expect(out[0].mergeFailed?.[0].half_moved).toBe(true)
  })

  it('refuses to cancel a copy whose roster still lists somebody', async () => {
    // The roster re-read is the proof. A double whose roster never empties stands
    // in for a move Court Reserve reported as fine but did not apply.
    const src = other()
    const { cr, cancelled } = fakeCr([keeper(), src], { rosters: { [src.Id as number]: [11] } })
    const stubborn = {
      ...(cr as unknown as Record<string, unknown>),
      roster: async () => [{ org_member_id: 11, member_name: 'Member 11', email: null, has_email: false }],
    } as never
    const out = await runDuplicateCleanup(stubborn, null, COURTS, { days: 7, now: NOW })
    expect(cancelled).toEqual([])
    expect(out[0].mergeFailed?.[0].error).toContain('still on the copy')
  })

  it('does not move anybody when the roster cannot be read', async () => {
    const src = other()
    const { cr, cancelled, moves } = fakeCr([keeper(), src], {
      rosters: { [src.Id as number]: [11, 12] },
      failRoster: [src.Id as number],
    })
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(moves).toEqual([])
    expect(cancelled).toEqual([])
    expect(out[0].mergeFailed?.[0].error).toContain('could not read the roster')
  })

  it('records a cancel that fails after a successful merge, without losing the moves', async () => {
    const src = other()
    const { cr, moves } = fakeCr([keeper(), src], {
      rosters: { [src.Id as number]: [11, 12] },
      failCancel: [src.Id as number],
    })
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(moves).toHaveLength(2)
    expect(out[0].merged?.[0].moved).toEqual([11, 12])
    expect(out[0].failed?.[0].occurrence_id).toBe(src.Id)
  })

  it('moves nobody on a dry run, and says what it would do', async () => {
    const src = other()
    const lines: string[] = []
    const { cr, cancelled, moves } = fakeCr([keeper(), src], {
      rosters: { [src.Id as number]: [11, 12, 13] },
    })
    await runDuplicateCleanup(cr, null, COURTS, {
      days: 7,
      now: NOW,
      dryRun: true,
      log: (m) => lines.push(m),
    })
    expect(moves).toEqual([])
    expect(cancelled).toEqual([])
    expect(lines.join('\n')).toContain('would move 3 player(s)')
    expect(lines.join('\n')).toContain('no email')
  })

  it('leaves an unknown-count copy out of the merge entirely', async () => {
    const mystery = occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, {
      MembersCount: null,
    })
    const { cr, cancelled, moves } = fakeCr([keeper(), mystery], {
      rosters: { [mystery.Id as number]: [11] },
    })
    const out = await runDuplicateCleanup(cr, null, COURTS, { days: 7, now: NOW })
    expect(moves).toEqual([])
    expect(cancelled).toEqual([])
    expect(out[0].unknown).toHaveLength(1)
    expect(out[0].mergeable).toHaveLength(0)
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

    // Amber is now for what the run could not judge: an unreported sign-up count.
    const unknownGroups = findDuplicateOccurrences(
      [
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8),
        occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 0, { MembersCount: null }),
      ],
      COURTS,
    )
    const amber = buildDuplicateEmbed([resolveDuplicate(unknownGroups[0])]) as {
      embeds: { color: number }[]
    }
    expect(amber.embeds[0].color).toBe(0xf39c12)

    // A merge that stopped part-way is red — somebody has to look at it.
    const stuck = resolveDuplicate(
      findDuplicateOccurrences(
        [
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [4], 8),
          occ(STRUCTURED_PLAY, '2026-10-27', '17:00', '19:00', [2], 2),
        ],
        COURTS,
      )[0],
    )
    stuck.mergeFailed = [
      { occurrence_id: stuck.mergeable[0].occurrence_id, moved: [1], error: '409 HALF MOVED', half_moved: true },
    ]
    const red = buildDuplicateEmbed([stuck]) as {
      embeds: { color: number; title: string; description: string }[]
    }
    expect(red.embeds[0].color).toBe(0xe74c3c)
    expect(red.embeds[0].description).toContain('both')
  })
})
