import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createTempGitRepo, commitAll, writeExecutableScript, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit, isWorkingTreeDirty } from '../../src/git.js'
import { gitDiffZeroContext, parseUnifiedDiff } from '../../src/scope/diff.js'
import { groupHunks } from '../../src/scope/groups.js'
import { runRevertAblation } from '../../src/scope/ablation.js'

let repo: TempRepo
afterEach(() => repo?.cleanup())

function setup(): string {
  repo = createTempGitRepo()
  writeFileSync(path.join(repo.repoPath, 'lib.js'), 'export function add(a, b) {\n  return 0\n}\n\nexport function label() {\n  return "x"\n}\n')
  // The gate only checks add(); label() is not covered by any test.
  writeExecutableScript(repo.repoPath, 'check.sh', 'exit 0')
  writeExecutableScript(repo.repoPath, 'build.sh', 'exit 0')
  writeExecutableScript(repo.repoPath, 'test.sh', 'node --input-type=module -e "import { add } from \'./lib.js\'; if (add(2, 3) !== 5) { console.error(\'FAIL adds two numbers\'); process.exit(1) }"')
  commitAll(repo.repoPath, 'base')
  const base = currentCommit(repo.repoPath)
  writeFileSync(path.join(repo.repoPath, 'lib.js'), 'export function add(a, b) {\n  return a + b\n}\n\nexport function label() {\n  return "y"\n}\n')
  writeFileSync(path.join(repo.repoPath, 'extra.js'), 'export const telemetry = true\n')
  commitAll(repo.repoPath, 'implement')
  return base
}

describe('runRevertAblation', () => {
  it('marks a change load-bearing only when reverting it turns the gate red, and restores HEAD', () => {
    const base = setup()
    const groups = groupHunks(repo.repoPath, parseUnifiedDiff(gitDiffZeroContext(repo.repoPath, base)))
    const report = runRevertAblation(repo.repoPath, groups, {
      acceptance: [{ id: 'AC-1', text: 'adds numbers', tests: ['adds two numbers'], implicit: false }],
    })
    expect(report.ran).toBe(true)
    const bySymbol = Object.fromEntries(groups.map((g) => [g.symbol, report.results.find((r) => r.group === g.id)!]))
    expect(bySymbol.add.loadBearing).toBe(true)
    expect(bySymbol.add.implicatedAcs).toEqual(['AC-1'])
    expect(bySymbol.label.loadBearing).toBe(false)
    expect(bySymbol['(new file)'].loadBearing).toBe(false)
    expect(report.gateRuns).toBe(4)
    expect(isWorkingTreeDirty(repo.repoPath)).toBe(false)
    expect(readFileSync(path.join(repo.repoPath, 'lib.js'), 'utf8')).toContain('return a + b')
    expect(existsSync(path.join(repo.repoPath, 'extra.js'))).toBe(true)
  })

  it('skips when the gate is already red at HEAD, and respects the revert budget', () => {
    const base = setup()
    const groups = groupHunks(repo.repoPath, parseUnifiedDiff(gitDiffZeroContext(repo.repoPath, base)))
    expect(runRevertAblation(repo.repoPath, groups, { gate: () => ({ passed: false, output: '' }) }).ran).toBe(false)
    const limited = runRevertAblation(repo.repoPath, groups, { maxGroups: 1 })
    expect(limited.results.filter((r) => r.loadBearing === null)).toHaveLength(2)
  })
})

describe('runRevertAblation at symbol level', () => {
  it('reverts a new function appended right after a rewritten one without leaving a stray brace', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'lib.js'), 'export function add(a, b) {\n  return 0\n}\n')
    writeExecutableScript(repo.repoPath, 'check.sh', 'exit 0')
    writeExecutableScript(repo.repoPath, 'build.sh', 'exit 0')
    writeExecutableScript(repo.repoPath, 'test.sh', 'node --input-type=module -e "import { add } from \'./lib.js\'; if (add(2, 3) !== 5) process.exit(1)"')
    commitAll(repo.repoPath, 'base')
    const base = currentCommit(repo.repoPath)
    // git aligns the old closing brace with the new function's brace, so a hunk-level revert of
    // formatBytes alone would break the file.
    writeFileSync(path.join(repo.repoPath, 'lib.js'), 'export function add(a, b) {\n  const s = a + b\n  return s\n}\n\nexport function formatBytes(n) {\n  return n + " B"\n}\n')
    commitAll(repo.repoPath, 'implement')
    const groups = groupHunks(repo.repoPath, parseUnifiedDiff(gitDiffZeroContext(repo.repoPath, base)))
    const report = runRevertAblation(repo.repoPath, groups, { baseRev: base })
    const by = Object.fromEntries(groups.map((g) => [g.symbol, report.results.find((r) => r.group === g.id)!.loadBearing]))
    expect(by).toEqual({ add: true, formatBytes: false })
    expect(isWorkingTreeDirty(repo.repoPath)).toBe(false)
  })
})

