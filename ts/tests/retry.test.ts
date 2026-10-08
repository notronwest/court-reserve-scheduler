import { describe, it, expect } from 'vitest'
import { withRetry } from '../src/retry'

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    let slept = 0
    const r = await withRetry(async () => 42, { delaysMs: [10, 10], sleep: async (ms) => { slept += ms } })
    expect(r).toBe(42)
    expect(slept).toBe(0)
  })

  it('retries through the configured delays and logs each failure', async () => {
    let calls = 0
    const slept: number[] = []
    const log: string[] = []
    const r = await withRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('Timeout 30000ms exceeded')
        return 'ok'
      },
      { delaysMs: [20, 60], sleep: async (ms) => { slept.push(ms) }, log: (m) => log.push(m), label: 'fetch' },
    )
    expect(r).toBe('ok')
    expect(calls).toBe(3)
    expect(slept).toEqual([20, 60])
    expect(log).toHaveLength(2)
    expect(log[0]).toContain('attempt 1/3')
  })

  it('gives up with the last error after delaysMs.length + 1 attempts', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new Error(`boom ${calls}`)
        },
        { delaysMs: [0, 0], sleep: async () => {} },
      ),
    ).rejects.toThrow('boom 3')
    expect(calls).toBe(3)
  })
})
