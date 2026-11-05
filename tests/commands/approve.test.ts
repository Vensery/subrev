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
    taskId: 't1', project: 'selfmatch', repoKey: 'main', branch: 'task/t1',
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
    expect(approved).toContain('- AC-1: thing')

    const updated = readTaskMeta(repoPath, meta.taskId)
    expect(updated.status).toBe('plan-approved')
    expect(updated.planVersion).toBe(1)
  })

  it('uses an edited plan when provided instead of plan.md', () => {
    const meta = seedTask()
    approveTask(repoPath, meta.taskId, '## Files\n- b.ts\n\n## Acceptance criteria\n\n1. edited\n')
    expect(readTaskFile(repoPath, meta.taskId, 'plan-approved.md')).toContain('- AC-1: edited')
  })

  it('keeps explicit AC ids and test bindings, and warns when the acceptance section is missing', () => {
    const meta = seedTask()
    approveTask(repoPath, meta.taskId, '## Files\n- a.ts\n\n## Acceptance criteria\n\n- AC-2: parses hours [tests: parses 1h]\n- AC-5: rejects spaces\n')
    const approved = readTaskFile(repoPath, meta.taskId, 'plan-approved.md')!
    expect(approved).toContain('- AC-2: parses hours [tests: parses 1h]')
    expect(approved).toContain('- AC-5: rejects spaces')

    const meta2 = { ...meta, taskId: 't2' }
    scaffoldTask(repoPath, meta2, 'brief')
    const result = approveTask(repoPath, 't2', '## Files\n- a.ts\n')
    expect(result.warnings.join(' ')).toMatch(/no "## Acceptance criteria"/)
  })

  it('refuses a plan whose acceptance ids are ambiguous', () => {
    const meta = seedTask()
    expect(() =>
      approveTask(repoPath, meta.taskId, '## Acceptance criteria\n\n- AC-1: one thing here\n- AC-1: another thing\n')
    ).toThrow(/duplicate acceptance criterion id AC-1/)
  })
})
