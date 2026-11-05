import type { AiRunner } from '../aiRunner.js'
import { parseAcceptanceCriteria } from '../acceptance.js'
import type { ScopeCheckResult } from '../mechanicalCheck.js'
import { runRevertAblation, type AblationReport, type GateFn } from './ablation.js'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { gitDiffZeroContext, parseUnifiedDiff } from './diff.js'
import { groupHunks, type ChangeGroup } from './groups.js'
import {
  buildLayer2Prompt,
  decideScope,
  parseLayer2Response,
  renderScopeReport,
  type Layer2Response,
  type ScopeDecision,
} from './layer2.js'

export interface Layer2Options {
  /** Run the revert experiment before asking the reviewer. Default true. */
  ablation?: boolean
  gate?: GateFn
  maxRevertGroups?: number
  strictUnverified?: boolean
  /** Extra reviewer calls when the output is not parseable JSON. Default 1. */
  maxParseRetries?: number
}

export interface Layer2Result {
  groups: ChangeGroup[]
  ablation: AblationReport | null
  decision: ScopeDecision
  report: string
  reviewerOutput: string
}

/**
 * Layer 2, run on the diff window `base...HEAD` (in the orchestrator: lastReviewedCommit, so only
 * the fix that tripped layer 1 is examined).
 */
export async function runLayer2(
  ai: AiRunner,
  repoPath: string,
  base: string,
  planApproved: string,
  layer1: Pick<ScopeCheckResult, 'reasons'>,
  opts: Layer2Options = {}
): Promise<Layer2Result> {
  const criteria = parseAcceptanceCriteria(planApproved).criteria
  const groups = groupHunks(repoPath, parseUnifiedDiff(gitDiffZeroContext(repoPath, base)))
  const baseRev = execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
  const ablation =
    opts.ablation === false
      ? null
      : runRevertAblation(repoPath, groups, { gate: opts.gate, maxGroups: opts.maxRevertGroups, acceptance: criteria, baseRev })

  const prompt = buildLayer2Prompt(criteria, groups, ablation)
  let response: Layer2Response | null = null
  let reviewerOutput = ''
  const tries = 1 + (opts.maxParseRetries ?? 1)
  for (let i = 0; i < tries && response === null; i++) {
    try {
      // Like phase-1 review, the scope reviewer must not read the implementer's notes under .ai/.
      reviewerOutput = await ai.claudeReview(prompt, repoPath, { denyReadPaths: [path.join(repoPath, '.ai')] })
      response = parseLayer2Response(reviewerOutput)
    } catch (error) {
      reviewerOutput += `\n\n[subrev] ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const decision = decideScope(criteria, groups, ablation, response, { strictUnverified: opts.strictUnverified })
  return { groups, ablation, decision, report: renderScopeReport(decision, layer1.reasons, ablation), reviewerOutput }
}

export { parseLayer2Response, decideScope, buildLayer2Prompt } from './layer2.js'
