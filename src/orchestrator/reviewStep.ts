// tools/subrev/src/orchestrator/reviewStep.ts
import type { AiRunner } from '../aiRunner.js'
import { readTaskFile, writeTaskFile, readTaskMeta, writeTaskMeta } from '../taskStore.js'
import { diffText, currentCommit } from '../git.js'
import { parseVerdict, type Verdict } from '../verdict.js'
import { randomBytes } from 'node:crypto'

let unparseableReviewSequence = 0

export interface ReviewOutcome {
  verdict: Verdict
  escalatedUnparseable: boolean
}

export interface ReviewOptions {
  maxVerdictRetries: number
  reviewFile?: string
}

function buildReviewPrompt(planApproved: string, diff: string): string {
  return [
    'Review the diff below against the approved plan. No implementer self-report is provided — review the diff independently.',
    'Cover two things:',
    '1. Functional bugs, edge cases, hidden problems (not business-logic correctness).',
    '2. Plan coverage: go through each numbered acceptance item in the plan and mark it covered or missing.',
    'End your response with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL".',
    '',
    '## Approved plan',
    planApproved,
    '',
    '## Diff',
    diff,
  ].join('\n')
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
  const prompt = buildReviewPrompt(planApproved, diff)
  const reviewFile = opts.reviewFile ?? 'review.md'

  let verdict: Verdict = null
  let attempts = 0
  let reviewText = ''
  while (attempts <= opts.maxVerdictRetries) {
    attempts += 1
    reviewText = await ai.claudeReview(prompt, repoPath)
    verdict = parseVerdict(reviewText)
    if (verdict) break
  }

  const header = `<!-- reviewed-plan-version: ${meta.planVersion} -->\n\n`
  writeTaskFile(repoPath, taskId, reviewFile, header + reviewText)

  meta.lastReviewedCommit = currentCommit(repoPath)
  if (!verdict) {
    const stamp = `${Date.now()}-${++unparseableReviewSequence}-${randomBytes(8).toString('hex')}`
    writeTaskFile(repoPath, taskId, `review-unparseable-${stamp}.md`, header + reviewText)
    meta.status = 'escalated-unparseable-review'
    meta.unparseableReviewCount = (meta.unparseableReviewCount ?? 0) + 1
    writeTaskMeta(repoPath, meta)
    return { verdict: null, escalatedUnparseable: true }
  }
  writeTaskMeta(repoPath, meta)
  return { verdict, escalatedUnparseable: false }
}
