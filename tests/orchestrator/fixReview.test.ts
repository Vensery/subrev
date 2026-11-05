import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, appendFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { runTask, type RunOptions } from '../../src/orchestrator/runTask.js'
import { isTestPath } from '../../src/orchestrator/fixDelta.js'
import { scaffoldTask, readTaskMeta, readTaskFile, writeTaskFile, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, installControllableGate, setGate, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit, createTaskBranch } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'
import { FIX_REVIEW_PREFIX, stageForReviewPrompt } from '../../src/aiRunner.js'
import { buildStatusReport, formatStatusReport } from '../../src/commands/status.js'

let repo: TempRepo
afterEach(() => repo?.cleanup())

const OPTS: RunOptions = { maxMechanicalRetries: 2, maxVerdictRetries: 1, maxReviewRounds: 3, baseBranch: '' }

function seed(files = '## Files\n- a.ts\n- a.test.ts\n'): { meta: TaskMeta; base: string } {
  repo = createTempGitRepo()
  installControllableGate(repo.repoPath)
  const base = currentCommit(repo.repoPath)
  const meta: TaskMeta = {
    taskId: 't1', project: 'selfmatch', repoKey: 'main', branch: 'task/t1',
    status: 'in-progress', round: 0, planVersion: 1, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z', baseBranch: base, unparseableReviewCount: 0,
  }
  scaffoldTask(repo.repoPath, meta, 'brief')
  writeTaskFile(repo.repoPath, meta.taskId, 'plan-approved.md', `<!-- plan-version: 1 -->\n\n${files}\n## Acceptance criteria\n\n- AC-1: limit is 10\n`)
  createTaskBranch(repo.repoPath, meta.branch)
  return { meta, base }
}

const write = (file: string, text: string) => writeFileSync(path.join(repo.repoPath, file), text)
function green(): void {
  setGate(repo.repoPath, true)
}
const implement = () => {
  write('a.ts', 'export const LIMIT = 10\nexport function allowed(n: number) { return n <= LIMIT }\n')
  write('a.test.ts', "import { allowed } from './a'\n")
  green()
  commitAll(repo.repoPath, 'implement')
}
// The dangerous case: a fix inside a planned file that quietly changes a business rule,
// with no new function or branch, so the scope check alone does not fire.
const silentLogicFix = () => { write('a.ts', 'export const LIMIT = 5\nexport function allowed(n: number) { return n < LIMIT }\n'); commitAll(repo.repoPath, 'fix') }
const testOnlyFix = () => { appendFileSync(path.join(repo.repoPath, 'a.test.ts'), '// stronger assertion\n'); commitAll(repo.repoPath, 'fix') }

describe('fix re-review (default fixReview: non-test)', () => {
  it('re-reviews a fix that silently changes logic in a planned file, even though the scope check stays quiet', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, silentLogicFix)
    ai.reviewResponses.push('PREVIOUS-FINDING: off by one\nVERDICT: FAIL', 'VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })

    expect(status).toBe('awaiting-judgment')
    expect(ai.reviewCalls).toHaveLength(2)
    const prompt = ai.reviewCalls[1].prompt
    expect(prompt.startsWith(FIX_REVIEW_PREFIX)).toBe(true)
    expect(stageForReviewPrompt(prompt)).toBe('fix-review')
    expect(prompt).toContain('fix changed non-test files: a.ts')
    expect(prompt).toContain('PREVIOUS-FINDING: off by one')
    expect(prompt).toContain('+export const LIMIT = 5')
    expect(prompt).toContain('Changes beyond the review')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toContain('PASS')

    const fixSummary = readTaskFile(repo.repoPath, meta.taskId, 'fix-round-1.md')!
    expect(fixSummary).toContain('re-review forced')
    expect(fixSummary).toContain('| a.ts | code | modified |')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'fix-round-1.patch')).toContain('-export const LIMIT = 10')

    const m = readTaskMeta(repo.repoPath, meta.taskId)
    expect(m.fixCount).toBe(1)
    expect(m.lastVerdict).toBe('PASS')
    expect(m.unreviewedFixRound).toBeUndefined()

    const brief = readTaskFile(repo.repoPath, meta.taskId, 'judgment-brief.md')!
    expect(brief).toContain('Fix after round 1 changed non-test code (a.ts)')
    expect(brief).toContain('| 1 | re-review forced | review-2.md | a.ts | fix-round-1.patch |')
  })

  it('does not re-review a test-only fix, but tells the human that the last FAIL was never re-checked', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, testOnlyFix)
    ai.reviewResponses.push('weak assertion\nVERDICT: FAIL')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })

    expect(status).toBe('awaiting-judgment')
    expect(ai.reviewCalls).toHaveLength(1)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'fix-round-1.md')).toContain('not re-reviewed')
    const m = readTaskMeta(repo.repoPath, meta.taskId)
    expect(m.unreviewedFixRound).toBe(1)
    expect(m.lastVerdict).toBe('FAIL')
    const brief = readTaskFile(repo.repoPath, meta.taskId, 'judgment-brief.md')!
    expect(brief).toContain('FAILED, and the fix after it was **not re-reviewed**')
    expect(brief).toContain('— (not re-reviewed)')
    expect(formatStatusReport(buildStatusReport(repo.repoPath))).toContain('fix after FAILED round 1 not re-reviewed')
  })

  it('re-reviews an out-of-plan config change and names both reasons', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, () => { write('config.json', '{"strict": false}\n'); commitAll(repo.repoPath, 'fix') })
    ai.reviewResponses.push('VERDICT: FAIL', 'VERDICT: FAIL', 'VERDICT: PASS')
    ai.codexEffects.push(() => { write('config.json', '{"strict": true}\n'); commitAll(repo.repoPath, 'fix 2') })

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })

    expect(status).toBe('awaiting-judgment')
    const prompt = ai.reviewCalls[1].prompt
    expect(prompt).toContain('fix changed non-test files: config.json')
    expect(prompt).toContain('scope check: config.json')
    // every round keeps its own review file
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review.md')).toContain('FAIL')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2.md')).toContain('FAIL')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-3.md')).toContain('PASS')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'fix-round-2.md')).toContain('re-review forced')
    expect(readTaskMeta(repo.repoPath, meta.taskId).fixCount).toBe(2)
  })

  it('abandons, and says so, when a code fix needs a re-review the round budget no longer allows', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, silentLogicFix)
    ai.reviewResponses.push('VERDICT: FAIL')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, maxReviewRounds: 1, baseBranch: base })

    expect(status).toBe('abandoned')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'decision-log.md')).toContain('it was never reviewed')
  })

  it('scope-only keeps the previous behaviour for the eval ablation', async () => {
    const { meta, base } = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(implement, silentLogicFix)
    ai.reviewResponses.push('VERDICT: FAIL')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base, fixReview: 'scope-only' })

    expect(status).toBe('awaiting-judgment')
    expect(ai.reviewCalls).toHaveLength(1)
    expect(readTaskMeta(repo.repoPath, meta.taskId).unreviewedFixRound).toBe(1)
    // the human still gets the fix diff and the warning
    expect(readTaskFile(repo.repoPath, meta.taskId, 'judgment-brief.md')).toContain('changed non-test code (a.ts)')
  })
})

describe('isTestPath', () => {
  it('classifies common test locations as tests and everything else as code', () => {
    for (const p of ['a.test.ts', 'src/x.spec.tsx', 'pkg/__tests__/y.js', 'tools/subrev/tests/z.ts', 'test/helpers.js', 'app/test_views.py', 'svc/handler_test.go'])
      expect(isTestPath(p), p).toBe(true)
    for (const p of ['a.ts', 'config.json', 'supabase/migrations/0001.sql', 'docs/prompts/report.md', 'scripts/test.sh', 'src/contest.ts'])
      expect(isTestPath(p), p).toBe(false)
  })
})

describe('test integrity in the review loop', () => {
  const STRONG = "import { allowed } from './a'\nit('limit', () => {\n  expect(allowed(10)).toBe(true)\n  expect(allowed(11)).toBe(false)\n})\n"
  const implementWithTests = () => {
    write('a.ts', 'export const LIMIT = 10\nexport function allowed(n: number) { return n <= LIMIT }\n')
    write('a.test.ts', STRONG)
    green()
    commitAll(repo.repoPath, 'implement')
  }
  // A test-only "fix" that makes the failing case stop checking anything.
  const weakenTest = () => {
    write('a.test.ts', STRONG.replace('expect(allowed(11)).toBe(false)', 'expect(allowed(11)).toBeDefined()'))
    commitAll(repo.repoPath, 'fix')
  }

  for (const fixReview of ['non-test', 'scope-only'] as const) {
    it(`forces a re-review of a test-only fix that weakens an assertion (fixReview: ${fixReview})`, async () => {
      const { meta, base } = seed()
      const ai = new FakeAiRunner()
      ai.codexEffects.push(implementWithTests, weakenTest)
      ai.reviewResponses.push('allowed(11) should be false\nVERDICT: FAIL', 'weakened\nVERDICT: FAIL', 'VERDICT: FAIL')
      ai.codexEffects.push(() => { write('a.test.ts', STRONG + '// restored\n'); commitAll(repo.repoPath, 'fix 2') })
      ai.codexEffects.push(() => { write('a.test.ts', STRONG + '// restored again\n'); commitAll(repo.repoPath, 'fix 3') })

      await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base, fixReview })

      expect(ai.reviewCalls.length).toBeGreaterThanOrEqual(2)
      const rereview = ai.reviewCalls[1].prompt
      expect(rereview).toContain('## Test integrity report')
      expect(rereview).toContain('test integrity: a.test.ts: specific matchers 2 → 1')
      expect(readTaskFile(repo.repoPath, meta.taskId, 'test-integrity-round-1.md')).toContain('FLAGGED')
      expect(readTaskFile(repo.repoPath, meta.taskId, 'fix-round-1.md')).toContain('re-review forced')
      expect(readTaskMeta(repo.repoPath, meta.taskId).testIntegrityFlags).toBeGreaterThanOrEqual(1)
    })
  }

  it('shows the first review a flagged report when the implementation itself deletes an existing test', async () => {
    const { meta, base } = (() => {
      const s = seed()
      write('old.test.ts', "it('keeps working', () => { expect(1 + 1).toBe(2) })\n")
      commitAll(repo.repoPath, 'existing test')
      const m = readTaskMeta(repo.repoPath, s.meta.taskId)
      return { meta: m, base: currentCommit(repo.repoPath) }
    })()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => {
      write('a.ts', 'export const LIMIT = 10\n')
      rmSync(path.join(repo.repoPath, 'old.test.ts'))
      green()
      commitAll(repo.repoPath, 'implement')
    })
    ai.reviewResponses.push('VERDICT: PASS')

    const status = await runTask(ai, repo.repoPath, meta.taskId, { ...OPTS, baseBranch: base })

    expect(status).toBe('awaiting-judgment')
    expect(ai.reviewCalls[0].prompt).toContain('old.test.ts: test file deleted (had 1 case(s), 1 assertion(s))')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'judgment-brief.md')).toContain('Tests may have been weakened (test-integrity-implement.md)')
    expect(formatStatusReport(buildStatusReport(repo.repoPath))).toContain('tests possibly weakened in 1 window(s)')
  })
})
