// tools/subrev/src/integrity/gateApproval.ts
//
// Human approvals of specific gate changes. Stored outside the repository on purpose: the
// implementer runs with write access to the whole workspace (including .ai/), so an
// approval it could write itself would be worthless. Default location ~/.subrev/,
// overridable with SUBREV_STATE_DIR.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface ApprovalEntry {
  fingerprint: string
  approvedAt: string
  approvedBy: string
}

type ApprovalStore = Record<string, ApprovalEntry[]>

function storeFile(): string {
  const dir = process.env.SUBREV_STATE_DIR ?? path.join(os.homedir(), '.subrev')
  return path.join(dir, 'gate-approvals.json')
}

function key(repoPath: string, taskId: string): string {
  return `${realpathSync(repoPath)}::${taskId}`
}

function load(): ApprovalStore {
  const file = storeFile()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ApprovalStore
  } catch {
    // A corrupt store approves nothing.
    return {}
  }
}

export function isGateChangeApproved(repoPath: string, taskId: string, fingerprint: string): boolean {
  return (load()[key(repoPath, taskId)] ?? []).some((e) => e.fingerprint === fingerprint)
}

export function recordGateApproval(repoPath: string, taskId: string, fingerprint: string): void {
  const store = load()
  const k = key(repoPath, taskId)
  const entries = store[k] ?? []
  if (!entries.some((e) => e.fingerprint === fingerprint)) {
    entries.push({ fingerprint, approvedAt: new Date().toISOString(), approvedBy: os.userInfo().username })
  }
  store[k] = entries
  const file = storeFile()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', 'utf8')
}
