import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  generateTaskId,
  scaffoldTask,
  readTaskMeta,
  writeTaskMeta,
  readTaskFile,
  writeTaskFile,
  listTasks,
  type TaskMeta,
} from '../src/taskStore.js'

let repoPath: string

afterEach(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true })
})

function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    taskId: '2026-07-08-add-foo',
    project: 'acme',
    repoKey: 'main',
    branch: 'task/2026-07-08-add-foo',
    status: 'planning',
    round: 0,
    planVersion: 0,
    retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

describe('generateTaskId', () => {
  it('combines date and a slugified description', () => {
    const id = generateTaskId('Add Foo Bar!!', new Date('2026-07-08T12:00:00Z'))
    expect(id).toBe('2026-07-08-add-foo-bar')
  })
})

describe('scaffoldTask / readTaskMeta / writeTaskMeta', () => {
  it('round-trips task metadata and the brief', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-store-'))
    const meta = makeMeta()
    scaffoldTask(repoPath, meta, '# Brief\n\ndo the thing\n')

    const readBack = readTaskMeta(repoPath, meta.taskId)
    expect(readBack.taskId).toBe(meta.taskId)
    expect(readBack.status).toBe('planning')

    const brief = readTaskFile(repoPath, meta.taskId, 'brief.md')
    expect(brief).toContain('do the thing')

    readBack.status = 'plan-approved'
    writeTaskMeta(repoPath, readBack)
    expect(readTaskMeta(repoPath, meta.taskId).status).toBe('plan-approved')
  })

  it('returns null for a file that has not been written', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-store-'))
    scaffoldTask(repoPath, makeMeta(), 'brief')
    expect(readTaskFile(repoPath, '2026-07-08-add-foo', 'review.md')).toBeNull()
  })

  it('returns independent objects on repeated reads of unchanged content (gray-matter cache regression)', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-store-'))
    const meta = makeMeta()
    scaffoldTask(repoPath, meta, '# Brief\n\ndo the thing\n')

    const first = readTaskMeta(repoPath, meta.taskId)
    const second = readTaskMeta(repoPath, meta.taskId)

    first.status = 'plan-approved'

    expect(second.status).toBe('planning')
  })
})

describe('writeTaskFile / listTasks', () => {
  it('lists all scaffolded tasks', () => {
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-store-'))
    scaffoldTask(repoPath, makeMeta({ taskId: 'a' }), 'brief a')
    scaffoldTask(repoPath, makeMeta({ taskId: 'b', retrospectivePending: true }), 'brief b')
    writeTaskFile(repoPath, 'a', 'plan.md', '# plan')

    const tasks = listTasks(repoPath)
    expect(tasks.map((t) => t.taskId).sort()).toEqual(['a', 'b'])
    expect(tasks.find((t) => t.taskId === 'b')?.retrospectivePending).toBe(true)
    expect(readTaskFile(repoPath, 'a', 'plan.md')).toBe('# plan')
  })
})
