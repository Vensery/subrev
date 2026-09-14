import { describe, it, expect, afterEach } from 'vitest'
import { createTempGitRepo, writeExecutableScript, type TempRepo } from './helpers/tempGitRepo.js'
import { runAllScripts, allGreen, formatTestLog } from '../src/scripts.js'

let repo: TempRepo

afterEach(() => repo?.cleanup())

describe('runAllScripts', () => {
  it('reports missing scripts as failures', () => {
    repo = createTempGitRepo()
    const results = runAllScripts(repo.repoPath)
    expect(allGreen(results)).toBe(false)
    expect(results.every((r) => r.output.includes('missing script'))).toBe(true)
  })

  it('runs check/build/test.sh and reports pass/fail per script', () => {
    repo = createTempGitRepo()
    writeExecutableScript(repo.repoPath, 'check.sh', 'echo checking; exit 0')
    writeExecutableScript(repo.repoPath, 'build.sh', 'echo building; exit 1')
    writeExecutableScript(repo.repoPath, 'test.sh', 'echo testing; exit 0')

    const results = runAllScripts(repo.repoPath)
    expect(allGreen(results)).toBe(false)
    const build = results.find((r) => r.name === 'build.sh')
    expect(build?.passed).toBe(false)
    expect(build?.output).toContain('building')

    const log = formatTestLog(results)
    expect(log).toContain('check.sh — PASS')
    expect(log).toContain('build.sh — FAIL')
  })

  it('reports all green when every script exits 0', () => {
    repo = createTempGitRepo()
    for (const name of ['check.sh', 'build.sh', 'test.sh']) {
      writeExecutableScript(repo.repoPath, name, 'exit 0')
    }
    expect(allGreen(runAllScripts(repo.repoPath))).toBe(true)
  })
})
