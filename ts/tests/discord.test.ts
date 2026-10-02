import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  parseBookingReply,
  parseRetryReply,
  progressBar,
  packLinesIntoFields,
  buildRecommendationsEmbed,
  buildBookingResultsEmbed,
  buildAutoBookSummaryEmbed,
  type BookingResult,
} from '../src/discord/notify'
import {
  parseDate,
  parseApproval,
  processMessage,
  resolveCourt,
  bookWindow,
  type ListenerCtx,
} from '../src/discord/listener'
import { normalizeCrResult, executeBookings, executeMove } from '../src/discord/execute'
import { createState } from '../src/discord/state'
import type { Stats, Recommendation, RecommendationDict } from '../src/recommender'
import { NaiveDateTime } from '../src/datetime'

// ── Fakes ──────────────────────────────────────────────────────────────────────

interface Posted {
  embeds: unknown[]
  messages: string[]
}

function makeRest(posted: Posted, queuedMessages: { id: string; content?: string }[][] = []) {
  return {
    posted,
    getMessages: async () => queuedMessages.shift() ?? [],
    getBotId: async () => 'bot-1',
    postEmbed: async (p: unknown) => {
      posted.embeds.push(p)
      return 'msg-1'
    },
    postMessage: async (t: string) => {
      posted.messages.push(t)
      return 'msg-1'
    },
    addReaction: async () => true,
    getReactionUsers: async () => [],
  }
}

const REC_DICT: RecommendationDict = {
  event_id: 1931656,
  event_name: 'Co-ed Intermediate Open Play',
  level: 'Intermediate',
  court_num: 3,
  court_id: 52351,
  court_label: 'Pickleball-Court #3',
  extra_court_ids: [],
  extra_court_nums: [],
  max_participants: 0,
  date: '7/22/2026',
  start_time: '2:00 PM',
  end_time: '4:00 PM',
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'crs-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function makeCtx(over: {
  rest: unknown
  cr?: unknown
  policy?: unknown
  state?: ReturnType<typeof createState>
  spawnSchedule?: (d: string) => void
  today?: () => Date
}): ListenerCtx {
  const paths = {
    state: resolve(tmp, 'listener_state.json'),
    pending: resolve(tmp, 'pending_approval.json'),
    pendingWaitlist: resolve(tmp, 'pending_waitlist.json'),
  }
  return {
    rest: over.rest as ListenerCtx['rest'],
    cr: (over.cr ?? {}) as ListenerCtx['cr'],
    policy: (over.policy ?? {}) as ListenerCtx['policy'],
    state: over.state ?? createState(),
    botId: 'bot-1',
    paths,
    log: () => {},
    spawnSchedule: over.spawnSchedule ?? (() => {}),
    today: over.today ?? (() => new Date(2026, 6, 8)), // Wed Jul 8 2026
  }
}

// ── Reply parsers ──────────────────────────────────────────────────────────────

describe('parseBookingReply', () => {
  it('maps affirmations and skips', () => {
    expect(parseBookingReply('all')).toBe('all')
    expect(parseBookingReply('book all')).toBe('all')
    expect(parseBookingReply('')).toBe('all')
    expect(parseBookingReply('none')).toBe('none')
    expect(parseBookingReply('skip everything now')).toBe('none') // skip* always none
    expect(parseBookingReply('book 1,3,5')).toEqual([0, 2, 4])
    expect(parseBookingReply('nonsense words')).toBeNull()
  })
})

describe('parseRetryReply', () => {
  it('handles retry / skip / specific', () => {
    expect(parseRetryReply('retry', 3)).toEqual([0, 1, 2])
    expect(parseRetryReply('retry all', 2)).toEqual([0, 1])
    expect(parseRetryReply('retry 1,2', 3)).toEqual([0, 1])
    expect(parseRetryReply('skip', 3)).toBe('skip')
    expect(parseRetryReply('done', 3)).toBe('skip')
    expect(parseRetryReply('what', 3)).toBeNull()
    expect(parseRetryReply('retry 9', 2)).toEqual([]) // out of range dropped
  })
})

describe('parseApproval', () => {
  it('affirmations → all indices', () => {
    expect(parseApproval('yes', 3)).toEqual([0, 1, 2])
    expect(parseApproval('approve them all', 2)).toEqual([0, 1])
    expect(parseApproval('do it', 1)).toEqual([0])
  })
  it('negatives → none', () => {
    expect(parseApproval('none', 3)).toBe('none')
    expect(parseApproval('not today', 3)).toBe('none')
  })
  it('numeric lists, comma or space', () => {
    expect(parseApproval('1,3', 5)).toEqual([0, 2])
    expect(parseApproval('book 2 4', 5)).toEqual([1, 3])
    expect(parseApproval('9', 3)).toBeNull() // all out of range → null
  })
  it('empty and gibberish → null', () => {
    expect(parseApproval('', 3)).toBeNull()
    expect(parseApproval('maybe later', 3)).toBeNull()
  })
})

// ── Date parser ────────────────────────────────────────────────────────────────

describe('parseDate', () => {
  const wed = new Date(2026, 6, 8) // Wednesday July 8 2026
  it('today / tomorrow', () => {
    expect(parseDate('today', wed)).toBe('7/8/2026')
    expect(parseDate('tomorrow', wed)).toBe('7/9/2026')
  })
  it('day names → next occurrence (never today)', () => {
    expect(parseDate('wednesday', wed)).toBe('7/15/2026') // next Wed, not today
    expect(parseDate('fri', wed)).toBe('7/10/2026')
  })
  it('M/D rolls to next year if already past', () => {
    expect(parseDate('7/9', wed)).toBe('7/9/2026')
    expect(parseDate('1/5', wed)).toBe('1/5/2027') // Jan already passed
  })
  it('M/D/YYYY and M-D-YYYY', () => {
    expect(parseDate('4/30/2026', wed)).toBe('4/30/2026')
    expect(parseDate('4-30-2026', wed)).toBe('4/30/2026')
  })
  it('rejects garbage and impossible dates', () => {
    expect(parseDate('someday', wed)).toBeNull()
    expect(parseDate('2/30/2026', wed)).toBeNull()
    expect(parseDate('13/1/2026', wed)).toBeNull()
  })
})

// ── Formatting ─────────────────────────────────────────────────────────────────

describe('progressBar', () => {
  it('renders a bar with a target marker', () => {
    const b = progressBar(50, 60)
    expect(b).toContain('50%')
    expect(b).toContain('target: 60%')
    expect(b).toContain('│')
  })
})

describe('packLinesIntoFields', () => {
  it('splits when over the limit and labels continuations', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(30)}`)
    const fields = packLinesIntoFields('Results', lines, 200)
    expect(fields.length).toBeGreaterThan(1)
    expect(fields[0].name).toBe('Results')
    expect(fields[1].name).toBe('Results (cont.)')
    for (const f of fields) expect(f.value.length).toBeLessThanOrEqual(200)
  })
})

function rec(): Recommendation {
  return {
    event_id: 1931656,
    event_name: 'Co-ed Intermediate Open Play',
    level: 'Intermediate',
    court_num: 3,
    court_id: 52351,
    court_label: 'Pickleball-Court #3',
    start: NaiveDateTime.fromYMDHM('2026-07-22', '14:00'),
    end: NaiveDateTime.fromYMDHM('2026-07-22', '16:00'),
    extra_court_ids: [],
    extra_court_nums: [],
    max_participants: 0,
  }
}

const STATS: Stats = {
  skipped_fixed_events: [],
  target_date: '7/22/2026',
  day_of_week: 'Wednesday',
  existing_court_hours: 4,
  recommended_court_hours: 2,
  achieved_court_hours: 6,
  target_court_hours: 10,
  achieved_pct: 60,
  target_pct: 60,
  gap_court_hours: 4,
  gap_pct_points: 0,
  levels_covered: ['Intermediate'],
  levels_missing: ['Advanced'],
  min_recommendations_met: true,
  n_recommendations: 1,
  popularity_used: false,
  existing_level_counts: {},
  rec_source: 'llm',
}

describe('buildRecommendationsEmbed', () => {
  it('lists recs, uses orange when a level is missing', () => {
    const payload = buildRecommendationsEmbed('7/22/2026', [rec()], STATS) as {
      embeds: { title: string; color: number; fields: { name: string; value: string }[] }[]
    }
    const embed = payload.embeds[0]
    expect(embed.title).toContain('Wednesday, July 22 2026')
    expect(embed.color).toBe(0xf39c12) // orange — a level is missing
    expect(embed.fields[0].value).toContain('2:00 PM – 4:00 PM')
    expect(embed.fields[0].value).toContain('Court #3')
    expect(embed.fields.some((f) => f.name.includes('How to approve'))).toBe(true)
  })
  it('preview mode swaps in the dry-run field', () => {
    const payload = buildRecommendationsEmbed('7/22/2026', [rec()], STATS, true) as {
      embeds: { fields: { name: string }[] }[]
    }
    expect(payload.embeds[0].fields.some((f) => f.name.includes('Preview'))).toBe(true)
  })
  it('footers the policy sha when provenance is given, no stale warning when in sync', () => {
    const payload = buildRecommendationsEmbed('7/22/2026', [rec()], STATS, false, {
      policy_sha: 'abcdef1234567',
      head_sha: 'abcdef1234567',
      behind_origin_main: 0,
    }) as { embeds: { description?: string; footer: { text: string } }[] }
    expect(payload.embeds[0].footer.text).toContain('policy @ abcdef1')
    expect(payload.embeds[0].description).toBeUndefined()
  })
  it('shows a visible STALE POLICY warning when behind_origin_main > 0', () => {
    const payload = buildRecommendationsEmbed('7/22/2026', [rec()], STATS, false, {
      policy_sha: 'abcdef1234567',
      head_sha: 'ffffff1234567',
      behind_origin_main: 2,
    }) as { embeds: { description?: string }[] }
    expect(payload.embeds[0].description).toContain('STALE POLICY')
    expect(payload.embeds[0].description).toContain('2')
  })
  it('omits the stale warning and uses no sha suffix when provenance is unavailable (null policy_sha)', () => {
    const payload = buildRecommendationsEmbed('7/22/2026', [rec()], STATS, false, {
      policy_sha: null,
      head_sha: null,
      behind_origin_main: null,
    }) as { embeds: { description?: string; footer: { text: string } }[] }
    expect(payload.embeds[0].description).toBeUndefined()
    expect(payload.embeds[0].footer.text).not.toContain('policy @')
  })
})

describe('buildAutoBookSummaryEmbed', () => {
  const items = [
    {
      event_name: 'Co-ed Intermediate Open Play',
      level: 'Intermediate',
      start_time: '2:00 PM',
      end_time: '4:00 PM',
      court_num: 3,
      success: true,
    },
  ]
  it('footers the policy sha', () => {
    const payload = buildAutoBookSummaryEmbed('7/22/2026', items, {
      policy_sha: 'abcdef1234567',
      head_sha: 'abcdef1234567',
      behind_origin_main: 0,
    }) as { embeds: { footer: { text: string }; description: string }[] }
    expect(payload.embeds[0].footer.text).toContain('policy @ abcdef1')
    expect(payload.embeds[0].description).not.toContain('STALE POLICY')
  })
  it('prefixes a STALE POLICY warning when behind origin/main', () => {
    const payload = buildAutoBookSummaryEmbed('7/22/2026', items, {
      policy_sha: 'abcdef1234567',
      head_sha: 'ffffff1234567',
      behind_origin_main: 5,
    }) as { embeds: { description: string }[] }
    expect(payload.embeds[0].description).toContain('STALE POLICY')
    expect(payload.embeds[0].description).toContain('5')
  })
})

describe('buildBookingResultsEmbed', () => {
  it('offers a retry field on failure with attempts remaining', () => {
    const results: BookingResult[] = [
      { recommendation: REC_DICT, result: { success: false, error: 'court taken' } },
    ]
    const payload = buildBookingResultsEmbed(results, '7/22/2026', 1, 3) as {
      embeds: { color: number; fields: { name: string; value: string }[] }[]
    }
    const embed = payload.embeds[0]
    expect(embed.color).toBe(0xe74c3c) // all failed → red
    expect(embed.fields.some((f) => f.name.includes('Retry'))).toBe(true)
    expect(embed.fields[0].value).toContain('court taken')
  })
  it('no retry field on the final attempt', () => {
    const results: BookingResult[] = [
      { recommendation: REC_DICT, result: { success: false, error: 'x' } },
    ]
    const payload = buildBookingResultsEmbed(results, '7/22/2026', 3, 3) as {
      embeds: { fields: { name: string }[] }[]
    }
    expect(payload.embeds[0].fields.some((f) => f.name.includes('Retry'))).toBe(false)
  })
})

// ── normalizeCrResult ──────────────────────────────────────────────────────────

describe('normalizeCrResult', () => {
  it('reads the Python {success, occurrence_id} shape', () => {
    expect(normalizeCrResult({ success: true, occurrence_id: 42 })).toEqual({
      success: true,
      occurrence_id: 42,
      error: undefined,
    })
  })
  it('accepts {ok:true} and res_id aliases', () => {
    expect(normalizeCrResult({ ok: true, res_id: '99' }).occurrence_id).toBe(99)
  })
  it('defaults a failure error message', () => {
    expect(normalizeCrResult({ success: false })).toEqual({
      success: false,
      occurrence_id: undefined,
      error: 'unknown error',
    })
  })
})

// ── processMessage routing ─────────────────────────────────────────────────────

describe('processMessage routing', () => {
  it('!help posts the commands embed', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const ctx = makeCtx({ rest: makeRest(posted) })
    await processMessage(ctx, '!help')
    expect(posted.embeds).toHaveLength(1)
  })

  it('!schedule <date> guards, announces, and spawns', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    let spawnedFor = ''
    const ctx = makeCtx({
      rest: makeRest(posted),
      spawnSchedule: (d) => {
        spawnedFor = d
      },
    })
    await processMessage(ctx, '!schedule friday')
    expect(spawnedFor).toBe('7/10/2026')
    expect(posted.messages[0]).toContain('Adding events')
  })

  it('!schedule with a bad date explains the format', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const ctx = makeCtx({ rest: makeRest(posted) })
    await processMessage(ctx, '!schedule someday')
    expect(posted.messages[0]).toContain("Couldn't parse date")
  })

  it('pending !book confirm executes and clears state', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const booked: unknown[] = []
    const cr = {
      // Empty schedule — Court #3 is free, so the confirm-time re-check passes.
      schedule: async () => [],
      book: async (r: unknown) => {
        booked.push(r)
        return { success: true, occurrence_id: 1 }
      },
      setCourts: async () => ({ success: true }),
    }
    const state = createState()
    state.pending_book_params = {
      event_id: 1931656,
      event_name: 'Co-ed Intermediate Open Play',
      level: 'Intermediate',
      date: '7/22/2026',
      start_time: '2:00 PM',
      end_time: '4:00 PM',
      court_num: 3,
      court_id: 52351,
      extra_court_ids: [],
      extra_court_nums: [],
      max_participants: 0,
      error: null,
    }
    const ctx = makeCtx({ rest: makeRest(posted), cr, state })
    await processMessage(ctx, 'confirm')
    expect(booked).toHaveLength(1)
    expect(ctx.state.pending_book_params).toBeNull()
    expect(posted.embeds.some((e) => JSON.stringify(e).includes('Booked'))).toBe(true)
  })

  it('pending !book cancel clears state without booking', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const cr = { book: async () => ({ success: true }) }
    const state = createState()
    state.pending_book_params = { event_id: 1, error: null }
    const ctx = makeCtx({ rest: makeRest(posted), cr, state })
    await processMessage(ctx, 'cancel')
    expect(ctx.state.pending_book_params).toBeNull()
    expect(posted.messages.some((m) => m.includes('cancelled'))).toBe(true)
  })

  it('daily approval "all" books every rec and clears pending', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const booked: unknown[] = []
    const cr = {
      book: async (r: unknown) => {
        booked.push(r)
        return { success: true, occurrence_id: 1 }
      },
      setCourts: async () => ({ success: true }),
    }
    const ctx = makeCtx({ rest: makeRest(posted), cr })
    writeFileSync(
      ctx.paths.pending,
      JSON.stringify({
        target_date: '7/22/2026',
        posted_at: new Date().toISOString(),
        recommendations: [REC_DICT, { ...REC_DICT, court_num: 4, court_id: 52352 }],
      }),
    )
    await processMessage(ctx, 'all')
    expect(booked).toHaveLength(2)
    expect(existsSync(ctx.paths.pending)).toBe(false) // cleared
  })

  it('daily approval "none" skips and clears pending', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const cr = { book: async () => ({ success: true }) }
    const ctx = makeCtx({ rest: makeRest(posted), cr })
    writeFileSync(
      ctx.paths.pending,
      JSON.stringify({
        target_date: '7/22/2026',
        posted_at: new Date().toISOString(),
        recommendations: [REC_DICT],
      }),
    )
    await processMessage(ctx, 'none')
    expect(existsSync(ctx.paths.pending)).toBe(false)
    expect(posted.messages.some((m) => m.includes('skipped'))).toBe(true)
  })
})

// ── executeBookings / executeMove ──────────────────────────────────────────────

describe('executeBookings', () => {
  it('multi-court booking sets extra courts via setCourts', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const setCourtsCalls: unknown[] = []
    const cr = {
      book: async () => ({ success: true, occurrence_id: 555 }),
      setCourts: async (r: unknown) => {
        setCourtsCalls.push(r)
        return { success: true }
      },
    }
    const ctx = makeCtx({ rest: makeRest(posted), cr })
    const deps = {
      rest: ctx.rest,
      cr: ctx.cr,
      state: ctx.state,
      saveState: () => {},
      clearPending: () => {},
    }
    const multi: RecommendationDict = {
      ...REC_DICT,
      extra_court_ids: [52352],
      extra_court_nums: [4],
      max_participants: 8,
    }
    await executeBookings(
      deps as never,
      { target_date: '7/22/2026', recommendations: [multi] },
      [0],
    )
    expect(setCourtsCalls).toHaveLength(1)
    expect((setCourtsCalls[0] as { court_ids: string[] }).court_ids).toEqual(['52351', '52352'])
    // event_id must be forwarded — the service needs it to open the right grid.
    expect((setCourtsCalls[0] as { event_id: string }).event_id).toBe('1931656')
  })
})

describe('executeMove', () => {
  it('finds the occurrence by event+time and calls /move', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const moves: unknown[] = []
    const cr = {
      schedule: async () => [
        { Id: 777, EventId: 1931656, StartDateTime: '2026-07-22T09:00:00' },
      ],
      move: async (r: unknown) => {
        moves.push(r)
        return { success: true }
      },
    }
    const ctx = makeCtx({ rest: makeRest(posted), cr })
    const deps = {
      rest: ctx.rest,
      cr: ctx.cr,
      state: ctx.state,
      saveState: () => {},
      clearPending: () => {},
    }
    await executeMove(deps as never, {
      event_id: 1931656,
      event_name: 'Co-ed Intermediate Open Play',
      date: '7/22/2026',
      current_start_time: '9:00 AM',
      new_start_time: '11:00 AM',
      new_end_time: '1:00 PM',
      new_court_id: null,
      new_court_num: null,
      error: null,
    })
    expect(moves).toHaveLength(1)
    const req = moves[0] as {
      event_id: string; occurrence_id: string; current_date: string
      new_date: string; new_start: string; edit_series: boolean
    }
    expect(req.occurrence_id).toBe('777')
    expect(req.event_id).toBe('1931656')
    expect(req.current_date).toBe('7/22/2026')
    expect(req.new_date).toBe('7/22/2026') // same-day retime defaults new_date to date
    expect(req.edit_series).toBe(false)
    expect(posted.embeds.some((e) => JSON.stringify(e).includes('Moved'))).toBe(true)
  })

  it('cross-day move sends the new day and labels the embed a rebook', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const moves: unknown[] = []
    const cr = {
      schedule: async () => [
        { Id: 60990845, EventId: 1717124, StartDateTime: '2026-09-30T15:00:00' },
      ],
      move: async (r: unknown) => {
        moves.push(r)
        return { success: true }
      },
    }
    const ctx = makeCtx({ rest: makeRest(posted), cr })
    const deps = {
      rest: ctx.rest,
      cr: ctx.cr,
      state: ctx.state,
      saveState: () => {},
      clearPending: () => {},
    }
    await executeMove(deps as never, {
      event_id: 1717124,
      event_name: "Women's Advanced Intermediate Open Play",
      date: '9/30/2026',
      new_date: '10/1/2026',
      current_start_time: '3:00 PM',
      new_start_time: '3:00 PM',
      new_end_time: '5:00 PM',
      new_court_id: null,
      new_court_num: null,
      edit_series: false,
      error: null,
    })
    expect(moves).toHaveLength(1)
    const req = moves[0] as { occurrence_id: string; current_date: string; new_date: string }
    expect(req.occurrence_id).toBe('60990845')
    expect(req.current_date).toBe('9/30/2026')
    expect(req.new_date).toBe('10/1/2026')
    expect(posted.embeds.some((e) => JSON.stringify(e).includes('rebook'))).toBe(true)
  })

  it('reports when no occurrence matches', async () => {
    const posted: Posted = { embeds: [], messages: [] }
    const cr = { schedule: async () => [], move: async () => ({ success: true }) }
    const ctx = makeCtx({ rest: makeRest(posted), cr })
    const deps = { rest: ctx.rest, cr: ctx.cr, state: ctx.state, saveState: () => {}, clearPending: () => {} }
    await executeMove(deps as never, {
      event_id: 1931656,
      event_name: 'Co-ed Intermediate Open Play',
      date: '7/22/2026',
      current_start_time: '9:00 AM',
      new_start_time: '11:00 AM',
      new_end_time: '1:00 PM',
      new_court_id: null,
      new_court_num: null,
      error: null,
    })
    expect(posted.messages.some((m) => m.includes("Couldn't find"))).toBe(true)
  })
})

// ── !book court guard ──────────────────────────────────────────────────────────

describe('resolveCourt', () => {
  // 9/3/2026: Court #1 taken 5–7 PM, Court #4 taken 6–8 PM. #2 and #3 are free
  // at 6 PM. This is the real schedule that produced the 2026-09-02 double-book.
  const SCHEDULE = [
    {
      EventId: 111,
      EventName: 'Mens Advanced Plus Open Play',
      StartDateTime: '2026-09-03T17:00:00',
      EndDateTime: '2026-09-03T19:00:00',
      Courts: 'Court #1',
    },
    {
      EventId: 222,
      EventName: 'Co-ed Advanced Intermediate Open Play',
      StartDateTime: '2026-09-03T18:00:00',
      EndDateTime: '2026-09-03T20:00:00',
      Courts: 'Court #4',
    },
  ]

  const POLICY = { recommendation_rules: { preferred_court_when_free: 4 } }

  const baseParams = {
    event_id: 1672774,
    event_name: 'Co-ed Advanced Intermediate Open Play',
    level: 'Advanced Intermediate',
    date: '9/3/2026',
    start_time: '6:00 PM',
    end_time: '8:00 PM',
    extra_court_ids: [],
    extra_court_nums: [],
    max_participants: 0,
    error: null,
  }

  function ctxWith(schedule: unknown[] = SCHEDULE, extra: Record<string, unknown> = {}) {
    return makeCtx({
      rest: makeRest({ embeds: [], messages: [] }),
      cr: { schedule: async () => schedule, ...extra },
      policy: POLICY,
    })
  }

  it('picks a free court when the request named none', async () => {
    const r = await resolveCourt(ctxWith(), { ...baseParams, court_num: null, court_id: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.autoPicked).toBe(true)
    // #4 is preferred but busy at 6 PM, so the next free ascending court wins.
    expect(r.params.court_num).toBe(2)
    expect(r.params.court_id).toBe(52350)
  })

  it('rejects a named court that overlaps an existing booking', async () => {
    const r = await resolveCourt(ctxWith(), { ...baseParams, court_num: 1, court_id: 52349 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('Already booked')
    expect(r.message).toContain('Mens Advanced Plus Open Play')
    // …and points at somewhere that actually works.
    expect(r.message).toContain('Court #2')
  })

  it('allows a named court that is genuinely free', async () => {
    const r = await resolveCourt(ctxWith(), { ...baseParams, court_num: 3, court_id: 52351 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.autoPicked).toBe(false)
    expect(r.params.court_num).toBe(3)
  })

  it('rejects when any court in a multi-court request is taken', async () => {
    const r = await resolveCourt(ctxWith(), {
      ...baseParams,
      court_num: 3,
      court_id: 52351,
      extra_court_nums: [4],
      extra_court_ids: [52352],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('Court #4')
  })

  it('touching times do not count as an overlap', async () => {
    // Court #1 frees up at 7 PM; a 7–9 PM booking on it is fine.
    const r = await resolveCourt(ctxWith(), {
      ...baseParams,
      start_time: '7:00 PM',
      end_time: '9:00 PM',
      court_num: 1,
      court_id: 52349,
    })
    expect(r.ok).toBe(true)
  })

  it('reports every court busy rather than picking one anyway', async () => {
    const full = [1, 2, 3, 4].map((cn) => ({
      EventId: cn,
      EventName: `Booking ${cn}`,
      StartDateTime: '2026-09-03T18:00:00',
      EndDateTime: '2026-09-03T20:00:00',
      Courts: `Court #${cn}`,
    }))
    const r = await resolveCourt(ctxWith(full), { ...baseParams, court_num: null, court_id: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('Every court is booked')
  })

  it('fails closed when the schedule cannot be fetched', async () => {
    const ctx = makeCtx({
      rest: makeRest({ embeds: [], messages: [] }),
      cr: {
        schedule: async () => {
          throw new Error('courtreserve-api down')
        },
      },
      policy: POLICY,
    })
    const r = await resolveCourt(ctx, { ...baseParams, court_num: null, court_id: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('Not booking')
  })

  it('ignores events on another date', async () => {
    const otherDay = [{ ...SCHEDULE[0], StartDateTime: '2026-09-04T17:00:00', EndDateTime: '2026-09-04T19:00:00' }]
    const r = await resolveCourt(ctxWith(otherDay), { ...baseParams, court_num: 1, court_id: 52349 })
    expect(r.ok).toBe(true)
  })
})

describe('bookWindow', () => {
  it('parses a 12-hour window into naive datetimes', () => {
    const w = bookWindow({ date: '9/3/2026', start_time: '6:00 PM', end_time: '8:00 PM' })
    expect(w).not.toBeNull()
    expect(w!.ymd).toBe('2026-09-03')
    expect(w!.start.formatTime()).toBe('6:00 PM')
    expect(w!.end.formatTime()).toBe('8:00 PM')
  })

  it('returns null on unparseable input', () => {
    expect(bookWindow({ date: 'nope', start_time: '6:00 PM', end_time: '8:00 PM' })).toBeNull()
  })
})
