import { checkScopeCreep } from './mechanicalCheck.js'
import { diffAddedLines } from './git.js'

export interface FastLaneCheck {
  violated: boolean
  reason?: string
}

const TASK_ID_PATTERN = /\b\d{4}-\d{2}-\d{2}-[a-z0-9-]+\b/

export function checkFastLaneCompliance(
  repoPath: string,
  base: string,
  commitMessage: string,
  maxLines = 20
): FastLaneCheck {
  if (TASK_ID_PATTERN.test(commitMessage)) {
    return { violated: false }
  }

  const scope = checkScopeCreep(repoPath, base, [])
  if (scope.newFiles.length > 0) {
    return { violated: true, reason: 'adds a new file without a task-id in the commit message' }
  }
  if (scope.newFunctionOrBranch) {
    return { violated: true, reason: 'adds a new function/branch without a task-id in the commit message' }
  }

  const addedLines = diffAddedLines(repoPath, base).length
  if (addedLines > maxLines) {
    return {
      violated: true,
      reason: `adds ${addedLines} lines (over the ${maxLines}-line fast-lane threshold) without a task-id in the commit message`,
    }
  }

  return { violated: false }
}
