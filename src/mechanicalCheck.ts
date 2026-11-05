import { execFileSync } from 'node:child_process'
import { diffStatNewFiles, diffChangedFiles } from './git.js'
import { gitDiffZeroContext, hunkAddedText, parseUnifiedDiff } from './scope/diff.js'
import { showFile } from './scope/groups.js'
import { collectSymbols, compareSymbols, isJsLike } from './scope/symbols.js'

/**
 * Layer 1 of the scope check: cheap, deterministic, deliberately over-sensitive. When it fires,
 * layer 2 (scope/layer2.ts) or a forced re-review decides whether the change is actually out of
 * scope; a false positive here costs one extra pass, a false negative lets creep through.
 *
 * JS/TS files are compared at the AST level (new callables, new branches in a symbol), so the
 * word "function" in a comment or an existing `if` that merely moved no longer fires. Every
 * other language keeps the original keyword regexes over added lines.
 */
const FUNCTION_KEYWORDS = [
  /\bfun\s+\w+/,
  /\bfunc\s+\w+/,
  /\bfunc\s*\(/,
  /\bdef\s+\w+/,
  /\bfunction\b/,
  /=>\s*\{/,
]
const BRANCH_KEYWORDS = [/\bif\s*\(/, /\belse\b/, /\bwhen\s*\(/, /\bswitch\s*\(/, /\bcase\b/]

export interface ScopeCheckResult {
  newFiles: string[]
  newFunctionOrBranch: boolean
  outOfPlanFiles: string[]
  triggered: boolean
  /** Human-readable reasons, one per signal, e.g. "a.ts: new callable sneaky". */
  reasons: string[]
}

function mergeBase(repoPath: string, base: string): string {
  try {
    return execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
  } catch {
    return base
  }
}

export function checkScopeCreep(repoPath: string, base: string, planFiles: string[]): ScopeCheckResult {
  const rawNewFiles = diffStatNewFiles(repoPath, base)
  const newFiles = planFiles.length === 0 ? rawNewFiles : rawNewFiles.filter((f) => !planFiles.includes(f))

  const reasons: string[] = []
  const oldRev = mergeBase(repoPath, base)
  let newFunctionOrBranch = false
  for (const file of parseUnifiedDiff(gitDiffZeroContext(repoPath, base))) {
    if (file.binary || file.status === 'deleted') continue
    if (isJsLike(file.path)) {
      const after = showFile(repoPath, 'HEAD', file.path) ?? ''
      const before = file.status === 'added' ? '' : showFile(repoPath, oldRev, file.path) ?? ''
      const signals = compareSymbols(collectSymbols(before, file.path), collectSymbols(after, file.path))
      for (const name of signals.newCallables) reasons.push(`${file.path}: new callable ${name}`)
      for (const name of signals.branchIncreases) reasons.push(`${file.path}: new branch in ${name}`)
      if (signals.newCallables.length || signals.branchIncreases.length) newFunctionOrBranch = true
    } else {
      const added = file.hunks.map(hunkAddedText).join('\n').split('\n')
      const hit = added.find((line) => [...FUNCTION_KEYWORDS, ...BRANCH_KEYWORDS].some((p) => p.test(line)))
      if (hit !== undefined) {
        newFunctionOrBranch = true
        reasons.push(`${file.path}: function/branch keyword in added line "${hit.trim().slice(0, 60)}"`)
      }
    }
  }

  const changedFiles = diffChangedFiles(repoPath, base)
  const outOfPlanFiles = planFiles.length === 0 ? [] : changedFiles.filter((file) => !planFiles.includes(file))
  for (const f of newFiles) reasons.push(`${f}: new file not listed in the plan`)
  for (const f of outOfPlanFiles) if (!newFiles.includes(f)) reasons.push(`${f}: changed file not listed in the plan`)

  const triggered = newFiles.length > 0 || newFunctionOrBranch || outOfPlanFiles.length > 0
  return { newFiles, newFunctionOrBranch, outOfPlanFiles, triggered, reasons }
}
