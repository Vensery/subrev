import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
  } catch (err) {
    // Skip leading global options (e.g. `-c color.ui=false`) so the reported
    // subcommand names the actual git operation (`git diff`, `git checkout`, ...).
    let i = 0
    while (args[i] === '-c') i += 2
    const subcommand = `git ${args[i] ?? ''}`.trim()
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to run "${subcommand}" in repo "${repoPath}": ${reason}`)
  }
}

export function isWorkingTreeDirty(repoPath: string): boolean {
  return git(repoPath, ['status', '--porcelain']).trim().length > 0
}

export function currentBranch(repoPath: string): string {
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

export function currentCommit(repoPath: string): string {
  return git(repoPath, ['rev-parse', 'HEAD']).trim()
}

export function createTaskBranch(repoPath: string, branch: string): void {
  git(repoPath, ['checkout', '-b', branch])
}

export function commitAllChanges(repoPath: string, message: string): void {
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '-m', message])
}

export function checkoutBranch(repoPath: string, branch: string): void {
  git(repoPath, ['checkout', branch])
}

export function diffStatNewFiles(repoPath: string, base: string): string[] {
  return git(repoPath, [
    '-c',
    'color.ui=false',
    'diff',
    '--diff-filter=A',
    '--name-only',
    `${base}...HEAD`,
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function diffChangedFiles(repoPath: string, base: string): string[] {
  return git(repoPath, ['-c', 'color.ui=false', 'diff', '--name-only', `${base}...HEAD`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function diffAddedLines(repoPath: string, base: string): string[] {
  return git(repoPath, ['-c', 'color.ui=false', 'diff', '-U0', `${base}...HEAD`])
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
}

export function diffText(repoPath: string, base: string): string {
  return git(repoPath, ['-c', 'color.ui=false', 'diff', `${base}...HEAD`])
}

export function writeDiffSnapshot(
  repoPath: string,
  base: string,
  outDir: string,
  filename = 'final-diff.patch'
): string {
  const patch = diffText(repoPath, base)
  const outPath = path.join(outDir, filename)
  writeFileSync(outPath, patch, 'utf8')
  return outPath
}
