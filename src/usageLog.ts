// tools/subrev/src/usageLog.ts
//
// Per-task log of every AI call (stage, wall time, cost when the CLI reports it), so the
// price of each pipeline stage — in particular the forced fix re-review — is measured on
// real tasks rather than estimated.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CallObserver, CallRecord } from './aiRunner.js'
import { listTasks, readTaskMeta, taskDir } from './taskStore.js'

export const USAGE_LOG = 'ai-calls.jsonl'

export interface LoggedCall extends CallRecord {
  at: string
  round: number
}

export function createUsageLogger(repoPath: string, taskId: string): CallObserver {
  return (record) => {
    let round = 0
    try {
      round = readTaskMeta(repoPath, taskId).round
    } catch {
      // meta unreadable: still log the call
    }
    const line: LoggedCall = { at: new Date().toISOString(), round, ...record }
    try {
      appendFileSync(path.join(taskDir(repoPath, taskId), USAGE_LOG), JSON.stringify(line) + '\n', 'utf8')
    } catch {
      // usage accounting must never break a run
    }
  }
}

export function readUsageLog(repoPath: string, taskId: string): LoggedCall[] {
  const file = path.join(taskDir(repoPath, taskId), USAGE_LOG)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LoggedCall]
      } catch {
        return []
      }
    })
}

export interface StageSummary {
  stage: string
  calls: number
  tasks: number
  totalMs: number
  /** Summed over calls that reported a cost; null when none did. */
  costUsd: number | null
  callsWithCost: number
}

export interface UsageSummary {
  tasks: number
  stages: StageSummary[]
  totalMs: number
  totalCostUsd: number | null
}

export function summarizeUsage(repoPath: string, taskIds?: string[]): UsageSummary {
  const ids = taskIds ?? listTasks(repoPath).map((t) => t.taskId)
  const byStage = new Map<string, StageSummary & { taskSet: Set<string> }>()
  let tasksWithCalls = 0
  for (const id of ids) {
    const calls = readUsageLog(repoPath, id)
    if (calls.length) tasksWithCalls += 1
    for (const c of calls) {
      const s = byStage.get(c.stage) ?? { stage: c.stage, calls: 0, tasks: 0, totalMs: 0, costUsd: null, callsWithCost: 0, taskSet: new Set<string>() }
      s.calls += 1
      s.totalMs += c.ms
      s.taskSet.add(id)
      if (typeof c.costUsd === 'number') {
        s.costUsd = (s.costUsd ?? 0) + c.costUsd
        s.callsWithCost += 1
      }
      byStage.set(c.stage, s)
    }
  }
  const order = ['plan', 'implement', 'review', 'audit', 'fix-review', 'scope']
  const rank = (stage: string) => (order.includes(stage) ? order.indexOf(stage) : order.length)
  const stages = [...byStage.values()]
    .map(({ taskSet, ...s }) => ({ ...s, tasks: taskSet.size }))
    .sort((a, b) => rank(a.stage) - rank(b.stage))
  const costs = stages.map((s) => s.costUsd).filter((c): c is number => c !== null)
  return {
    tasks: tasksWithCalls,
    stages,
    totalMs: stages.reduce((n, s) => n + s.totalMs, 0),
    totalCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(3)}`)

export function formatUsageSummary(summary: UsageSummary): string {
  if (summary.tasks === 0) return `No ${USAGE_LOG} found yet: usage is logged from the next "subrev run".`
  const lines = [
    `Tasks with logged calls: ${summary.tasks}`,
    '',
    'stage        calls  tasks  total time  mean/call  total cost  mean cost/call',
    ...summary.stages.map((s) =>
      [
        s.stage.padEnd(12),
        String(s.calls).padStart(5),
        String(s.tasks).padStart(6),
        secs(s.totalMs).padStart(11),
        secs(s.totalMs / s.calls).padStart(10),
        usd(s.costUsd).padStart(11),
        (s.callsWithCost ? usd((s.costUsd ?? 0) / s.callsWithCost) : 'n/a').padStart(15),
      ].join(' ')
    ),
    '',
    `Total: ${secs(summary.totalMs)}, ${usd(summary.totalCostUsd)} (codex calls report time only)`,
  ]
  const fixReview = summary.stages.find((s) => s.stage === 'fix-review')
  if (fixReview) {
    const share = (x: number, total: number) => (total > 0 ? `${((100 * x) / total).toFixed(1)}%` : 'n/a')
    lines.push(
      `Fix re-reviews: ${fixReview.calls} call(s) in ${fixReview.tasks} task(s); ` +
        `${share(fixReview.totalMs, summary.totalMs)} of AI time, ` +
        `${fixReview.costUsd !== null && summary.totalCostUsd ? share(fixReview.costUsd, summary.totalCostUsd) : 'n/a'} of cost.`
    )
  }
  return lines.join('\n')
}
