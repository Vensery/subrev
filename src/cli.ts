#!/usr/bin/env node
import { Command } from 'commander'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, realpathSync } from 'node:fs'
import { newTask } from './commands/new.js'
import { planTask } from './commands/plan.js'
import { approveTask } from './commands/approve.js'
import { runCommand, resumeCommand } from './commands/run.js'
import { amendPlan } from './commands/amendPlan.js'
import { buildStatusReport, formatStatusReport } from './commands/status.js'
import { closeTask, abandonTask, retro } from './commands/closeAndAbandon.js'
import { runDoctor } from './commands/doctor.js'
import { createSubprocessAiRunner, type ModelTiers } from './aiRunner.js'
import { checkFastLaneCompliance } from './fastLane.js'

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

export function buildProgram(): Command {
  const program = new Command()
  program.name('subrev').description('Submit-review efficiency CLI').version('0.1.0')

  program.command('new <description>').action((description: string) => {
    const meta = newTask({ cwd: process.cwd(), description })
    console.log(`Created task ${meta.taskId}`)
  })

  program.command('plan <taskId>').action(async (taskId: string) => {
    const repoPath = process.cwd()
    const ai = createSubprocessAiRunner(loadModelTiers(repoPath))
    await planTask(ai, repoPath, taskId)
    console.log(`plan.md written for ${taskId}`)
  })

  program.command('approve <taskId>').action((taskId: string) => {
    approveTask(process.cwd(), taskId)
    console.log(`plan-approved.md written for ${taskId}`)
  })

  program.command('run <taskId>').action(async (taskId: string) => {
    const repoPath = process.cwd()
    const ai = createSubprocessAiRunner(loadModelTiers(repoPath))
    const status = await runCommand(ai, repoPath, taskId)
    console.log(`Task ${taskId} finished with status: ${status}`)
  })

  program.command('resume <taskId>').action(async (taskId: string) => {
    const repoPath = process.cwd()
    const ai = createSubprocessAiRunner(loadModelTiers(repoPath))
    const status = await resumeCommand(ai, repoPath, taskId)
    console.log(`Task ${taskId} finished with status: ${status}`)
  })

  program.command('amend-plan <taskId> <planFile>').action((taskId: string, planFile: string) => {
    const revised = readFileSync(planFile, 'utf8')
    amendPlan(process.cwd(), taskId, revised)
    console.log(`plan-approved.md amended for ${taskId}`)
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
