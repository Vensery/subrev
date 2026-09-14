import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export interface TempRepo {
  repoPath: string
  cleanup: () => void
}

export function createTempGitRepo(): TempRepo {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath })
  writeFileSync(path.join(repoPath, 'README.md'), '# test repo\n')
  // Mirrors a real host repo's expected topology: .ai/ is gitignored entirely, so subrev's own
  // per-task bookkeeping under .ai/tasks/** never shows up in `git status`/`git diff` output in
  // production, and a plain `git add -A` never sweeps it into a commit. Without this, every temp
  // repo the test suite creates would diverge from that topology and make subrev's own
  // uncommitted bookkeeping files look like real, trackable changes.
  writeFileSync(path.join(repoPath, '.gitignore'), '.ai/\n')
  execFileSync('git', ['add', '.'], { cwd: repoPath })
  execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repoPath })
  return { repoPath, cleanup: () => rmSync(repoPath, { recursive: true, force: true }) }
}

export function writeExecutableScript(repoPath: string, name: string, body: string): void {
  const scriptsDir = path.join(repoPath, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  const scriptPath = path.join(scriptsDir, name)
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(scriptPath, 0o755)
}

export function commitAll(repoPath: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: repoPath })
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repoPath })
}
