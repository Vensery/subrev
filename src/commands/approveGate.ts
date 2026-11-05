// tools/subrev/src/commands/approveGate.ts
//
// Inspecting and approving a gate change. `subrev show-gate <task>` shows the change,
// recomputed from git and the working tree (never read back from .ai/). Approval is not stored:
// the human passes the fingerprint to `subrev resume <task> --approve-gate <fp>`, it is checked
// against the disk at start and held in memory for that run only.
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readTaskMeta, readTaskFile, taskDir } from '../taskStore.js'
import { checkGateIntegrity, renderGateReport, type GateIntegrityResult } from '../integrity/gateIntegrity.js'
import { appendGateApprovalAudit } from '../integrity/gateApproval.js'
import { extractPlanFiles } from '../orchestrator/planFiles.js'

function currentGateChange(repoPath: string, taskId: string): GateIntegrityResult {
  const meta = readTaskMeta(repoPath, taskId)
  if (!meta.baseBranch) throw new Error(`Task ${taskId} has no baseBranch.`)
  const base = execFileSync('git', ['merge-base', meta.baseBranch, 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
  return checkGateIntegrity(repoPath, base)
}

export function showGate(repoPath: string, taskId: string): { report: string; fingerprint: string | null } {
  const result = currentGateChange(repoPath, taskId)
  if (!result.fingerprint) return { report: 'The gate matches the base commit; nothing to approve.', fingerprint: null }
  const planFiles = extractPlanFiles(readTaskFile(repoPath, taskId, 'plan-approved.md') ?? '')
  return { report: renderGateReport(taskId, result, planFiles), fingerprint: result.fingerprint }
}

/**
 * Check a fingerprint the human typed against the gate change on disk right now. Returns it for
 * the run to hold in memory; records an audit entry that nothing ever reads back.
 */
export function confirmGateApproval(repoPath: string, taskId: string, fingerprint: string): string {
  const result = currentGateChange(repoPath, taskId)
  if (!result.fingerprint) throw new Error(`--approve-gate ${fingerprint}: the gate matches the base commit; there is nothing to approve.`)
  if (fingerprint !== result.fingerprint) {
    throw new Error(
      `--approve-gate ${fingerprint} does not match the gate change on disk now (${result.fingerprint}). Run "subrev show-gate ${taskId}" and review the current diff.`
    )
  }
  const files = result.changes.map((c) => c.path)
  appendGateApprovalAudit(repoPath, taskId, fingerprint, files)
  appendFileSync(
    path.join(taskDir(repoPath, taskId), 'decision-log.md'),
    `\n- ${new Date().toISOString()}: human approved gate change ${fingerprint} (${files.join(', ')}) for this run.\n`
  )
  return fingerprint
}
