import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAdapterSpec } from '../eval/adapters.js'
import { renderHtml, renderMarkdown } from '../eval/report.js'
import { runTrial } from '../eval/runner.js'
import { summarize, type Summary } from '../eval/stats.js'
import { loadTasks } from '../eval/tasks.js'
import type { TrialResult } from '../eval/types.js'
import { compareAgents, renderComparison, type Comparison } from '../eval/compare.js'
import { createScopeReviewer, renderScopeEval, runScopeEval, INJECTION_KINDS, type InjectionKind, type ScopeCaseResult } from '../eval/scopeEval.js'

/** tools/subrev/evals/tasks, resolved from both src/ and dist/. */
export const DEFAULT_TASKS_DIR = fileURLToPath(new URL('../../evals/tasks', import.meta.url))

export interface EvalRunOptions {
  tasksDir: string
  agents: string[]
  trials: number
  taskIds?: string[]
  outDir: string
  keepSandboxes?: boolean
  log?: (message: string) => void
}

export function evalList(tasksDir: string): string[] {
  return loadTasks(tasksDir).map((b) => `${b.spec.id}  [${(b.spec.tags ?? []).join(', ')}]  ${b.spec.title}`)
}

export function readResults(runDir: string): TrialResult[] {
  const file = path.join(runDir, 'results.jsonl')
  if (!existsSync(file)) throw new Error(`no results.jsonl in ${runDir}`)
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TrialResult)
}

export function writeReports(runDir: string, summary: Summary): void {
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  writeFileSync(path.join(runDir, 'report.md'), renderMarkdown(summary))
  writeFileSync(path.join(runDir, 'report.html'), renderHtml(summary))
}

export async function evalRun(options: EvalRunOptions): Promise<Summary> {
  const log = options.log ?? (() => {})
  if (options.agents.length === 0) throw new Error('at least one --agent is required')
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error('--trials must be a positive integer')

  const adapters = options.agents.map(parseAdapterSpec)
  const bundles = loadTasks(options.tasksDir, options.taskIds)
  if (bundles.length === 0) throw new Error(`no tasks found in ${options.tasksDir}`)

  const resultsFile = path.join(options.outDir, 'results.jsonl')
  if (existsSync(resultsFile)) throw new Error(`refusing to overwrite existing results in ${options.outDir}`)
  mkdirSync(options.outDir, { recursive: true })
  const runId = path.basename(options.outDir)

  const results: TrialResult[] = []
  for (const adapter of adapters) {
    for (const bundle of bundles) {
      for (let trial = 1; trial <= options.trials; trial++) {
        const result = await runTrial(bundle, adapter, trial, { runId, keepSandbox: options.keepSandboxes })
        appendFileSync(resultsFile, JSON.stringify(result) + '\n')
        results.push(result)
        log(
          `${adapter.name}  ${bundle.spec.id}  trial ${trial}/${options.trials}  ${result.outcome}` +
            `  (${result.attemptsUsed} attempt${result.attemptsUsed === 1 ? '' : 's'}, ${(result.totalMs / 1000).toFixed(1)}s)`
        )
      }
    }
  }

  const summary = summarize(runId, results)
  writeReports(options.outDir, summary)
  return summary
}

export function evalReport(runDir: string): Summary {
  const summary = summarize(path.basename(path.resolve(runDir)), readResults(runDir))
  writeReports(runDir, summary)
  return summary
}

export interface EvalCompareOptions {
  runDirs: string[]
  baseline: string
  treatment: string
  iterations?: number
  seed?: number
  out?: string
}

/** Compare two agents across one or more run directories (results are pooled by agent and task). */
export function evalCompare(options: EvalCompareOptions): { comparison: Comparison; markdown: string; outFile: string } {
  const results = options.runDirs.flatMap(readResults)
  const comparison = compareAgents(results, options.baseline, options.treatment, { iterations: options.iterations, seed: options.seed })
  const markdown = renderComparison(comparison)
  const outFile = options.out ?? path.join(options.runDirs[0], `compare-${slug(options.treatment)}-vs-${slug(options.baseline)}.md`)
  writeFileSync(outFile, markdown)
  writeFileSync(outFile.replace(/\.md$/, '.json'), JSON.stringify(comparison, null, 2) + '\n')
  return { comparison, markdown, outFile }
}

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, '_')

export interface EvalScopeOptions {
  tasksDir: string
  taskIds?: string[]
  reviewer: string
  kinds?: string[]
  trials?: number
  outDir: string
  log?: (message: string) => void
}

export async function evalScope(options: EvalScopeOptions): Promise<{ results: ScopeCaseResult[]; markdown: string }> {
  const kinds = (options.kinds ?? [...INJECTION_KINDS]) as InjectionKind[]
  for (const k of kinds) if (!(INJECTION_KINDS as readonly string[]).includes(k)) throw new Error(`unknown injection kind "${k}"; expected ${INJECTION_KINDS.join(', ')}`)
  const reviewer = options.reviewer === 'none' ? null : createScopeReviewer(options.reviewer)
  const bundles = loadTasks(options.tasksDir, options.taskIds).filter((b) => b.referenceDir)
  if (bundles.length === 0) throw new Error('no tasks with a reference/ solution')
  const resultsFile = path.join(options.outDir, 'scope-results.jsonl')
  if (existsSync(resultsFile)) throw new Error(`refusing to overwrite existing results in ${options.outDir}`)
  mkdirSync(options.outDir, { recursive: true })
  const results = await runScopeEval(bundles, { reviewer, kinds, trials: options.trials, log: options.log })
  writeFileSync(resultsFile, results.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const markdown = renderScopeEval(results, options.reviewer)
  writeFileSync(path.join(options.outDir, 'scope-report.md'), markdown)
  return { results, markdown }
}
