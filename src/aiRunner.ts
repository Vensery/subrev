import { spawn } from 'node:child_process'

export interface AiRunner {
  claudePlan(prompt: string, cwd: string): Promise<string>
  claudeReview(prompt: string, cwd: string): Promise<string>
  /** Resolves with codex's stdout so the orchestrator can persist it for debugging. */
  codexExec(prompt: string, cwd: string): Promise<string>
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

export function createSubprocessAiRunner(modelTiers: ModelTiers, timeoutMs = 10 * 60 * 1000): AiRunner {
  return {
    claudePlan: (prompt, cwd) =>
      runWithRetry(() => runProcess('claude', ['-p', prompt, '--model', modelTiers.plan], cwd, timeoutMs), 1),
    claudeReview: (prompt, cwd) =>
      runWithRetry(() => runProcess('claude', ['-p', prompt, '--model', modelTiers.review], cwd, timeoutMs), 1),
    codexExec: (prompt, cwd) =>
      // codex exec sandboxes to read-only by default, which silently discards every
      // file the agent tries to write — workspace-write is required for it to
      // actually implement (and git-commit) anything.
      runWithRetry(() => runProcess('codex', ['exec', '-s', 'workspace-write', prompt], cwd, timeoutMs), 1),
  }
}
