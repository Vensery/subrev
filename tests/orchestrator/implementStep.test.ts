// tools/subrev/tests/orchestrator/implementStep.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { implementAndGate } from '../../src/orchestrator/implementStep.js'
import { scaffoldTask, writeTaskFile, readTaskMeta, taskDir, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, writeExecutableScript, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit, isWorkingTreeDirty } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo
let repoPath: string
let seedCounter = 0

afterEach(() => repo?.cleanup())

function seedTask(): TaskMeta {
  repo = createTempGitRepo()
  repoPath = repo.repoPath
  seedCounter += 1
  const meta: TaskMeta = {
    // createdAt is varied per call so each test's initial meta.md content is a
    // distinct string. gray-matter (used by taskStore.ts) keeps a process-wide
    // parse cache keyed by exact file content, and shallow-copies cached `data`
    // objects on hit — so two tests that both write byte-identical initial
    // meta.md content and then mutate the object returned by readTaskMeta would
    // otherwise corrupt each other's cached status via that shared reference.
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status: 'in-progress', round: 0, planVersion: 1, retrospectivePending: false,
    createdAt: `2026-07-08T00:00:${String(seedCounter).padStart(2, '0')}.000Z`,
  }
  scaffoldTask(repoPath, meta, 'brief')
  writeTaskFile(repoPath, meta.taskId, 'plan-approved.md', '## Files\n- a.ts\n\n## Acceptance criteria\n\n1. thing\n')
  return meta
}

// Writes green scripts AND commits them, matching production's expectation (per
// the "codex must commit its work" guard in implementAndGate) that a successful
// all-green attempt always leaves a new commit on HEAD.
function greenScriptsCommitted(message = 'implement'): void {
  for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repoPath, name, 'exit 0')
  commitAll(repoPath, message)
}

function redScripts(): void {
  for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repoPath, name, 'exit 1')
}

describe('implementAndGate', () => {
  it('passes through when codex leaves the repo all-green on the first attempt', async () => {
    const meta = seedTask()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => greenScriptsCommitted())

    const result = await implementAndGate(ai, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    expect(result.deviationRequested).toBe(false)
    expect(result.scripts.every((s) => s.passed)).toBe(true)
    expect(readTaskMeta(repoPath, meta.taskId).status).toBe('in-progress')
  })

  it('escalates to escalated-mechanical after exhausting retries on a red build', async () => {
    const meta = seedTask()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => redScripts(), () => redScripts(), () => redScripts())

    const result = await implementAndGate(ai, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    expect(result.mechanicalAttempts).toBe(3)
    expect(readTaskMeta(repoPath, meta.taskId).status).toBe('escalated-mechanical')
  })

  it('stops and escalates to escalated-plan-deviation when codex writes deviation-request.md', async () => {
    const meta = seedTask()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => {
      writeFileSync(path.join(taskDir(repoPath, meta.taskId), 'deviation-request.md'), 'the plan references a missing API')
    })

    const result = await implementAndGate(ai, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    expect(result.deviationRequested).toBe(true)
    expect(readTaskMeta(repoPath, meta.taskId).status).toBe('escalated-plan-deviation')
  })

  it('treats a failed codexExec as a mechanical failure and recovers on retry', async () => {
    const meta = seedTask()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(
      () => { throw new Error('codex subprocess crashed') },
      () => greenScriptsCommitted()
    )

    const result = await implementAndGate(ai, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    expect(result.mechanicalAttempts).toBe(2)
    expect(result.deviationRequested).toBe(false)
    expect(result.scripts.every((s) => s.passed)).toBe(true)
    expect(readTaskMeta(repoPath, meta.taskId).status).toBe('in-progress')
  })

  it('escalates to escalated-mechanical after codexExec fails on every attempt', async () => {
    const meta = seedTask()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(
      () => { throw new Error('codex subprocess crashed (attempt 1)') },
      () => { throw new Error('codex subprocess crashed (attempt 2)') },
      () => { throw new Error('codex subprocess crashed (attempt 3)') }
    )

    const result = await implementAndGate(ai, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    expect(result.mechanicalAttempts).toBe(3)
    expect(result.deviationRequested).toBe(false)
    expect(result.scripts).toEqual([{ name: 'codex exec', passed: false, output: 'codex subprocess crashed (attempt 3)' }])
    expect(readTaskMeta(repoPath, meta.taskId).status).toBe('escalated-mechanical')
  })

  it('does not re-escalate on a stale deviation-request.md left over from a previous escalated attempt', async () => {
    const meta = seedTask()
    const deviationFile = path.join(taskDir(repoPath, meta.taskId), 'deviation-request.md')

    // First run: codex deviates and escalates, as in the test above.
    const firstAi = new FakeAiRunner()
    firstAi.codexEffects.push(() => {
      writeFileSync(deviationFile, 'the plan references a missing API')
    })
    const firstResult = await implementAndGate(firstAi, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    expect(firstResult.deviationRequested).toBe(true)
    expect(readTaskMeta(repoPath, meta.taskId).status).toBe('escalated-plan-deviation')

    // Simulates the amend-plan + resume flow: deviation-request.md is still sitting on disk
    // (nothing deletes it), but this second attempt's codex effect does NOT write it again —
    // it just implements cleanly. The stale file must not cause a spurious re-escalation.
    const secondAi = new FakeAiRunner()
    secondAi.codexEffects.push(() => greenScriptsCommitted('re-implement after amend-plan'))
    const secondResult = await implementAndGate(secondAi, repoPath, meta.taskId, { maxMechanicalRetries: 2 })

    expect(secondResult.deviationRequested).toBe(false)
    expect(secondResult.scripts.every((s) => s.passed)).toBe(true)
  })

  it('auto-commits work codex left uncommitted (codex sandbox cannot write .git)', async () => {
    const meta = seedTask()
    const before = currentCommit(repoPath)
    const ai = new FakeAiRunner()
    // Writes green scripts but does NOT commit them — matching real codex, whose
    // workspace-write sandbox mounts .git read-only.
    ai.codexEffects.push(() => {
      for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repoPath, name, 'exit 0')
    })

    const result = await implementAndGate(ai, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    expect(result.deviationRequested).toBe(false)
    expect(result.scripts.every((s) => s.passed)).toBe(true)
    expect(currentCommit(repoPath)).not.toBe(before)
    expect(isWorkingTreeDirty(repoPath)).toBe(false)
  })

  it('keeps transcript files from separate runs instead of overwriting the previous run', async () => {
    const meta = seedTask()
    const first = new FakeAiRunner()
    const second = new FakeAiRunner()
    first.codexEffects.push(() => {
      for (const name of ['check.sh', 'build.sh', 'test.sh']) writeExecutableScript(repoPath, name, 'exit 0')
      commitAll(repoPath, 'first transcript run')
    })
    second.codexEffects.push(() => {
      // Must be a REAL change: rewriting identical scripts leaves nothing staged,
      // commitAll throws, and the whole second run silently dies in the mechanical
      // retry path — which the old >=1 assertions never noticed.
      writeFileSync(path.join(repoPath, 'second-run-change.txt'), 'round two\n')
      commitAll(repoPath, 'second transcript run')
    })

    await implementAndGate(first, repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    const firstTranscriptFiles = readdirSync(path.join(repoPath, '.ai', 'tasks', meta.taskId)).filter((name) =>
      name.startsWith('codex-output-') && name.endsWith('.log')
    )
    await implementAndGate(second, repoPath, meta.taskId, { maxMechanicalRetries: 2 })

    const transcriptFiles = readdirSync(path.join(repoPath, '.ai', 'tasks', meta.taskId)).filter((name) =>
      name.startsWith('codex-output-') && name.endsWith('.log')
    )
    // The load-bearing assertions: run 2 must PRESERVE run 1's transcript file(s)
    // and add exactly one of its own. With the overwrite bug (fixed filename per
    // attempt number), run 2 would replace run 1's file and the directory would
    // still hold exactly one attempt-1 log — so `>= 1`-style assertions pass
    // against the bug and prove nothing.
    expect(firstTranscriptFiles.length).toBe(1)
    for (const name of firstTranscriptFiles) {
      expect(transcriptFiles).toContain(name)
    }
    expect(transcriptFiles.length).toBe(firstTranscriptFiles.length + 1)
    expect(transcriptFiles.every((name) => name.includes('attempt-1'))).toBe(true)
  })

  it('throws when a green attempt produced no changes and no commit at all', async () => {
    const meta = seedTask()
    // Scripts are already green and committed BEFORE the attempt, so a do-nothing
    // codex run leaves the tree clean and HEAD unmoved — the guard must reject it
    // rather than sending an empty diff to review.
    greenScriptsCommitted('pre-seeded green scripts')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => {})

    await expect(implementAndGate(ai, repoPath, meta.taskId, { maxMechanicalRetries: 2 })).rejects.toThrow(
      /produced no changes/
    )
  })
})
