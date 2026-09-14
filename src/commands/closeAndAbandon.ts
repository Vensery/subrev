import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { readTaskFile, writeTaskFile, readTaskMeta, writeTaskMeta, taskDir } from '../taskStore.js'
import { writeDiffSnapshot } from '../git.js'
import { loadProjectsConfig, resolveArchiveRepo } from '../config.js'

type TransitionOptions = { force?: boolean }

const TERMINAL_STATUSES = new Set(['closed', 'abandoned'] as const)
const CLOSE_ALLOWED_STATUSES = new Set(['awaiting-judgment'] as const)
const ABANDON_ALLOWED_STATUSES = new Set([
  'awaiting-judgment',
  'escalated-mechanical',
  'escalated-unparseable-review',
  'escalated-plan-deviation',
] as const)

function archiveTask(repoPath: string, taskId: string, project: string, configPath?: string): void {
  const config = loadProjectsConfig(configPath)
  const archiveRepoPath = resolveArchiveRepo(project, config)
  const source = taskDir(repoPath, taskId)
  const dest = path.join(archiveRepoPath, taskId)
  // `retro` re-archives a task that was already archived by close/abandon, so
  // `dest` may already exist. `cp -R` treats an existing destination
  // directory as a target to copy *into*, which would nest the folder
  // (archiveRepo/t1/t1/...) instead of replacing it. Clear it first so every
  // archive call is a clean, idempotent snapshot of the current task folder.
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  execFileSync('cp', ['-R', source, dest])
  execFileSync('git', ['add', '-A', taskId], { cwd: archiveRepoPath })
  const status = execFileSync('git', ['status', '--porcelain', '--', taskId], {
    cwd: archiveRepoPath,
    encoding: 'utf8',
  })
  if (status.trim().length === 0) {
    // Nothing changed since the last archive (e.g. re-archiving identical
    // content) — avoid a "nothing to commit" failure from `git commit`.
    return
  }
  execFileSync('git', ['commit', '-q', '-m', `archive ${taskId}`], { cwd: archiveRepoPath })
}

function mergeTaskBranch(repoPath: string, baseBranch: string, taskBranch: string): void {
  execFileSync('git', ['checkout', baseBranch], { cwd: repoPath })
  execFileSync('git', ['merge', '--no-ff', taskBranch, '-m', `merge ${taskBranch}`], { cwd: repoPath })
}

function requireBaseBranch(taskId: string, baseBranch: string | undefined): string {
  if (!baseBranch) {
    throw new Error(`Task ${taskId} is missing required meta.baseBranch; cannot continue without a recorded base branch.`)
  }
  return baseBranch
}

function taskStatusError(taskId: string, status: string, action: 'close' | 'abandon'): Error {
  return new Error(
    `Task ${taskId} is currently ${status}; cannot ${action} it from that state without --force for crash recovery.`,
  )
}

function validateTransition(
  taskId: string,
  status: string,
  allowedStatuses: ReadonlySet<string>,
  action: 'close' | 'abandon',
  force?: boolean,
): { forced: boolean } {
  if (TERMINAL_STATUSES.has(status as never)) {
    throw new Error(`Task ${taskId} is already ${status}; terminal tasks cannot be re-entered, even with --force.`)
  }
  if (allowedStatuses.has(status)) {
    return { forced: false }
  }
  if (!force) {
    throw taskStatusError(taskId, status, action)
  }
  return { forced: true }
}

function appendForcedTransitionLog(
  repoPath: string,
  taskId: string,
  currentLog: string | null,
  action: 'closed' | 'abandoned',
  sourceStatus: string,
  reason?: string,
): void {
  const existing = currentLog ?? ''
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing
  // The forced path bypasses the normal decision-log write, so the required
  // `reason` (abandon only) must be appended here or it never lands on disk —
  // and a crash-recovery abandon is exactly when "why we gave up" matters most.
  const reasonLine = reason === undefined ? '' : `Abandoned: ${reason}\n`
  const nextLine = `Forced ${action} transition from ${sourceStatus}.\n${reasonLine}`
  writeTaskFile(repoPath, taskId, 'decision-log.md', `${prefix}${nextLine}`)
}

export function closeTask(repoPath: string, taskId: string, configPath?: string, opts?: TransitionOptions): void {
  const meta = readTaskMeta(repoPath, taskId)
  const { forced } = validateTransition(taskId, meta.status, CLOSE_ALLOWED_STATUSES, 'close', opts?.force)
  const decisionLog = readTaskFile(repoPath, taskId, 'decision-log.md')
  if (forced) {
    appendForcedTransitionLog(repoPath, taskId, decisionLog, 'closed', meta.status)
  } else if (!decisionLog || decisionLog.trim().length === 0) {
    throw new Error(`decision-log.md is empty for task ${taskId}; write your final judgment before closing.`)
  }
  const baseBranch = requireBaseBranch(taskId, meta.baseBranch)
  // Snapshot the diff while still on the task branch (comparing against
  // baseBranch), BEFORE the merge switches the working tree to baseBranch.
  // Snapshotting after the merge would diff baseBranch against itself and
  // produce an empty patch.
  writeDiffSnapshot(repoPath, baseBranch, taskDir(repoPath, taskId))
  mergeTaskBranch(repoPath, baseBranch, meta.branch)
  meta.status = 'closed'
  writeTaskMeta(repoPath, meta)
  archiveTask(repoPath, taskId, meta.project, configPath)
}

export function abandonTask(repoPath: string, taskId: string, reason: string, configPath?: string, opts?: TransitionOptions): void {
  const meta = readTaskMeta(repoPath, taskId)
  const { forced } = validateTransition(taskId, meta.status, ABANDON_ALLOWED_STATUSES, 'abandon', opts?.force)
  const baseBranch = requireBaseBranch(taskId, meta.baseBranch)
  const decisionLog = readTaskFile(repoPath, taskId, 'decision-log.md')
  if (forced) {
    appendForcedTransitionLog(repoPath, taskId, decisionLog, 'abandoned', meta.status, reason)
  } else {
    const body = decisionLog && decisionLog.trim().length > 0 ? `${decisionLog.trimEnd()}\n\nAbandoned: ${reason}\n` : `# Decision Log\n\nAbandoned: ${reason}\n`
    writeTaskFile(repoPath, taskId, 'decision-log.md', body)
  }
  writeDiffSnapshot(repoPath, baseBranch, taskDir(repoPath, taskId))
  meta.status = 'abandoned'
  meta.retrospectivePending = true
  writeTaskMeta(repoPath, meta)
  archiveTask(repoPath, taskId, meta.project, configPath)
}

export function retro(repoPath: string, taskId: string, note: string, configPath?: string): void {
  const meta = readTaskMeta(repoPath, taskId)
  if (!meta.retrospectivePending) {
    throw new Error(`Task ${taskId} has no pending retrospective.`)
  }
  const existing = readTaskFile(repoPath, taskId, 'decision-log.md') ?? '# Decision Log\n'
  writeTaskFile(repoPath, taskId, 'decision-log.md', `${existing}\n## Retrospective\n\n${note}\n`)
  meta.retrospectivePending = false
  writeTaskMeta(repoPath, meta)
  archiveTask(repoPath, taskId, meta.project, configPath)
}
