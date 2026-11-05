import { passAtK } from './stats.js'
import type { TrialResult } from './types.js'

/**
 * Baseline-vs-treatment comparison over the same tasks.
 *
 * Trials of one task are not independent of each other (same prompt, same difficulty), so a
 * test over pooled trials (e.g. McNemar on all runs) overstates significance. Everything here is
 * paired by task:
 *  - per-task pass rates, then the macro mean of the per-task differences;
 *  - a hierarchical bootstrap (resample tasks, then trials within each task) for its 95% CI;
 *  - an exact Wilcoxon signed-rank test on the per-task differences.
 * With few tasks, the per-task table is the honest result; the summary numbers are secondary.
 *
 * Cost matching: a pipeline that spends 3x the tokens should be compared against a baseline
 * given 3x the budget. With the gate as the verifier, "run the baseline k times, keep any
 * passing attempt" is exactly pass@k, so the cost-matched baseline is pass@k at
 * k = floor(treatment cost / baseline cost), computed from trials already run.
 */

export interface TaskPair {
  taskId: string
  nA: number
  nB: number
  passA: number
  passB: number
  rateA: number
  rateB: number
  diff: number
  firstAttemptA: number
  firstAttemptB: number
}

export interface SideSummary {
  agent: string
  trials: number
  macroPass: number
  macroFirstAttempt: number
  medianMs: number | null
  meanCostUsd: number | null
  meanTokens: number | null
  trialsWithCost: number
  tampered: number
  escalationRate: number | null
  stageCost: Array<{ stage: string; meanCostUsd: number | null; meanMs: number; calls: number }>
}

export interface Comparison {
  baseline: SideSummary
  treatment: SideSummary
  tasks: TaskPair[]
  missingTasks: string[]
  meanDiff: number
  ci95: [number, number]
  bootstrapIterations: number
  seed: number
  wilcoxon: { n: number; wPlus: number; pValue: number | null }
  wins: number
  losses: number
  ties: number
  costMatched: { k: number; ratio: number; baselinePassAtK: number; note: string } | null
}

/** Small, seedable PRNG so a reported CI can be reproduced exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Hierarchical bootstrap of the macro mean difference: tasks with replacement, then trials within each task. */
export function hierarchicalBootstrap(
  outcomes: Array<{ a: boolean[]; b: boolean[] }>,
  iterations = 10_000,
  seed = 1
): [number, number] {
  if (outcomes.length === 0) return [NaN, NaN]
  const rand = mulberry32(seed)
  const pick = (n: number): number => Math.floor(rand() * n)
  const rate = (xs: boolean[]): number => {
    let c = 0
    for (let i = 0; i < xs.length; i++) if (xs[pick(xs.length)]) c++
    return c / xs.length
  }
  const stats: number[] = []
  for (let it = 0; it < iterations; it++) {
    let sum = 0
    for (let t = 0; t < outcomes.length; t++) {
      const task = outcomes[pick(outcomes.length)]
      sum += rate(task.b) - rate(task.a)
    }
    stats.push(sum / outcomes.length)
  }
  stats.sort((x, y) => x - y)
  return [quantile(stats, 0.025), quantile(stats, 0.975)]
}

/**
 * Exact two-sided Wilcoxon signed-rank test. Zero differences are dropped; tied magnitudes get
 * average ranks, and the exact null distribution is computed over those ranks (doubled to
 * integers), so ties are handled exactly rather than by the normal approximation.
 */
export function wilcoxonSignedRank(diffs: number[]): { n: number; wPlus: number; pValue: number | null } {
  const nonzero = diffs.filter((d) => Math.abs(d) > 1e-12)
  const n = nonzero.length
  if (n === 0) return { n: 0, wPlus: 0, pValue: null }
  const order = nonzero.map((d, i) => ({ abs: Math.abs(d), i })).sort((x, y) => x.abs - y.abs)
  const ranks2 = new Array<number>(n)
  for (let i = 0; i < n; ) {
    let j = i
    while (j + 1 < n && Math.abs(order[j + 1].abs - order[i].abs) < 1e-12) j++
    const avg2 = i + 1 + (j + 1) // 2 * average of ranks i+1..j+1
    for (let k = i; k <= j; k++) ranks2[order[k].i] = avg2
    i = j + 1
  }
  const wPlus2 = nonzero.reduce((s, d, i) => (d > 0 ? s + ranks2[i] : s), 0)
  // Count sign assignments by rank sum (in doubled units).
  let dist = new Map<number, number>([[0, 1]])
  for (const r of ranks2) {
    const next = new Map<number, number>()
    for (const [sum, count] of dist) {
      next.set(sum, (next.get(sum) ?? 0) + count)
      next.set(sum + r, (next.get(sum + r) ?? 0) + count)
    }
    dist = next
  }
  const all = 2 ** n
  let le = 0
  let ge = 0
  for (const [sum, count] of dist) {
    if (sum <= wPlus2) le += count
    if (sum >= wPlus2) ge += count
  }
  return { n, wPlus: wPlus2 / 2, pValue: Math.min(1, (2 * Math.min(le, ge)) / all) }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const firstAttemptPassed = (r: TrialResult): boolean => r.outcome !== 'tampered' && r.attempts[0]?.gatePassed === true

function summarizeSide(agent: string, results: TrialResult[], taskIds: string[]): SideSummary {
  const own = results.filter((r) => r.agent === agent && taskIds.includes(r.taskId))
  const perTask = taskIds.map((id) => own.filter((r) => r.taskId === id))
  const macro = (f: (r: TrialResult) => boolean): number =>
    perTask.reduce((s, rs) => s + (rs.length ? rs.filter(f).length / rs.length : 0), 0) / Math.max(1, perTask.length)
  const withCost = own.filter((r) => r.usage?.costUsd !== undefined)
  const withTokens = own.filter((r) => r.usage?.inputTokens !== undefined || r.usage?.outputTokens !== undefined)
  const withPipeline = own.filter((r) => r.pipeline)
  const stageNames = [...new Set(own.flatMap((r) => (r.stages ?? []).map((s) => s.stage)))]
  return {
    agent,
    trials: own.length,
    macroPass: macro((r) => r.passed),
    macroFirstAttempt: macro(firstAttemptPassed),
    medianMs: median(own.map((r) => r.totalMs)),
    meanCostUsd: withCost.length ? withCost.reduce((s, r) => s + (r.usage!.costUsd ?? 0), 0) / withCost.length : null,
    meanTokens: withTokens.length
      ? withTokens.reduce((s, r) => s + (r.usage!.inputTokens ?? 0) + (r.usage!.outputTokens ?? 0), 0) / withTokens.length
      : null,
    trialsWithCost: withCost.length,
    tampered: own.filter((r) => r.outcome === 'tampered').length,
    escalationRate: withPipeline.length
      ? withPipeline.filter((r) => r.pipeline!.escalations > 0).length / withPipeline.length
      : null,
    stageCost: stageNames.map((stage) => {
      const items = own.flatMap((r) => (r.stages ?? []).filter((s) => s.stage === stage))
      const costs = items.filter((s) => s.costUsd !== undefined)
      return {
        stage,
        meanCostUsd: costs.length ? costs.reduce((s, x) => s + (x.costUsd ?? 0), 0) / own.length : null,
        meanMs: items.reduce((s, x) => s + x.ms, 0) / Math.max(1, own.length),
        calls: items.reduce((s, x) => s + x.calls, 0),
      }
    }),
  }
}

export interface CompareOptions {
  iterations?: number
  seed?: number
}

export function compareAgents(
  results: TrialResult[],
  baseline: string,
  treatment: string,
  opts: CompareOptions = {}
): Comparison {
  const agents = new Set(results.map((r) => r.agent))
  for (const a of [baseline, treatment]) {
    if (!agents.has(a)) throw new Error(`no trials for agent "${a}"; have: ${[...agents].join(', ')}`)
  }
  const tasksOf = (agent: string): Set<string> => new Set(results.filter((r) => r.agent === agent).map((r) => r.taskId))
  const aTasks = tasksOf(baseline)
  const bTasks = tasksOf(treatment)
  const common = [...aTasks].filter((t) => bTasks.has(t)).sort()
  const missingTasks = [...new Set([...aTasks, ...bTasks])].filter((t) => !common.includes(t)).sort()

  const pairs: TaskPair[] = []
  const outcomes: Array<{ a: boolean[]; b: boolean[] }> = []
  for (const taskId of common) {
    const a = results.filter((r) => r.agent === baseline && r.taskId === taskId)
    const b = results.filter((r) => r.agent === treatment && r.taskId === taskId)
    const passA = a.filter((r) => r.passed).length
    const passB = b.filter((r) => r.passed).length
    pairs.push({
      taskId,
      nA: a.length,
      nB: b.length,
      passA,
      passB,
      rateA: passA / a.length,
      rateB: passB / b.length,
      diff: passB / b.length - passA / a.length,
      firstAttemptA: a.filter(firstAttemptPassed).length / a.length,
      firstAttemptB: b.filter(firstAttemptPassed).length / b.length,
    })
    outcomes.push({ a: a.map((r) => r.passed), b: b.map((r) => r.passed) })
  }

  const iterations = opts.iterations ?? 10_000
  const seed = opts.seed ?? 1
  const diffs = pairs.map((p) => p.diff)
  const base = summarizeSide(baseline, results, common)
  const treat = summarizeSide(treatment, results, common)

  let costMatched: Comparison['costMatched'] = null
  if (base.meanCostUsd && treat.meanCostUsd && pairs.length) {
    const ratio = treat.meanCostUsd / base.meanCostUsd
    const minN = Math.min(...pairs.map((p) => p.nA))
    const k = Math.max(1, Math.min(minN, Math.floor(ratio + 1e-9)))
    const baselinePassAtK = pairs.reduce((s, p) => s + passAtK(p.nA, p.passA, k), 0) / pairs.length
    const note =
      Math.floor(ratio + 1e-9) > minN
        ? `treatment costs ${ratio.toFixed(1)}x baseline but only ${minN} baseline trials per task exist; k capped at ${minN}, which favours the treatment`
        : ratio < 1
          ? 'treatment is cheaper than baseline; pass@1 is the cost-matched comparison'
          : `baseline best-of-${k} with the gate as verifier, at roughly the treatment's spend`
    costMatched = { k, ratio, baselinePassAtK, note }
  }

  return {
    baseline: base,
    treatment: treat,
    tasks: pairs,
    missingTasks,
    meanDiff: diffs.length ? diffs.reduce((s, d) => s + d, 0) / diffs.length : NaN,
    ci95: hierarchicalBootstrap(outcomes, iterations, seed),
    bootstrapIterations: iterations,
    seed,
    wilcoxon: wilcoxonSignedRank(diffs),
    wins: diffs.filter((d) => d > 1e-12).length,
    losses: diffs.filter((d) => d < -1e-12).length,
    ties: diffs.filter((d) => Math.abs(d) <= 1e-12).length,
    costMatched,
  }
}

const pct = (x: number | null): string => (x === null || Number.isNaN(x) ? '–' : `${(x * 100).toFixed(0)}%`)
const signedPct = (x: number): string => (Number.isNaN(x) ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pp`)
const usd = (x: number | null): string => (x === null ? 'n/a' : `$${x.toFixed(4)}`)
const secs = (ms: number | null): string => (ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`)

/**
 * The pre-registered decision rule from evals/PROTOCOL.md. Kept in code so the report states
 * whether it was met instead of leaving room to reinterpret afterwards.
 */
export function protocolVerdict(c: Comparison, minTasks = 10): { met: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (c.tasks.length < minTasks) reasons.push(`only ${c.tasks.length} paired tasks (protocol minimum ${minTasks})`)
  if (!(c.ci95[0] > 0)) reasons.push(`95% CI lower bound ${signedPct(c.ci95[0])} is not above 0`)
  if (c.wilcoxon.pValue === null || c.wilcoxon.pValue >= 0.05) reasons.push(`Wilcoxon p = ${c.wilcoxon.pValue?.toFixed(3) ?? 'n/a'} (needs < 0.05)`)
  if (!c.costMatched) reasons.push('cost unknown for one side, so the cost-matched comparison could not be made')
  else if (c.treatment.macroPass <= c.costMatched.baselinePassAtK) {
    reasons.push(`treatment ${pct(c.treatment.macroPass)} does not beat cost-matched baseline pass@${c.costMatched.k} ${pct(c.costMatched.baselinePassAtK)}`)
  }
  return { met: reasons.length === 0, reasons }
}

export function renderComparison(c: Comparison): string {
  const verdict = protocolVerdict(c)
  const side = (s: SideSummary): string[] => [
    s.agent,
    String(s.trials),
    pct(s.macroPass),
    pct(s.macroFirstAttempt),
    secs(s.medianMs),
    s.meanTokens === null ? 'n/a' : s.meanTokens.toFixed(0),
    usd(s.meanCostUsd) + (s.trialsWithCost && s.trialsWithCost < s.trials ? ` (${s.trialsWithCost}/${s.trials})` : ''),
    String(s.tampered),
    pct(s.escalationRate),
  ]
  const row = (cells: string[]): string => `| ${cells.join(' | ')} |`
  const lines = [
    `# Comparison: ${c.treatment.agent} vs ${c.baseline.agent}`,
    '',
    `Pre-registered criterion (evals/PROTOCOL.md): **${verdict.met ? 'MET' : 'NOT MET'}**`,
    ...verdict.reasons.map((r) => `- ${r}`),
    '',
    '## Summary',
    '',
    row(['Agent', 'Trials', 'Final pass (macro)', 'First-attempt pass', 'Median time', 'Mean tokens', 'Mean cost/trial', 'Tampered', 'Escalation rate']),
    row(['---', '---', '---', '---', '---', '---', '---', '---', '---']),
    row(side(c.baseline)),
    row(side(c.treatment)),
    '',
    `Paired over ${c.tasks.length} tasks: mean difference ${signedPct(c.meanDiff)}, ` +
      `95% CI [${signedPct(c.ci95[0])}, ${signedPct(c.ci95[1])}] (hierarchical bootstrap, ${c.bootstrapIterations} iterations, seed ${c.seed}).`,
    `Wilcoxon signed-rank (exact): n = ${c.wilcoxon.n} non-tied tasks, W+ = ${c.wilcoxon.wPlus}, p = ${c.wilcoxon.pValue === null ? 'n/a' : c.wilcoxon.pValue.toFixed(4)}.`,
    `Tasks: ${c.wins} better, ${c.losses} worse, ${c.ties} tied.`,
  ]
  if (c.costMatched) {
    lines.push(
      `Cost-matched: treatment costs ${c.costMatched.ratio.toFixed(2)}x baseline per trial; baseline pass@${c.costMatched.k} = ${pct(c.costMatched.baselinePassAtK)} vs treatment ${pct(c.treatment.macroPass)}. ${c.costMatched.note}.`
    )
  } else {
    lines.push('Cost-matched comparison: not available (cost not reported for one side).')
  }
  if (c.missingTasks.length) lines.push('', `Excluded (not run for both agents): ${c.missingTasks.join(', ')}`)
  lines.push(
    '',
    '## Per task',
    '',
    row(['Task', `${c.baseline.agent} pass`, `${c.treatment.agent} pass`, 'Diff', 'First-attempt (base / treat)']),
    row(['---', '---', '---', '---', '---']),
    ...c.tasks.map((p) =>
      row([p.taskId, `${p.passA}/${p.nA}`, `${p.passB}/${p.nB}`, signedPct(p.diff), `${pct(p.firstAttemptA)} / ${pct(p.firstAttemptB)}`])
    )
  )
  for (const s of [c.baseline, c.treatment]) {
    if (s.stageCost.length === 0) continue
    lines.push(
      '',
      `## Stage cost — ${s.agent}`,
      '',
      row(['Stage', 'Calls', 'Mean time/trial', 'Mean cost/trial']),
      row(['---', '---', '---', '---']),
      ...s.stageCost.map((x) => row([x.stage, String(x.calls), secs(x.meanMs), usd(x.meanCostUsd)]))
    )
  }
  lines.push(
    '',
    '## Reading this',
    '',
    '- Differences are computed per task and then averaged, so a task with more trials does not weigh more.',
    '- First-attempt pass for a pipeline agent means its single end-to-end run passed; for a baseline it means attempt 1 of the gate-feedback loop passed.',
    '- "Escalation rate" is the share of pipeline trials that ended in, or passed through, a human-facing escalation. It is not a measure of whether those escalations were right; see `subrev eval scope` for that.',
    ''
  )
  return lines.join('\n')
}
