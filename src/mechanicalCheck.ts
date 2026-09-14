import { diffStatNewFiles, diffAddedLines, diffChangedFiles } from './git.js'

// `function` covers JS/TS declarations and expressions (subrev's own codebase, and the
// most likely language of the target repo). `=>\s*{` covers arrow functions with a block
// body. Both are deliberately broad: per the spec, a false positive here just means an
// extra review pass, which is the cheap, acceptable direction — under-detection is not.
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
}

export function checkScopeCreep(repoPath: string, base: string, planFiles: string[]): ScopeCheckResult {
  const rawNewFiles = diffStatNewFiles(repoPath, base)
  const newFiles = planFiles.length === 0 ? rawNewFiles : rawNewFiles.filter((f) => !planFiles.includes(f))

  const addedLines = diffAddedLines(repoPath, base)
  const newFunctionOrBranch = addedLines.some((line) =>
    [...FUNCTION_KEYWORDS, ...BRANCH_KEYWORDS].some((pattern) => pattern.test(line))
  )

  const changedFiles = diffChangedFiles(repoPath, base)
  const outOfPlanFiles = planFiles.length === 0 ? [] : changedFiles.filter((file) => !planFiles.includes(file))

  const triggered = newFiles.length > 0 || newFunctionOrBranch || outOfPlanFiles.length > 0
  return { newFiles, newFunctionOrBranch, outOfPlanFiles, triggered }
}
