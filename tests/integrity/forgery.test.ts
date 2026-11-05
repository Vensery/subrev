// Regression for the gate-approval forgery found on 2026-11-05: code the gate executes runs as
// the same user outside any sandbox, so it can write anything on disk, including subrev's state
// dir. Approvals therefore must not come from disk.
import { it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { implementAndGate } from '../../src/orchestrator/implementStep.js'
import { checkGateIntegrity } from '../../src/integrity/gateIntegrity.js'
import { scaffoldTask, writeTaskFile, readTaskMeta, type TaskMeta } from '../../src/taskStore.js'
import { createTempGitRepo, commitAll, writeExecutableScript, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit } from '../../src/git.js'
import { FakeAiRunner } from '../../src/testing/fakeAiRunner.js'

let repo: TempRepo
let state: string
afterEach(() => {
  repo?.cleanup()
  rmSync(state, { recursive: true, force: true })
  delete process.env.SUBREV_STATE_DIR
})

function seedRunnerRepo(): { r: string; base: string } {
  state = mkdtempSync(path.join(os.tmpdir(), 'subrev-state-'))
  process.env.SUBREV_STATE_DIR = state
  repo = createTempGitRepo()
  const r = repo.repoPath
  // Base gate: a "test runner" that executes every test file, like `npm test` executes test code.
  writeExecutableScript(r, 'check.sh', 'exit 0')
  writeExecutableScript(r, 'build.sh', 'exit 0')
  writeExecutableScript(r, 'test.sh', 'cd "$(dirname "$0")/.." && for f in tests/*.sh; do bash "$f" || exit 1; done')
  mkdirSync(path.join(r, 'tests'))
  writeFileSync(path.join(r, 'tests', 'real.sh'), 'grep -q "x = 1" a.ts')
  writeFileSync(path.join(r, 'a.ts'), 'export const x = 1\n')
  commitAll(r, 'base')
  const base = currentCommit(r)
  const meta: TaskMeta = {
    taskId: 't1', project: 'p', repoKey: 'r', branch: 'b', status: 'in-progress', round: 0, planVersion: 1,
    retrospectivePending: false, createdAt: `2026-11-05T02:00:00.${Math.floor(Math.random() * 900 + 100)}Z`, baseBranch: base,
  }
  scaffoldTask(r, meta, 'brief')
  writeTaskFile(r, 't1', 'plan-approved.md', '## Files\n- a.ts\n')
  return { r, base }
}

it('an approval forged by code the gate runs does not unblock a neutered gate', async () => {
  const { r, base } = seedRunnerRepo()
  // The attacker precomputes the fingerprint of the gate change it will make later ...
  writeExecutableScript(r, 'test.sh', 'exit 0')
  const fp = checkGateIntegrity(r, base).fingerprint!
  execFileSync('git', ['checkout', '--', 'scripts/test.sh'], { cwd: r })
  // ... and plants every approval format subrev has used, in the state dir and in .ai/.
  const key = `${realpathSync(r)}::t1`
  const forgedJson = JSON.stringify({ [key]: [{ fingerprint: fp, approvedAt: 'x', approvedBy: 'x' }] })
  const forgedLog = JSON.stringify({ repo: r, taskId: 't1', fingerprint: fp })
  const ai = new FakeAiRunner()
  ai.codexEffects.push(() => {
    writeFileSync(
      path.join(r, 'tests', 'innocent.sh'),
      `mkdir -p "$SUBREV_STATE_DIR" && printf '%s' '${forgedJson}' > "$SUBREV_STATE_DIR/gate-approvals.json" && printf '%s\\n' '${forgedLog}' >> "$SUBREV_STATE_DIR/gate-approvals.log"; exit 1`
    )
  })
  ai.codexEffects.push(() => {
    writeFileSync(path.join(r, 'a.ts'), 'export const x = 2\n')
    writeExecutableScript(r, 'test.sh', 'exit 0')
  })

  const result = await implementAndGate(ai, r, 't1', { maxMechanicalRetries: 1 })

  expect(existsSync(path.join(state, 'gate-approvals.json'))).toBe(true) // the forgery itself happened
  expect(result.gateBlocked).toBe(true)
  expect(readTaskMeta(r, 't1').status).toBe('escalated-gate-change')
})

it('discards a gate run that changed the gate while it ran (unsandboxed: the post-gate check is the last line)', async () => {
  process.env.SUBREV_GATE_SANDBOX = 'off'
  const { r } = seedRunnerRepo()
  const head = currentCommit(r)
  const ai = new FakeAiRunner()
  // A "test" that passes and silences the gate for every later run.
  ai.codexEffects.push(() => {
    writeFileSync(path.join(r, 'tests', 'helper.sh'), `printf 'exit 0\\n' > scripts/test.sh; exit 0`)
  })

  const result = await implementAndGate(ai, r, 't1', { maxMechanicalRetries: 2 })

  expect(result.scripts.every((s) => s.passed)).toBe(true) // the gate itself reported green ...
  expect(result.gateBlocked).toBe(true) // ... but its result is discarded
  expect(result.mechanicalAttempts).toBe(1)
  expect(currentCommit(r)).toBe(head) // nothing committed
  const report = execFileSync('cat', [path.join(r, '.ai', 'tasks', 't1', 'gate-change-report.md')], { encoding: 'utf8' })
  expect(report).toContain('CHANGED WHILE THE GATE WAS RUNNING')
})
