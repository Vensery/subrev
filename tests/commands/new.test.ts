import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newTask } from '../../src/commands/new.js'
import { readTaskFile, writeTaskMeta, type TaskMeta } from '../../src/taskStore.js'
import { currentBranch } from '../../src/git.js'
import { createTempGitRepo, type TempRepo } from '../helpers/tempGitRepo.js'

let repo: TempRepo
let configPath: string

afterEach(() => {
  repo?.cleanup()
})

function setupConfig(): void {
  repo = createTempGitRepo()
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'subrev-new-config-'))
  configPath = path.join(configDir, 'projects.json')
  writeFileSync(configPath, JSON.stringify({ acme: { repos: { main: repo.repoPath } } }))
}

describe('newTask', () => {
  it('scaffolds a task and returns its metadata', () => {
    setupConfig()
    const originalBranch = currentBranch(repo.repoPath)
    const meta = newTask({
      cwd: repo.repoPath,
      description: 'Add foo bar',
      configPath,
      now: new Date('2026-07-08T00:00:00Z'),
    })
    expect(meta.taskId).toBe('2026-07-08-add-foo-bar')
    expect(meta.status).toBe('planning')
    expect(meta.baseBranch).toBe(originalBranch)
    expect(meta.unparseableReviewCount).toBe(0)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'brief.md')).toContain('Add foo bar')
  })

  it('throws when cwd is not registered in projects.json', () => {
    setupConfig()
    expect(() => newTask({ cwd: '/unregistered', description: 'x', configPath })).toThrow(/No project registered/)
  })

  it('refuses to create a task while a retrospective is pending', () => {
    setupConfig()
    const existing: TaskMeta = {
      taskId: 'old-task',
      project: 'acme',
      repoKey: 'main',
      branch: 'task/old-task',
      status: 'abandoned',
      round: 3,
      planVersion: 1,
      retrospectivePending: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      baseBranch: currentBranch(repo.repoPath),
      unparseableReviewCount: 0,
    }
    writeTaskMeta(repo.repoPath, existing)
    // scaffoldTask isn't used here since we only need meta.md to exist for listTasks to find it
    expect(() => newTask({ cwd: repo.repoPath, description: 'new one', configPath })).toThrow(/pending retrospective/)
  })
})
