// tools/subrev/src/integrity/gateApproval.ts
//
// Audit log of human gate approvals. It is WRITE-ONLY on purpose: nothing in subrev reads it
// to decide anything. The gate runs code the implementer wrote (tests, app code, npm scripts)
// as the same OS user and outside any sandbox, so any file on disk — inside the repo or in the
// home directory — can be written by untrusted code. A decision that read this file could be
// forged (reproduced in tests/integrity/forgery.test.ts). The only trusted approval is the
// fingerprint the human passes on the command line of the run that uses it
// (`subrev resume <task> --approve-gate <fp>`), held in memory for that process.
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function gateStateDir(): string {
  return process.env.SUBREV_STATE_DIR ?? path.join(os.homedir(), '.subrev')
}

export function appendGateApprovalAudit(repoPath: string, taskId: string, fingerprint: string, files: string[]): void {
  try {
    const dir = gateStateDir()
    mkdirSync(dir, { recursive: true })
    const line = { at: new Date().toISOString(), repo: repoPath, taskId, fingerprint, files, by: os.userInfo().username }
    appendFileSync(path.join(dir, 'gate-approvals.log'), JSON.stringify(line) + '\n', 'utf8')
  } catch {
    // An audit write failing must not block the run; the decision-log entry still records it.
  }
}
