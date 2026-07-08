import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { Policy } from '../src/policy'
import { parseBookCommand, parseMoveCommand } from '../src/llm/parser'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const policy = JSON.parse(readFileSync(resolve(FX, 'policy.json'), 'utf8')) as Policy

/** Stub client returning a fixed text block (optionally fence-wrapped). */
const textStub = (text: string) => ({
  messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }) },
})

describe('parseBookCommand', () => {
  it('parses a valid JSON reply and passes validation', async () => {
    const reply = JSON.stringify({
      event_id: 1931656,
      event_name: 'Co-ed Intermediate Open Play',
      level: 'Intermediate',
      date: '7/13/2026',
      start_time: '2:00 PM',
      end_time: '4:00 PM',
      court_num: 3,
      court_id: 52351,
      extra_court_nums: [],
      extra_court_ids: [],
      max_participants: 0,
      error: null,
    })
    const params = await parseBookCommand('intermediate 7/13 at 2pm court 3', policy, {
      client: textStub(reply) as never,
    })
    expect(params.event_id).toBe(1931656)
    expect(params.court_num).toBe(3)
    expect(params.error).toBeNull()
  })

  it('strips ```json fences before parsing', async () => {
    const reply = '```json\n' + JSON.stringify({ event_id: 1717147, court_id: 52349, error: null }) + '\n```'
    const params = await parseBookCommand('beginner tomorrow', policy, { client: textStub(reply) as never })
    expect(params.event_id).toBe(1717147)
  })

  it('flags an event_id not in the approved list', async () => {
    const reply = JSON.stringify({ event_id: 12345, court_id: 52349, error: null })
    const params = await parseBookCommand('mystery event', policy, { client: textStub(reply) as never })
    expect(params.error).toMatch(/12345 is not in the approved events list/)
  })

  it('flags an unrecognised court_id', async () => {
    const reply = JSON.stringify({ event_id: 1717147, court_id: 99999, error: null })
    const params = await parseBookCommand('beginner court 9', policy, { client: textStub(reply) as never })
    expect(params.error).toMatch(/99999 is not recognised/)
  })
})

describe('parseMoveCommand', () => {
  it('parses a valid move reply', async () => {
    const reply = JSON.stringify({
      event_id: 1931656,
      event_name: 'Co-ed Intermediate Open Play',
      date: '7/13/2026',
      current_start_time: '9:00 AM',
      new_start_time: '11:00 AM',
      new_end_time: '1:00 PM',
      new_court_id: null,
      new_court_num: null,
      error: null,
    })
    const params = await parseMoveCommand('intermediate 7/13 from 9am to 11am', policy, {
      client: textStub(reply) as never,
    })
    expect(params.event_id).toBe(1931656)
    expect(params.new_start_time).toBe('11:00 AM')
    expect(params.error).toBeNull()
  })

  it('flags an unrecognised new_court_id', async () => {
    const reply = JSON.stringify({ event_id: 1931656, new_court_id: 88888, error: null })
    const params = await parseMoveCommand('intermediate to court 8', policy, { client: textStub(reply) as never })
    expect(params.error).toMatch(/88888 is not recognised/)
  })
})
