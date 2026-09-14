import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeTask, abandonTask, retro } from '../../src/commands/closeAndAbandon.js'
import { scaffoldTask, writeTaskFile, readTaskFile, readTaskMeta, writeTaskMeta, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit, createTaskBranch, currentBranch } from '../../src/git.js'

let repo: TempRepo
let archiveRepo: TempRepo
let configPath: string

afterEach(() => {
  repo?.cleanup()
  archiveRepo?.cleanup()
})

function seedTask(status: TaskMeta['status'] = 'awaiting-judgment'): TaskMeta {
  repo = createTempGitRepo()
  archiveRepo = createTempGitRepo()
  const base = currentCommit(repo.repoPath)
  const meta: TaskMeta = {
    taskId: 't1', project: 'acme', repoKey: 'main', branch: 'task/t1',
    status, round: 1, planVersion: 1, retrospectivePending: false,
    createdAt: '2026-07-08T00:00:00.000Z', baseBranch: base, unparseableReviewCount: 0,
  }
  scaffoldTask(repo.repoPath, meta, 'brief')
  createTaskBranch(repo.repoPath, meta.branch)
  writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
  commitAll(repo.repoPath, 'implement')

  const configDir = mkdtempSync(path.join(os.tmpdir(), 'subrev-close-config-'))
  configPath = path.join(configDir, 'projects.json')
  writeFileSync(configPath, JSON.stringify({
    acme: { repos: { main: repo.repoPath }, archiveRepo: archiveRepo.repoPath },
  }))
  return meta
}

describe('closeTask', () => {
  it('refuses to close without a decision-log.md', () => {
    const meta = seedTask()
    expect(() => closeTask(repo.repoPath, meta.taskId, configPath)).toThrow(/decision-log.md is empty/)
  })

  it('refuses to close from in-progress without force and does not touch side effects', () => {
    const meta = seedTask('in-progress')
    const branchBefore = currentBranch(repo.repoPath)

    expect(() => closeTask(repo.repoPath, meta.taskId, configPath)).toThrow(/force/)

    expect(readTaskMeta(repo.repoPath, meta.taskId).status).toBe('in-progress')
    expect(currentBranch(repo.repoPath)).toBe(branchBefore)
    expect(readdirSync(archiveRepo.repoPath)).not.toContain('t1')
  })

  it('merges the task branch, marks closed, and archives with a diff snapshot', () => {
    const meta = seedTask()
    writeTaskFile(repo.repoPath, meta.taskId, 'decision-log.md', '# Decision Log\n\nApproved.\n')

    closeTask(repo.repoPath, meta.taskId, configPath)

    expect(readTaskMeta(repo.repoPath, meta.taskId).status).toBe('closed')
    expect(currentBranch(repo.repoPath)).not.toBe('task/t1')
    const archived = readdirSync(archiveRepo.repoPath)
    expect(archived).toContain('t1')
  })

  it('forces a close from in-progress and records the source status', () => {
    const meta = seedTask('in-progress')

    closeTask(repo.repoPath, meta.taskId, configPath, { force: true })

    expect(readTaskMeta(repo.repoPath, meta.taskId).status).toBe('closed')
    expect(readTaskFile(repo.repoPath, meta.taskId, 'decision-log.md')).toContain('Forced closed transition from in-progress.')
  })

  it('still refuses to close closed tasks even with force', () => {
    const meta = seedTask('closed')

    expect(() => closeTask(repo.repoPath, meta.taskId, configPath, { force: true })).toThrow(/terminal tasks cannot be re-entered/)
  })
})

describe('abandonTask', () => {
  it('marks abandoned with retrospectivePending and archives without merging', () => {
    const meta = seedTask('awaiting-judgment')
    const branchBefore = currentBranch(repo.repoPath)

    abandonTask(repo.repoPath, meta.taskId, 'plan turned out to be wrong', configPath)

    const updated = readTaskMeta(repo.repoPath, meta.taskId)
    expect(updated.status).toBe('abandoned')
    expect(updated.retrospectivePending).toBe(true)
    expect(currentBranch(repo.repoPath)).toBe(branchBefore)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'decision-log.md')).toContain('plan turned out to be wrong')
    expect(readdirSync(archiveRepo.repoPath)).toContain('t1')
  })

  it('refuses to abandon from planning without force', () => {
    const meta = seedTask('planning')

    expect(() => abandonTask(repo.repoPath, meta.taskId, 'plan changed', configPath)).toThrow(/force/)
  })

  it('throws when baseBranch is missing', () => {
    const meta = seedTask('awaiting-judgment')
    const stripped = readTaskMeta(repo.repoPath, meta.taskId)
    delete stripped.baseBranch
    writeTaskMeta(repo.repoPath, stripped)

    expect(() => abandonTask(repo.repoPath, meta.taskId, 'missing base branch', configPath)).toThrow(/baseBranch/)
  })

  it('forces abandon from in-progress and records the source status and reason', () => {
    const meta = seedTask('in-progress')

    abandonTask(repo.repoPath, meta.taskId, 'plan turned out to be wrong', configPath, { force: true })

    expect(readTaskMeta(repo.repoPath, meta.taskId).status).toBe('abandoned')
    const log = readTaskFile(repo.repoPath, meta.taskId, 'decision-log.md')
    expect(log).toContain('Forced abandoned transition from in-progress.')
    // The forced path must not drop the required reason (Obs 2).
    expect(log).toContain('Abandoned: plan turned out to be wrong')
  })

  it('still refuses to abandon closed tasks even with force', () => {
    const meta = seedTask('closed')

    expect(() => abandonTask(repo.repoPath, meta.taskId, 'already done', configPath, { force: true })).toThrow(/terminal tasks cannot be re-entered/)
  })
})

describe('retro', () => {
  it('clears retrospectivePending and appends the note', () => {
    const meta = seedTask('abandoned')
    const m = readTaskMeta(repo.repoPath, meta.taskId)
    m.retrospectivePending = true
    writeTaskFile(repo.repoPath, meta.taskId, 'decision-log.md', '# Decision Log\n\nAuto-abandoned.\n')
    writeTaskMeta(repo.repoPath, m)

    retro(repo.repoPath, meta.taskId, 'the plan underestimated the API surface', configPath)

    const updated = readTaskMeta(repo.repoPath, meta.taskId)
    expect(updated.retrospectivePending).toBe(false)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'decision-log.md')).toContain('underestimated')
  })

  it('refuses when there is no pending retrospective', () => {
    const meta = seedTask('closed')
    expect(() => retro(repo.repoPath, meta.taskId, 'note', configPath)).toThrow(/no pending retrospective/)
  })

  it('re-archiving after abandon replaces (not nests) the previous archive', () => {
    const meta = seedTask('awaiting-judgment')

    // First archive: abandonTask archives the task folder once.
    abandonTask(repo.repoPath, meta.taskId, 'requirements changed underneath us', configPath)
    expect(readTaskMeta(repo.repoPath, meta.taskId).retrospectivePending).toBe(true)

    // Second archive for the same task-id: retro() re-archives. Without the
    // `rmSync(dest)` fix, `cp -R` would nest the folder as
    // archiveRepo/t1/t1/... instead of replacing archiveRepo/t1/...
    retro(repo.repoPath, meta.taskId, 'should have spiked the API surface first', configPath)

    const topLevel = readdirSync(archiveRepo.repoPath)
    expect(topLevel).toContain('t1')
    // No nested duplicate directory at the top level of the archive repo,
    // and no nesting one level down inside t1 either.
    const insideT1 = readdirSync(path.join(archiveRepo.repoPath, 't1'))
    expect(insideT1).not.toContain('t1')

    // The archive repo stores the task folder directly at
    // `<archiveRepo>/<taskId>/...` (not under `.ai/tasks/`), so read the
    // archived decision-log.md by its literal path rather than via
    // readTaskFile (which assumes the `.ai/tasks/<id>/` layout).
    const archivedLog = readFileSync(path.join(archiveRepo.repoPath, meta.taskId, 'decision-log.md'), 'utf8')
    expect(archivedLog).toContain('requirements changed underneath us')
    expect(archivedLog).toContain('should have spiked the API surface first')
  })
})
