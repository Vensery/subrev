import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildReviewArgs, runProcess, stageForReviewPrompt, SCOPE_PROMPT_PREFIX, parseClaudeJson, type AiRunner, type ReviewCallOptions } from '../aiRunner.js'
import { approveTask } from '../commands/approve.js'
import { planTask } from '../commands/plan.js'
import { createTaskBranch, currentCommit } from '../git.js'
import { implementAndGate } from '../orchestrator/implementStep.js'
import { runTask } from '../orchestrator/runTask.js'
import { readTaskFile, readTaskMeta, scaffoldTask, taskDir, writeTaskFile, writeTaskMeta, type TaskMeta } from '../taskStore.js'
import type { AgentAdapter, AgentRequest, AgentResponse, PipelineOutcome, StageUsage } from './types.js'

/**
 * Runs the full subrev pipeline (plan -> approve -> implement+gate -> review -> fix -> scope
 * check) inside an eval sandbox, so it can be compared with a single agent on identical tasks.
 *
 * Fairness rules baked in:
 *  - the pipeline gets the same mechanical retry budget as the baseline's attempt budget
 *    (maxMechanicalRetries = task.maxAttempts - 1), and the runner calls it once per trial;
 *  - the implementer model can be the same CLI/model as the baseline (impl=claude,model=...),
 *    so a difference is attributable to the pipeline structure, not to a different coder;
 *  - the eval runner still checks protected paths and runs the gate itself afterwards; the
 *    pipeline's own verdict never counts as a pass.
 *
 * Spec: subrev[:key=value,flag,...]
 *   impl=codex|claude   implementer CLI (default codex, as in production)
 *   model=<m>           implementer model
 *   plan=<m> review=<m> plan / review model (claude)
 *   noplan              skip planning; the task prompt becomes a one-item plan (ablation)
 *   noreview            implement + gate only, no review loop (ablation)
 *   layered             layer-1 + layer-2 scope check (default layer1)
 *   norevert            layered without the revert experiment
 *   rounds=<n>          max review rounds (default 3, as in production)
 *   nofixreview         re-review a fix only when the scope check fires, the behaviour before
 *                       non-test fixes were always re-reviewed (ablation; measures that review)
 *   mock                deterministic stand-in AI (plans trivially, applies the reference
 *                       solution, always PASSes review); for testing the harness only
 */

export interface PipelineSpec {
  impl: 'codex' | 'claude'
  model?: string
  planModel?: string
  reviewModel?: string
  plan: boolean
  review: boolean
  scopeCheck: 'layer1' | 'layered'
  revert: boolean
  rounds: number
  mock: boolean
  /** 'scope-only' reproduces the pre-fix-review pipeline (ablation `nofixreview`). */
  fixReview: 'non-test' | 'scope-only'
}

export function parsePipelineSpec(arg: string | undefined): PipelineSpec {
  const spec: PipelineSpec = { impl: 'codex', plan: true, review: true, scopeCheck: 'layer1', revert: true, rounds: 3, mock: false, fixReview: 'non-test' }
  for (const part of (arg ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [key, value] = part.split('=')
    switch (key) {
      case 'impl':
        if (value !== 'codex' && value !== 'claude') throw new Error(`subrev adapter: impl must be codex or claude, got "${value}"`)
        spec.impl = value
        break
      case 'model': spec.model = value; break
      case 'plan': spec.planModel = value; break
      case 'review': spec.reviewModel = value; break
      case 'noplan': spec.plan = false; break
      case 'noreview': spec.review = false; break
      case 'layered': spec.scopeCheck = 'layered'; break
      case 'norevert': spec.revert = false; break
      case 'mock': spec.mock = true; break
      case 'nofixreview': spec.fixReview = 'scope-only'; break
      case 'rounds': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1) throw new Error(`subrev adapter: rounds must be a positive integer, got "${value}"`)
        spec.rounds = n
        break
      }
      default:
        throw new Error(`subrev adapter: unknown option "${part}"`)
    }
  }
  return spec
}

/**
 * The isolation flags production uses for phase-1 review (no Bash, Read denied under the given
 * paths), without the prompt/model part. buildReviewArgs always starts with
 * ['-p', prompt, '--model', model]; the variadic --disallowedTools must stay last.
 */
export function reviewIsolationArgs(opts?: ReviewCallOptions): string[] {
  return buildReviewArgs('', '', opts).slice(4)
}

/** Wraps an AiRunner and attributes time and usage to plan / implement / review / scope. */
export class StageRecorder {
  private stages = new Map<string, StageUsage>()

  record(stage: string, ms: number, usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    const s = this.stages.get(stage) ?? { stage, calls: 0, ms: 0 }
    s.calls += 1
    s.ms += ms
    if (usage) {
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
        if (usage[key] !== undefined) s[key] = (s[key] ?? 0) + (usage[key] as number)
      }
    }
    this.stages.set(stage, s)
  }

  list(): StageUsage[] {
    return [...this.stages.values()]
  }

  wrap(inner: AiRunner): AiRunner {
    const timed = async (stage: string, fn: () => Promise<string>): Promise<string> => {
      const started = Date.now()
      try {
        return await fn()
      } finally {
        this.record(stage, Date.now() - started)
      }
    }
    return {
      claudePlan: (p, cwd) => timed('plan', () => inner.claudePlan(p, cwd)),
      claudeReview: (p, cwd, o) => timed(stageForReviewPrompt(p), () => inner.claudeReview(p, cwd, o)),
      claudeAudit: (p, cwd) => timed('audit', () => inner.claudeAudit(p, cwd)),
      codexExec: (p, cwd) => timed('implement', () => inner.codexExec(p, cwd)),
    }
  }
}

/** Subprocess runner that asks claude for JSON output so usage and cost can be attributed per stage. */
export function createEvalAiRunner(spec: PipelineSpec, recorder: StageRecorder, timeoutMs: number): AiRunner {
  const claude = async (stage: string, prompt: string, cwd: string, model: string | undefined, extra: string[]): Promise<string> => {
    const started = Date.now()
    const args = ['-p', prompt, '--output-format', 'json', ...(model ? ['--model', model] : []), ...extra]
    const parsed = parseClaudeJson(await runProcess('claude', args, cwd, timeoutMs))
    recorder.record(stage, Date.now() - started, parsed.usage)
    return parsed.stdout
  }
  return {
    claudePlan: (p, cwd) => claude('plan', p, cwd, spec.planModel, []),
    // Same isolation flags as production phase-1 review (no shell, implementer notes unreadable).
    claudeReview: (p, cwd, o) =>
      claude(stageForReviewPrompt(p), p, cwd, spec.reviewModel, reviewIsolationArgs(o)),
    claudeAudit: (p, cwd) => claude('audit', p, cwd, spec.reviewModel, []),
    codexExec: async (p, cwd) => {
      if (spec.impl === 'claude') {
        return claude('implement', p, cwd, spec.model, [
          '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep',
        ])
      }
      const started = Date.now()
      const out = await runProcess('codex', ['exec', '-s', 'workspace-write', ...(spec.model ? ['-m', spec.model] : []), p], cwd, timeoutMs)
      recorder.record('implement', Date.now() - started)
      return out
    },
  }
}

/** Deterministic stand-in: plans trivially, "implements" by copying the task's reference solution, always PASSes. */
export function createMockPipelineAi(request: AgentRequest): AiRunner {
  return {
    claudePlan: async () => `## Files\n\n## Acceptance criteria\n\n- AC-1: ${request.task.title}\n`,
    claudeReview: async (prompt) =>
      prompt.startsWith(SCOPE_PROMPT_PREFIX)
        ? '```json\n{"groups":[]}\n```'
        : `- AC-1: covered\nVERDICT: PASS`,
    claudeAudit: async () => 'CONSISTENCY: CONSISTENT',
    codexExec: async (prompt, cwd) => {
      if (!request.referenceDir || !existsSync(request.referenceDir)) throw new Error('mock pipeline needs a reference/ directory')
      cpSync(request.referenceDir, cwd, { recursive: true, force: true })
      // Write the self-report the implement prompt asks for, so the report audit has something to audit.
      const summary = prompt.match(/write (\.ai\/tasks\/\S+?-summary\.md)/)
      if (summary) writeFileSync(path.join(cwd, summary[1]), 'mock: copied the reference solution\n')
      return 'mock pipeline: applied reference solution'
    },
  }
}

function writeScript(cwd: string, name: string, body: string): void {
  const dir = path.join(cwd, 'scripts')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, `#!/usr/bin/env bash\nset -e\n${body}\n`)
  chmodSync(file, 0o755)
}

/** Make an eval sandbox look like a subrev-managed repo without touching anything the diff or the gate can see. */
function prepareSandbox(cwd: string, gate: string): void {
  for (const name of ['check.sh', 'build.sh', 'test.sh']) {
    if (existsSync(path.join(cwd, 'scripts', name))) throw new Error(`fixture already has scripts/${name}; the subrev adapter would overwrite it`)
  }
  appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '\n.ai/\n/scripts/check.sh\n/scripts/build.sh\n/scripts/test.sh\n')
  writeScript(cwd, 'check.sh', 'exit 0')
  writeScript(cwd, 'build.sh', 'exit 0')
  writeScript(cwd, 'test.sh', gate)
}

function countScopeEscalations(cwd: string, taskId: string): number {
  const dir = taskDir(cwd, taskId)
  if (!existsSync(dir)) return 0
  return readdirSync(dir)
    .filter((f) => /^scope-report-round-\d+\.md$/.test(f))
    .filter((f) => {
      const text = readTaskFile(cwd, taskId, f) ?? ''
      return text.includes('**ESCALATE**') || text.includes('Layer 2 failed')
    }).length
}

export function createPipelineAdapter(arg?: string, aiFactory?: (request: AgentRequest, recorder: StageRecorder) => AiRunner): AgentAdapter {
  const spec = parsePipelineSpec(arg)
  return {
    name: arg ? `subrev:${arg}` : 'subrev',
    ownsRetries: true,
    async run(request): Promise<AgentResponse> {
      const cwd = request.cwd
      const recorder = new StageRecorder()
      const ai = aiFactory
        ? recorder.wrap(aiFactory(request, recorder))
        : spec.mock
          ? recorder.wrap(createMockPipelineAi(request))
          : createEvalAiRunner(spec, recorder, request.timeoutMs)

      prepareSandbox(cwd, request.task.gate)
      const taskId = `eval-${request.task.id}-${request.trial}`
      const meta: TaskMeta = {
        taskId, project: 'eval', repoKey: 'sandbox', branch: `task/${taskId}`, status: 'planning', round: 0,
        planVersion: 0, retrospectivePending: false, createdAt: new Date().toISOString(), unparseableReviewCount: 0,
      }
      scaffoldTask(cwd, meta, `# Brief\n\n${request.prompt}\n`)
      const notes: string[] = []

      if (spec.plan) {
        await planTask(ai, cwd, taskId)
        try {
          notes.push(...approveTask(cwd, taskId).warnings.map((w) => `plan warning: ${w}`))
        } catch (error) {
          // A malformed plan would block a human at approval. In an unattended eval, record it and
          // fall back to the no-plan form so the trial still measures implementation.
          notes.push(`plan rejected at approval: ${error instanceof Error ? error.message : String(error)}`)
          approveTask(cwd, taskId, noPlan(request))
        }
      } else {
        approveTask(cwd, taskId, noPlan(request))
      }

      const approved = readTaskMeta(cwd, taskId)
      approved.baseBranch = currentCommit(cwd)
      createTaskBranch(cwd, approved.branch)
      approved.status = 'in-progress'
      writeTaskMeta(cwd, approved)

      let status: string
      const mechanical = Math.max(0, request.task.maxAttempts - 1)
      if (spec.review) {
        status = await runTask(ai, cwd, taskId, {
          maxMechanicalRetries: mechanical,
          maxVerdictRetries: 1,
          maxReviewRounds: spec.rounds,
          baseBranch: approved.baseBranch,
          scopeCheck: spec.scopeCheck,
          layer2: { ablation: spec.revert },
          fixReview: spec.fixReview,
        })
      } else {
        const result = await implementAndGate(ai, cwd, taskId, { maxMechanicalRetries: mechanical })
        status = result.deviationRequested ? 'escalated-plan-deviation' : readTaskMeta(cwd, taskId).status
        if (status === 'in-progress') status = 'awaiting-judgment'
      }

      const final = readTaskMeta(cwd, taskId)
      const scopeEscalations = countScopeEscalations(cwd, taskId)
      const pipeline: PipelineOutcome = {
        status,
        reviewRounds: final.round,
        escalations: (status === 'awaiting-judgment' ? 0 : 1) + scopeEscalations,
        scopeEscalations,
      }
      writeTaskFile(cwd, taskId, 'eval-notes.md', notes.join('\n') + '\n')
      const stages = recorder.list()
      const usage = sumUsage(stages)
      return { stdout: `subrev pipeline finished: ${status}${notes.length ? `\n${notes.join('\n')}` : ''}`, stages, usage, pipeline }
    },
  }
}

function noPlan(request: AgentRequest): string {
  return `## Files\n\n## Acceptance criteria\n\n- AC-1: ${request.task.prompt.replace(/\s+/g, ' ').trim()}\n`
}

function sumUsage(stages: StageUsage[]): AgentResponse['usage'] {
  const out: NonNullable<AgentResponse['usage']> = {}
  for (const s of stages) {
    for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
      if (s[key] !== undefined) out[key] = (out[key] ?? 0) + (s[key] as number)
    }
  }
  return Object.keys(out).length ? out : undefined
}
