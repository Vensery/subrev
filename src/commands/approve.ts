import { readTaskFile, writeTaskFile, readTaskMeta, writeTaskMeta } from '../taskStore.js'
import { normalizePlanAcceptance } from '../acceptance.js'

export interface ApproveResult {
  warnings: string[]
}

/**
 * Approval is where acceptance criteria get their stable AC-n IDs (see acceptance.ts). A plan
 * without an acceptance section is still approved, with a warning, so older plans keep working;
 * a section that is present but malformed (empty, duplicate IDs) blocks approval, because every
 * later step that cites an AC id would be pointing at an ambiguous target.
 */
export function approveTask(repoPath: string, taskId: string, editedPlan?: string): ApproveResult {
  const meta = readTaskMeta(repoPath, taskId)
  const planContent = editedPlan ?? readTaskFile(repoPath, taskId, 'plan.md')
  if (!planContent) throw new Error(`plan.md not found for task ${taskId}`)

  const normalized = normalizePlanAcceptance(planContent)
  if (normalized.parse.found && normalized.parse.errors.length > 0) {
    throw new Error(`Cannot approve ${taskId}: ${normalized.parse.errors.join('; ')}`)
  }
  const warnings = [...(normalized.parse.found ? [] : normalized.parse.errors), ...normalized.parse.warnings]

  meta.planVersion += 1
  const versioned = `<!-- plan-version: ${meta.planVersion} -->\n\n${normalized.plan}`
  writeTaskFile(repoPath, taskId, 'plan-approved.md', versioned)
  meta.status = 'plan-approved'
  writeTaskMeta(repoPath, meta)
  return { warnings }
}
