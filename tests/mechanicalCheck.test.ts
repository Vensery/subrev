import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { createTempGitRepo, commitAll, type TempRepo } from './helpers/tempGitRepo.js'
import { currentCommit } from '../src/git.js'
import { checkScopeCreep } from '../src/mechanicalCheck.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

describe('checkScopeCreep', () => {
  it('does not trigger on a trivial in-plan edit', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
    commitAll(repo.repoPath, 'add a.ts')
    const base = currentCommit(repo.repoPath)

    appendFileSync(path.join(repo.repoPath, 'a.ts'), '// null check\n')
    commitAll(repo.repoPath, 'trivial fix')

    const result = checkScopeCreep(repo.repoPath, base, ['a.ts'])
    expect(result.triggered).toBe(false)
  })

  it('triggers on an unplanned new file', () => {
    repo = createTempGitRepo()
    const base = currentCommit(repo.repoPath)
    writeFileSync(path.join(repo.repoPath, 'b.ts'), 'export const y = 1\n')
    commitAll(repo.repoPath, 'add b.ts')

    const result = checkScopeCreep(repo.repoPath, base, ['a.ts'])
    expect(result.triggered).toBe(true)
    expect(result.newFiles).toEqual(['b.ts'])
  })

  it('does not treat a plan-listed new file as scope creep', () => {
    repo = createTempGitRepo()
    const base = currentCommit(repo.repoPath)
    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
    commitAll(repo.repoPath, 'add a.ts')

    const result = checkScopeCreep(repo.repoPath, base, ['a.ts'])
    expect(result.newFiles).toEqual([])
    expect(result.triggered).toBe(false)
  })

  it('triggers on a new function/branch', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
    commitAll(repo.repoPath, 'add a.ts')
    const base = currentCommit(repo.repoPath)

    appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export function helper() { if (x) { return 1 } }\n')
    commitAll(repo.repoPath, 'sneaky new function')

    const result = checkScopeCreep(repo.repoPath, base, ['a.ts'])
    expect(result.newFunctionOrBranch).toBe(true)
    expect(result.triggered).toBe(true)
  })

  it('triggers on a new JS/TS function declaration with no if/else/branch keyword', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
    commitAll(repo.repoPath, 'add a.ts')
    const base = currentCommit(repo.repoPath)

    appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export function newHelper() { return 1 }\n')
    commitAll(repo.repoPath, 'sneaky new function, no branch')

    const result = checkScopeCreep(repo.repoPath, base, ['a.ts'])
    expect(result.newFunctionOrBranch).toBe(true)
    expect(result.triggered).toBe(true)
  })

  it('triggers when a change touches a file outside the plan', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export const x = 1\n')
    writeFileSync(path.join(repo.repoPath, 'c.ts'), 'export const z = 1\n')
    commitAll(repo.repoPath, 'add a.ts and c.ts')
    const base = currentCommit(repo.repoPath)

    appendFileSync(path.join(repo.repoPath, 'c.ts'), '// touched outside plan\n')
    commitAll(repo.repoPath, 'touch c.ts')

    const result = checkScopeCreep(repo.repoPath, base, ['a.ts'])
    expect(result.outOfPlanFiles).toEqual(['c.ts'])
    expect(result.triggered).toBe(true)
  })
})

describe('checkScopeCreep (AST layer for JS/TS)', () => {
  it('ignores the word "function" in a comment and an unchanged branch, but names new callables and branches', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export function f(x: number) {\n  if (x) return 1\n  return 0\n}\n')
    commitAll(repo.repoPath, 'add a.ts')
    const base = currentCommit(repo.repoPath)

    writeFileSync(path.join(repo.repoPath, 'a.ts'), 'export function f(x: number) {\n  // this function returns 1 for truthy x\n  if (x) return 1\n  return 0\n}\n')
    commitAll(repo.repoPath, 'comment only')
    expect(checkScopeCreep(repo.repoPath, base, ['a.ts']).triggered).toBe(false)

    const mid = currentCommit(repo.repoPath)
    appendFileSync(path.join(repo.repoPath, 'a.ts'), 'export const g = (y: number) => (y ? 1 : 2)\n')
    commitAll(repo.repoPath, 'new arrow fn with a ternary')
    const result = checkScopeCreep(repo.repoPath, mid, ['a.ts'])
    expect(result.newFunctionOrBranch).toBe(true)
    expect(result.reasons).toEqual(['a.ts: new callable g', 'a.ts: new branch in g'])
  })

  it('keeps the keyword regexes for non-JS files', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.py'), 'x = 1\n')
    commitAll(repo.repoPath, 'add a.py')
    const base = currentCommit(repo.repoPath)
    appendFileSync(path.join(repo.repoPath, 'a.py'), 'def helper():\n    return 1\n')
    commitAll(repo.repoPath, 'python fn')
    expect(checkScopeCreep(repo.repoPath, base, ['a.py']).newFunctionOrBranch).toBe(true)
  })
})
