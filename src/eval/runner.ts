import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentAdapter,
  AgentUsage,
  AttemptRecord,
  Outcome,
  PipelineOutcome,
  StageUsage,
  TaskBundle,
  TrialResult,
} from './types.js'

const OUTPUT_TAIL_CHARS = 2000

export interface GateResult {
  passed: boolean
  output: string
  ms: number
}

export function runGate(cwd: string, command: string, timeoutMs: number): GateResult {
  const started = Date.now()
  const result = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', timeout: timeoutMs })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  return {
    passed: result.status === 0 && !timedOut,
    output: timedOut ? `${output}\n[gate timed out after ${timeoutMs}ms]` : output,
    ms: Date.now() - started,
  }
}

/** Content hash of every file under the given paths, keyed by posix-style relative path. */
export function snapshotPaths(root: string, relPaths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (abs: string, rel: string): void => {
    if (!existsSync(abs)) return
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(path.join(abs, name), path.posix.join(rel, name))
    } else {
      out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'))
    }
  }
  for (const rel of relPaths) walk(path.join(root, rel), rel.split(path.sep).join('/'))
  return out
}

/** Files that were changed, removed, or added between two snapshots. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort()
}

export function buildPrompt(bundle: TaskBundle, attempt: number, lastGateOutput?: string): string {
  const { spec } = bundle
  const constraints =
    `\n\nConstraints:\n- Verify your work by running: ${spec.gate}\n` +
    (spec.protectedPaths.length
      ? `- Do NOT modify, add, or delete anything under: ${spec.protectedPaths.join(', ')}\n`
      : '')
  if (attempt === 1 || lastGateOutput === undefined) return spec.prompt + constraints
  const tail = lastGateOutput.slice(-OUTPUT_TAIL_CHARS)
  return (
    `${spec.prompt}${constraints}\nYour previous attempt did not pass the gate. Gate output (tail):\n\n${tail}\n\n` +
    `Fix the implementation so the gate passes.`
  )
}

function sumUsage(items: Array<AgentUsage | undefined>): AgentUsage | null {
  const present = items.filter((u): u is AgentUsage => u !== undefined)
  if (present.length === 0) return null
  const total: AgentUsage = {}
  for (const u of present) {
    for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
      if (u[key] !== undefined) total[key] = (total[key] ?? 0) + (u[key] as number)
    }
  }
  return total
}

export function sumStages(lists: Array<StageUsage[] | undefined>): StageUsage[] | undefined {
  const present = lists.filter((l): l is StageUsage[] => Array.isArray(l))
  if (present.length === 0) return undefined
  const byStage = new Map<string, StageUsage>()
  for (const list of present) {
    for (const s of list) {
      const t = byStage.get(s.stage) ?? { stage: s.stage, calls: 0, ms: 0 }
      t.calls += s.calls
      t.ms += s.ms
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
        if (s[key] !== undefined) t[key] = (t[key] ?? 0) + (s[key] as number)
      }
      byStage.set(s.stage, t)
    }
  }
  return [...byStage.values()]
}

function initSandbox(bundle: TaskBundle, trial: number): string {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), `subrev-eval-${bundle.spec.id}-${trial}-`))
  cpSync(bundle.fixtureDir, sandbox, { recursive: true })
  const git = (...args: string[]) => spawnSync('git', args, { cwd: sandbox, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'eval@subrev.local')
  git('config', 'user.name', 'subrev-eval')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  return sandbox
}

export interface RunTrialOptions {
  runId: string
  keepSandbox?: boolean
}

export async function runTrial(
  bundle: TaskBundle,
  adapter: AgentAdapter,
  trial: number,
  options: RunTrialOptions
): Promise<TrialResult> {
  const { spec } = bundle
  const startedAt = new Date()
  const sandbox = initSandbox(bundle, trial)
  const protectedBefore = snapshotPaths(sandbox, spec.protectedPaths)
  const attempts: AttemptRecord[] = []
  let outcome: Outcome = 'fail'
  let tampered: string[] = []
  let lastGateOutput: string | undefined
  let pipeline: PipelineOutcome | undefined
  // A pipeline adapter spends the attempt budget internally; calling it again with gate output
  // would give it a second, uncounted retry loop.
  const attemptBudget = adapter.ownsRetries ? 1 : spec.maxAttempts

  try {
    for (let attempt = 1; attempt <= attemptBudget; attempt++) {
      const record: AttemptRecord = { attempt, agentMs: 0, gateMs: 0, gatePassed: false, gateOutputTail: '' }
      const agentStart = Date.now()
      try {
        const response = await adapter.run({
          prompt: buildPrompt(bundle, attempt, lastGateOutput),
          cwd: sandbox,
          task: spec,
          attempt,
          trial,
          referenceDir: bundle.referenceDir,
          timeoutMs: spec.timeoutMs ?? 10 * 60 * 1000,
        })
        record.usage = response.usage
        record.stages = response.stages
        if (response.pipeline) pipeline = response.pipeline
      } catch (error) {
        record.agentError = error instanceof Error ? error.message : String(error)
      }
      record.agentMs = Date.now() - agentStart
      attempts.push(record)

      // Integrity first: a gate that only passes because the tests were rewritten proves nothing.
      tampered = changedPaths(protectedBefore, snapshotPaths(sandbox, spec.protectedPaths))
      if (tampered.length > 0) {
        outcome = 'tampered'
        break
      }

      const gate = runGate(sandbox, spec.gate, spec.gateTimeoutMs ?? 120_000)
      record.gateMs = gate.ms
      record.gatePassed = gate.passed
      record.gateOutputTail = gate.output.slice(-OUTPUT_TAIL_CHARS)
      lastGateOutput = gate.output
      if (gate.passed) {
        outcome = 'pass'
        break
      }
    }
    if (outcome === 'fail' && attempts.length > 0 && attempts.every((a) => a.agentError !== undefined)) {
      outcome = 'error'
    }
  } finally {
    if (!options.keepSandbox) rmSync(sandbox, { recursive: true, force: true })
  }

  const passed = outcome === 'pass'
  return {
    schemaVersion: 1,
    runId: options.runId,
    startedAt: startedAt.toISOString(),
    taskId: spec.id,
    agent: adapter.name,
    trial,
    outcome,
    passed,
    attemptsUsed: attempts.length,
    attemptsToPass: passed ? attempts.length : null,
    totalMs: Date.now() - startedAt.getTime(),
    usage: sumUsage(attempts.map((a) => a.usage)),
    tamperedPaths: tampered,
    attempts,
    ...(attempts.some((a) => a.stages) ? { stages: sumStages(attempts.map((a) => a.stages)) } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(options.keepSandbox ? { sandbox } : {}),
  }
}
