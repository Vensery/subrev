import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveGateSandbox,
  seatbeltSandbox,
  seatbeltProfile,
  bwrapArgs,
  probeGateSandbox,
  writableRoots,
  GateSandboxUnavailable,
} from '../../src/integrity/gateSandbox.js'
import { implementAndGate } from '../../src/orchestrator/implementStep.js'
import { scaffoldTask, writeTaskFile, readTaskFile, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, writeExecutableScript, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo | undefined
let outside: string | undefined
const savedSandbox = process.env.SUBREV_GATE_SANDBOX
afterEach(() => {
  repo?.cleanup()
  repo = undefined
  if (outside) rmSync(outside, { recursive: true, force: true })
  outside = undefined
  if (savedSandbox === undefined) delete process.env.SUBREV_GATE_SANDBOX
  else process.env.SUBREV_GATE_SANDBOX = savedSandbox
})

/** A real backend is usable here (not nested inside another gate sandbox). */
const backend = (() => {
  try {
    return resolveGateSandbox({ ...process.env, SUBREV_GATE_SANDBOX: 'auto' }).kind
  } catch {
    return null
  }
})()
const realSandbox = backend === 'seatbelt' || backend === 'bwrap'

/** A directory outside every writable root: next to this test run, not under temp. */
function outsideDir(): string | null {
  const dir = mkdtempSync(path.join(process.cwd(), '.sbx-outside-'))
  if (writableRoots().some((r) => dir === r || dir.startsWith(r + path.sep))) {
    rmSync(dir, { recursive: true, force: true })
    return null
  }
  return dir
}

describe('resolveGateSandbox', () => {
  it('honours off, refuses unknown modes, and never nests', () => {
    expect(resolveGateSandbox({ SUBREV_GATE_SANDBOX: 'off' }).kind).toBe('off')
    expect(resolveGateSandbox({ SUBREV_GATE_SANDBOX: 'off' }).describe('/r')).toContain('UNSANDBOXED')
    expect(() => resolveGateSandbox({ SUBREV_GATE_SANDBOX: 'maybe' })).toThrow(/auto or off/)
    expect(resolveGateSandbox({ SUBREV_IN_GATE_SANDBOX: '1', SUBREV_GATE_SANDBOX: 'auto' }).kind).toBe('nested')
  })

  it('fails closed in auto mode when the platform has no backend', () => {
    expect(() => resolveGateSandbox({ SUBREV_GATE_SANDBOX: 'auto' }, 'win32')).toThrow(GateSandboxUnavailable)
  })
})

describe('backend arguments', () => {
  it('Seatbelt: one deny rule over everything outside repo-minus-protected, temp and caches; script run in place', () => {
    const profile = seatbeltProfile(3, 2)
    expect(profile.match(/\(deny /g)).toHaveLength(1)
    expect(profile).toContain('(require-not (require-any (subpath (param "REPO")) (subpath (param "WR_0")) (subpath (param "WR_1")) (subpath "/dev")))')
    // Protected dirs are denied on their own, outside the require-not: a repo under a writable temp
    // root must not get .git / scripts back through the temp allowance (the bug found on macOS).
    const protLine = profile.split('\n').find((l) => l.includes('PROT_0'))!
    expect(protLine.trim()).toBe('(subpath (param "PROT_0")) (subpath (param "PROT_1")) (subpath (param "PROT_2"))))')

    repo = createTempGitRepo()
    mkdirSync(path.join(repo.repoPath, '.ai'))
    mkdirSync(path.join(repo.repoPath, 'scripts'))
    const script = path.join(repo.repoPath, 'scripts', 'test.sh')
    const { cmd, args } = seatbeltSandbox({}).command(repo.repoPath, script)
    expect(cmd).toBe('/usr/bin/sandbox-exec')
    expect(args.slice(-2)).toEqual(['bash', script])
    const params = args.filter((a) => /^(REPO|PROT_\d+)=/.test(a))
    expect(params.some((p) => p.endsWith('/.git'))).toBe(true)
    expect(params.some((p) => p.endsWith('/.ai'))).toBe(true)
    expect(params.some((p) => p.endsWith('/scripts'))).toBe(true)
  })

  it('bwrap: read-only root, writable roots, the repo, then protected dirs read-only again', () => {
    repo = createTempGitRepo()
    mkdirSync(path.join(repo.repoPath, 'scripts'))
    const script = path.join(repo.repoPath, 'scripts', 'test.sh')
    const args = bwrapArgs(repo.repoPath, script, {})
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/'])
    const repoBind = args.findIndex((a, i) => a === '--bind' && args[i + 2]?.endsWith(path.basename(repo!.repoPath)))
    const gitRo = args.findIndex((a, i) => a === '--ro-bind' && args[i + 1]?.endsWith('/.git'))
    expect(repoBind).toBeGreaterThan(0)
    expect(gitRo).toBeGreaterThan(repoBind)
    expect(args.slice(-3)).toEqual(['--', 'bash', script])
  })
})

describe.skipIf(!realSandbox)(`real gate sandbox (${backend})`, () => {
  it('probe: working tree writable; .git, .ai, scripts/ and outside paths denied', () => {
    repo = createTempGitRepo()
    mkdirSync(path.join(repo.repoPath, '.ai'))
    mkdirSync(path.join(repo.repoPath, 'scripts'))
    outside = outsideDir() ?? undefined
    if (!outside) return
    const result = probeGateSandbox(repo.repoPath, outside, { ...process.env, SUBREV_GATE_SANDBOX: 'auto' })
    expect(result).toMatchObject({ ok: true })
  })

  it('a gate script cannot rewrite the gate, git state or task state, and the scripts still find the repo', async () => {
    process.env.SUBREV_GATE_SANDBOX = 'auto'
    repo = createTempGitRepo()
    const r = repo.repoPath
    writeExecutableScript(r, 'check.sh', 'exit 0')
    writeExecutableScript(r, 'build.sh', 'exit 0')
    // The "tests" are implementer code. This one tries to cover its tracks, then passes.
    writeExecutableScript(r, 'test.sh', 'cd "$(dirname "$0")/.." && for f in tests/*.sh; do bash "$f" || exit 1; done')
    mkdirSync(path.join(r, 'tests'))
    writeFileSync(path.join(r, 'tests', 'real.sh'), 'grep -q "x = 1" a.ts')
    writeFileSync(path.join(r, 'a.ts'), 'export const x = 1\n')
    commitAll(r, 'base')
    const base = currentCommit(r)
    const meta: TaskMeta = {
      taskId: 't1', project: 'p', repoKey: 'r', branch: 'b', status: 'in-progress', round: 0, planVersion: 1,
      retrospectivePending: false, createdAt: `2026-11-05T03:00:00.${Math.floor(Math.random() * 900 + 100)}Z`, baseBranch: base,
    }
    scaffoldTask(r, meta, 'brief')
    writeTaskFile(r, 't1', 'plan-approved.md', '## Files\n- a.ts\n')
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => {
      writeFileSync(path.join(r, 'tests', 'helper.sh'), [
        `printf 'exit 0\\n' > scripts/test.sh 2>/dev/null || echo "scripts denied" >> sandbox-results.txt`,
        `touch .git/refs/heads/evil 2>/dev/null || echo "git denied" >> sandbox-results.txt`,
        `echo hacked >> .ai/tasks/t1/meta.md 2>/dev/null || echo "ai denied" >> sandbox-results.txt`,
        `echo "nested=$SUBREV_IN_GATE_SANDBOX" >> sandbox-results.txt`,
        'exit 0',
      ].join('\n'))
    })

    const result = await implementAndGate(ai, r, 't1', { maxMechanicalRetries: 0 })

    expect(result.gateBlocked).toBeFalsy()
    expect(result.scripts.every((s) => s.passed)).toBe(true)
    expect(readFileSync(path.join(r, 'sandbox-results.txt'), 'utf8').split('\n').filter(Boolean)).toEqual([
      'scripts denied', 'git denied', 'ai denied', 'nested=1',
    ])
    expect(readFileSync(path.join(r, 'scripts', 'test.sh'), 'utf8')).toContain('for f in tests/*.sh')
    expect(existsSync(path.join(r, '.git', 'refs', 'heads', 'evil'))).toBe(false)
    expect(readFileSync(path.join(r, '.ai', 'tasks', 't1', 'meta.md'), 'utf8')).not.toContain('hacked')
    expect(readTaskFile(r, 't1', 'test-log.md')).toMatch(/Gate ran under (bubblewrap|macOS Seatbelt)/)
  })
})
