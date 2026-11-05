// tools/subrev/src/commands/run.ts
import type { AiRunner } from '../aiRunner.js'
import { readTaskMeta, writeTaskMeta } from '../taskStore.js'
import { isWorkingTreeDirty, currentBranch, createTaskBranch, checkoutBranch } from '../git.js'
import { runTask, type RunOptions } from '../orchestrator/runTask.js'
import { confirmGateApproval } from './approveGate.js'

const DEFAULT_OPTIONS = {
  maxMechanicalRetries: 2,
  maxVerdictRetries: 1,
  maxReviewRounds: 3,
} satisfies Omit<RunOptions, 'baseBranch'>

function requireBaseBranch(taskId: string, baseBranch: string | undefined): string {
  if (!baseBranch) {
    throw new Error(`Task ${taskId} is missing required meta.baseBranch; cannot run without a recorded base branch.`)
  }
  return baseBranch
}

export type RunOverrides = Pick<RunOptions, 'scopeCheck' | 'layer2'> & {
  /** Fingerprint typed by the human (`--approve-gate`); verified against the disk before anything runs. */
  approveGate?: string
}

export async function runCommand(
  ai: AiRunner,
  repoPath: string,
  taskId: string,
  overrides: RunOverrides = {}
): Promise<string> {
  const meta = readTaskMeta(repoPath, taskId)

  if (meta.status === 'plan-approved') {
    if (isWorkingTreeDirty(repoPath)) {
      throw new Error(`Repo has uncommitted changes; commit or stash before "subrev run ${taskId}".`)
    }
    meta.baseBranch = currentBranch(repoPath)
    createTaskBranch(repoPath, meta.branch)
    meta.status = 'in-progress'
    writeTaskMeta(repoPath, meta)
  } else if (
    meta.status === 'in-progress' ||
    meta.status === 'escalated-mechanical' ||
    meta.status === 'escalated-unparseable-review' ||
    meta.status === 'escalated-gate-change'
  ) {
    checkoutBranch(repoPath, meta.branch)
    // Resuming from an escalated status must reset it to 'in-progress' before
    // runTask runs again — otherwise runTask.ts's post-implement guard
    // (`if (meta.status === 'escalated-mechanical') return meta.status`) reads
    // the stale escalated status back off disk and immediately dead-ends the
    // task even after a clean re-implementation.
    meta.status = 'in-progress'
    writeTaskMeta(repoPath, meta)
  } else {
    throw new Error(`Task ${taskId} is not in a runnable state (status: ${meta.status}).`)
  }

  const refreshed = readTaskMeta(repoPath, taskId)
  const { approveGate, ...runOverrides } = overrides
  const approvedGateFingerprint = approveGate ? confirmGateApproval(repoPath, taskId, approveGate) : undefined
  const options: RunOptions = {
    ...DEFAULT_OPTIONS,
    ...runOverrides,
    baseBranch: requireBaseBranch(taskId, refreshed.baseBranch),
    approvedGateFingerprint,
  }
  return runTask(ai, repoPath, taskId, options)
}

export const resumeCommand = runCommand
