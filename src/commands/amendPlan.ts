import { readTaskMeta, writeTaskMeta, writeTaskFile, readTaskFile } from '../taskStore.js'
import { diffCriteria, normalizePlanAcceptance, parseAcceptanceCriteria } from '../acceptance.js'

export interface AmendResult {
  warnings: string[]
}

export function amendPlan(repoPath: string, taskId: string, revisedPlanApproved: string): AmendResult {
  const meta = readTaskMeta(repoPath, taskId)
  if (meta.status !== 'escalated-plan-deviation') {
    throw new Error(`Task ${taskId} is not awaiting a plan amendment (status: ${meta.status}).`)
  }
  const normalized = normalizePlanAcceptance(revisedPlanApproved)
  if (normalized.parse.found && normalized.parse.errors.length > 0) {
    throw new Error(`Cannot amend ${taskId}: ${normalized.parse.errors.join('; ')}`)
  }
  const warnings = [...normalized.parse.warnings]
  const previous = parseAcceptanceCriteria(readTaskFile(repoPath, taskId, 'plan-approved.md') ?? '')
  if (previous.found && normalized.parse.found) {
    const delta = diffCriteria(previous.criteria, normalized.parse.criteria)
    if (delta.removed.length) warnings.push(`amendment removes acceptance criteria ${delta.removed.join(', ')}`)
    if (delta.reworded.length) warnings.push(`amendment rewords acceptance criteria ${delta.reworded.join(', ')}; earlier reviews cite the old wording`)
  }

  meta.planVersion += 1
  writeTaskFile(repoPath, taskId, 'plan-approved.md', `<!-- plan-version: ${meta.planVersion} -->\n\n${normalized.plan}`)
  meta.status = 'in-progress'
  writeTaskMeta(repoPath, meta)
  // round is intentionally left unchanged: amend-plan is not an escape hatch from the round cap
  return { warnings }
}
