import { describe, it, expect } from 'vitest'
import { passAtK, wilson, median, summarize } from '../../src/eval/stats.js'
import type { TrialResult } from '../../src/eval/types.js'

describe('passAtK', () => {
  it('equals c/n for k=1', () => expect(passAtK(10, 3, 1)).toBeCloseTo(0.3, 10))
  it('is 1 when k exceeds the number of failures', () => expect(passAtK(5, 3, 3)).toBe(1))
  it('is 0 when nothing passed', () => expect(passAtK(5, 0, 2)).toBe(0))
  it('matches the combinatorial definition', () => expect(passAtK(4, 2, 2)).toBeCloseTo(1 - 1 / 6, 10))
  it('rejects invalid inputs', () => {
    expect(() => passAtK(3, 4, 1)).toThrow(RangeError)
    expect(() => passAtK(3, 1, 4)).toThrow(RangeError)
    expect(() => passAtK(0, 0, 1)).toThrow(RangeError)
  })
})

describe('wilson', () => {
  it('is wide for zero successes in few trials', () => {
    const [lo, hi] = wilson(0, 10)
    expect(lo).toBe(0)
    expect(hi).toBeCloseTo(0.2775, 3)
  })
  it('is [0, 1] with no data', () => expect(wilson(0, 0)).toEqual([0, 1]))
  it('stays inside [0, 1]', () => {
    const [lo, hi] = wilson(10, 10)
    expect(lo).toBeGreaterThan(0.7)
    expect(hi).toBe(1)
  })
})

describe('median', () => {
  it('handles odd, even, and empty input', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

function trial(partial: Partial<TrialResult> & Pick<TrialResult, 'agent' | 'taskId' | 'trial' | 'outcome'>): TrialResult {
  const passed = partial.outcome === 'pass'
  return {
    schemaVersion: 1,
    runId: 'r',
    startedAt: '2026-01-01T00:00:00.000Z',
    passed,
    attemptsUsed: 1,
    attemptsToPass: passed ? 1 : null,
    totalMs: 1000,
    usage: null,
    tamperedPaths: [],
    attempts: [],
    ...partial,
  }
}

describe('summarize', () => {
  it('aggregates per task and per agent, and flags mixed outcomes as flaky', () => {
    const results = [
      trial({ agent: 'a', taskId: 't1', trial: 1, outcome: 'pass' }),
      trial({ agent: 'a', taskId: 't1', trial: 2, outcome: 'fail' }),
      trial({ agent: 'a', taskId: 't1', trial: 3, outcome: 'pass', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }),
      trial({ agent: 'a', taskId: 't2', trial: 1, outcome: 'tampered' }),
      trial({ agent: 'a', taskId: 't2', trial: 2, outcome: 'tampered' }),
      trial({ agent: 'a', taskId: 't2', trial: 3, outcome: 'tampered' }),
    ]
    const summary = summarize('r', results)
    const t1 = summary.tasks.find((t) => t.taskId === 't1')!
    expect(t1.passes).toBe(2)
    expect(t1.passAt1).toBeCloseTo(2 / 3, 10)
    expect(t1.flaky).toBe(true)
    expect(t1.passAtK).toEqual({ k: 3, value: 1 })
    expect(t1.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01, trialsWithUsage: 1 })
    const t2 = summary.tasks.find((t) => t.taskId === 't2')!
    expect(t2.flaky).toBe(false)
    expect(t2.outcomes.tampered).toBe(3)
    expect(summary.agents).toHaveLength(1)
    expect(summary.agents[0].macroPassAt1).toBeCloseTo((2 / 3 + 0) / 2, 10)
    expect(summary.agents[0].tampered).toBe(3)
    expect(summary.agents[0].flakyTasks).toBe(1)
  })
})
