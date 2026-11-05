import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { runTask, type RunOptions } from '../../src/orchestrator/runTask.js'
import { scaffoldTask, readTaskMeta, readTaskFile, writeTaskFile, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, installControllableGate, setGate, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit, createTaskBranch } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo
afterEach(() => repo?.cleanup())

const OPTS: RunOptions = { maxMechanicalRetries: 2, maxVerdictRetries: 1, maxReviewRounds: 3, baseBranch: '', scopeCheck: 'layered' }

function seed(): { meta: TaskMeta; base: string } {
  repo = createTempGitRepo()
  installControllableGate(repo.repoPath)
  const base = currentCommit(repo.repoPath)
  const meta: TaskMeta = {
    taskId: 't1', project: 'selfmatch', repoKey: 'main', branch: 'task/t1',
    status: 'in-progress', round: 0, planVersion: 1, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z', baseBranch: base, unparseableReviewCount: 0,
  }
  scaffoldTask(repo.repoPath, meta, 'brief')
  writeTaskFile(repo.repoPath, meta.taskId, 'plan-approved.md',
    '<!-- plan-version: 1 -->\n\n## Files\n- a.ts\n\n## Acceptance criteria\n\n- AC-1: x is exported and equals 1\n- AC-2: validate() rejects empty input\n')
  createTaskBranch(repo.repoPath, meta.branch)
  return { meta, base }
}

function green(): void {
  setGate(repo.repoPath, true)
}

const implement = () => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n'); green(); commitAll(repo.repoPath, 'implement') }
const fixWithFunction = () => {
  appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export function validate(s: string) { if (!s) throw new Error("empty") }\n')
  commitAll(repo.repoPath, 'fix')
}
const layer2 = (category: string, acceptance: string[]) =>
  '```json\n' + JSON.stringify({ groups: [{
    group: 'G1', category, acceptance, hunks: ['a.ts:2'],
    counterfactual: category === 'unmapped' ? '' : 'without validate(), empty input is accepted and AC-2 is not met',
    reason: category === 'unmapped' ? 'nothing in the plan asks for this' : 'implements AC-2',
  }] }) + '\n```'

describe('runTask with layered scope check', () => {
  it('still re-reviews a non-test fix that layer 2 accepted: layer 2 cannot waive a code fix review', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, fixWithFunction)
    ai.reviewResponses.push('missing AC-2\nVERDICT: FAIL', layer2('direct', ['AC-2']), 'VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toContain('PASS')
    // the re-review sees both the layer-2 report and the fix context
    const rereview = ai.reviewCalls[2].prompt
    expect(rereview).toContain('within scope')
    expect(rereview).toContain('fix changed non-test files: a.ts')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'fix-round-1.md')).toContain('layer 2 accepted every flagged group')
  })

  it('lets a flagged fix through when layer 2 maps it to an AC, and records the scope report', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, fixWithFunction)
    ai.reviewResponses.push('missing AC-2\nVERDICT: FAIL', layer2('direct', ['AC-2']))

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base, fixReview: 'scope-only' })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toBeNull()
    const report = readTaskFile(repo.repoPath, meta.taskId, 'scope-report-round-1.md')!
    expect(report).toContain('within scope')
    // The scripts gate is always green here, so the revert experiment cannot confirm the mapping.
    expect(report).toContain('revert-green')
    expect(report).toContain('unverified')
    expect(ai.reviewCalls[1].prompt).toContain('- AC-2: validate() rejects empty input')
    expect(ai.reviewCalls[1].opts?.denyReadPaths).toEqual([path.join(repo.repoPath, '.ai')])
  })

  it('forces a second review that sees the scope report when layer 2 escalates', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, fixWithFunction)
    ai.reviewResponses.push('VERDICT: FAIL', layer2('unmapped', []), 'VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskMeta(repo.repoPath, meta.taskId).round).toBe(2)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'scope-report-round-1.md')).toContain('ESCALATE')
    expect(ai.reviewCalls[2].prompt).toContain('## Scope report (why this extra review was forced)')
    expect(ai.reviewCalls[2].prompt).toContain('nothing in the plan asks for this')
  })

  it('falls back to a forced review when layer 2 output is unusable', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, fixWithFunction)
    ai.reviewResponses.push('VERDICT: FAIL', 'not json', 'still not json', 'VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskMeta(repo.repoPath, meta.taskId).round).toBe(2)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'scope-report-round-1.md')).toContain('no usable layer-2 review')
  })
})
