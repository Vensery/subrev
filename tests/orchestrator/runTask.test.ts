import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { runTask, type RunOptions } from '../../src/orchestrator/runTask.js'
import { scaffoldTask, readTaskMeta, readTaskFile, writeTaskFile, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, writeExecutableScript, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit, createTaskBranch } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

const OPTS: RunOptions = { maxMechanicalRetries: 2, maxVerdictRetries: 1, maxReviewRounds: 3, baseBranch: '' }

function seed(planFilesSection: string): { meta: TaskMeta; base: string } {
  repo = createTempGitRepo()
  const base = currentCommit(repo.repoPath)
  const meta: TaskMeta = {
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status: 'in-progress', round: 0, planVersion: 1, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z', baseBranch: base,
    unparseableReviewCount: 0,
  }
  scaffoldTask(repo.repoPath, meta, 'brief')
  writeTaskFile(repo.repoPath, meta.taskId, 'plan-approved.md', `<!-- plan-version: 1 -->\n\n${planFilesSection}\n\n## Acceptance criteria\n\n1. thing\n`)
  createTaskBranch(repo.repoPath, meta.branch)
  return { meta, base }
}

function green(): void {
  for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repo.repoPath, name, 'exit 0')
}

describe('runTask', () => {
  it('goes straight to awaiting-judgment when round 1 review PASSes', async () => {
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n'); green(); commitAll(repo.repoPath, 'implement') })
    ai.reviewResponses.push('VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskMeta(repo.repoPath, meta.taskId).round).toBe(1)
  })

  it('preserves lastReviewedCommit when round 1 review PASSes', async () => {
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n'); green(); commitAll(repo.repoPath, 'implement') })
    ai.reviewResponses.push('VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskMeta(repo.repoPath, meta.taskId).lastReviewedCommit).toBe(currentCommit(repo.repoPath))
  })

  it('does not force a second review when the fix stays within plan and adds no new function', async () => {
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(
      () => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n'); green(); commitAll(repo.repoPath, 'implement') },
      () => { appendFileSync(path.join(repo.repoPath, 'a.ts'), '// null check\n'); green(); commitAll(repo.repoPath, 'fix') }
    )
    ai.reviewResponses.push('VERDICT: FAIL')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskMeta(repo.repoPath, meta.taskId).round).toBe(1)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toBeNull()
  })

  it('regression: a legitimately-planned function from round 1 does not force endless second reviews', async () => {
    // round 1 implement legitimately adds a function (this is normal — most plans add functions).
    // If scope-creep were measured against the branch's original base instead of lastReviewedCommit,
    // this function would still be "new" on every subsequent diff and every fix would wrongly
    // trigger a second review forever. It must not.
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(
      () => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export function helper() { return 1 }\n'); green(); commitAll(repo.repoPath, 'implement') },
      // Comment text deliberately avoids the literal word "function" — mechanicalCheck's
      // keyword regexes are text-based, not AST-aware, so an incidental mention of that
      // word in a comment would itself count as a (heuristic, acceptable) false positive.
      () => { appendFileSync(path.join(repo.repoPath, 'a.ts'), '// trivial fix, nothing new added\n'); green(); commitAll(repo.repoPath, 'fix') }
    )
    ai.reviewResponses.push('VERDICT: FAIL')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toBeNull()
  })

  it('forces a second review (review-2.md) when the fix itself adds a new function, same round budget', async () => {
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(
      () => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n'); green(); commitAll(repo.repoPath, 'implement') },
      () => { appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export function sneaky() { if (x) { return 1 } }\n'); green(); commitAll(repo.repoPath, 'fix') }
    )
    ai.reviewResponses.push('VERDICT: FAIL', 'VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskMeta(repo.repoPath, meta.taskId).round).toBe(2)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toContain('PASS')
  })

  it('auto-abandons with retrospectivePending after exhausting the round cap', async () => {
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(
      () => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n'); green(); commitAll(repo.repoPath, 'implement') },
      () => { appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export function sneaky1() { if (x) { return 1 } }\n'); green(); commitAll(repo.repoPath, 'fix1') },
      () => { appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export function sneaky2() { if (x) { return 2 } }\n'); green(); commitAll(repo.repoPath, 'fix2') },
      () => { appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export function sneaky3() { if (x) { return 3 } }\n'); green(); commitAll(repo.repoPath, 'fix3') }
    )
    ai.reviewResponses.push('VERDICT: FAIL', 'VERDICT: FAIL', 'VERDICT: FAIL')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('abandoned')
    const updated = readTaskMeta(repo.repoPath, meta.taskId)
    expect(updated.retrospectivePending).toBe(true)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'decision-log.md')).toContain('round cap')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'final-diff.patch')).not.toBeNull()
  })

  it('regression (discriminating case): a round-1 file outside the enumerated plan list does not keep re-triggering review on later trivial fixes', async () => {
    // Unlike the brief's own "legitimately-planned function" regression test (which happens to
    // pass even against the old base-branch-based scope check, because round 1's own commit is
    // structurally excluded from the diff window once lastReviewedCommit is stamped after round
    // 1's review, regardless of which keywords mechanicalCheck's regexes match),
    // this scenario is a genuine discriminator: round 1 legitimately adds a companion file
    // (extra.ts) that was never enumerated in the plan's "## Files" list. If scope-creep were
    // measured against the branch's original base (opts.baseBranch) instead of
    // lastReviewedCommit, extra.ts would show up as an unplanned "new file" on every subsequent
    // diff forever, wrongly forcing a second review on every later trivial fix. Measuring
    // against lastReviewedCommit correctly treats extra.ts as already "known" after round 1's
    // review and lets a trivial follow-up fix go straight to awaiting-judgment.
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(
      () => {
        writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
        writeFileSync(path.join(repo.repoPath, 'extra.ts'), 'export const y = 2\n')
        green()
        commitAll(repo.repoPath, 'implement')
      },
      () => { appendFileSync(path.join(repo.repoPath, 'a.ts'), '// trivial fix\n'); green(); commitAll(repo.repoPath, 'fix') }
    )
    ai.reviewResponses.push('VERDICT: FAIL')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('awaiting-judgment')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toBeNull()
  })

  it('treats a throwing reviewStep (e.g. claudeReview crash) as an unparseable-review escalation', async () => {
    const { meta, base } = seed('## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => { writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n'); green(); commitAll(repo.repoPath, 'implement') })
    // No reviewResponses scripted: FakeAiRunner.claudeReview throws "no more scripted review responses",
    // simulating reviewStep's un-caught ai.claudeReview rejection propagating out of reviewStep.

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })
    expect(status).toBe('escalated-unparseable-review')
    const updated = readTaskMeta(repo.repoPath, meta.taskId)
    expect(updated.status).toBe('escalated-unparseable-review')
    expect(updated.unparseableReviewCount).toBe(1)
  })
})
