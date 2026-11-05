import { listTasks, type TaskMeta, type TaskStatus } from '../taskStore.js'

const TERMINAL: TaskStatus[] = ['closed', 'abandoned']
const BLOCKED: TaskStatus[] = [
  'escalated-mechanical',
  'escalated-unparseable-review',
  'escalated-plan-deviation',
  'escalated-gate-change',
  'awaiting-judgment',
]

export interface StatusReport {
  blocked: TaskMeta[]
  terminal: TaskMeta[]
  inProgress: TaskMeta[]
  pendingRetrospectives: TaskMeta[]
}

export function buildStatusReport(repoPath: string): StatusReport {
  const tasks = listTasks(repoPath)
  return {
    blocked: tasks.filter((t) => BLOCKED.includes(t.status)),
    terminal: tasks.filter((t) => TERMINAL.includes(t.status)),
    inProgress: tasks.filter((t) => !BLOCKED.includes(t.status) && !TERMINAL.includes(t.status)),
    pendingRetrospectives: tasks.filter((t) => t.retrospectivePending),
  }
}

/**
 * Signals a human should see next to a blocked task: an unreviewed fix, fixes that changed
 * non-test code (business logic is the human's call), and a report audit that did not come
 * back clean. Details are in the task's judgment-brief.md.
 */
function taskNotes(t: TaskMeta): string {
  const notes: string[] = []
  if (t.unreviewedFixRound !== undefined) notes.push(`fix after FAILED round ${t.unreviewedFixRound} not re-reviewed`)
  if (t.fixCount) notes.push(`${t.fixCount} fix(es), see judgment-brief.md`)
  if (t.testIntegrityFlags) notes.push(`tests possibly weakened in ${t.testIntegrityFlags} window(s)`)
  if (t.status === 'escalated-gate-change') notes.push('gate changed; see gate-change-report.md, then subrev approve-gate')
  if (t.auditResult && t.auditResult !== 'consistent') notes.push(`report audit: ${t.auditResult}`)
  return notes.length ? ` ⚠ ${notes.join('; ')}` : ''
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = []
  if (report.pendingRetrospectives.length > 0) {
    lines.push(`⚠ ${report.pendingRetrospectives.length} task(s) need a retrospective before "subrev new" will work:`)
    for (const t of report.pendingRetrospectives) lines.push(`  - ${t.taskId}`)
    lines.push('')
  }
  lines.push('In progress:', ...report.inProgress.map((t) => `  - ${t.taskId} [${t.status}]`))
  lines.push('Blocked (needs a human):', ...report.blocked.map((t) => `  - ${t.taskId} [${t.status}]${taskNotes(t)}`))
  lines.push('Done:', ...report.terminal.map((t) => `  - ${t.taskId} [${t.status}]`))
  return lines.join('\n')
}
