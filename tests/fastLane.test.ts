import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { createTempGitRepo, commitAll, type TempRepo } from './helpers/tempGitRepo.js'
import { currentCommit } from '../src/git.js'
import { checkFastLaneCompliance } from '../src/fastLane.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

describe('checkFastLaneCompliance', () => {
  it('never violates when the commit message references a task id', () => {
    repo = createTempGitRepo()
    const base = currentCommit(repo.repoPath)
    writeFileSync(path.join(repo.repoPath, 'new.ts'), 'export function x() {}\n')
    commitAll(repo.repoPath, 'add new.ts')
    const result = checkFastLaneCompliance(repo.repoPath, base, 'wip 2026-07-08-add-x')
    expect(result.violated).toBe(false)
  })

  it('allows a small edit with no task id', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
    commitAll(repo.repoPath, 'add a.ts')
    const base = currentCommit(repo.repoPath)
    appendFileSync(path.join(repo.repoPath, 'a.ts'), '// tweak\n')
    commitAll(repo.repoPath, 'tweak styling')

    const result = checkFastLaneCompliance(repo.repoPath, base, 'tweak styling')
    expect(result.violated).toBe(false)
  })

  it('flags a new file with no task id', () => {
    repo = createTempGitRepo()
    const base = currentCommit(repo.repoPath)
    writeFileSync(path.join(repo.repoPath, 'new.ts'), 'export const y = 1\n')
    commitAll(repo.repoPath, 'add new.ts')

    const result = checkFastLaneCompliance(repo.repoPath, base, 'quick change')
    expect(result.violated).toBe(true)
    expect(result.reason).toMatch(/new file/)
  })

  it('flags a diff over the line threshold with no task id', () => {
    repo = createTempGitRepo()
    const base = currentCommit(repo.repoPath)
    const longContent = Array.from({ length: 25 }, (_, i) => `const v${i} = ${i}`).join('\n')
    appendFileSync(path.join(repo.repoPath, 'README.md'), `\n${longContent}\n`)
    commitAll(repo.repoPath, 'quick change')

    const result = checkFastLaneCompliance(repo.repoPath, base, 'quick change', 20)
    expect(result.violated).toBe(true)
    expect(result.reason).toMatch(/lines/)
  })
})
