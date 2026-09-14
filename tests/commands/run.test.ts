import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runCommand, resumeCommand } from '../../src/commands/run.js'
import { scaffoldTask, writeTaskFile, readTaskMeta, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, writeExecutableScript, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentBranch } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

function seedApproved(): TaskMeta {
  repo = createTempGitRepo()
  const meta: TaskMeta = {
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status: 'plan-approved', round: 0, planVersion: 1, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z', baseBranch: currentBranch(repo.repoPath), unparseableReviewCount: 0,
  }
  scaffoldTask(repo.repoPath, meta, 'brief')
  writeTaskFile(repo.repoPath, meta.taskId, 'plan-approved.md', '## Files\n- a.ts\n\n## Acceptance criteria\n\n1. thing\n')
  return meta
}

describe('runCommand', () => {
  it('creates the task branch, records baseBranch, and runs the loop to awaiting-judgment', async () => {
    const meta = seedApproved()
    const originalBranch = currentBranch(repo.repoPath)
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => {
      writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
      for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repo.repoPath, name, 'exit 0')
      commitAll(repo.repoPath, 'implement')
    })
    ai.reviewResponses.push('VERDICT: PASS')

    const status = await runCommand(ai, repo.repoPath, meta.taskId)
    expect(status).toBe('awaiting-judgment')
    const updated = readTaskMeta(repo.repoPath, meta.taskId)
    expect(updated.baseBranch).toBe(originalBranch)
    expect(updated.unparseableReviewCount).toBe(0)
    expect(currentBranch(repo.repoPath)).toBe('task/t1')
  })

  it('rejects starting on a dirty working tree', async () => {
    const meta = seedApproved()
    writeFileSync(path.join(repo.repoPath, 'scratch.txt'), 'uncommitted')
    await expect(runCommand(new FakeAiRunner(), repo.repoPath, meta.taskId)).rejects.toThrow(/uncommitted/)
  })

  it('rejects a task that is not in a runnable state', async () => {
    const meta = seedApproved()
    const { writeTaskMeta, readTaskMeta: read } = await import('../../src/taskStore.js')
    const m = read(repo.repoPath, meta.taskId)
    m.status = 'closed'
    writeTaskMeta(repo.repoPath, m)
    await expect(runCommand(new FakeAiRunner(), repo.repoPath, meta.taskId)).rejects.toThrow(/not in a runnable state/)
  })

  it('exposes resume as an alias of run', () => {
    expect(resumeCommand).toBe(runCommand)
  })

  it('recovers from escalated-mechanical on resume once codex implements cleanly', async () => {
    const meta = seedApproved()

    // First run: codex leaves the build red on every mechanical attempt, so the task
    // dead-ends at escalated-mechanical (default options allow 2 retries -> 3 attempts).
    const failingAi = new FakeAiRunner()
    const leaveRed = () => {
      for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repo.repoPath, name, 'exit 1')
    }
    failingAi.codexEffects.push(leaveRed, leaveRed, leaveRed)

    const firstStatus = await runCommand(failingAi, repo.repoPath, meta.taskId)
    expect(firstStatus).toBe('escalated-mechanical')
    expect(readTaskMeta(repo.repoPath, meta.taskId).status).toBe('escalated-mechanical')

    // Resuming with a codex run that succeeds this time must NOT immediately re-return
    // escalated-mechanical because of a stale status read back off disk — it must reset
    // status to in-progress and actually run the review loop again.
    const succeedingAi = new FakeAiRunner()
    succeedingAi.codexEffects.push(() => {
      for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repo.repoPath, name, 'exit 0')
      commitAll(repo.repoPath, 'fix after escalation')
    })
    succeedingAi.reviewResponses.push('VERDICT: PASS')

    const resumedStatus = await resumeCommand(succeedingAi, repo.repoPath, meta.taskId)
    expect(resumedStatus).toBe('awaiting-judgment')
    expect(readTaskMeta(repo.repoPath, meta.taskId).status).toBe('awaiting-judgment')
  })
})
