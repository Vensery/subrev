// tools/subrev/src/orchestrator/runTask.ts
import type { AiRunner } from '../aiRunner.js'
import { readTaskMeta, writeTaskMeta, readTaskFile, writeTaskFile, taskDir, type TaskStatus } from '../taskStore.js'
import { implementAndGate } from './implementStep.js'
import { reviewStep, type ReviewOutcome } from './reviewStep.js'
import { checkScopeCreep } from '../mechanicalCheck.js'
import { extractPlanFiles } from './planFiles.js'
import { writeDiffSnapshot } from '../git.js'

export interface RunOptions {
  maxMechanicalRetries: number
  maxVerdictRetries: number
  maxReviewRounds: number
  baseBranch: string
}

export async function runTask(ai: AiRunner, repoPath: string, taskId: string, opts: RunOptions): Promise<TaskStatus> {
  const implemented = await implementAndGate(ai, repoPath, taskId, { maxMechanicalRetries: opts.maxMechanicalRetries })
  if (implemented.deviationRequested) return 'escalated-plan-deviation'

  let meta = readTaskMeta(repoPath, taskId)
  if (meta.status === 'escalated-mechanical') return meta.status

  while (meta.round < opts.maxReviewRounds) {
    meta.round += 1
    writeTaskMeta(repoPath, meta)

    const reviewFileForThisRound = meta.round === 1 ? 'review.md' : 'review-2.md'
    let review: ReviewOutcome
    try {
      review = await reviewStep(ai, repoPath, taskId, opts.baseBranch, {
        maxVerdictRetries: opts.maxVerdictRetries,
        reviewFile: reviewFileForThisRound,
      })
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

    if (review.verdict === 'PASS') {
      meta = readTaskMeta(repoPath, taskId) // pick up lastReviewedCommit written by reviewStep
      meta.status = 'awaiting-judgment'
      writeTaskMeta(repoPath, meta)
      return meta.status
    }

    meta = readTaskMeta(repoPath, taskId) // pick up lastReviewedCommit written by reviewStep
    const reviewText = readTaskFile(repoPath, taskId, reviewFileForThisRound) ?? ''

    const fixed = await implementAndGate(ai, repoPath, taskId, {
      maxMechanicalRetries: opts.maxMechanicalRetries,
      isFix: true,
      review: reviewText,
    })
    if (fixed.deviationRequested) return 'escalated-plan-deviation'

    meta = readTaskMeta(repoPath, taskId)
    if (meta.status === 'escalated-mechanical') return meta.status

    const planFiles = extractPlanFiles(readTaskFile(repoPath, taskId, 'plan-approved.md') ?? '')
    const scopeCheck = checkScopeCreep(repoPath, meta.lastReviewedCommit ?? opts.baseBranch, planFiles)
    if (!scopeCheck.triggered) {
      meta.status = 'awaiting-judgment'
      writeTaskMeta(repoPath, meta)
      return meta.status
    }
    // scope creep detected: loop continues, forcing another review under the same round budget
  }

  meta.status = 'abandoned'
  meta.retrospectivePending = true
  writeTaskMeta(repoPath, meta)
  writeTaskFile(
    repoPath,
    taskId,
    'decision-log.md',
    `# Decision Log\n\nAuto-abandoned: review-fix loop reached the ${opts.maxReviewRounds}-round cap without a PASS verdict.\n`
  )
  writeDiffSnapshot(repoPath, opts.baseBranch, taskDir(repoPath, taskId))
  return meta.status
}
