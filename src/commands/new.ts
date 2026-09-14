import { loadProjectsConfig, resolveRepoFromCwd } from '../config.js'
import { generateTaskId, scaffoldTask, listTasks, type TaskMeta } from '../taskStore.js'
import { assertNoRetrospectiveDebt } from '../gate.js'
import { currentBranch } from '../git.js'

export interface NewTaskOptions {
  cwd: string
  description: string
  now?: Date
  configPath?: string
}

export function newTask(options: NewTaskOptions): TaskMeta {
  const config = loadProjectsConfig(options.configPath)
  const resolved = resolveRepoFromCwd(options.cwd, config)
  if (!resolved) {
    throw new Error(`No project registered for ${options.cwd} in ~/.subrev/projects.json`)
  }
  assertNoRetrospectiveDebt(listTasks(resolved.repoPath))

  const now = options.now ?? new Date()
  const taskId = generateTaskId(options.description, now)
  const meta: TaskMeta = {
    taskId,
    project: resolved.project,
    repoKey: resolved.repoKey,
    branch: `task/${taskId}`,
    status: 'planning',
    round: 0,
    planVersion: 0,
    retrospectivePending: false,
    createdAt: now.toISOString(),
    baseBranch: currentBranch(resolved.repoPath),
    unparseableReviewCount: 0,
  }
  const brief = `# Brief\n\n${options.description}\n\n## Files\n\n- TODO\n\n## Acceptance criteria\n\n1. TODO: replace with real numbered items\n`
  scaffoldTask(resolved.repoPath, meta, brief)
  return meta
}
