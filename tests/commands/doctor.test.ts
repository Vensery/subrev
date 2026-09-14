import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runDoctor } from '../../src/commands/doctor.js'
import { createTempGitRepo, commitAll, writeExecutableScript } from '../helpers/tempGitRepo.js'

let oldPath = process.env.PATH ?? ''
const cleanups: Array<() => void> = []

afterEach(() => {
  process.env.PATH = oldPath
  while (cleanups.length) cleanups.pop()?.()
})

function fakeBinaryDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'subrev-doctor-bin-'))
  return dir
}

function writeFakeBinary(dir: string, name: string, body: string): void {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(file, 0o755)
}

function codexShim(): string {
  return [
    'if [[ "$1" == "--version" ]]; then echo "codex 1.2.3"; exit 0; fi',
    'if [[ "$1" == "exec" && "$2" == "--help" ]]; then echo "workspace-write"; exit 0; fi',
    'if [[ "$1" == "sandbox" && "$2" == "-c" ]]; then touch "${@: -1}"; exit 0; fi',
    'exit 0',
  ].join('\n')
}

function prepareRepo(): { repoPath: string; archiveRepo: ReturnType<typeof createTempGitRepo> } {
  const repo = createTempGitRepo()
  const archiveRepo = createTempGitRepo()
  cleanups.push(repo.cleanup, archiveRepo.cleanup)
  mkdirSync(path.join(repo.repoPath, 'tools', 'subrev', 'src'), { recursive: true })
  mkdirSync(path.join(repo.repoPath, 'tools', 'subrev', 'dist'), { recursive: true })
  writeFileSync(path.join(repo.repoPath, 'tools', 'subrev', 'src', 'fresh.ts'), 'export const fresh = 1\n')
  writeFileSync(path.join(repo.repoPath, 'tools', 'subrev', 'dist', 'fresh.js'), 'export const fresh = 1;\n')
  commitAll(repo.repoPath, 'add subrev tree')
  return { repoPath: repo.repoPath, archiveRepo }
}

describe('runDoctor', () => {
  it('reports the expected local checks without requiring installed AI binaries', () => {
    const { repoPath, archiveRepo } = prepareRepo()
    const binDir = fakeBinaryDir()
    writeFakeBinary(binDir, 'codex', codexShim())
    writeFakeBinary(binDir, 'claude', 'echo "claude 9.9.9"')
    process.env.PATH = `${binDir}:${oldPath}`

    const configPath = path.join(repoPath, 'projects.json')
    writeFileSync(
      configPath,
      JSON.stringify({ acme: { repos: { main: repoPath }, archiveRepo: archiveRepo.repoPath } }, null, 2)
    )
    writeExecutableScript(repoPath, 'check.sh', 'exit 0')
    writeExecutableScript(repoPath, 'build.sh', 'exit 0')
    writeExecutableScript(repoPath, 'test.sh', 'exit 0')

    const report = runDoctor(repoPath, configPath, { toolRoot: path.join(repoPath, 'tools', 'subrev') })
    expect(report.checks).toHaveLength(10)
    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => check.name)).toEqual([
      'codex binary',
      'claude binary',
      'codex exec sandbox',
      'registered project',
      '.git writable',
      'archive repo',
      'scripts are executable',
      'Node.js major version',
      'dist freshness',
      'codex workspace-write probe',
    ])
    expect(report.checks.find((check) => check.name === 'codex binary')?.detail).toContain('codex 1.2.3')
    expect(report.checks.find((check) => check.name === 'claude binary')?.detail).toContain('claude 9.9.9')
    expect(report.checks.find((check) => check.name === 'codex exec sandbox')?.ok).toBe(true)
    expect(report.checks.find((check) => check.name === 'dist freshness')?.ok).toBe(true)
    expect(existsSync(path.join(repoPath, '.git', '.subrev-doctor-probe'))).toBe(false)
  })

  it('fails dist freshness when source is newer than dist', () => {
    const { repoPath, archiveRepo } = prepareRepo()
    const binDir = fakeBinaryDir()
    writeFakeBinary(binDir, 'codex', codexShim())
    writeFakeBinary(binDir, 'claude', 'echo "claude 9.9.9"')
    process.env.PATH = `${binDir}:${oldPath}`

    const configPath = path.join(repoPath, 'projects.json')
    writeFileSync(configPath, JSON.stringify({ acme: { repos: { main: repoPath }, archiveRepo: archiveRepo.repoPath } }))
    writeExecutableScript(repoPath, 'check.sh', 'exit 0')
    writeExecutableScript(repoPath, 'build.sh', 'exit 0')
    writeExecutableScript(repoPath, 'test.sh', 'exit 0')
    writeFileSync(path.join(repoPath, 'tools', 'subrev', 'src', 'fresh.ts'), 'export const newer = 2\n')

    const report = runDoctor(repoPath, configPath, { toolRoot: path.join(repoPath, 'tools', 'subrev') })
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === 'dist freshness')?.detail).toContain('run npm run build')
  })

  it('reaches the same conclusions from a subdirectory as from the repo root', () => {
    const { repoPath, archiveRepo } = prepareRepo()
    const binDir = fakeBinaryDir()
    writeFakeBinary(binDir, 'codex', codexShim())
    writeFakeBinary(binDir, 'claude', 'echo "claude 9.9.9"')
    process.env.PATH = `${binDir}:${oldPath}`

    const configPath = path.join(repoPath, 'projects.json')
    writeFileSync(
      configPath,
      JSON.stringify({ acme: { repos: { main: repoPath }, archiveRepo: archiveRepo.repoPath } })
    )
    writeExecutableScript(repoPath, 'check.sh', 'exit 0')
    writeExecutableScript(repoPath, 'build.sh', 'exit 0')
    writeExecutableScript(repoPath, 'test.sh', 'exit 0')

    // Regression (found live, invisible to root-anchored tests): project resolution
    // walks UP from a subdirectory, but the repo-scoped checks used to build paths
    // off the raw cwd — passing from the root while failing from tools/subrev.
    const subdir = path.join(repoPath, 'tools', 'subrev', 'src')
    const fromSubdir = runDoctor(subdir, configPath, { toolRoot: path.join(repoPath, 'tools', 'subrev') })
    const fromRoot = runDoctor(repoPath, configPath, { toolRoot: path.join(repoPath, 'tools', 'subrev') })

    expect(fromSubdir.ok).toBe(true)
    for (const name of ['registered project', '.git writable', 'scripts are executable', 'dist freshness']) {
      expect(fromSubdir.checks.find((check) => check.name === name)?.ok).toBe(
        fromRoot.checks.find((check) => check.name === name)?.ok
      )
    }
  })

  it('reports a missing archive repo as a failed check', () => {
    const { repoPath } = prepareRepo()
    const binDir = fakeBinaryDir()
    writeFakeBinary(binDir, 'codex', codexShim())
    writeFakeBinary(binDir, 'claude', 'echo "claude 9.9.9"')
    process.env.PATH = `${binDir}:${oldPath}`

    const configPath = path.join(repoPath, 'projects.json')
    writeFileSync(configPath, JSON.stringify({ acme: { repos: { main: repoPath } } }))
    writeExecutableScript(repoPath, 'check.sh', 'exit 0')
    writeExecutableScript(repoPath, 'build.sh', 'exit 0')
    writeExecutableScript(repoPath, 'test.sh', 'exit 0')

    const report = runDoctor(repoPath, configPath)
    expect(report.checks.find((check) => check.name === 'archive repo')?.ok).toBe(false)
  })

  it('never leaves the .git probe behind on a writable repo failure path', () => {
    const { repoPath, archiveRepo } = prepareRepo()
    const binDir = fakeBinaryDir()
    writeFakeBinary(binDir, 'codex', codexShim())
    writeFakeBinary(binDir, 'claude', 'echo "claude 9.9.9"')
    process.env.PATH = `${binDir}:${oldPath}`

    const configPath = path.join(repoPath, 'projects.json')
    writeFileSync(configPath, JSON.stringify({ acme: { repos: { main: repoPath }, archiveRepo: archiveRepo.repoPath } }))
    writeExecutableScript(repoPath, 'check.sh', 'exit 0')
    writeExecutableScript(repoPath, 'build.sh', 'exit 0')
    writeExecutableScript(repoPath, 'test.sh', 'exit 0')
    const probe = path.join(repoPath, '.git', '.subrev-doctor-probe')
    writeFileSync(probe, 'preexisting probe')

    const report = runDoctor(repoPath, configPath)
    expect(report.checks.find((check) => check.name === '.git writable')?.ok).toBe(true)
    expect(existsSync(probe)).toBe(false)
  })
})
