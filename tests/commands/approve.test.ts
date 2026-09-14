import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { approveTask } from '../../src/commands/approve.js'
import { scaffoldTask, writeTaskFile, readTaskFile, readTaskMeta, type TaskMeta } from '../../src/taskStore.js'

let repoPath: string

afterEach(() => { if (repoPath) rmSync(repoPath, { recursive: true, force: true }) })

function seedTask(): TaskMeta {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-approve-'))
  const meta: TaskMeta = {
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status: 'planning', round: 0, planVersion: 0, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z',
  }
  scaffoldTask(repoPath, meta, 'brief')
  writeTaskFile(repoPath, meta.taskId, 'plan.md', '## Files\n- a.ts\n\n## Acceptance criteria\n\n1. thing\n')
  return meta
}

describe('approveTask', () => {
  it('copies plan.md into plan-approved.md, versioned, and bumps status', () => {
    const meta = seedTask()
    approveTask(repoPath, meta.taskId)

    const approved = readTaskFile(repoPath, meta.taskId, 'plan-approved.md')
    expect(approved).toContain('plan-version: 1')
    expect(approved).toContain('1. thing')

    const updated = readTaskMeta(repoPath, meta.taskId)
    expect(updated.status).toBe('plan-approved')
    expect(updated.planVersion).toBe(1)
  })

  it('uses an edited plan when provided instead of plan.md', () => {
    const meta = seedTask()
    approveTask(repoPath, meta.taskId, '## Files\n- b.ts\n\n## Acceptance criteria\n\n1. edited\n')
    expect(readTaskFile(repoPath, meta.taskId, 'plan-approved.md')).toContain('1. edited')
  })
})
