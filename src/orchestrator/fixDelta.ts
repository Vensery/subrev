// tools/subrev/src/orchestrator/fixDelta.ts
//
// What a fix changed since the last review, computed from git alone (never from the
// implementer's own report). Used to decide whether the fix must be re-reviewed and to
// show a human exactly what moved after the reviewer last looked.
import { diffText } from '../git.js'
import { gitDiffZeroContext, parseUnifiedDiff } from '../scope/diff.js'
import { groupHunks } from '../scope/groups.js'

/**
 * Paths that count as tests. Everything else, including config, migrations, prompts and
 * docs, counts as non-test: a fix that touches any of it gets re-reviewed. Erring towards
 * "non-test" costs one extra review; erring the other way lets an unreviewed change through.
 */
const TEST_PATH_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
]

export function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERNS.some((p) => p.test(filePath))
}

export interface FixFile {
  path: string
  status: 'added' | 'deleted' | 'modified'
  kind: 'test' | 'code'
  added: number
  removed: number
}

export interface FixDelta {
  base: string
  files: FixFile[]
  nonTestFiles: string[]
  /** "file :: symbol" for every changed declaration in a non-test file. */
  codeSymbols: string[]
  patch: string
}

export function analyzeFix(repoPath: string, base: string): FixDelta {
  const fileDiffs = parseUnifiedDiff(gitDiffZeroContext(repoPath, base))
  const files: FixFile[] = fileDiffs.map((f) => {
    let added = 0
    let removed = 0
    for (const h of f.hunks) {
      for (const line of h.lines) {
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) removed += 1
      }
    }
    return { path: f.path, status: f.status, kind: isTestPath(f.path) ? 'test' : 'code', added, removed }
  })
  const nonTestFiles = files.filter((f) => f.kind === 'code').map((f) => f.path)
  let codeSymbols: string[] = []
  try {
    codeSymbols = groupHunks(repoPath, fileDiffs.filter((f) => !isTestPath(f.path)))
      .filter((g) => !g.binary)
      .map((g) => `${g.file} :: ${g.symbol}`)
  } catch {
    // Symbol grouping is a reading aid only; the file list above is what decisions use.
  }
  return { base, files, nonTestFiles, codeSymbols: [...new Set(codeSymbols)], patch: diffText(repoPath, base) }
}

export function renderFixSummary(
  round: number,
  delta: FixDelta,
  decision: { reReview: boolean; reasons: string[] }
): string {
  const lines = [
    `# Fix after review round ${round}`,
    '',
    `Diff window: \`${delta.base.slice(0, 12)}..HEAD\` (only what this fix changed). Full patch: \`fix-round-${round}.patch\`.`,
    '',
    `Decision: **${decision.reReview ? 're-review forced' : 'not re-reviewed'}**`,
    ...decision.reasons.map((r) => `- ${r}`),
    '',
    '## Files',
    '',
    '| File | Kind | Status | +/- |',
    '| --- | --- | --- | --- |',
    ...delta.files.map((f) => `| ${f.path} | ${f.kind} | ${f.status} | +${f.added} / -${f.removed} |`),
  ]
  if (delta.codeSymbols.length) {
    lines.push('', '## Changed declarations in non-test files', '', ...delta.codeSymbols.map((s) => `- ${s}`))
  }
  return lines.join('\n') + '\n'
}
