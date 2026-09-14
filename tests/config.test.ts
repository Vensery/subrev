import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadProjectsConfig,
  resolveRepoFromCwd,
  resolveArchiveRepo,
  type ProjectsConfig,
} from '../src/config.js'

let tmpDir: string

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

function writeConfig(config: ProjectsConfig): string {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'subrev-config-'))
  const configPath = path.join(tmpDir, 'projects.json')
  writeFileSync(configPath, JSON.stringify(config))
  return configPath
}

describe('loadProjectsConfig', () => {
  it('throws a clear error when the config file is missing', () => {
    expect(() => loadProjectsConfig('/nonexistent/projects.json')).toThrow(/not found/)
  })

  it('parses a valid config file', () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-repo-'))
    const configPath = writeConfig({ acme: { repos: { main: repoPath } } })
    const config = loadProjectsConfig(configPath)
    expect(config.acme.repos.main).toBe(repoPath)
    rmSync(repoPath, { recursive: true, force: true })
  })
})

describe('resolveRepoFromCwd', () => {
  it('matches a cwd nested inside a registered repo path', () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-repo-'))
    mkdirSync(path.join(repoPath, 'src'))
    const config: ProjectsConfig = { acme: { repos: { main: repoPath } } }
    const resolved = resolveRepoFromCwd(path.join(repoPath, 'src'), config)
    expect(resolved).toEqual({ project: 'acme', repoKey: 'main', repoPath })
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('returns null when cwd matches nothing', () => {
    const config: ProjectsConfig = { acme: { repos: { main: '/some/other/path' } } }
    expect(resolveRepoFromCwd('/unrelated/dir', config)).toBeNull()
  })
})

describe('resolveArchiveRepo', () => {
  it('returns the configured archive repo path', () => {
    const config: ProjectsConfig = {
      acme: { repos: { main: '/x' }, archiveRepo: '/archive' },
    }
    expect(resolveArchiveRepo('acme', config)).toBe('/archive')
  })

  it('throws when no archiveRepo is configured', () => {
    const config: ProjectsConfig = { acme: { repos: { main: '/x' } } }
    expect(() => resolveArchiveRepo('acme', config)).toThrow(/No archiveRepo/)
  })
})
