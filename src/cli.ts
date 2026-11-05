#!/usr/bin/env node
import { Command } from 'commander'
import { createUsageLogger, summarizeUsage, formatUsageSummary } from './usageLog.js'
import { showGate } from './commands/approveGate.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, realpathSync } from 'node:fs'
import { newTask } from './commands/new.js'
import { planTask } from './commands/plan.js'
import { approveTask } from './commands/approve.js'
import { runCommand, resumeCommand, type RunOverrides } from './commands/run.js'
import { amendPlan } from './commands/amendPlan.js'
import { buildStatusReport, formatStatusReport } from './commands/status.js'
import { closeTask, abandonTask, retro } from './commands/closeAndAbandon.js'
import { runDoctor } from './commands/doctor.js'
import { createSubprocessAiRunner, type ModelTiers } from './aiRunner.js'
import { checkFastLaneCompliance } from './fastLane.js'
import { DEFAULT_TASKS_DIR, evalCompare, evalList, evalReport, evalRun, evalScope } from './commands/eval.js'

export function loadModelTiers(repoPath: string): ModelTiers {
  try {
    const protocol = readFileSync(join(repoPath, '.ai/PROTOCOL.md'), 'utf8')
    const lines = protocol.split(/\r?\n/)
    const modelTiersIndex = lines.findIndex((line) => line.trim() === '## Model tiers')
    if (modelTiersIndex === -1) return { plan: 'default', review: 'default' }

    let plan = 'default'
    let review = 'default'
    for (let index = modelTiersIndex + 1; index < lines.length; index++) {
      const line = lines[index].trim()
      if (line.startsWith('##')) break
      const planMatch = line.match(/^-\s+plan:\s*(.+)$/)
      if (planMatch && plan === 'default') plan = planMatch[1].trim()
      const reviewMatch = line.match(/^-\s+review:\s*(.+)$/)
      if (reviewMatch && review === 'default') review = reviewMatch[1].trim()
    }
    return { plan, review }
  } catch {
    return { plan: 'default', review: 'default' }
  }
}

export function parseRunOverrides(opts: { scopeCheck?: string; revert?: boolean; strictUnverified?: boolean; approveGate?: string }): RunOverrides {
  const mode = opts.scopeCheck ?? 'layer1'
  if (mode !== 'layer1' && mode !== 'layered') throw new Error(`--scope-check must be layer1 or layered, got "${mode}"`)
  return {
    scopeCheck: mode,
    layer2: { ablation: opts.revert !== false, strictUnverified: Boolean(opts.strictUnverified) },
    ...(opts.approveGate ? { approveGate: opts.approveGate } : {}),
  }
}

export function buildProgram(): Command {
  const program = new Command()
  program.name('subrev').description('Submit-review efficiency CLI').version('0.1.0')

  program.command('new <description>').action((description: string) => {
    const meta = newTask({ cwd: process.cwd(), description })
    console.log(`Created task ${meta.taskId}`)
  })

  program.command('plan <taskId>').action(async (taskId: string) => {
    const repoPath = process.cwd()
    const ai = createSubprocessAiRunner(loadModelTiers(repoPath), undefined, createUsageLogger(repoPath, taskId))
    await planTask(ai, repoPath, taskId)
    console.log(`plan.md written for ${taskId}`)
  })

  program.command('approve <taskId>').action((taskId: string) => {
    const { warnings } = approveTask(process.cwd(), taskId)
    for (const w of warnings) console.warn(`warning: ${w}`)
    console.log(`plan-approved.md written for ${taskId}`)
  })

  for (const [name, fn] of [['run', runCommand], ['resume', resumeCommand]] as const) {
    program
      .command(`${name} <taskId>`)
      .option('--scope-check <mode>', 'layer1 (any layer-1 signal forces a review) or layered (layer 2 decides)', process.env.SUBREV_SCOPE_CHECK ?? 'layer1')
      .option('--no-revert', 'layered mode: skip the revert experiment (no extra gate runs)')
      .option('--strict-unverified', 'layered mode: escalate AC mappings that no test needs')
      .option('--approve-gate <fingerprint>', 'approve exactly this gate change, for this run only (see subrev show-gate)')
      .action(async (taskId: string, opts: { scopeCheck: string; revert: boolean; strictUnverified?: boolean; approveGate?: string }) => {
        const repoPath = process.cwd()
        const ai = createSubprocessAiRunner(loadModelTiers(repoPath), undefined, createUsageLogger(repoPath, taskId))
        const status = await fn(ai, repoPath, taskId, parseRunOverrides(opts))
        console.log(`Task ${taskId} finished with status: ${status}`)
      })
  }

  program.command('amend-plan <taskId> <planFile>').action((taskId: string, planFile: string) => {
    const revised = readFileSync(planFile, 'utf8')
    const { warnings } = amendPlan(process.cwd(), taskId, revised)
    for (const w of warnings) console.warn(`warning: ${w}`)
    console.log(`plan-approved.md amended for ${taskId}`)
  })

  program
    .command('show-gate <taskId>')
    .description('show a gate change recomputed from git; approve it with "subrev resume <taskId> --approve-gate <fp>"')
    .action((taskId: string) => {
      console.log(showGate(process.cwd(), taskId).report)
    })

  program
    .command('usage [taskId]')
    .description('time and cost per pipeline stage, from each task\'s ai-calls.jsonl')
    .action((taskId?: string) => {
      console.log(formatUsageSummary(summarizeUsage(process.cwd(), taskId ? [taskId] : undefined)))
    })

  program.command('status').action(() => {
    console.log(formatStatusReport(buildStatusReport(process.cwd())))
  })

  program
    .command('close <taskId>')
    .option('--force', 'force the transition for crash recovery')
    .action((taskId: string, opts: { force?: boolean }) => {
      closeTask(process.cwd(), taskId, undefined, { force: opts.force })
      console.log(`Task ${taskId} closed and archived.`)
    })

  program
    .command('abandon <taskId>')
    .requiredOption('--reason <reason>', 'why this task is being abandoned')
    .option('--force', 'force the transition for crash recovery')
    .action((taskId: string, opts: { reason: string; force?: boolean }) => {
      abandonTask(process.cwd(), taskId, opts.reason, undefined, { force: opts.force })
      console.log(`Task ${taskId} abandoned and archived.`)
    })

  program.command('retro <taskId> <note>').action((taskId: string, note: string) => {
    retro(process.cwd(), taskId, note)
    console.log(`Retrospective recorded for ${taskId}.`)
  })

  program.command('doctor').action(() => {
    const report = runDoctor(process.cwd())
    for (const check of report.checks) {
      const marker = check.ok ? 'PASS' : 'FAIL'
      console.log(`[${marker}] ${check.name}: ${check.detail}`)
    }
    if (!report.ok) process.exitCode = 1
  })

  program
    .command('check-fast-lane')
    .requiredOption('--base <ref>', 'git ref to diff against')
    .requiredOption('--message <message>', 'the commit message being checked')
    .action((opts: { base: string; message: string }) => {
      const result = checkFastLaneCompliance(process.cwd(), opts.base, opts.message)
      if (result.violated) {
        console.error(`Fast-lane violation: ${result.reason}`)
        process.exitCode = 1
      }
    })

  const evalCmd = program.command('eval').description('Run coding-agent evaluations against sandboxed tasks')

  evalCmd
    .command('list')
    .option('--tasks-dir <dir>', 'directory containing task folders', DEFAULT_TASKS_DIR)
    .action((opts: { tasksDir: string }) => {
      for (const line of evalList(opts.tasksDir)) console.log(line)
    })

  evalCmd
    .command('run')
    .requiredOption('--agent <spec...>', 'agent(s): mock:<solve|fail|retry|flaky|tamper>, claude[:model], codex[:model], subrev[:options]')
    .option('--trials <n>', 'independent trials per task', '3')
    .option('--task <id...>', 'only run these task ids')
    .option('--tasks-dir <dir>', 'directory containing task folders', DEFAULT_TASKS_DIR)
    .option('--out <dir>', 'output directory (default: .ai/evals/<timestamp>)')
    .option('--keep-sandboxes', 'keep sandbox directories for debugging')
    .action(
      async (opts: {
        agent: string[]
        trials: string
        task?: string[]
        tasksDir: string
        out?: string
        keepSandboxes?: boolean
      }) => {
        const outDir =
          opts.out ?? join(process.cwd(), '.ai', 'evals', new Date().toISOString().replace(/[:.]/g, '-'))
        const summary = await evalRun({
          tasksDir: opts.tasksDir,
          agents: opts.agent,
          trials: Number(opts.trials),
          taskIds: opts.task,
          outDir,
          keepSandboxes: opts.keepSandboxes,
          log: (message) => console.log(message),
        })
        for (const a of summary.agents) {
          console.log(`${a.agent}: pass@1 ${(a.macroPassAt1 * 100).toFixed(0)}% over ${a.tasks} tasks x ${a.trials / a.tasks} trials`)
        }
        console.log(`Report: ${join(outDir, 'report.md')}`)
      }
    )

  evalCmd.command('report <runDir>').action((runDir: string) => {
    evalReport(runDir)
    console.log(`Re-rendered reports in ${runDir}`)
  })

  evalCmd
    .command('compare <runDir...>')
    .description('Paired, cost-aware comparison of two agents over the same tasks')
    .requiredOption('--baseline <agent>', 'baseline agent name as it appears in results.jsonl')
    .requiredOption('--treatment <agent>', 'treatment agent name as it appears in results.jsonl')
    .option('--iterations <n>', 'bootstrap iterations', '10000')
    .option('--seed <n>', 'bootstrap seed (fixed so the CI is reproducible)', '1')
    .option('--out <file>', 'markdown output path (default: <first runDir>/compare-<treatment>-vs-<baseline>.md)')
    .action((runDirs: string[], opts: { baseline: string; treatment: string; iterations: string; seed: string; out?: string }) => {
      const { markdown, outFile } = evalCompare({
        runDirs,
        baseline: opts.baseline,
        treatment: opts.treatment,
        iterations: Number(opts.iterations),
        seed: Number(opts.seed),
        out: opts.out,
      })
      console.log(markdown)
      console.log(`Written to ${outFile}`)
    })

  evalCmd
    .command('scope')
    .description('Measure the scope detectors on reference solutions with and without injected out-of-scope changes')
    .option('--reviewer <spec>', 'layer-2 reviewer: mock:lenient, mock:strict, claude[:model], or none', 'mock:lenient')
    .option('--kind <kind...>', 'injection kinds (default: all)')
    .option('--trials <n>', 'repeats per case (only useful with a model reviewer)', '1')
    .option('--task <id...>', 'only these task ids')
    .option('--tasks-dir <dir>', 'directory containing task folders', DEFAULT_TASKS_DIR)
    .option('--out <dir>', 'output directory (default: .ai/evals/scope-<timestamp>)')
    .action(async (opts: { reviewer: string; kind?: string[]; trials: string; task?: string[]; tasksDir: string; out?: string }) => {
      const outDir = opts.out ?? join(process.cwd(), '.ai', 'evals', `scope-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      const { markdown } = await evalScope({
        tasksDir: opts.tasksDir,
        taskIds: opts.task,
        reviewer: opts.reviewer,
        kinds: opts.kind,
        trials: Number(opts.trials),
        outDir,
        log: (m) => console.log(m),
      })
      console.log(markdown)
      console.log(`Report: ${join(outDir, 'scope-report.md')}`)
    })

  return program
}

// Resolve both sides through any symlinks before comparing: a globally-linked install
// (e.g. `npm link`) invokes this script via a symlinked bin path, so `process.argv[1]`
// stays as the symlink while `import.meta.url` resolves to the real underlying file —
// without realpathSync-ing both, the comparison never matches and the CLI silently no-ops.
const isMainModule =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
if (isMainModule) {
  buildProgram().parse(process.argv)
}
