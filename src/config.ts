import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface ProjectsConfig {
  [project: string]: {
    repos: { [repoKey: string]: string }
    archiveRepo?: string
  }
}

export interface ResolvedRepo {
  project: string
  repoKey: string
  repoPath: string
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.subrev', 'projects.json')
}

export function loadProjectsConfig(configPath: string = defaultConfigPath()): ProjectsConfig {
  if (!existsSync(configPath)) {
    throw new Error(`subrev config not found at ${configPath}. Create it with project/repo paths.`)
  }
  const raw = readFileSync(configPath, 'utf8')
  return JSON.parse(raw) as ProjectsConfig
}

export function resolveRepoFromCwd(cwd: string, config: ProjectsConfig): ResolvedRepo | null {
  const normalizedCwd = path.resolve(cwd)
  for (const [project, { repos }] of Object.entries(config)) {
    for (const [repoKey, repoPath] of Object.entries(repos)) {
      const normalizedRepoPath = path.resolve(repoPath)
      if (normalizedCwd === normalizedRepoPath || normalizedCwd.startsWith(normalizedRepoPath + path.sep)) {
        return { project, repoKey, repoPath: normalizedRepoPath }
      }
    }
  }
  return null
}

export function resolveArchiveRepo(project: string, config: ProjectsConfig): string {
  const archiveRepo = config[project]?.archiveRepo
  if (!archiveRepo) {
    throw new Error(`No archiveRepo configured for project "${project}" in ~/.subrev/projects.json`)
  }
  return archiveRepo
}
