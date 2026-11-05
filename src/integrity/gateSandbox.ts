// tools/subrev/src/integrity/gateSandbox.ts
//
// The gate runs code the implementer wrote (tests, app code, npm lifecycle scripts). Without a
// sandbox that code runs as you and can rewrite anything subrev later trusts: .git refs, .ai/
// task state, the gate scripts, files in your home directory. Every gate run therefore goes
// through an OS sandbox that allows writes only to:
//   - the repository working tree, EXCEPT .git, .ai and scripts/ (read-only);
//   - temp directories and package-manager caches;
//   - extra paths a human lists in SUBREV_GATE_WRITABLE (path-delimited).
// Reads, process execution and network are not restricted (npm ci needs the network).
//
// Backends: macOS Seatbelt (`sandbox-exec`), Linux bubblewrap (`bwrap`). SUBREV_GATE_SANDBOX:
//   auto (default) — the platform backend; if none is available the gate does NOT run.
//   off            — run unsandboxed; every test log says so. A human's explicit choice.
// When subrev runs inside a gate sandbox already (its own tests run by an outer gate), the outer
// sandbox still confines everything and nesting is not attempted (SUBREV_IN_GATE_SANDBOX).
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type GateSandboxKind = 'seatbelt' | 'bwrap' | 'off' | 'nested'

export interface GateSandbox {
  kind: GateSandboxKind
  /** argv to run `bash <script>` under the sandbox, with the script path left untouched. */
  command(repoPath: string, scriptPath: string): { cmd: string; args: string[] }
  /** One line for test-log.md. */
  describe(repoPath: string): string
}

export const IN_SANDBOX_ENV = 'SUBREV_IN_GATE_SANDBOX'
/** Directories inside the repo that the gate must not write. */
export const PROTECTED_DIRS = ['.git', '.ai', 'scripts']

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function uniq(paths: string[]): string[] {
  return [...new Set(paths.map(real))].filter((p) => existsSync(p))
}

/** Writable roots outside the repo: temp dirs, package caches, and human-listed extras. */
export function writableRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir()
  const roots = [
    os.tmpdir(),
    '/tmp',
    ...(process.platform === 'darwin' ? ['/private/var/folders'] : []),
    path.join(home, '.npm'),
    path.join(home, '.cache'),
    path.join(home, 'Library', 'Caches'),
    path.join(home, '.pnpm-store'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.yarn'),
    ...(env.SUBREV_GATE_WRITABLE ?? '').split(path.delimiter).filter(Boolean),
  ]
  return uniq(roots)
}

export function protectedPaths(repoPath: string): string[] {
  return uniq(PROTECTED_DIRS.map((d) => path.join(repoPath, d)))
}

/**
 * Seatbelt profile: allow everything, then ONE deny rule (so rule order cannot matter) for writes
 * that are outside the allowed set OR inside a protected dir. Protected dirs must be denied on their
 * own, not just carved out of the repo: when the repo itself lives under a writable root (a temp dir,
 * as in tests and eval sandboxes), the temp-dir allowance would otherwise re-allow .git and scripts/.
 * (bwrap gets this for free: the protected read-only binds are mounted last.)
 */
export function seatbeltProfile(nProtected: number, nWritable: number): string {
  const wr = Array.from({ length: nWritable }, (_, i) => `(subpath (param "WR_${i}"))`).join(' ')
  const prot = Array.from({ length: nProtected }, (_, i) => `(subpath (param "PROT_${i}"))`).join(' ')
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*',
    '  (require-any',
    `    (require-not (require-any (subpath (param "REPO")) ${wr} (subpath "/dev")))`,
    `    ${prot}))`,
  ].join('\n')
}

export function seatbeltSandbox(env: NodeJS.ProcessEnv = process.env): GateSandbox {
  return {
    kind: 'seatbelt',
    command(repoPath, scriptPath) {
      const prot = protectedPaths(repoPath)
      const wr = writableRoots(env)
      const params = [
        '-D', `REPO=${real(repoPath)}`,
        ...prot.flatMap((p, i) => ['-D', `PROT_${i}=${p}`]),
        ...wr.flatMap((p, i) => ['-D', `WR_${i}=${p}`]),
      ]
      return { cmd: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(prot.length, wr.length), ...params, 'bash', scriptPath] }
    },
    describe: (repoPath) => `Gate ran under macOS Seatbelt: writable = working tree except ${PROTECTED_DIRS.join(', ')}; temp; package caches${env.SUBREV_GATE_WRITABLE ? '; SUBREV_GATE_WRITABLE' : ''}. (${real(repoPath)})`,
  }
}

/** bwrap: read-only root, then writable roots, then the repo, then protected dirs read-only again (later mounts win). */
export function bwrapArgs(repoPath: string, scriptPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const repo = real(repoPath)
  const args = ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev']
  for (const w of writableRoots(env)) args.push('--bind', w, w)
  args.push('--bind', repo, repo)
  for (const p of protectedPaths(repo)) args.push('--ro-bind', p, p)
  args.push('--chdir', repo, '--', 'bash', scriptPath)
  return args
}

function bwrap(env: NodeJS.ProcessEnv): GateSandbox {
  return {
    kind: 'bwrap',
    command: (repoPath, scriptPath) => ({ cmd: 'bwrap', args: bwrapArgs(repoPath, scriptPath, env) }),
    describe: (repoPath) => `Gate ran under bubblewrap: writable = working tree except ${PROTECTED_DIRS.join(', ')}; temp; package caches${env.SUBREV_GATE_WRITABLE ? '; SUBREV_GATE_WRITABLE' : ''}. (${real(repoPath)})`,
  }
}

const unsandboxed = (kind: 'off' | 'nested', note: string): GateSandbox => ({
  kind,
  command: (_repoPath, scriptPath) => ({ cmd: 'bash', args: [scriptPath] }),
  describe: () => note,
})

function available(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

export class GateSandboxUnavailable extends Error {}

/**
 * Pick the sandbox for this process. Throws GateSandboxUnavailable in auto mode when no backend
 * works: the gate must not silently run unconfined.
 */
export function resolveGateSandbox(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): GateSandbox {
  if (env[IN_SANDBOX_ENV] === '1') {
    return unsandboxed('nested', 'Gate ran inside an outer gate sandbox (subrev running under another subrev gate); no nested sandbox.')
  }
  const mode = env.SUBREV_GATE_SANDBOX ?? 'auto'
  if (mode === 'off') {
    return unsandboxed('off', '⚠ Gate ran UNSANDBOXED (SUBREV_GATE_SANDBOX=off): code it executed could write anywhere you can.')
  }
  if (mode !== 'auto') throw new GateSandboxUnavailable(`SUBREV_GATE_SANDBOX must be auto or off, got "${mode}"`)
  if (platform === 'darwin' && available('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])) return seatbeltSandbox(env)
  if (platform === 'linux' && available('bwrap', ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', 'true'])) return bwrap(env)
  throw new GateSandboxUnavailable(
    `No gate sandbox available on ${platform} (macOS needs /usr/bin/sandbox-exec, Linux needs bubblewrap). ` +
      'The gate runs implementer-written code, so it is not run unconfined. Install the backend, or set ' +
      'SUBREV_GATE_SANDBOX=off to accept running it unsandboxed.'
  )
}

/** Environment for the sandboxed process: marks it so a subrev started inside does not nest. */
export function sandboxedEnv(sandbox: GateSandbox, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return sandbox.kind === 'seatbelt' || sandbox.kind === 'bwrap' ? { ...env, [IN_SANDBOX_ENV]: '1' } : env
}

/**
 * Run a probe under the sandbox this process would use for the gate: a write inside the working
 * tree must succeed; writes to .git, .ai, scripts/ and the given outside directory must fail.
 */
export function probeGateSandbox(repoPath: string, outsideDir: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; detail: string } {
  let sandbox: GateSandbox
  try {
    sandbox = resolveGateSandbox(env)
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
  if (sandbox.kind === 'off') return { ok: false, detail: sandbox.describe(repoPath) }
  if (sandbox.kind === 'nested') return { ok: true, detail: sandbox.describe(repoPath) }
  const repo = real(repoPath)
  const name = `.subrev-gate-probe-${process.pid}`
  const targets = {
    inside: path.join(repo, name),
    git: path.join(repo, '.git', name),
    ai: path.join(repo, '.ai', name),
    scripts: path.join(repo, 'scripts', name),
    outside: path.join(real(outsideDir), name),
  }
  const script = path.join(os.tmpdir(), `${name}.sh`)
  const body = Object.entries(targets)
    .map(([k, t]) => `if touch ${JSON.stringify(t)} 2>/dev/null; then echo "${k}=written"; else echo "${k}=denied"; fi`)
    .join('\n')
  try {
    writeFileSync(script, body + '\n')
    const { cmd, args } = sandbox.command(repo, script)
    const out = execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', env: sandboxedEnv(sandbox, env) })
    const seen = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')))
    const wrong = [
      ...(seen.inside !== 'written' ? ['could not write inside the working tree'] : []),
      ...(['git', 'ai', 'scripts', 'outside'] as const).filter((k) => seen[k] !== 'denied').map((k) => `could write ${targets[k]}`),
    ]
    return wrong.length
      ? { ok: false, detail: `${sandbox.kind}: ${wrong.join('; ')}` }
      : { ok: true, detail: `${sandbox.kind}: working tree writable; .git, .ai, scripts/ and ${real(outsideDir)} denied` }
  } catch (error) {
    return { ok: false, detail: `${sandbox.kind} probe failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    for (const t of [...Object.values(targets), script]) rmSync(t, { force: true })
  }
}
