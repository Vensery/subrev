export interface EvalTaskSpec {
  id: string
  title: string
  /** What the agent is asked to do. The runner appends gate + protected-path constraints. */
  prompt: string
  /**
   * Acceptance criteria for this task, as written into a plan ("AC-1" is the first item). Used by
   * the scope-detector eval to build an approved plan. Each item may end with "[tests: ...]".
   */
  acceptance?: string[]
  /** Shell command run in the sandbox root after each attempt. Exit code 0 means the gate passed. */
  gate: string
  /** Paths (files or directories, relative to the sandbox root) the agent must not change, add to, or delete from. */
  protectedPaths: string[]
  /** Mechanical feedback rounds: attempt N+1 receives the failing gate output of attempt N. */
  maxAttempts: number
  /** Per-attempt agent timeout. */
  timeoutMs?: number
  gateTimeoutMs?: number
  tags?: string[]
}

export interface TaskBundle {
  spec: EvalTaskSpec
  dir: string
  fixtureDir: string
  /** Optional known-good solution, overlaid onto the sandbox by the mock adapter and used to verify the gate itself. */
  referenceDir?: string
}

export interface AgentUsage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface AgentRequest {
  prompt: string
  cwd: string
  task: EvalTaskSpec
  attempt: number
  trial: number
  referenceDir?: string
  timeoutMs: number
}

/** Cost of one pipeline stage within a trial (plan, implement, review, scope). */
export interface StageUsage extends AgentUsage {
  stage: string
  calls: number
  ms: number
}

export interface AgentResponse {
  stdout: string
  usage?: AgentUsage
  /** Per-stage breakdown, for adapters that run a multi-stage pipeline. */
  stages?: StageUsage[]
  /** Pipeline end state (e.g. awaiting-judgment, escalated-mechanical, abandoned) and escalation counts. */
  pipeline?: PipelineOutcome
}

export interface PipelineOutcome {
  status: string
  reviewRounds: number
  /** Times the pipeline stopped or forced extra work for a human-facing reason. */
  escalations: number
  scopeEscalations: number
}

export interface AgentAdapter {
  name: string
  /**
   * true when the adapter runs its own implement/gate/retry loop (the subrev pipeline). The
   * runner then calls it once per trial instead of feeding gate output back per attempt, so
   * the attempt budget is not counted twice.
   */
  ownsRetries?: boolean
  run(request: AgentRequest): Promise<AgentResponse>
}

export type Outcome = 'pass' | 'fail' | 'tampered' | 'error'

export interface AttemptRecord {
  attempt: number
  agentMs: number
  gateMs: number
  gatePassed: boolean
  gateOutputTail: string
  agentError?: string
  usage?: AgentUsage
  stages?: StageUsage[]
}

export interface TrialResult {
  schemaVersion: 1
  runId: string
  startedAt: string
  taskId: string
  agent: string
  trial: number
  outcome: Outcome
  passed: boolean
  attemptsUsed: number
  attemptsToPass: number | null
  totalMs: number
  usage: AgentUsage | null
  tamperedPaths: string[]
  attempts: AttemptRecord[]
  /** Summed per-stage usage (pipeline adapters only). */
  stages?: StageUsage[]
  pipeline?: PipelineOutcome
  /** Sandbox directory, present only when it was kept (--keep-sandboxes). */
  sandbox?: string
}
