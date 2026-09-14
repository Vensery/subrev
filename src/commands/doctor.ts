import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProjectsConfig, resolveRepoFromCwd } from '../config.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorReport {
  checks: Array<DoctorCheck>
  ok: boolean
}

function safeVersion(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `unavailable: ${reason}`
  }
}

function binaryCheck(name: string, cmd: string): DoctorCheck {
  try {
    const version = safeVersion(cmd, ['--version'])
    return { name, ok: !version.startsWith('unavailable:'), detail: version }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name, ok: false, detail: reason }
  }
}

function codexSandboxCheck(): DoctorCheck {
  try {
    const help = execFileSync('codex', ['exec', '--help'], { encoding: 'utf8' })
    const ok = help.includes('workspace-write')
    return {
      name: 'codex exec sandbox',
      ok,
      detail: ok ? 'codex exec --help mentions workspace-write' : 'codex exec --help does not mention workspace-write',
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name: 'codex exec sandbox', ok: false, detail: reason }
  }
}

function codexWorkspaceWriteProbe(repoPath: string): DoctorCheck {
  const probe = path.join(repoPath, '.subrev-doctor-probe')
  try {
    rmSync(probe, { force: true })
    // cwd MUST be repoPath, mirroring exactly how codexExec spawns codex: the
    // sandbox's writable workspace root is codex's own cwd (observed live — run
    // from a subdirectory, a probe at the repo root is outside the sandbox and
    // fails with "Operation not permitted" even under workspace-write).
    const result = execFileSync('codex', ['sandbox', '-c', 'sandbox_mode="workspace-write"', 'touch', probe], {
      encoding: 'utf8',
      cwd: repoPath,
    })
    const ok = existsSync(probe)
    return {
      name: 'codex workspace-write probe',
      ok,
      detail: ok ? 'codex sandbox created the probe file' : `codex sandbox exited successfully but did not create ${probe}: ${result.trim()}`,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name: 'codex workspace-write probe', ok: false, detail: reason }
  } finally {
    rmSync(probe, { force: true })
  }
}

function gitWritableCheck(repoPath: string): DoctorCheck {
  const probe = path.join(repoPath, '.git', '.subrev-doctor-probe')
  try {
    writeFileSync(probe, 'probe', 'utf8')
    rmSync(probe, { force: true })
    return { name: '.git writable', ok: true, detail: 'created and removed .git/.subrev-doctor-probe' }
  } catch (error) {
    rmSync(probe, { force: true })
    const reason = error instanceof Error ? error.message : String(error)
    return { name: '.git writable', ok: false, detail: reason }
  }
}

function resolvedProjectCheck(
  cwd: string,
  configPath?: string
): { ok: boolean; detail: string; project?: string; repoPath?: string } {
  try {
    const config = loadProjectsConfig(configPath)
    const resolved = resolveRepoFromCwd(cwd, config)
    if (!resolved) return { ok: false, detail: 'cwd is not inside a registered project repo' }
    return {
      ok: true,
      detail: `${resolved.project}/${resolved.repoKey} -> ${resolved.repoPath}`,
      project: resolved.project,
      repoPath: resolved.repoPath,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: reason }
  }
}

function archiveRepoCheck(cwd: string, configPath?: string): DoctorCheck {
  try {
    const config = loadProjectsConfig(configPath)
    const resolved = resolveRepoFromCwd(cwd, config)
    if (!resolved) return { name: 'archive repo', ok: false, detail: 'cwd is not inside a registered project repo' }
    const archiveRepo = config[resolved.project]?.archiveRepo
    if (!archiveRepo) return { name: 'archive repo', ok: false, detail: `No archiveRepo configured for project "${resolved.project}"` }
    if (!existsSync(archiveRepo)) return { name: 'archive repo', ok: false, detail: `archiveRepo does not exist: ${archiveRepo}` }
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: archiveRepo, encoding: 'utf8' })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { name: 'archive repo', ok: false, detail: `archiveRepo is not a git repository: ${reason}` }
    }
    return { name: 'archive repo', ok: true, detail: archiveRepo }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { name: 'archive repo', ok: false, detail: reason }
  }
}

function executableCheck(name: string, scriptPath: string): DoctorCheck {
  try {
    accessSync(scriptPath, constants.X_OK)
    return { name, ok: true, detail: 'executable' }
  } catch {
    return { name, ok: false, detail: `missing or not executable: ${scriptPath}` }
  }
}

function nodeVersionCheck(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0] ?? '0')
  return { name: 'Node.js major version', ok: major >= 20, detail: process.versions.node }
}

/**
 * Where THIS subrev installation lives — derived from the compiled module's own
 * location (dist/commands/doctor.js -> ../../ = the tools/subrev root), NOT from
 * the target repo. The dist-freshness question is about the running tool being
 * stale, and the target repo need not contain subrev at all.
 */
function defaultToolRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function distFreshnessCheck(toolRoot: string): DoctorCheck {
  const srcRoot = path.join(toolRoot, 'src')
  const distRoot = path.join(toolRoot, 'dist')
  let newestSrc = 0
  let newestDist = 0

  const walk = (dir: string, predicate: (filePath: string) => boolean, seen: (mtimeMs: number) => void): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(fullPath, predicate, seen)
      else if (predicate(fullPath)) seen(statSync(fullPath).mtimeMs)
    }
  }

  walk(srcRoot, (filePath) => filePath.endsWith('.ts'), (mtime) => { newestSrc = Math.max(newestSrc, mtime) })
  walk(distRoot, (filePath) => filePath.endsWith('.js'), (mtime) => { newestDist = Math.max(newestDist, mtime) })

  if (!newestDist) {
    return { name: 'dist freshness', ok: false, detail: `${distRoot} is missing or empty; run npm run build` }
  }
  if (newestSrc > newestDist) {
    return { name: 'dist freshness', ok: false, detail: `${distRoot} is stale; run npm run build` }
  }
  return { name: 'dist freshness', ok: true, detail: 'dist is up to date' }
}

export function runDoctor(cwd: string, configPath?: string, opts?: { toolRoot?: string }): DoctorReport {
  const checks: DoctorCheck[] = []
  checks.push(binaryCheck('codex binary', 'codex'))
  checks.push(binaryCheck('claude binary', 'claude'))
  checks.push(codexSandboxCheck())

  const cwdResolved = resolvedProjectCheck(cwd, configPath)
  checks.push({ name: 'registered project', ok: cwdResolved.ok, detail: cwdResolved.detail })

  // Every repo-scoped check anchors on the RESOLVED repo root, not the raw cwd —
  // doctor run from a subdirectory must reach the same conclusions as from the
  // repo root (project resolution already walks up; the checks must follow it).
  // If resolution failed, fall back to cwd so the checks still report something.
  const repoPath = cwdResolved.repoPath ?? cwd
  checks.push(gitWritableCheck(repoPath))
  checks.push(archiveRepoCheck(cwd, configPath))
  const scriptChecks = ['check.sh', 'build.sh', 'test.sh'].map((name) =>
    executableCheck(`scripts/${name}`, path.join(repoPath, 'scripts', name))
  )
  checks.push({
    name: 'scripts are executable',
    ok: scriptChecks.every((check) => check.ok),
    detail: scriptChecks.map((check) => `${check.name}: ${check.detail}`).join('; '),
  })
  checks.push(nodeVersionCheck())
  checks.push(distFreshnessCheck(opts?.toolRoot ?? defaultToolRoot()))
  checks.push(codexWorkspaceWriteProbe(repoPath))

  return { checks, ok: checks.every((check) => check.ok) }
}
