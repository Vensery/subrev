import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createTempGitRepo, commitAll, type TempRepo } from './helpers/tempGitRepo.js'
import {
  isWorkingTreeDirty,
  currentBranch,
  currentCommit,
  createTaskBranch,
  diffStatNewFiles,
  diffAddedLines,
  diffChangedFiles,
  writeDiffSnapshot,
} from '../src/git.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

describe('git helpers', () => {
  it('detects a clean tree and reports the current branch', () => {
    repo = createTempGitRepo()
    expect(isWorkingTreeDirty(repo.repoPath)).toBe(false)
    expect(currentBranch(repo.repoPath)).toMatch(/master|main/)
  })

  it('detects a dirty tree', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'scratch.txt'), 'uncommitted')
    expect(isWorkingTreeDirty(repo.repoPath)).toBe(true)
  })

  it('finds new files and added lines on a task branch, and snapshots the diff', () => {
    repo = createTempGitRepo()
    const base = currentCommit(repo.repoPath)
    createTaskBranch(repo.repoPath, 'task/demo')
    writeFileSync(path.join(repo.repoPath, 'new-file.ts'), 'export function foo() {}\n')
    commitAll(repo.repoPath, 'add foo')

    expect(diffStatNewFiles(repo.repoPath, base)).toEqual(['new-file.ts'])
    expect(diffAddedLines(repo.repoPath, base).join('\n')).toContain('function foo')

    const outPath = writeDiffSnapshot(repo.repoPath, base, repo.repoPath)
    expect(outPath).toContain('final-diff.patch')
  })

  it('wraps a failing git invocation with repo path and subcommand context', () => {
    repo = createTempGitRepo()
    let thrown: unknown
    try {
      diffChangedFiles(repo.repoPath, 'not-a-real-ref')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('git diff')
    expect(message).toContain(repo.repoPath)
  })
})
