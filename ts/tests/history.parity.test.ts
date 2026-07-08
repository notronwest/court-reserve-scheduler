import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadPopularity } from '../src/history'
import { recommend, toDict, type ScheduleItem } from '../src/recommender'
import type { Policy } from '../src/policy'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(FX, name), 'utf8')) as T

const policy = readJson<Policy>('policy.json')

describe('history popularity parity with Python', () => {
  it('loadPopularity() matches the Python popularity map', () => {
    const scores = loadPopularity(resolve(FX, 'history_synth.json'))
    const asObj = Object.fromEntries([...scores.entries()].sort())
    const expected = readJson<Record<string, number>>('popularity_synth.json')
    expect(asObj).toEqual(expected)
  })

  it('recommend() with synthetic history matches the Python golden', () => {
    const golden = readJson<{ recs: Record<string, unknown>[]; stats: Record<string, unknown> }>(
      'golden_history_2026-07-13.json',
    )
    const scores = loadPopularity(resolve(FX, 'history_synth.json'))
    const { recommendations, stats } = recommend([] as ScheduleItem[], '7/13/2026', policy, {
      popularity: scores,
    })

    expect(recommendations.map(toDict)).toEqual(golden.recs)
    expect(stats.popularity_used).toBe(true)
    // Popularity pulled Intermediate to the 9 AM slot (vs midday without history).
    expect(recommendations[0].level).toBe('Intermediate')
    expect(toDict(recommendations[0]).start_time).toBe('9:00 AM')
  })
})
