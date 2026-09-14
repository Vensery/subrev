import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPlanPrompt, planTask } from '../../src/commands/plan.js'
import { scaffoldTask, readTaskFile, type TaskMeta } from '../../src/taskStore.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repoPath: string

afterEach(() => { if (repoPath) rmSync(repoPath, { recursive: true, force: true }) })

function seedTask(): TaskMeta {
  repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-plan-'))
  const meta: TaskMeta = {
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status: 'planning', round: 0, planVersion: 0, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z',
  }
  scaffoldTask(repoPath, meta, '# Brief\n\nAdd a foo\n')
  return meta
}

describe('buildPlanPrompt', () => {
  it('requires a Files section and a numbered acceptance criteria section', () => {
    const prompt = buildPlanPrompt('do the thing')
    expect(prompt).toContain('## Files')
    expect(prompt).toContain('NUMBERED list')
    expect(prompt).toContain('do the thing')
  })
})

describe('planTask', () => {
  it('writes the AI-generated plan to plan.md', async () => {
    const meta = seedTask()
    const ai = new FakeAiRunner()
    ai.planResponses.push('## Files\n- a.ts\n\n## Acceptance criteria\n\n1. Does the thing\n')
    const plan = await planTask(ai, repoPath, meta.taskId)
    expect(plan).toContain('Does the thing')
    expect(readTaskFile(repoPath, meta.taskId, 'plan.md')).toBe(plan)
  })
})
