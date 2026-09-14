// tools/subrev/tests/orchestrator/reviewStep.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { reviewStep } from '../../src/orchestrator/reviewStep.js'
import { scaffoldTask, writeTaskFile, readTaskFile, readTaskMeta, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

function seedTask(repoPath: string): { meta: TaskMeta; base: string } {
  const base = currentCommit(repoPath)
  const meta: TaskMeta = {
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status: 'in-progress', round: 1, planVersion: 2, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z', baseBranch: base, unparseableReviewCount: 0,
  }
  scaffoldTask(repoPath, meta, 'brief')
  writeTaskFile(repoPath, meta.taskId, 'plan-approved.md', '<!-- plan-version: 2 -->\n\n1. thing\n')
  writeFileSync(path.join(repoPath, 'a.ts'), 'export const x = 1\n')
  commitAll(repoPath, 'implement')
  return { meta, base }
}

describe('reviewStep', () => {
  it('parses PASS and stamps the plan version reviewed', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('Looks fine.\nVERDICT: PASS')

    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(outcome).toEqual({ verdict: 'PASS', escalatedUnparseable: false })
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review.md')).toContain('reviewed-plan-version: 2')
    const updated = readTaskMeta(repo.repoPath, meta.taskId)
    expect(updated.lastReviewedCommit).toBe(currentCommit(repo.repoPath))
    expect(updated.unparseableReviewCount).toBe(0)
  })

  it('retries once on an unparseable verdict, then succeeds', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('no verdict here', 'VERDICT: FAIL')

    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(outcome).toEqual({ verdict: 'FAIL', escalatedUnparseable: false })
  })

  it('escalates when the verdict is still unparseable after retrying', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('no verdict here', 'still nothing')

    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(outcome.escalatedUnparseable).toBe(true)
    const updated = readTaskMeta(repo.repoPath, meta.taskId)
    expect(updated.status).toBe('escalated-unparseable-review')
    expect(updated.unparseableReviewCount).toBe(1)
    const files = readdirSync(path.join(repo.repoPath, '.ai', 'tasks', meta.taskId))
    const unparseable = files.find((name) => name.startsWith('review-unparseable-'))
    expect(unparseable).toBeDefined()
    expect(readFileSync(path.join(repo.repoPath, '.ai', 'tasks', meta.taskId, unparseable!), 'utf8')).toContain('still nothing')
  })

  it('writes to review-2.md when reviewFile is overridden', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: PASS')

    await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1, reviewFile: 'review-2.md' })
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toContain('PASS')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review.md')).toBeNull()
  })
})
