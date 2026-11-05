import { describe, it, expect } from 'vitest'
import { compareAgents, hierarchicalBootstrap, protocolVerdict, renderComparison, wilcoxonSignedRank } from '../../src/eval/compare.js'
import type { TrialResult } from '../../src/eval/types.js'

function trial(agent: string, taskId: string, n: number, passed: boolean, costUsd?: number, firstAttempt = passed): TrialResult {
  return {
    schemaVersion: 1, runId: 'r', startedAt: '2026-01-01T00:00:00.000Z', taskId, agent, trial: n,
    outcome: passed ? 'pass' : 'fail', passed, attemptsUsed: 1, attemptsToPass: passed ? 1 : null, totalMs: 1000,
    usage: costUsd === undefined ? null : { costUsd }, tamperedPaths: [],
    attempts: [{ attempt: 1, agentMs: 1, gateMs: 1, gatePassed: firstAttempt, gateOutputTail: '' }],
  }
}

describe('wilcoxonSignedRank', () => {
  it('matches the exact tail for all-positive differences', () => {
    // n = 5, all positive: P(W+ = 15) = 1/32, two-sided 2/32.
    expect(wilcoxonSignedRank([0.1, 0.2, 0.3, 0.4, 0.5]).pValue).toBeCloseTo(2 / 32, 10)
  })
  it('drops zeros, handles ties, and returns null with no signal', () => {
    expect(wilcoxonSignedRank([0, 0]).pValue).toBeNull()
    const r = wilcoxonSignedRank([0.5, 0.5, -0.5, 0])
    expect(r.n).toBe(3)
    expect(r.wPlus).toBe(4) // ranks 2, 2, 2
    expect(r.pValue).toBeCloseTo(1, 10)
  })
})

describe('hierarchicalBootstrap', () => {
  it('is reproducible for a fixed seed and brackets the observed difference', () => {
    const data = [
      { a: [false, false, true], b: [true, true, true] },
      { a: [true, false, false], b: [true, true, false] },
      { a: [false, false, false], b: [true, false, true] },
    ]
    const ci = hierarchicalBootstrap(data, 2000, 7)
    expect(hierarchicalBootstrap(data, 2000, 7)).toEqual(ci)
    expect(ci[0]).toBeLessThan(0.44)
    expect(ci[1]).toBeGreaterThan(0.44)
  })
  it('collapses to a point when every task is deterministic', () => {
    expect(hierarchicalBootstrap([{ a: [true, true], b: [true, true] }], 500, 1)).toEqual([0, 0])
  })
})

describe('compareAgents', () => {
  const results: TrialResult[] = []
  for (let t = 0; t < 12; t++) {
    for (let n = 1; n <= 3; n++) {
      results.push(trial('base', `t${t}`, n, n === 1 && t % 2 === 0, 0.01))
      results.push(trial('pipe', `t${t}`, n, t !== 11, 0.03, n !== 3))
    }
  }
  results.push(trial('base', 'only-base', 1, true, 0.01))

  it('pairs by task, excludes unpaired tasks, and reports first-attempt and final pass separately', () => {
    const c = compareAgents(results, 'base', 'pipe', { iterations: 2000 })
    expect(c.tasks).toHaveLength(12)
    expect(c.missingTasks).toEqual(['only-base'])
    expect(c.baseline.macroPass).toBeCloseTo(6 / 36, 10)
    expect(c.treatment.macroPass).toBeCloseTo(11 / 12, 10)
    expect(c.treatment.macroFirstAttempt).toBeCloseTo((11 * 2 + 2) / 36, 10)
    expect(c.wins).toBe(11)
    expect(c.losses).toBe(0)
    expect(c.ties).toBe(1)
  })

  it('compares against a cost-matched baseline (pass@k at k = cost ratio)', () => {
    const c = compareAgents(results, 'base', 'pipe', { iterations: 2000 })
    expect(c.costMatched!.k).toBe(3) // floor(0.03 / 0.01), within the 3 baseline trials per task
    expect(c.costMatched!.ratio).toBeCloseTo(3, 6)
    const verdict = protocolVerdict(c)
    expect(verdict.met).toBe(true)
    expect(renderComparison(c)).toContain('**MET**')
  })

  it('refuses to declare an improvement with too few tasks or unknown cost', () => {
    const few = results.filter((r) => ['t0', 't2', 't4'].includes(r.taskId)).map((r) => ({ ...r, usage: null }))
    const verdict = protocolVerdict(compareAgents(few, 'base', 'pipe', { iterations: 500 }))
    expect(verdict.met).toBe(false)
    expect(verdict.reasons.join(' ')).toMatch(/only 3 paired tasks/)
    expect(verdict.reasons.join(' ')).toMatch(/cost unknown/)
  })

  it('rejects unknown agents', () => {
    expect(() => compareAgents(results, 'base', 'nope')).toThrow(/no trials for agent "nope"/)
  })
})
