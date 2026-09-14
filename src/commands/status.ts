import { listTasks, type TaskMeta, type TaskStatus } from '../taskStore.js'

const TERMINAL: TaskStatus[] = ['closed', 'abandoned']
const BLOCKED: TaskStatus[] = [
  'escalated-mechanical',
  'escalated-unparseable-review',
  'escalated-plan-deviation',
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

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = []
  if (report.pendingRetrospectives.length > 0) {
    lines.push(`⚠ ${report.pendingRetrospectives.length} task(s) need a retrospective before "subrev new" will work:`)
    for (const t of report.pendingRetrospectives) lines.push(`  - ${t.taskId}`)
    lines.push('')
  }
  lines.push('In progress:', ...report.inProgress.map((t) => `  - ${t.taskId} [${t.status}]`))
  lines.push('Blocked (needs a human):', ...report.blocked.map((t) => `  - ${t.taskId} [${t.status}]`))
  lines.push('Done:', ...report.terminal.map((t) => `  - ${t.taskId} [${t.status}]`))
  return lines.join('\n')
}
