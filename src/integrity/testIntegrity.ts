// tools/subrev/src/integrity/testIntegrity.ts
//
// Static check for tests that got weaker between two commits: deleted test files, fewer test
// cases, new skip/only/todo, fewer assertions, strong matchers swapped for weak ones, and
// assertion lines that were removed or rewritten. Every finding forces a review and is shown
// to the reviewer and the human. It is a heuristic: a tautology like expect(f(x)).toBe(f(x))
// or an assertion moved into a helper can get past it, so it narrows the gap, it does not close it.
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { gitDiffZeroContext, parseUnifiedDiff } from '../scope/diff.js'
import { showFile } from '../scope/groups.js'
import { isJsLike } from '../scope/symbols.js'
import { isTestPath } from '../orchestrator/fixDelta.js'

export interface TestStats {
  cases: number
  skipped: number
  focused: number
  assertions: number
  strongMatchers: number
  weakMatchers: number
  tautologies: number
}

export interface TestFileReport {
  path: string
  status: 'added' | 'deleted' | 'modified'
  before: TestStats | null
  after: TestStats | null
  removedAssertionLines: number
  findings: string[]
}

export interface TestIntegrityReport {
  base: string
  files: TestFileReport[]
  flagged: boolean
  findings: string[]
}

const EMPTY: TestStats = { cases: 0, skipped: 0, focused: 0, assertions: 0, strongMatchers: 0, weakMatchers: 0, tautologies: 0 }

const CASE_ROOTS = new Set(['it', 'test', 'specify'])
const SKIP_ROOTS = new Set(['xit', 'xtest', 'xdescribe', 'xspecify'])
const WEAK_MATCHERS = new Set(['toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toHaveBeenCalled', 'toBeInstanceOf'])
const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual'])

function chain(e: ts.Expression): string[] {
  if (ts.isIdentifier(e)) return [e.text]
  if (ts.isPropertyAccessExpression(e)) return [...chain(e.expression), e.name.text]
  if (ts.isCallExpression(e)) return [...chain(e.expression), '()']
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) return chain(e.expression)
  return ['?']
}

/** The argument of the expect(...) call at the root of a matcher chain. */
function expectArg(e: ts.Expression): ts.Expression | undefined {
  let cur: ts.Expression = e
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === 'expect') return cur.arguments[0]
    cur = cur.expression
  }
  return undefined
}

const isLiteral = (n: ts.Node) =>
  ts.isLiteralExpression(n) || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword

function jsStats(source: string, fileName: string): TestStats {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : /\.[cm]?ts$/i.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const s = { ...EMPTY }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = chain(n.expression)
      const root = c[0]
      if (CASE_ROOTS.has(root) || root === 'describe') {
        if (c.includes('skip') || c.includes('todo')) s.skipped += 1
        else if (c.includes('only')) {
          s.focused += 1
          if (root !== 'describe') s.cases += 1
        } else if (root !== 'describe') {
          // it.each(table)('name', fn): count the outer call only.
          if (!c.includes('each') || c[c.length - 1] === '()') s.cases += 1
        }
      } else if (SKIP_ROOTS.has(root)) {
        s.skipped += 1
      } else if (root === 'expect' && c.length === 1) {
        s.assertions += 1
      } else if (root === 'assert') {
        s.assertions += 1
      } else if (root === 'expect' && c[1] === '()' && c.length > 2) {
        const matcher = c[c.length - 1]
        if (matcher.startsWith('to')) {
          const negated = c.includes('not')
          const noArgThrow = matcher === 'toThrow' && n.arguments.length === 0
          if (negated || noArgThrow || WEAK_MATCHERS.has(matcher)) s.weakMatchers += 1
          else s.strongMatchers += 1
          if (!negated && EQUALITY_MATCHERS.has(matcher) && n.arguments[0]) {
            const actual = expectArg(n.expression)
            const expected = n.arguments[0]
            if (actual && (actual.getText(sf) === expected.getText(sf) || (isLiteral(actual) && isLiteral(expected)))) s.tautologies += 1
          }
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return s
}

/** Fallback for non-JS tests (pytest/unittest style). */
function regexStats(source: string): TestStats {
  const count = (re: RegExp) => (source.match(re) ?? []).length
  return {
    ...EMPTY,
    cases: count(/^\s*(async\s+)?def\s+test_\w*/gm),
    skipped: count(/@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\(|@unittest\.skip/g),
    assertions: count(/^\s*assert\b|\bself\.assert\w+\(/gm),
  }
}

export function testStats(source: string, filePath: string): TestStats {
  return isJsLike(filePath) ? jsStats(source, filePath) : regexStats(source)
}

const ASSERTION_LINE = /\bexpect\s*\(|\bassert(\.\w+)?\s*\(|^\s*assert\b|\bself\.assert\w+\(/

function mergeBase(repoPath: string, base: string): string {
  try {
    return execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
  } catch {
    return base
  }
}

function compare(path: string, before: TestStats | null, after: TestStats | null, removedAssertionLines: number): string[] {
  const out: string[] = []
  const b = before ?? EMPTY
  const a = after ?? EMPTY
  if (before && !after) {
    out.push(`${path}: test file deleted (had ${b.cases} case(s), ${b.assertions} assertion(s))`)
    return out
  }
  if (a.cases < b.cases) out.push(`${path}: test cases ${b.cases} → ${a.cases}`)
  if (a.skipped > b.skipped) out.push(`${path}: skipped/todo tests ${b.skipped} → ${a.skipped}`)
  if (a.focused > b.focused) out.push(`${path}: .only ${b.focused} → ${a.focused} (other tests stop running)`)
  if (a.assertions < b.assertions) out.push(`${path}: assertions ${b.assertions} → ${a.assertions}`)
  if (a.strongMatchers < b.strongMatchers) {
    out.push(`${path}: specific matchers ${b.strongMatchers} → ${a.strongMatchers} (weak matchers ${b.weakMatchers} → ${a.weakMatchers})`)
  }
  if (a.tautologies > b.tautologies) out.push(`${path}: assertions comparing a value with itself or two literals ${b.tautologies} → ${a.tautologies}`)
  if (removedAssertionLines > 0) out.push(`${path}: ${removedAssertionLines} assertion line(s) removed or rewritten — check the new version is not weaker`)
  return out
}

/** Compare every test file changed in `base...HEAD`. */
export function checkTestIntegrity(repoPath: string, base: string): TestIntegrityReport {
  const oldRev = mergeBase(repoPath, base)
  const files: TestFileReport[] = []
  for (const f of parseUnifiedDiff(gitDiffZeroContext(repoPath, base))) {
    if (f.binary || !isTestPath(f.path)) continue
    const beforeSrc = f.status === 'added' ? null : showFile(repoPath, oldRev, f.oldPath ?? f.path)
    const afterSrc = f.status === 'deleted' ? null : showFile(repoPath, 'HEAD', f.newPath ?? f.path)
    const before = beforeSrc === null ? null : testStats(beforeSrc, f.path)
    const after = afterSrc === null ? null : testStats(afterSrc, f.path)
    const removedAssertionLines =
      f.status === 'modified'
        ? f.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith('-') && ASSERTION_LINE.test(l.slice(1))).length
        : 0
    const findings = compare(f.path, before, after, removedAssertionLines)
    files.push({ path: f.path, status: f.status, before, after, removedAssertionLines, findings })
  }
  const findings = files.flatMap((f) => f.findings)
  return { base, files, flagged: findings.length > 0, findings }
}

export function renderTestIntegrityReport(title: string, report: TestIntegrityReport): string {
  const stat = (s: TestStats | null) =>
    s ? `${s.cases} / ${s.skipped} / ${s.assertions} / ${s.strongMatchers}:${s.weakMatchers}` : '—'
  const lines = [
    `# Test integrity — ${title}`,
    '',
    `Diff window: \`${report.base.slice(0, 12)}...HEAD\`. Static check: it can miss weakening it has no rule for (e.g. a tautology through a helper).`,
    '',
    `Result: **${report.flagged ? 'FLAGGED — review forced' : 'nothing flagged'}**`,
    ...report.findings.map((f) => `- ${f}`),
  ]
  if (report.files.length) {
    lines.push(
      '',
      '| Test file | Status | cases / skipped / assertions / specific:weak (before) | (after) |',
      '| --- | --- | --- | --- |',
      ...report.files.map((f) => `| ${f.path} | ${f.status} | ${stat(f.before)} | ${stat(f.after)} |`)
    )
  }
  return lines.join('\n') + '\n'
}
