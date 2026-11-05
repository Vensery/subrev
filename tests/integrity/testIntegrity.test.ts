import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { testStats, checkTestIntegrity } from '../../src/integrity/testIntegrity.js'
import { createTempGitRepo, commitAll, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit } from '../../src/git.js'

let repo: TempRepo
afterEach(() => repo?.cleanup())

const SUITE = `import { describe, it, expect } from 'vitest'
describe('limit', () => {
  it('accepts 10', () => {
    expect(allowed(10)).toBe(true)
    expect(parse('10')).toEqual({ n: 10 })
  })
  it('rejects 11', () => {
    expect(allowed(11)).toBe(false)
  })
})
`

function seed(file = 'src/limit.test.ts', text = SUITE): string {
  repo = createTempGitRepo()
  write(file, text)
  commitAll(repo.repoPath, 'tests')
  return currentCommit(repo.repoPath)
}
function write(file: string, text: string): void {
  mkdirSync(path.dirname(path.join(repo.repoPath, file)), { recursive: true })
  writeFileSync(path.join(repo.repoPath, file), text)
}
function change(file: string, text: string): ReturnType<typeof checkTestIntegrity> {
  const base = currentCommit(repo.repoPath)
  write(file, text)
  commitAll(repo.repoPath, 'change')
  return checkTestIntegrity(repo.repoPath, base)
}

describe('testStats', () => {
  it('counts cases, skips, focus, assertions and matcher strength from the AST, not from text', () => {
    const s = testStats(
      `// it('commented out', () => {})
it('a', () => { expect(x).toEqual(1); expect(y).toBeDefined() })
it.each([1, 2])('b %s', (n) => { expect(n).not.toBe(0) })
it.skip('c', () => {})
xit('d', () => {})
it.todo('e')
test.only('f', () => { expect(() => g()).toThrow() })
describe.skip('g', () => {})
expect.assertions(1)
`,
      'x.test.ts'
    )
    expect(s).toEqual({ cases: 3, skipped: 4, focused: 1, assertions: 4, strongMatchers: 1, weakMatchers: 3, tautologies: 0 })
  })

  it('spots assertions that compare a value with itself or two literals', () => {
    expect(testStats(`it('t', () => { expect(f(1)).toBe(f(1)); expect(true).toBe(true); expect(f(1)).toBe(2) })`, 'a.test.ts').tautologies).toBe(2)
  })

  it('falls back to patterns for pytest files', () => {
    expect(testStats('def test_a():\n    assert f() == 1\n\n@pytest.mark.skip\ndef test_b():\n    pass\n', 'tests/test_x.py')).toMatchObject({ cases: 2, skipped: 1, assertions: 1 })
  })
})

describe('checkTestIntegrity', () => {
  it('flags a deleted test case', () => {
    seed()
    const r = change('src/limit.test.ts', SUITE.replace(/  it\('rejects 11'[\s\S]*?\n  \}\)\n/, ''))
    expect(r.flagged).toBe(true)
    expect(r.findings).toContain('src/limit.test.ts: test cases 2 → 1')
    expect(r.findings).toContain('src/limit.test.ts: assertions 3 → 2')
  })

  it('flags a new skip and a new .only', () => {
    seed()
    expect(change('src/limit.test.ts', SUITE.replace("it('rejects 11'", "it.skip('rejects 11'")).findings).toContain('src/limit.test.ts: skipped/todo tests 0 → 1')
    expect(change('src/limit.test.ts', SUITE.replace("it('accepts 10'", "it.only('accepts 10'")).findings.join('\n')).toContain('.only 0 → 1')
  })

  it('flags a strong matcher swapped for a weak one, and a tautology, even when the counts stay equal', () => {
    seed()
    const weaker = change('src/limit.test.ts', SUITE.replace("expect(parse('10')).toEqual({ n: 10 })", "expect(parse('10')).toBeDefined()"))
    expect(weaker.findings.join('\n')).toContain('specific matchers 3 → 2 (weak matchers 0 → 1)')
    expect(weaker.findings.join('\n')).toContain('1 assertion line(s) removed or rewritten')

    const tautology = change('src/limit.test.ts', SUITE.replace('expect(allowed(11)).toBe(false)', 'expect(allowed(11)).toBe(allowed(11))'))
    expect(tautology.findings.join('\n')).toContain('comparing a value with itself or two literals 0 → 1')
  })

  it('flags a deleted test file', () => {
    seed()
    const base = currentCommit(repo.repoPath)
    rmSync(path.join(repo.repoPath, 'src/limit.test.ts'))
    commitAll(repo.repoPath, 'delete')
    expect(checkTestIntegrity(repo.repoPath, base).findings).toEqual(['src/limit.test.ts: test file deleted (had 2 case(s), 3 assertion(s))'])
  })

  it('does not flag added tests or stronger assertions added alongside existing ones', () => {
    seed()
    const r = change('src/limit.test.ts', SUITE.replace("  it('rejects 11'", "  it('rejects 12', () => {\n    expect(allowed(12)).toBe(false)\n  })\n  it('rejects 11'"))
    expect(r.flagged).toBe(false)
    expect(r.files).toHaveLength(1)
  })

  it('ignores non-test files', () => {
    seed()
    const r = change('src/limit.ts', 'export const LIMIT = 5\n')
    expect(r.files).toEqual([])
  })
})
