import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { recommend, toDict, type ScheduleItem } from '../src/recommender'
import type { Policy } from '../src/policy'

const FX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readJson = <T>(name: string): T => JSON.parse(readFileSync(resolve(FX, name), 'utf8')) as T

const policy = readJson<Policy>('policy.json')
const schedule = readJson<ScheduleItem[]>('schedule.json')

interface Golden {
  date: string
  schedule?: string
  recs: Record<string, unknown>[]
  stats: Record<string, unknown>
}

interface ManifestEntry {
  label: string
  date: string
  schedule?: string
  n_recs: number
}

const manifest = readJson<ManifestEntry[]>('manifest.json')

/** Compare stats: exact for non-numbers, sub-1e-5 tolerance for floats (Python
 *  round vs JS rounding can differ only in the last ULP, never in real logic). */
function expectStatsMatch(actual: Record<string, unknown>, golden: Record<string, unknown>): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort())
  for (const key of Object.keys(golden)) {
    const a = actual[key]
    const g = golden[key]
    if (typeof g === 'number' && typeof a === 'number') {
      expect(a, `stats.${key}`).toBeCloseTo(g, 5)
    } else {
      expect(a, `stats.${key}`).toEqual(g)
    }
  }
}

describe('recommender parity with Python (rule-based)', () => {
  for (const entry of manifest) {
    it(`${entry.label} (${entry.date}) matches the Python golden`, () => {
      const golden = readJson<Golden>(`golden_${entry.label}.json`)
      const items = entry.schedule === 'empty' ? [] : schedule
      // No history fixture → empty popularity, matching the golden's environment.
      const { recommendations, stats } = recommend(items, entry.date, policy, {
        popularity: new Map(),
      })

      expect(recommendations.map(toDict)).toEqual(golden.recs)
      expectStatsMatch(stats as unknown as Record<string, unknown>, golden.stats)
    })
  }
})
