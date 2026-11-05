// tools/subrev/src/orchestrator/runTask.ts
import type { AiRunner } from '../aiRunner.js'
import { readTaskMeta, writeTaskMeta, readTaskFile, writeTaskFile, taskDir, type TaskStatus } from '../taskStore.js'
import { implementAndGate } from './implementStep.js'
import { reviewStep, type ReviewOutcome, type FixReviewContext } from './reviewStep.js'
import { checkScopeCreep } from '../mechanicalCheck.js'
import { extractPlanFiles } from './planFiles.js'
import { writeDiffSnapshot } from '../git.js'
import { runLayer2, type Layer2Options } from '../scope/index.js'
import { analyzeFix, renderFixSummary } from './fixDelta.js'
import { writeJudgmentBrief } from './judgmentBrief.js'
import { checkTestIntegrity, renderTestIntegrityReport } from '../integrity/testIntegrity.js'

/** Run the test-integrity check on base...HEAD, persist the report, and return it for the reviewer when flagged. */
function testIntegrityFor(repoPath: string, taskId: string, base: string, file: string, title: string): { flagged: boolean; findings: string[]; report?: string } {
  const result = checkTestIntegrity(repoPath, base)
  if (result.files.length === 0) return { flagged: false, findings: [] }
  const report = renderTestIntegrityReport(title, result)
  writeTaskFile(repoPath, taskId, file, report)
  if (result.flagged) {
    const meta = readTaskMeta(repoPath, taskId)
    meta.testIntegrityFlags = (meta.testIntegrityFlags ?? 0) + 1
    writeTaskMeta(repoPath, meta)
  }
  return { flagged: result.flagged, findings: result.findings, report: result.flagged ? report : undefined }
}

export interface RunOptions {
  maxMechanicalRetries: number
  maxVerdictRetries: number
  maxReviewRounds: number
  baseBranch: string
  /**
   * 'layer1' (default): any layer-1 signal after a fix forces another review.
   * 'layered': a layer-1 signal runs layer 2 (revert experiment + AC mapping); only groups it
   * escalates force another review, and that review sees the scope report.
   */
  scopeCheck?: 'layer1' | 'layered'
  layer2?: Layer2Options
  /**
   * When a fix gets re-reviewed.
   * 'non-test' (default): any fix that changes a non-test file is re-reviewed, whatever the scope
   *   check says; the scope check only decides for test-only fixes.
   * 'scope-only': the previous behaviour, re-review only when the scope check fires. Kept as an
   *   eval ablation to measure what the extra review costs and catches.
   */
  fixReview?: 'non-test' | 'scope-only'
  /** Gate change the human approved on this run's command line (see commands/approveGate.ts). */
  approvedGateFingerprint?: string
}

export function reviewFileForRound(round: number): string {
  return round === 1 ? 'review.md' : `review-${round}.md`
}

function finishAwaitingJudgment(repoPath: string, taskId: string, unreviewedFixRound?: number): TaskStatus {
  const meta = readTaskMeta(repoPath, taskId)
  meta.status = 'awaiting-judgment'
  if (unreviewedFixRound !== undefined) meta.unreviewedFixRound = unreviewedFixRound
  else delete meta.unreviewedFixRound
  writeTaskMeta(repoPath, meta)
  writeJudgmentBrief(repoPath, taskId)
  return meta.status
}

export async function runTask(ai: AiRunner, repoPath: string, taskId: string, opts: RunOptions): Promise<TaskStatus> {
  const implemented = await implementAndGate(ai, repoPath, taskId, {
    maxMechanicalRetries: opts.maxMechanicalRetries,
    approvedGateFingerprint: opts.approvedGateFingerprint,
  })
  if (implemented.deviationRequested) return 'escalated-plan-deviation'
  if (implemented.gateBlocked) return 'escalated-gate-change'

  let meta = readTaskMeta(repoPath, taskId)
  if (meta.status === 'escalated-mechanical') return meta.status

  // The first review always runs; a flagged integrity report goes in front of it.
  let pendingTestIntegrity = testIntegrityFor(repoPath, taskId, opts.baseBranch, 'test-integrity-implement.md', 'implementation').report
  meta = readTaskMeta(repoPath, taskId) // testIntegrityFor may have updated meta
  let pendingScopeReport: string | undefined
  let pendingFixContext: FixReviewContext | undefined
  let lastFixForcedReview = false
  while (meta.round < opts.maxReviewRounds) {
    meta.round += 1
    writeTaskMeta(repoPath, meta)

    const reviewFileForThisRound = reviewFileForRound(meta.round)
    let review: ReviewOutcome
    try {
      review = await reviewStep(ai, repoPath, taskId, opts.baseBranch, {
        maxVerdictRetries: opts.maxVerdictRetries,
        reviewFile: reviewFileForThisRound,
        scopeReport: pendingScopeReport,
        fixContext: pendingFixContext,
        testIntegrityReport: pendingTestIntegrity,
      })
      pendingScopeReport = undefined
      pendingTestIntegrity = undefined
      pendingFixContext = undefined
      lastFixForcedReview = false
    } catch {
      // reviewStep does not catch a throwing/rejecting ai.claudeReview call (e.g. a real
      // subprocess crash after its own internal retry) — treat this exactly like the
      // unparseable-review outcome reviewStep itself produces when parsing fails after
      // retries, per Task 13's precedent of treating a failed AI subprocess call as an
      // escalation rather than letting it crash the run loop.
      meta = readTaskMeta(repoPath, taskId)
      meta.status = 'escalated-unparseable-review'
      meta.unparseableReviewCount = (meta.unparseableReviewCount ?? 0) + 1
      writeTaskMeta(repoPath, meta)
      return meta.status
    }
    if (review.escalatedUnparseable) return 'escalated-unparseable-review'

    meta = readTaskMeta(repoPath, taskId) // pick up lastReviewedCommit written by reviewStep
    meta.lastVerdict = review.verdict === 'PASS' ? 'PASS' : 'FAIL'
    writeTaskMeta(repoPath, meta)

    if (review.verdict === 'PASS') return finishAwaitingJudgment(repoPath, taskId)

    const reviewText = readTaskFile(repoPath, taskId, reviewFileForThisRound) ?? ''

    const fixed = await implementAndGate(ai, repoPath, taskId, {
      maxMechanicalRetries: opts.maxMechanicalRetries,
      isFix: true,
      review: reviewText,
      approvedGateFingerprint: opts.approvedGateFingerprint,
    })
    if (fixed.deviationRequested) return 'escalated-plan-deviation'
    if (fixed.gateBlocked) return 'escalated-gate-change'

    meta = readTaskMeta(repoPath, taskId)
    if (meta.status === 'escalated-mechanical') return meta.status

    const fixRound = meta.round
    const scopeBase = meta.lastReviewedCommit ?? opts.baseBranch
    const delta = analyzeFix(repoPath, scopeBase)
    writeTaskFile(repoPath, taskId, `fix-round-${fixRound}.patch`, delta.patch)
    meta.fixCount = (meta.fixCount ?? 0) + 1
    writeTaskMeta(repoPath, meta)

    const planApproved = readTaskFile(repoPath, taskId, 'plan-approved.md') ?? ''
    const planFiles = extractPlanFiles(planApproved)
    const scopeCheck = checkScopeCreep(repoPath, scopeBase, planFiles)

    const reasons: string[] = []
    const forcedByCode = opts.fixReview !== 'scope-only' && delta.nonTestFiles.length > 0
    if (forcedByCode) reasons.push(`fix changed non-test files: ${delta.nonTestFiles.join(', ')}`)
    // Weakened tests force a re-review even for a test-only fix, under every fixReview policy.
    const integrity = testIntegrityFor(repoPath, taskId, scopeBase, `test-integrity-round-${fixRound}.md`, `fix after round ${fixRound}`)
    const forcedByTests = integrity.flagged
    if (forcedByTests) reasons.push(...integrity.findings.map((f) => `test integrity: ${f}`))
    meta = readTaskMeta(repoPath, taskId) // testIntegrityFor may have updated meta
    if (scopeCheck.triggered) reasons.push(...scopeCheck.reasons.map((r) => `scope check: ${r}`))

    let reReview = forcedByCode || forcedByTests || scopeCheck.triggered
    if (scopeCheck.triggered && opts.scopeCheck === 'layered') {
      let escalate = true
      try {
        const layer2 = await runLayer2(ai, repoPath, scopeBase, planApproved, scopeCheck, opts.layer2)
        writeTaskFile(repoPath, taskId, `scope-report-round-${fixRound}.md`, layer2.report)
        writeTaskFile(repoPath, taskId, `scope-review-round-${fixRound}.log`, layer2.reviewerOutput)
        escalate = layer2.decision.escalate
        pendingScopeReport = layer2.report
      } catch (error) {
        // Layer 2 failing (git, gate, or reviewer crash) must not wave a flagged change through:
        // fall back to layer-1 behaviour and force the review.
        const message = error instanceof Error ? error.message : String(error)
        writeTaskFile(repoPath, taskId, `scope-report-round-${fixRound}.md`, `# Scope report\n\nLayer 2 failed; falling back to a forced review.\n\n${message}\n`)
      }
      if (!escalate) reasons.push('layer 2 accepted every flagged group')
      // Layer 2 can only waive a review the scope check asked for, never one forced by code or tests.
      reReview = forcedByCode || forcedByTests || escalate
    }
    if (!reReview && reasons.length === 0) reasons.push('fix only changed test files and the scope check did not fire')

    writeTaskFile(repoPath, taskId, `fix-round-${fixRound}.md`, renderFixSummary(fixRound, delta, { reReview, reasons }))

    if (!reReview) {
      pendingScopeReport = undefined
      return finishAwaitingJudgment(repoPath, taskId, fixRound)
    }
    pendingFixContext = { previousRound: fixRound, previousReview: reviewText, reasons, fixPatch: delta.patch }
    pendingTestIntegrity = integrity.report
    lastFixForcedReview = true
    // loop continues: the fix is re-reviewed under the same round budget
  }

  meta.status = 'abandoned'
  meta.retrospectivePending = true
  writeTaskMeta(repoPath, meta)
  const capNote = lastFixForcedReview
    ? `\nThe last fix (fix-round-${meta.round}.md) needed a re-review that the round budget no longer allowed; it was never reviewed.\n`
    : ''
  writeTaskFile(
    repoPath,
    taskId,
    'decision-log.md',
    `# Decision Log\n\nAuto-abandoned: review-fix loop reached the ${opts.maxReviewRounds}-round cap without a PASS verdict.\n${capNote}`
  )
  writeDiffSnapshot(repoPath, opts.baseBranch, taskDir(repoPath, taskId))
  return meta.status
}
