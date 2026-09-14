import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildStatusReport, formatStatusReport } from '../../src/commands/status.js'
import { scaffoldTask, type TaskMeta } from '../../src/taskStore.js'

let repoPath: string

afterEach(() => { if (repoPath) rmSync(repoPath, { recursive: true, force: true }) })

function seed(overrides: Partial<TaskMeta>): void {
  const meta: TaskMeta = {
    taskId: overrides.taskId ?? 'x', project: 'acme', repoKey: 'main', branch: 'task/x',
    status: 'in-progress', round: 0, planVersion: 1, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z', ...overrides,
  }
  scaffoldTask(repoPath, meta, 'brief')
}

describe('buildStatusReport', () => {
  it('buckets tasks into in-progress, blocked, terminal, and pending retrospectives', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-status-'))
    seed({ taskId: 'running', status: 'in-progress' })
    seed({ taskId: 'stuck', status: 'escalated-mechanical' })
    seed({ taskId: 'done', status: 'closed' })
    seed({ taskId: 'gone', status: 'abandoned', retrospectivePending: true })

    const report = buildStatusReport(repoPath)
    expect(report.inProgress.map((t) => t.taskId)).toEqual(['running'])
    expect(report.blocked.map((t) => t.taskId)).toEqual(['stuck'])
    expect(report.terminal.map((t) => t.taskId).sort()).toEqual(['done', 'gone'])
    expect(report.pendingRetrospectives.map((t) => t.taskId)).toEqual(['gone'])
  })
})

describe('formatStatusReport', () => {
  it('surfaces the pending-retrospective warning when present', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-status-'))
    seed({ taskId: 'gone', status: 'abandoned', retrospectivePending: true })
    const text = formatStatusReport(buildStatusReport(repoPath))
    expect(text).toContain('need a retrospective')
    expect(text).toContain('gone')
  })

  it('omits the warning when nothing is pending', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-status-'))
    seed({ taskId: 'running', status: 'in-progress' })
    expect(formatStatusReport(buildStatusReport(repoPath))).not.toContain('need a retrospective')
  })
})
