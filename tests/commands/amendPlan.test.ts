import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { amendPlan } from '../../src/commands/amendPlan.js'
import { scaffoldTask, readTaskFile, readTaskMeta, type TaskMeta } from '../../src/taskStore.js'

let repoPath: string

afterEach(() => { if (repoPath) rmSync(repoPath, { recursive: true, force: true }) })

function seedDeviatedTask(): TaskMeta {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-amend-'))
  const meta: TaskMeta = {
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status: 'escalated-plan-deviation', round: 2, planVersion: 1, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z',
  }
  scaffoldTask(repoPath, meta, 'brief')
  return meta
}

describe('amendPlan', () => {
  it('bumps planVersion, sets status back to in-progress, and leaves round untouched', () => {
    const meta = seedDeviatedTask()
    amendPlan(repoPath, meta.taskId, '## Files\n- b.ts\n\n## Acceptance criteria\n\n1. revised\n')

    const updated = readTaskMeta(repoPath, meta.taskId)
    expect(updated.planVersion).toBe(2)
    expect(updated.status).toBe('in-progress')
    expect(updated.round).toBe(2)
    expect(readTaskFile(repoPath, meta.taskId, 'plan-approved.md')).toContain('plan-version: 2')
  })

  it('refuses to amend a task that is not awaiting a deviation decision', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-amend-'))
    const meta: TaskMeta = {
      taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
      status: 'in-progress', round: 0, planVersion: 1, retrospectivePending: false,
      createdAt: '2026-07-08T00:00:00.000Z',
    }
    scaffoldTask(repoPath, meta, 'brief')
    expect(() => amendPlan(repoPath, meta.taskId, 'x')).toThrow(/not awaiting a plan amendment/)
  })
})
