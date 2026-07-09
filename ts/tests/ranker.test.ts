import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { NaiveDateTime } from '../src/datetime'
import type { Policy } from '../src/policy'
import {
  BOOK_SLOTS_TOOL,
  systemPrompt,
  userPrompt,
  parseBookings,
  callLlmRanker,
  type FreeSlot,
  type LlmRankerInput,
} from '../src/llm/ranker'
import { APPROVED_EVENTS_ORDER } from '../src/recommender'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const policy = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy

const slot = (cn: number, start: string, end: string): FreeSlot => ({
  cn,
  ss: NaiveDateTime.fromYMDHM('2026-07-13', start),
  se: NaiveDateTime.fromYMDHM('2026-07-13', end),
})

const zeroCounts = (): Map<number, number> =>
  new Map(APPROVED_EVENTS_ORDER.map((e) => [e.id, 0]))

const baseInput = (over: Partial<LlmRankerInput> = {}): LlmRankerInput => ({
  pass0Recs: [],
  freeSlots: [slot(4, '09:00', '11:00'), slot(1, '09:00', '11:00'), slot(2, '11:00', '13:00')],
  policy,
  dateStr: '2026-07-13',
  dayName: 'Monday',
  eventCounts: zeroCounts(),
  levelCounts: { Beginner: 0, 'Advanced Beginner': 0, Intermediate: 0, 'Advanced Intermediate': 0, Advanced: 0 },
  targetCourtHours: 26.4,
  existingCourtHours: 0,
  historyPath: '/nonexistent-history.json',
  ...over,
})

describe('BOOK_SLOTS_TOOL schema', () => {
  it('pins event_id and court_num enums to the approved sets', () => {
    const props = BOOK_SLOTS_TOOL.input_schema.properties.bookings.items.properties
    expect(props.event_id.enum).toEqual([1717147, 1717131, 1931656, 1672774, 1633147])
    expect(props.court_num.enum).toEqual([1, 2, 3, 4])
    expect(BOOK_SLOTS_TOOL.input_schema.properties.bookings.items.required).toEqual([
      'event_id',
      'court_num',
      'start_time',
    ])
  })
})

describe('systemPrompt', () => {
  it('states the hard rules sourced from policy', () => {
    const s = systemPrompt(policy, 'Monday')
    expect(s).toContain('at most 2x total') // max occurrences
    expect(s).toContain('event 1672774) is capped at 1x per day') // AI override
    expect(s).toContain('≥2h apart') // min gap
    expect(s).toContain('past Monday data') // day name interpolated
    expect(s).toContain('60% court utilization')
  })
})

describe('userPrompt', () => {
  it('lists free slots, level coverage, and no-history note', () => {
    const p = userPrompt(baseInput())
    expect(p).toContain('DATE: Monday, 2026-07-13')
    expect(p).toContain('FREE SLOTS')
    expect(p).toContain('09:00-11:00  [C1  C4]') // grouped + court-sorted
    expect(p).toContain('11:00-13:00  [C2]')
    expect(p).toContain('LEVEL COVERAGE (saturated at 2+):')
    expect(p).toContain('ATTENDANCE HISTORY: No data available yet')
    expect(p).toContain('Call book_slots with your selections.')
  })

  it('renders attendance history when a history file is present', () => {
    const p = userPrompt(baseInput({ historyPath: resolve(FX, 'history_synth.json') }))
    expect(p).toContain('ATTENDANCE HISTORY — Mondays')
    expect(p).toContain('Intermediate') // synthetic Monday 9am Intermediate data
  })
})

describe('parseBookings — re-validation', () => {
  it('keeps valid bookings and drops every invalid one', () => {
    const freeSlots = [
      slot(4, '09:00', '11:00'),
      slot(1, '09:00', '11:00'),
      slot(2, '11:00', '13:00'),
      slot(1, '11:00', '13:00'),
    ]
    const bookings = [
      { event_id: 1717147, court_num: 4, start_time: '09:00' }, // valid
      { event_id: 999, court_num: 1, start_time: '09:00' }, // bad event → drop
      { event_id: 1931656, court_num: 7, start_time: '09:00' }, // bad court → drop
      { event_id: 1931656, court_num: 3, start_time: '09:00' }, // slot not free → drop
      { event_id: 1717131, court_num: 4, start_time: '09:00' }, // slot already used → drop
      { event_id: 1717147, court_num: 1, start_time: '11:00' }, // same event, gap violation → drop
      { event_id: 1931656, court_num: 2, start_time: '11:00' }, // valid
    ]
    const recs = parseBookings(bookings, freeSlots, zeroCounts(), policy)
    expect(recs.map((r) => [r.event_id, r.court_num, r.start.formatHm()])).toEqual([
      [1717147, 4, '09:00'],
      [1931656, 2, '11:00'],
    ])
  })

  it('enforces the global max-occurrence cap (2), like the Python _parse_bookings', () => {
    // Faithful to Python: this stage uses the GLOBAL limit only. The per-event
    // override (AI capped at 1) is applied later, in the recommender's post-LLM
    // re-validation loop — not here.
    const freeSlots = [slot(4, '09:00', '11:00'), slot(2, '13:00', '15:00'), slot(1, '17:00', '19:00')]
    const bookings = [
      { event_id: 1717147, court_num: 4, start_time: '09:00' }, // ok (count 1)
      { event_id: 1717147, court_num: 2, start_time: '13:00' }, // ok (count 2)
      { event_id: 1717147, court_num: 1, start_time: '17:00' }, // over cap of 2 → drop
    ]
    const recs = parseBookings(bookings, freeSlots, zeroCounts(), policy)
    expect(recs).toHaveLength(2)
    expect(recs.every((r) => r.event_id === 1717147)).toBe(true)
  })
})

describe('callLlmRanker — with a stubbed client', () => {
  it('reads the book_slots tool call and returns validated recs', async () => {
    const stub = {
      messages: {
        create: async () => ({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'book_slots',
              input: {
                summary: 'cover morning + midday',
                bookings: [
                  { event_id: 1717147, court_num: 4, start_time: '09:00' },
                  { event_id: 1931656, court_num: 2, start_time: '11:00' },
                  { event_id: 42, court_num: 1, start_time: '09:00' }, // hallucination → dropped
                ],
              },
            },
          ],
        }),
      },
    }
    const recs = await callLlmRanker(baseInput({ client: stub as never }))
    expect(recs.map((r) => r.event_id)).toEqual([1717147, 1931656])
  })

  it('throws when the model returns no book_slots call', async () => {
    const stub = {
      messages: {
        create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'no' }] }),
      },
    }
    await expect(callLlmRanker(baseInput({ client: stub as never }))).rejects.toThrow(/No book_slots/)
  })
})
