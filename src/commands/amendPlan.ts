import { readTaskMeta, writeTaskMeta, writeTaskFile } from '../taskStore.js'

export function amendPlan(repoPath: string, taskId: string, revisedPlanApproved: string): void {
  const meta = readTaskMeta(repoPath, taskId)
  if (meta.status !== 'escalated-plan-deviation') {
    throw new Error(`Task ${taskId} is not awaiting a plan amendment (status: ${meta.status}).`)
  }
  meta.planVersion += 1
  writeTaskFile(repoPath, taskId, 'plan-approved.md', `<!-- plan-version: ${meta.planVersion} -->\n\n${revisedPlanApproved}`)
  meta.status = 'in-progress'
  writeTaskMeta(repoPath, meta)
  // round is intentionally left unchanged: amend-plan is not an escape hatch from the round cap
}
