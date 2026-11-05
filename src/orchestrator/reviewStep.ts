// tools/subrev/src/orchestrator/reviewStep.ts
//
// Review runs in two phases:
//
//   Phase 1 — independent review (the gate). The reviewer gets the approved plan
//   and the diff, and runs inside a detached worktree of HEAD so it can read the
//   rest of the codebase for context. The implementer's self-reports live under
//   the gitignored `.ai/` directory, which does not exist in that worktree, and
//   the main repo's `.ai/` is additionally denied to the reviewer. Only this
//   phase's VERDICT decides PASS/FAIL.
//
//   Phase 2 — report audit (informational). After phase 1 has committed to a
//   verdict, a second call sees the implementer's report next to the phase-1
//   review, scores it with the CLAUDE.md rubric, and checks the two for
//   contradictions. Its result is recorded on the task (meta.auditResult) for the
//   human; it never changes the verdict.
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { FIX_REVIEW_PREFIX, type AiRunner } from '../aiRunner.js'
import {
  readTaskFile,
  writeTaskFile,
  readTaskMeta,
  writeTaskMeta,
  type AuditResult,
} from '../taskStore.js'
import { diffText, diffChangedFiles, currentCommit, addDetachedWorktree, removeWorktree, pruneWorktrees } from '../git.js'
import { parseVerdict, parseConsistency, type Verdict } from '../verdict.js'

let unparseableReviewSequence = 0

/** Implementer self-reports, in the order they were written. */
const IMPLEMENTER_REPORT_FILES = ['diff-summary.md', 'fix-summary.md'] as const

export interface ReviewOutcome {
  verdict: Verdict
  escalatedUnparseable: boolean
  /** Phase-2 result; null when phase 1 escalated and the audit never ran. */
  audit: AuditResult | null
}

export interface ReviewOptions {
  maxVerdictRetries: number
  reviewFile?: string
  /** Layer-2 scope report that forced this review; shown to the phase-1 reviewer as extra evidence. */
  scopeReport?: string
  /** Set when this review re-checks a fix: why it was forced, the previous review, and the fix-only diff. */
  fixContext?: FixReviewContext
  /** Flagged test-integrity report (deleted cases, skips, weaker assertions) for the reviewed window. */
  testIntegrityReport?: string
}

export interface FixReviewContext {
  previousRound: number
  previousReview: string
  /** Deterministic reasons (from git and the scope check), never from the implementer's report. */
  reasons: string[]
  fixPatch: string
}

function buildFixSection(fix: FixReviewContext): string[] {
  return [
    '',
    `## Why this re-review was forced`,
    `Review round ${fix.previousRound} FAILED and the implementer then changed code. Every such fix is re-reviewed:`,
    ...fix.reasons.map((r) => `- ${r}`),
    '',
    'In addition to the two checks above:',
    `3. For each finding in the round-${fix.previousRound} review, check in the code (not by assumption) that it is actually fixed.`,
    '4. List every change in the fix diff that the previous review did not ask for under a heading "Changes beyond the review",',
    '   especially changed conditions, constants, thresholds or behaviour. You still do not judge whether such a',
    '   business rule is right, but an unrequested behaviour change is a reason to FAIL, and a human reads this list.',
    '',
    `## Previous review (round ${fix.previousRound})`,
    fix.previousReview,
    '',
    `## Fix diff (only what changed since round ${fix.previousRound} was reviewed)`,
    fix.fixPatch,
  ]
}

function buildTestIntegritySection(report: string): string[] {
  return [
    '',
    '## Test integrity report (deterministic; why tests need your attention)',
    'A static check found tests that may have been weakened. For each finding, decide whether the plan or the previous',
    'review justifies it. A deleted test case, a new skip/only, or a weaker or rewritten assertion that nothing justifies',
    'is a reason to FAIL: a green gate means nothing if the tests stopped checking. The check is not exhaustive, so also',
    'look for weakening it has no rule for (an assertion that compares a value with itself, logic moved out of the test).',
    '',
    report,
  ]
}

function buildReviewPrompt(
  planApproved: string,
  diff: string,
  scopeReport?: string,
  fix?: FixReviewContext,
  testIntegrity?: string
): string {
  // The scope report is built from the plan and the diff only (never the implementer's report),
  // so showing it here does not break phase-1 independence.
  const scope = scopeReport
    ? [
        '',
        '## Scope report (why this extra review was forced)',
        'An automated scope check flagged changes it could not map to an acceptance item. For each escalated group,',
        'decide whether it was asked for. Unrequested changes are a reason to FAIL.',
        '',
        scopeReport,
      ]
    : []
  return [
    // The prefix lets usage accounting attribute fix re-reviews separately (stageForReviewPrompt).
    ...(fix ? [FIX_REVIEW_PREFIX] : []),
    'This is PHASE 1 (independent review) of a two-phase review.',
    "Review the diff below against the approved plan. The implementer's self-report is deliberately withheld in this phase — do not look for it; judge the diff on its own.",
    'Your working directory is a checkout of the reviewed commit: read any other source file you need for context.',
    'Cover two things:',
    '1. Functional bugs, edge cases, hidden problems (not business-logic correctness).',
    '2. Plan coverage: go through each acceptance item in the plan (by its AC id) and mark it covered or missing.',
    'End your response with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL".',
    '',
    '## Approved plan',
    planApproved,
    '',
    '## Diff',
    diff,
    ...scope,
    ...(testIntegrity ? buildTestIntegritySection(testIntegrity) : []),
    ...(fix ? buildFixSection(fix) : []),
  ].join('\n')
}

/**
 * Changed files that no report mentions, by full path or file name. A plain text match: cheap,
 * deterministic, and only a hint for the auditor and the human — a report can mention a file and
 * still misdescribe the change, and an unmentioned file may be trivial.
 */
export function findUndisclosedFiles(changedFiles: string[], reportText: string): string[] {
  return changedFiles.filter((file) => !reportText.includes(file) && !reportText.includes(path.basename(file)))
}

function buildAuditPrompt(
  planApproved: string,
  diff: string,
  independentReview: string,
  reports: string,
  undisclosed: string[]
): string {
  return [
    'This is PHASE 2 (report audit) of a two-phase review. Phase 1 already reviewed the diff independently, without seeing the implementer\'s report, and its verdict is final — do not re-issue a VERDICT.',
    'Your job:',
    '1. Score the implementer\'s report with the "Scoring Codex\'s implementation report" rubric in CLAUDE.md (literal execution 1–3, implicit judgment Tier 1–4, split-tier rule, verification discipline). Check each claim against the diff and source files, not against the report itself.',
    '2. Compare the report with the phase-1 review. A contradiction is: the report claims something the diff does not support; or the report discloses a deviation, substitution, assumption or known limitation that the phase-1 review did not account for; or the phase-1 review found a problem the report says does not exist; or the diff contains a change the report does not disclose (most important when it changes behaviour, conditions, constants or business rules).',
    'This audit is an auxiliary signal for the human. It never replaces the phase-1 code review and never changes its verdict.',
    'End your response with exactly one line: "CONSISTENCY: CONSISTENT" or "CONSISTENCY: CONTRADICTION".',
    '',
    '## Approved plan',
    planApproved,
    '',
    '## Phase-1 independent review',
    independentReview,
    '',
    "## Implementer's report(s)",
    reports,
    '',
    '## Changed files no report mentions (deterministic text match; a starting point, not a verdict)',
    ...(undisclosed.length ? undisclosed.map((f) => `- ${f}`) : ['- (none)']),
    '',
    '## Diff',
    diff,
  ].join('\n')
}

function auditFileFor(reviewFile: string): string {
  return reviewFile.replace(/\.md$/, '') + '-audit.md'
}

/**
 * Run `fn` with a detached worktree of `commit`. Fails closed if `.ai/` turns out
 * to be visible there (i.e. it stopped being gitignored), because then the
 * phase-1 isolation guarantee would silently not hold.
 */
async function withIsolatedCheckout<T>(
  repoPath: string,
  taskId: string,
  commit: string,
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `subrev-review-${taskId.slice(0, 40)}-`))
  try {
    addDetachedWorktree(repoPath, dir, commit)
    if (existsSync(path.join(dir, '.ai'))) {
      throw new Error(
        'review isolation broken: .ai/ is tracked by git, so implementer reports would be visible to the phase-1 reviewer'
      )
    }
    return await fn(dir)
  } finally {
    try {
      removeWorktree(repoPath, dir)
    } catch {
      // worktree may not have been created; fall through to plain cleanup
    }
    rmSync(dir, { recursive: true, force: true })
    try {
      pruneWorktrees(repoPath)
    } catch {
      // best effort
    }
  }
}

async function runAudit(
  ai: AiRunner,
  repoPath: string,
  taskId: string,
  planApproved: string,
  diff: string,
  reviewText: string,
  auditFile: string,
  header: string,
  maxRetries: number,
  changedFiles: string[]
): Promise<{ result: AuditResult; undisclosed: string[] }> {
  const reports = IMPLEMENTER_REPORT_FILES.map((name) => ({ name, text: readTaskFile(repoPath, taskId, name) }))
    .filter((r): r is { name: (typeof IMPLEMENTER_REPORT_FILES)[number]; text: string } => r.text !== null)
  if (reports.length === 0) {
    writeTaskFile(
      repoPath,
      taskId,
      auditFile,
      header + 'No implementer report (diff-summary.md / fix-summary.md) was found, although the implementer was instructed to write one. Audit skipped.\n'
    )
    return { result: 'missing-report', undisclosed: changedFiles }
  }
  const reportText = reports.map((r) => `### ${r.name}\n\n${r.text}`).join('\n\n')
  const undisclosed = findUndisclosedFiles(changedFiles, reportText)
  const prompt = buildAuditPrompt(planApproved, diff, reviewText, reportText, undisclosed)
  const undisclosedNote =
    `<!-- changed files not mentioned in any report: ${undisclosed.length ? undisclosed.join(', ') : 'none'} -->\n\n`

  let auditText = ''
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Phase 2 is allowed to see everything, so it runs in the real repo.
      auditText = await ai.claudeAudit(prompt, repoPath)
      const consistency = parseConsistency(auditText)
      if (consistency) {
        writeTaskFile(repoPath, taskId, auditFile, header + undisclosedNote + auditText)
        return { result: consistency === 'CONSISTENT' ? 'consistent' : 'contradiction', undisclosed }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeTaskFile(repoPath, taskId, auditFile, header + undisclosedNote + `Audit call failed: ${message}\n`)
    return { result: 'error', undisclosed }
  }
  writeTaskFile(repoPath, taskId, auditFile, header + undisclosedNote + auditText)
  return { result: 'unparseable', undisclosed }
}

export async function reviewStep(
  ai: AiRunner,
  repoPath: string,
  taskId: string,
  baseBranch: string,
  opts: ReviewOptions
): Promise<ReviewOutcome> {
  const meta = readTaskMeta(repoPath, taskId)
  const planApproved = readTaskFile(repoPath, taskId, 'plan-approved.md') ?? ''
  const diff = diffText(repoPath, baseBranch)
  const reviewedCommit = currentCommit(repoPath)
  const prompt = buildReviewPrompt(planApproved, diff, opts.scopeReport, opts.fixContext, opts.testIntegrityReport)
  const reviewFile = opts.reviewFile ?? 'review.md'
  const header = `<!-- reviewed-plan-version: ${meta.planVersion} -->\n\n`

  // ---- Phase 1: independent review in an isolated checkout ----
  let verdict: Verdict = null
  let reviewText = ''
  await withIsolatedCheckout(repoPath, taskId, reviewedCommit, async (isolatedDir) => {
    let attempts = 0
    while (attempts <= opts.maxVerdictRetries) {
      attempts += 1
      reviewText = await ai.claudeReview(prompt, isolatedDir, {
        denyReadPaths: [path.join(repoPath, '.ai')],
      })
      verdict = parseVerdict(reviewText)
      if (verdict) break
    }
  })

  writeTaskFile(repoPath, taskId, reviewFile, header + reviewText)

  meta.lastReviewedCommit = reviewedCommit
  if (!verdict) {
    const stamp = `${Date.now()}-${++unparseableReviewSequence}-${randomBytes(8).toString('hex')}`
    writeTaskFile(repoPath, taskId, `review-unparseable-${stamp}.md`, header + reviewText)
    meta.status = 'escalated-unparseable-review'
    meta.unparseableReviewCount = (meta.unparseableReviewCount ?? 0) + 1
    writeTaskMeta(repoPath, meta)
    return { verdict: null, escalatedUnparseable: true, audit: null }
  }
  // Persist phase 1 before phase 2 runs, so the verdict is on disk regardless of
  // what the audit does.
  writeTaskMeta(repoPath, meta)

  // ---- Phase 2: report audit (informational, never changes the verdict) ----
  const { result: audit, undisclosed } = await runAudit(
    ai,
    repoPath,
    taskId,
    planApproved,
    diff,
    reviewText,
    auditFileFor(reviewFile),
    header,
    opts.maxVerdictRetries,
    diffChangedFiles(repoPath, baseBranch)
  )
  const after = readTaskMeta(repoPath, taskId)
  after.auditResult = audit
  // Only meaningful when there is a report to compare against.
  if (audit === 'missing-report') delete after.undisclosedFileCount
  else after.undisclosedFileCount = undisclosed.length
  writeTaskMeta(repoPath, after)

  return { verdict, escalatedUnparseable: false, audit }
}
