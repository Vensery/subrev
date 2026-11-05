// tools/subrev/src/commands/approveGate.ts
//
// A human accepts one specific gate change. Without --fingerprint it only shows the change,
// recomputed from git and the working tree (never read back from .ai/, which the implementer
// can write). With --fingerprint it records the approval, and only if the fingerprint still
// matches what is on disk now.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { readTaskMeta, readTaskFile, taskDir } from '../taskStore.js'
import { checkGateIntegrity, renderGateReport } from '../integrity/gateIntegrity.js'
import { isGateChangeApproved, recordGateApproval } from '../integrity/gateApproval.js'
import { extractPlanFiles } from '../orchestrator/planFiles.js'

export interface ApproveGateResult {
  report: string
  fingerprint: string | null
  recorded: boolean
}

export function approveGate(repoPath: string, taskId: string, fingerprint?: string): ApproveGateResult {
  const meta = readTaskMeta(repoPath, taskId)
  if (!meta.baseBranch) throw new Error(`Task ${taskId} has no baseBranch.`)
  const base = execFileSync('git', ['merge-base', meta.baseBranch, 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
  const result = checkGateIntegrity(repoPath, base)
  const planFiles = extractPlanFiles(readTaskFile(repoPath, taskId, 'plan-approved.md') ?? '')
  if (!result.fingerprint) return { report: 'The gate matches the base commit; nothing to approve.', fingerprint: null, recorded: false }
  const report = renderGateReport(taskId, result, planFiles)
  if (!fingerprint) return { report, fingerprint: result.fingerprint, recorded: false }
  if (fingerprint !== result.fingerprint) {
    throw new Error(
      `Fingerprint ${fingerprint} does not match the gate change on disk now (${result.fingerprint}). Re-run "subrev approve-gate ${taskId}" and review the current diff.`
    )
  }
  if (!isGateChangeApproved(repoPath, taskId, fingerprint)) recordGateApproval(repoPath, taskId, fingerprint)
  appendFileSync(
    path.join(taskDir(repoPath, taskId), 'decision-log.md'),
    `\n- ${new Date().toISOString()}: human approved gate change ${fingerprint} (${result.changes.map((c) => c.path).join(', ')}).\n`
  )
  return { report, fingerprint, recorded: true }
}
