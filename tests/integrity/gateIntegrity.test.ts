import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkGateIntegrity } from '../../src/integrity/gateIntegrity.js'
import { showGate, confirmGateApproval } from '../../src/commands/approveGate.js'
import { implementAndGate } from '../../src/orchestrator/implementStep.js'
import { scaffoldTask, writeTaskFile, readTaskMeta, readTaskFile, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, installControllableGate, setGate, writeExecutableScript, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit, isWorkingTreeDirty } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo
let stateDir: string
let base: string
let seq = 0

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'subrev-state-'))
  process.env.SUBREV_STATE_DIR = stateDir
})
afterEach(() => {
  repo?.cleanup()
  rmSync(stateDir, { recursive: true, force: true })
  delete process.env.SUBREV_STATE_DIR
})

function seed(planFiles = '- a.ts'): TaskMeta {
  repo = createTempGitRepo()
  installControllableGate(repo.repoPath)
  writeFileSync(path.join(repo.repoPath, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run', build: 'tsc' }, dependencies: { a: '1' } }, null, 2))
  commitAll(repo.repoPath, 'package.json')
  base = currentCommit(repo.repoPath)
  seq += 1
  const meta: TaskMeta = {
    taskId: 't1', project: 'p', repoKey: 'r', branch: 'task/t1', status: 'in-progress', round: 0, planVersion: 1,
    retrospectivePending: false, createdAt: `2026-11-05T00:00:${String(seq).padStart(2, '0')}.000Z`, baseBranch: base,
  }
  scaffoldTask(repo.repoPath, meta, 'brief')
  writeTaskFile(repo.repoPath, meta.taskId, 'plan-approved.md', `## Files\n${planFiles}\n\n## Acceptance criteria\n\n- AC-1: thing\n`)
  return meta
}
const write = (f: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo.repoPath, f)), { recursive: true })
  writeFileSync(path.join(repo.repoPath, f), text)
}
const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: 'x', scripts: { test: 'vitest run', build: 'tsc' }, dependencies: { a: '1' }, ...extra }, null, 2)

describe('checkGateIntegrity', () => {
  it('reports nothing when the gate matches the base', () => {
    seed()
    write('a.ts', 'export const x = 1\n')
    expect(checkGateIntegrity(repo.repoPath, base)).toMatchObject({ changes: [], fingerprint: null })
  })

  it('catches an uncommitted edit to a gate script, an untracked runner config and a deleted script', () => {
    seed()
    writeExecutableScript(repo.repoPath, 'test.sh', 'exit 0')
    write('apps/web/vitest.config.ts', 'export default { test: { include: [] } }\n')
    rmSync(path.join(repo.repoPath, 'scripts', 'check.sh'))
    const r = checkGateIntegrity(repo.repoPath, base)
    expect(r.changes.map((c) => [c.path, c.kind, c.status])).toEqual([
      ['apps/web/vitest.config.ts', 'test-config', 'added'],
      ['scripts/check.sh', 'gate-script', 'deleted'],
      ['scripts/test.sh', 'gate-script', 'modified'],
    ])
    expect(r.changes.find((c) => c.path === 'scripts/test.sh')!.detail).toContain('+exit 0')
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('looks only at test fields of package.json', () => {
    seed()
    write('package.json', pkg({ dependencies: { a: '2', b: '1' } }))
    expect(checkGateIntegrity(repo.repoPath, base).changes).toEqual([])

    write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run --passWithNoTests', build: 'tsc' } }))
    const r = checkGateIntegrity(repo.repoPath, base)
    expect(r.changes.map((c) => [c.path, c.kind])).toEqual([['package.json', 'package-json-test-fields']])
    expect(r.changes[0].detail).toContain('--passWithNoTests')

    write('package.json', pkg({ jest: { testPathIgnorePatterns: ['.*'] } }))
    expect(checkGateIntegrity(repo.repoPath, base).changes).toHaveLength(1)

    write('package.json', '{ not json')
    expect(checkGateIntegrity(repo.repoPath, base).changes[0].detail).toContain('UNPARSEABLE')
  })

  it('ignores gitignored files and gives a new fingerprint for every new version of a change', () => {
    seed()
    write('.gitignore', '.ai/\n.gate-exit\nnode_modules/\n')
    commitAll(repo.repoPath, 'ignore node_modules')
    base = currentCommit(repo.repoPath)
    write('node_modules/lib/package.json', JSON.stringify({ scripts: { test: 'echo' } }))
    expect(checkGateIntegrity(repo.repoPath, base).changes).toEqual([])
    writeExecutableScript(repo.repoPath, 'test.sh', 'exit 0')
    const first = checkGateIntegrity(repo.repoPath, base).fingerprint
    writeExecutableScript(repo.repoPath, 'test.sh', 'true')
    expect(checkGateIntegrity(repo.repoPath, base).fingerprint).not.toBe(first)
  })
})

describe('implementAndGate with a changed gate', () => {
  const neuterGate = () => {
    write('a.ts', 'export const x = 1\n')
    setGate(repo.repoPath, false) // the real tests fail ...
    writeExecutableScript(repo.repoPath, 'test.sh', 'exit 0') // ... so the implementer silences test.sh
  }

  it('blocks before running the gate and commits nothing, even when the plan lists the script', async () => {
    const meta = seed('- a.ts\n- scripts/test.sh')
    const head = currentCommit(repo.repoPath)
    const ai = new FakeAiRunner()
    ai.codexEffects.push(neuterGate)

    const result = await implementAndGate(ai, repo.repoPath, meta.taskId, { maxMechanicalRetries: 2 })

    expect(result.gateBlocked).toBe(true)
    expect(result.mechanicalAttempts).toBe(1) // no retries: a human decides
    expect(result.scripts).toEqual([]) // the gate never ran
    expect(currentCommit(repo.repoPath)).toBe(head)
    expect(isWorkingTreeDirty(repo.repoPath)).toBe(true)
    const m = readTaskMeta(repo.repoPath, meta.taskId)
    expect(m.status).toBe('escalated-gate-change')
    const report = readTaskFile(repo.repoPath, meta.taskId, 'gate-change-report.md')!
    expect(report).toContain(`Fingerprint: \`${m.gateChangeFingerprint}\``)
    expect(report).toContain('| scripts/test.sh | gate-script | modified | yes |')
    expect(report).toContain('plan does not approve a gate change')
    expect(report).toContain(`subrev resume t1 --approve-gate ${m.gateChangeFingerprint}`)
  })

  it('runs the gate only with an approval given to that run, never from anything on disk', async () => {
    const meta = seed()
    const ai = new FakeAiRunner()
    ai.codexEffects.push(neuterGate)
    await implementAndGate(ai, repo.repoPath, meta.taskId, { maxMechanicalRetries: 2 })
    const fp = readTaskMeta(repo.repoPath, meta.taskId).gateChangeFingerprint!

    // Showing the change approves nothing; a wrong fingerprint is refused before anything runs.
    expect(showGate(repo.repoPath, meta.taskId).fingerprint).toBe(fp)
    expect(() => confirmGateApproval(repo.repoPath, meta.taskId, '0000000000000000')).toThrow(/does not match/)

    // Confirming writes an audit entry, but a later run without the fingerprint is still blocked:
    // nothing on disk grants an approval.
    expect(confirmGateApproval(repo.repoPath, meta.taskId, fp)).toBe(fp)
    expect(readFileSync(path.join(stateDir, 'gate-approvals.log'), 'utf8')).toContain(fp)
    expect(readTaskFile(repo.repoPath, meta.taskId, 'decision-log.md')).toContain(`human approved gate change ${fp}`)
    const noFlag = new FakeAiRunner()
    noFlag.codexEffects.push(() => {})
    expect((await implementAndGate(noFlag, repo.repoPath, meta.taskId, { maxMechanicalRetries: 0 })).gateBlocked).toBe(true)

    // With the approval held by the run, the gate runs: the edited test.sh passes, the untouched check.sh still fails.
    const approved = new FakeAiRunner()
    approved.codexEffects.push(() => {})
    const ok = await implementAndGate(approved, repo.repoPath, meta.taskId, { maxMechanicalRetries: 0, approvedGateFingerprint: fp })
    expect(ok.gateBlocked).toBeFalsy()
    expect(ok.scripts.map((s) => [s.name, s.passed])).toEqual([['check.sh', false], ['build.sh', false], ['test.sh', true]])
    expect(readTaskFile(repo.repoPath, meta.taskId, 'test-log.md')).toContain(`under human approval ${fp} given on this run's command line`)

    // Any further edit to the gate is a different change: the old approval does not cover it.
    const again = new FakeAiRunner()
    again.codexEffects.push(() => { writeExecutableScript(repo.repoPath, 'test.sh', 'true'); write('a.ts', 'export const x = 2\n') })
    expect((await implementAndGate(again, repo.repoPath, meta.taskId, { maxMechanicalRetries: 0, approvedGateFingerprint: fp })).gateBlocked).toBe(true)
  })

  it('fails closed when the task has no base to compare with', async () => {
    const meta = seed()
    const m = readTaskMeta(repo.repoPath, meta.taskId)
    delete m.baseBranch
    const { writeTaskMeta } = await import('../../src/taskStore.js')
    writeTaskMeta(repo.repoPath, m)
    const ai = new FakeAiRunner()
    ai.codexEffects.push(() => write('a.ts', 'x\n'))
    await expect(implementAndGate(ai, repo.repoPath, meta.taskId, { maxMechanicalRetries: 0 })).rejects.toThrow(/no baseBranch/)
  })
})
