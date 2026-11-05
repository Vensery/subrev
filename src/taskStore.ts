import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'

export type TaskStatus =
  | 'planning'
  | 'plan-approved'
  | 'in-progress'
  | 'escalated-mechanical'
  | 'escalated-unparseable-review'
  | 'escalated-plan-deviation'
  | 'escalated-gate-change'
  | 'awaiting-judgment'
  | 'closed'
  | 'abandoned'

export interface TaskMeta {
  taskId: string
  project: string
  repoKey: string
  branch: string
  status: TaskStatus
  round: number
  planVersion: number
  retrospectivePending: boolean
  createdAt: string
  baseBranch?: string
  unparseableReviewCount?: number
  lastReviewedCommit?: string
  /** Outcome of the latest report-audit phase (phase 2 of review). Informational, not a gate. */
  auditResult?: AuditResult
  /** Verdict of the most recent phase-1 review. */
  lastVerdict?: 'PASS' | 'FAIL'
  /** Number of review-driven fixes applied so far. */
  fixCount?: number
  /** Set when the task stopped after a fix that no review looked at (test-only fix, or layer 2 accepted it). */
  unreviewedFixRound?: number
  /** Files changed in the reviewed diff that no implementer report mentions (latest audit). */
  undisclosedFileCount?: number
  /** Fingerprint of the gate change that blocked the task (escalated-gate-change). */
  gateChangeFingerprint?: string
  /** Number of review windows in which the test-integrity check flagged weakened tests. */
  testIntegrityFlags?: number
}

export type AuditResult = 'consistent' | 'contradiction' | 'unparseable' | 'missing-report' | 'error'

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

export function generateTaskId(description: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return `${date}-${slugify(description)}`
}

export function taskDir(repoPath: string, taskId: string): string {
  return path.join(repoPath, '.ai', 'tasks', taskId)
}

function metaPath(repoPath: string, taskId: string): string {
  return path.join(taskDir(repoPath, taskId), 'meta.md')
}

export function writeTaskMeta(repoPath: string, meta: TaskMeta): void {
  mkdirSync(taskDir(repoPath, meta.taskId), { recursive: true })
  const body = `# Task ${meta.taskId}\n\nProject: ${meta.project}\nRepo: ${meta.repoKey}\n`
  const content = matter.stringify(body, meta as unknown as Record<string, unknown>)
  writeFileSync(metaPath(repoPath, meta.taskId), content, 'utf8')
}

export function readTaskMeta(repoPath: string, taskId: string): TaskMeta {
  const raw = readFileSync(metaPath(repoPath, taskId), 'utf8')
  const parsed = matter(raw)
  // gray-matter caches parse results process-wide, keyed by the raw input
  // string. On a cache hit, `parsed.data` is the SAME object reference
  // across calls, not a fresh copy. Callers commonly do
  // `const meta = readTaskMeta(...); meta.status = 'x'; writeTaskMeta(...)`,
  // which would otherwise silently mutate every other read of
  // byte-identical content before it's ever written back to disk. Return a
  // shallow clone so each call yields an independent object. TaskMeta's
  // fields are all primitives, so a shallow clone is sufficient.
  return { ...parsed.data } as TaskMeta
}

export function scaffoldTask(repoPath: string, meta: TaskMeta, briefText: string): void {
  mkdirSync(taskDir(repoPath, meta.taskId), { recursive: true })
  writeTaskMeta(repoPath, meta)
  writeTaskFile(repoPath, meta.taskId, 'brief.md', briefText)
}

export function writeTaskFile(repoPath: string, taskId: string, filename: string, content: string): void {
  writeFileSync(path.join(taskDir(repoPath, taskId), filename), content, 'utf8')
}

export function readTaskFile(repoPath: string, taskId: string, filename: string): string | null {
  const filePath = path.join(taskDir(repoPath, taskId), filename)
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null
}

export function listTaskIds(repoPath: string): string[] {
  const tasksRoot = path.join(repoPath, '.ai', 'tasks')
  if (!existsSync(tasksRoot)) return []
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

export function listTasks(repoPath: string): TaskMeta[] {
  return listTaskIds(repoPath).map((taskId) => readTaskMeta(repoPath, taskId))
}
