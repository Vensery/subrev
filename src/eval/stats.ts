import type { Outcome, TrialResult } from './types.js'

/**
 * Unbiased pass@k estimator (Chen et al., 2021): the probability that at least one of k
 * samples drawn without replacement from n trials (c of which passed) is a pass.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k) || n < 1 || c < 0 || c > n) {
    throw new RangeError(`invalid pass@k inputs: n=${n}, c=${c}, k=${k}`)
  }
  if (k < 1 || k > n) throw new RangeError(`k must be in [1, n]; got k=${k}, n=${n}`)
  if (n - c < k) return 1
  let product = 1
  for (let i = n - c + 1; i <= n; i++) product *= 1 - k / i
  return 1 - product
}

/** Wilson score interval for a binomial proportion. Honest about small n, unlike a bare percentage. */
export function wilson(c: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1]
  const p = c / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  costUsd: number
  trialsWithUsage: number
}

export interface TaskStats {
  agent: string
  taskId: string
  n: number
  passes: number
  outcomes: Record<Outcome, number>
  passAt1: number
  passAtK: { k: number; value: number }
  passCi: [number, number]
  meanAttemptsToPass: number | null
  medianMs: number | null
  usage: UsageTotals
  /** Mixed outcomes across identical trials: the signature of a non-deterministic (or flaky) result. */
  flaky: boolean
}

export interface AgentStats {
  agent: string
  tasks: number
  trials: number
  macroPassAt1: number
  tampered: number
  errors: number
  flakyTasks: number
  medianMs: number | null
  usage: UsageTotals
}

export interface Summary {
  runId: string
  generatedAt: string
  tasks: TaskStats[]
  agents: AgentStats[]
}

const emptyOutcomes = (): Record<Outcome, number> => ({ pass: 0, fail: 0, tampered: 0, error: 0 })
const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, trialsWithUsage: 0 })

function addUsage(totals: UsageTotals, result: TrialResult): void {
  if (!result.usage) return
  totals.trialsWithUsage += 1
  totals.inputTokens += result.usage.inputTokens ?? 0
  totals.outputTokens += result.usage.outputTokens ?? 0
  totals.costUsd += result.usage.costUsd ?? 0
}

export function summarize(runId: string, results: TrialResult[], now: Date = new Date()): Summary {
  const byKey = new Map<string, TrialResult[]>()
  for (const r of results) {
    const key = `${r.agent}\u0000${r.taskId}`
    byKey.set(key, [...(byKey.get(key) ?? []), r])
  }

  const tasks: TaskStats[] = []
  for (const group of byKey.values()) {
    const n = group.length
    const passes = group.filter((r) => r.passed).length
    const outcomes = emptyOutcomes()
    const usage = emptyUsage()
    for (const r of group) {
      outcomes[r.outcome] += 1
      addUsage(usage, r)
    }
    const k = Math.min(3, n)
    const attempts = group.flatMap((r) => (r.attemptsToPass === null ? [] : [r.attemptsToPass]))
    tasks.push({
      agent: group[0].agent,
      taskId: group[0].taskId,
      n,
      passes,
      outcomes,
      passAt1: passes / n,
      passAtK: { k, value: passAtK(n, passes, k) },
      passCi: wilson(passes, n),
      meanAttemptsToPass: attempts.length ? attempts.reduce((a, b) => a + b, 0) / attempts.length : null,
      medianMs: median(group.map((r) => r.totalMs)),
      usage,
      flaky: passes > 0 && passes < n,
    })
  }
  tasks.sort((a, b) => a.agent.localeCompare(b.agent) || a.taskId.localeCompare(b.taskId))

  const agents: AgentStats[] = []
  for (const name of [...new Set(tasks.map((t) => t.agent))].sort()) {
    const own = tasks.filter((t) => t.agent === name)
    const ownResults = results.filter((r) => r.agent === name)
    const usage = emptyUsage()
    for (const r of ownResults) addUsage(usage, r)
    agents.push({
      agent: name,
      tasks: own.length,
      trials: ownResults.length,
      macroPassAt1: own.reduce((sum, t) => sum + t.passAt1, 0) / own.length,
      tampered: own.reduce((sum, t) => sum + t.outcomes.tampered, 0),
      errors: own.reduce((sum, t) => sum + t.outcomes.error, 0),
      flakyTasks: own.filter((t) => t.flaky).length,
      medianMs: median(ownResults.map((r) => r.totalMs)),
      usage,
    })
  }

  return { runId, generatedAt: now.toISOString(), tasks, agents }
}
