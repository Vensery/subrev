import { readTaskFile, writeTaskFile, readTaskMeta, writeTaskMeta } from '../taskStore.js'

export function approveTask(repoPath: string, taskId: string, editedPlan?: string): void {
  const meta = readTaskMeta(repoPath, taskId)
  const planContent = editedPlan ?? readTaskFile(repoPath, taskId, 'plan.md')
  if (!planContent) throw new Error(`plan.md not found for task ${taskId}`)

  meta.planVersion += 1
  const versioned = `<!-- plan-version: ${meta.planVersion} -->\n\n${planContent}`
  writeTaskFile(repoPath, taskId, 'plan-approved.md', versioned)
  meta.status = 'plan-approved'
  writeTaskMeta(repoPath, meta)
}
