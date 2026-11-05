// tools/subrev/tests/orchestrator/reviewStep.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { reviewStep, findUndisclosedFiles } from '../../src/orchestrator/reviewStep.js'
import { scaffoldTask, writeTaskFile, readTaskFile, readTaskMeta, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

function seedTask(repoPath: string): { meta: TaskMeta; base: string } {
  const base = currentCommit(repoPath)
  const meta: TaskMeta = {
    taskId: 't1', project: 'selfmatch', repoKey: 'main', branch: 'task/t1',
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
    expect(outcome).toEqual({ verdict: 'PASS', escalatedUnparseable: false, audit: 'missing-report' })
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
    expect(outcome).toEqual({ verdict: 'FAIL', escalatedUnparseable: false, audit: 'missing-report' })
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

describe('reviewStep — phase 1 isolation', () => {
  it('runs the independent review in a throwaway checkout where .ai/ does not exist', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'SELF-REPORT-MARKER: all items done')
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: PASS')

    await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })

    expect(ai.reviewCalls).toHaveLength(1)
    const call = ai.reviewCalls[0]
    expect(call.cwd).not.toBe(repo.repoPath)
    expect(call.aiDirVisible).toBe(false)
    expect(call.prompt).not.toContain('SELF-REPORT-MARKER')
    expect(existsSync(call.cwd)).toBe(false) // the throwaway checkout is removed afterwards
    expect(call.opts?.denyReadPaths).toEqual([path.join(repo.repoPath, '.ai')])
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo.repoPath, encoding: 'utf8' })
    expect(worktrees.trim().split('\n')).toHaveLength(1)
  })

  it('gives the reviewer the reviewed commit, including files outside the diff', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    const ai = new FakeAiRunner()
    let sawSource = false
    let sawReadme = false
    const original = ai.claudeReview.bind(ai)
    ai.claudeReview = async (prompt, cwd, opts) => {
      sawSource = existsSync(path.join(cwd, 'a.ts'))
      sawReadme = existsSync(path.join(cwd, 'README.md'))
      return original(prompt, cwd, opts)
    }
    ai.reviewResponses.push('VERDICT: PASS')
    await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(sawSource).toBe(true)
    expect(sawReadme).toBe(true)
  })

  it('fails closed, without calling the reviewer, if .ai/ is tracked and would leak into the checkout', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'leak')
    rmSync(path.join(repo.repoPath, '.gitignore'))
    execFileSync('git', ['add', '-A', '-f'], { cwd: repo.repoPath })
    execFileSync('git', ['commit', '-q', '-m', 'track .ai by mistake'], { cwd: repo.repoPath })
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: PASS')

    await expect(reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })).rejects.toThrow(/isolation broken/)
    expect(ai.reviewCalls).toHaveLength(0)
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo.repoPath, encoding: 'utf8' })
    expect(worktrees.trim().split('\n')).toHaveLength(1)
  })
})

describe('reviewStep — phase 2 report audit', () => {
  it('shows the report and the phase-1 review to the auditor, and records a contradiction without changing the verdict', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'SELF-REPORT-MARKER: used a different algorithm')
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('PHASE1-MARKER looks fine\nVERDICT: PASS')
    ai.auditResponses.push('Report discloses a substitution phase 1 missed.\nCONSISTENCY: CONTRADICTION')

    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })

    expect(outcome).toEqual({ verdict: 'PASS', escalatedUnparseable: false, audit: 'contradiction' })
    expect(ai.auditCalls).toHaveLength(1)
    expect(ai.auditCalls[0].cwd).toBe(repo.repoPath)
    expect(ai.auditCalls[0].prompt).toContain('SELF-REPORT-MARKER')
    expect(ai.auditCalls[0].prompt).toContain('PHASE1-MARKER')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-audit.md')).toContain('CONSISTENCY: CONTRADICTION')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review.md')).not.toContain('SELF-REPORT-MARKER')
    expect(readTaskMeta(repo.repoPath, meta.taskId).auditResult).toBe('contradiction')
  })

  it('includes fix-summary.md alongside diff-summary.md and names the audit file after the round', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'FIRST-REPORT')
    writeTaskFile(repo.repoPath, meta.taskId, 'fix-summary.md', 'FIX-REPORT')
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: FAIL')

    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1, reviewFile: 'review-2.md' })
    expect(outcome.audit).toBe('consistent')
    expect(ai.auditCalls[0].prompt).toContain('FIRST-REPORT')
    expect(ai.auditCalls[0].prompt).toContain('FIX-REPORT')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-2-audit.md')).toContain('CONSISTENT')
  })

  it('records missing-report without calling the auditor when the implementer wrote no report', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: PASS')
    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(outcome.audit).toBe('missing-report')
    expect(ai.auditCalls).toHaveLength(0)
    expect(readTaskMeta(repo.repoPath, meta.taskId).auditResult).toBe('missing-report')
  })

  it('records unparseable after retrying, and keeps the phase-1 verdict', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'report')
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: PASS')
    ai.auditResponses.push('no line', 'still no line')
    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(outcome).toEqual({ verdict: 'PASS', escalatedUnparseable: false, audit: 'unparseable' })
    expect(ai.auditCalls).toHaveLength(2)
  })

  it('records error when the audit call throws, and keeps the phase-1 verdict', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'report')
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: FAIL')
    ai.claudeAudit = async () => { throw new Error('boom') }
    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(outcome).toEqual({ verdict: 'FAIL', escalatedUnparseable: false, audit: 'error' })
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-audit.md')).toContain('boom')
  })

  it('does not run the audit when phase 1 escalates as unparseable', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'report')
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('nope', 'nope')
    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })
    expect(outcome).toEqual({ verdict: null, escalatedUnparseable: true, audit: null })
    expect(ai.auditCalls).toHaveLength(0)
  })
})

describe('reviewStep — undisclosed changes (auxiliary audit signal)', () => {
  it('lists changed files no report mentions, records the count, and never changes the verdict', async () => {
    repo = createTempGitRepo()
    const { meta, base } = seedTask(repo.repoPath)
    writeFileSync(path.join(repo.repoPath, 'b.ts'), 'export const LIMIT = 5\n')
    commitAll(repo.repoPath, 'quiet extra change')
    writeTaskFile(repo.repoPath, meta.taskId, 'diff-summary.md', 'Implemented a.ts as planned.')
    const ai = new FakeAiRunner()
    ai.reviewResponses.push('VERDICT: PASS')
    ai.auditResponses.push('b.ts is not disclosed\nCONSISTENCY: CONTRADICTION')

    const outcome = await reviewStep(ai, repo.repoPath, meta.taskId, base, { maxVerdictRetries: 1 })

    expect(outcome.verdict).toBe('PASS')
    expect(outcome.audit).toBe('contradiction')
    const prompt = ai.auditCalls[0].prompt
    const section = prompt.split("## Changed files no report mentions")[1].split('## Diff')[0]
    expect(section).toContain('- b.ts')
    expect(section).not.toContain('- a.ts')
    expect(prompt).toContain('never replaces the phase-1 code review')
    expect(readTaskMeta(repo.repoPath, meta.taskId).undisclosedFileCount).toBe(1)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'review-audit.md')).toContain('not mentioned in any report: b.ts')
  })
})

describe('findUndisclosedFiles', () => {
  it('matches by full path or file name', () => {
    expect(findUndisclosedFiles(['src/a.ts', 'src/b.ts', 'cfg/app.json'], 'touched src/a.ts and app.json')).toEqual(['src/b.ts'])
  })
})
