import { spawn } from 'node:child_process'

export interface ReviewCallOptions {
  /**
   * Absolute directories the reviewer must not read. Passed to the claude CLI as
   * Read(...) deny rules, as defense in depth on top of running the independent
   * review in a worktree where those paths do not exist at all.
   */
  denyReadPaths?: string[]
}

export interface AiRunner {
  claudePlan(prompt: string, cwd: string): Promise<string>
  /** Phase 1: independent review. Must never see the implementer's self-report. */
  claudeReview(prompt: string, cwd: string, opts?: ReviewCallOptions): Promise<string>
  /** Phase 2: audit the implementer's self-report against the independent review. */
  claudeAudit(prompt: string, cwd: string): Promise<string>
  /** Resolves with codex's stdout so the orchestrator can persist it for debugging. */
  codexExec(prompt: string, cwd: string): Promise<string>
}

/** First line of a phase-1 review that re-checks a fix; used to attribute its cost. */
export const FIX_REVIEW_PREFIX = '[subrev: fix re-review]'
/** First words of a layer-2 scope review prompt (scope/layer2.ts). */
export const SCOPE_PROMPT_PREFIX = 'You are auditing a code change for scope creep.'

export type AiStage = 'plan' | 'review' | 'fix-review' | 'scope' | 'audit' | 'implement'

/** claudeReview serves three kinds of call; tell them apart by the prompt's first line. */
export function stageForReviewPrompt(prompt: string): AiStage {
  if (prompt.startsWith(SCOPE_PROMPT_PREFIX)) return 'scope'
  if (prompt.startsWith(FIX_REVIEW_PREFIX)) return 'fix-review'
  return 'review'
}

export interface CallUsage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

/** One AI call as seen by usage accounting. */
export interface CallRecord extends CallUsage {
  stage: AiStage
  ms: number
  ok: boolean
}

export type CallObserver = (record: CallRecord) => void

/** Parse `claude -p --output-format json`; falls back to the raw text when it is not JSON. */
export function parseClaudeJson(stdout: string): { stdout: string; usage?: CallUsage } {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown
      total_cost_usd?: unknown
      usage?: { input_tokens?: unknown; output_tokens?: unknown }
    }
    const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
    const usage: CallUsage = {
      inputTokens: num(parsed.usage?.input_tokens),
      outputTokens: num(parsed.usage?.output_tokens),
      costUsd: num(parsed.total_cost_usd),
    }
    const hasUsage = Object.values(usage).some((v) => v !== undefined)
    return { stdout: typeof parsed.result === 'string' ? parsed.result : stdout, usage: hasUsage ? usage : undefined }
  } catch {
    return { stdout }
  }
}

export interface ModelTiers {
  plan: string
  review: string
}

export async function runWithRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export function runProcess(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`))
    })
  })
}

/**
 * Argument vector for the phase-1 review call. Bash is denied outright (a shell
 * could cat any file), and each deny path becomes a Read rule; in the claude CLI's
 * rule syntax an absolute path is written with a leading `//`. The variadic
 * --disallowedTools flag goes last so it cannot swallow other arguments.
 */
export function buildReviewArgs(prompt: string, model: string, opts?: ReviewCallOptions): string[] {
  const args = ['-p', prompt, '--model', model]
  const denyRules = ['Bash', ...(opts?.denyReadPaths ?? []).map((dir) => `Read(/${dir.replace(/\/+$/, '')}/**)`)]
  args.push('--disallowedTools', ...denyRules)
  return args
}

/**
 * Production runner. Claude is asked for JSON so each call's cost and tokens can be logged;
 * `observer` receives one record per subprocess call (retries included), timed end to end.
 * Codex reports no cost, so its records carry time only.
 */
export function createSubprocessAiRunner(
  modelTiers: ModelTiers,
  timeoutMs = 10 * 60 * 1000,
  observer?: CallObserver
): AiRunner {
  const observe = async <T>(stage: AiStage, fn: () => Promise<{ text: T; usage?: CallUsage }>): Promise<T> => {
    const started = Date.now()
    try {
      const { text, usage } = await fn()
      observer?.({ stage, ms: Date.now() - started, ok: true, ...usage })
      return text
    } catch (error) {
      observer?.({ stage, ms: Date.now() - started, ok: false })
      throw error
    }
  }
  const claude = (stage: AiStage, args: string[], cwd: string) =>
    runWithRetry(
      () =>
        observe(stage, async () => {
          const parsed = parseClaudeJson(await runProcess('claude', ['--output-format', 'json', ...args], cwd, timeoutMs))
          return { text: parsed.stdout, usage: parsed.usage }
        }),
      1
    )
  return {
    claudePlan: (prompt, cwd) => claude('plan', ['-p', prompt, '--model', modelTiers.plan], cwd),
    claudeReview: (prompt, cwd, opts) =>
      claude(stageForReviewPrompt(prompt), buildReviewArgs(prompt, modelTiers.review, opts), cwd),
    claudeAudit: (prompt, cwd) => claude('audit', ['-p', prompt, '--model', modelTiers.review], cwd),
    codexExec: (prompt, cwd) =>
      // codex exec sandboxes to read-only by default, which silently discards every
      // file the agent tries to write — workspace-write is required for it to
      // actually implement (and git-commit) anything.
      runWithRetry(
        () => observe('implement', async () => ({ text: await runProcess('codex', ['exec', '-s', 'workspace-write', prompt], cwd, timeoutMs) })),
        1
      ),
  }
}
