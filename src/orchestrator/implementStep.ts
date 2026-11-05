// tools/subrev/src/orchestrator/implementStep.ts
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { AiRunner } from '../aiRunner.js'
import { readTaskFile, writeTaskFile, readTaskMeta, writeTaskMeta, taskDir } from '../taskStore.js'
import { runAllScripts, allGreen, formatTestLog, type ScriptResult } from '../scripts.js'
import { resolveGateSandbox } from '../integrity/gateSandbox.js'
import { currentCommit, isWorkingTreeDirty, commitAllChanges } from '../git.js'
import { checkGateIntegrity, renderGateReport } from '../integrity/gateIntegrity.js'
import { extractPlanFiles } from './planFiles.js'
import { execFileSync } from 'node:child_process'

export interface ImplementResult {
  scripts: ScriptResult[]
  deviationRequested: boolean
  mechanicalAttempts: number
  /** The working tree changed the gate (scripts, test config, package.json test fields) without an approval for that exact change. */
  gateBlocked?: boolean
}

export interface ImplementOptions {
  maxMechanicalRetries: number
  isFix?: boolean
  review?: string
  /** Gate change the human approved on this run's command line; held in memory, never read from disk. */
  approvedGateFingerprint?: string
}

let transcriptSequence = 0

function buildImplementPrompt(planApproved: string, taskId: string, isFix: boolean, review?: string): string {
  // Repo-relative paths, stated explicitly: codex resolves bare filenames to the
  // repo root (observed live), which would put the deviation request somewhere
  // the orchestrator never looks and sweep summaries into the production commit.
  const taskDirRel = `.ai/tasks/${taskId}`
  const summaryFile = isFix ? `${taskDirRel}/fix-summary.md` : `${taskDirRel}/diff-summary.md`
  const lines = [
    isFix
      ? `Fix the implementation based on the review below, then write ${summaryFile} describing what changed and why.`
      : `Implement the approved plan below, then write ${summaryFile} describing what you did and any judgment calls you made.`,
    'Do NOT run git add/commit — your sandbox cannot write .git; subrev commits your work automatically after validation.',
    'If the plan itself is wrong (e.g. references code that does not exist), do NOT silently deviate.',
    `Instead write ${taskDirRel}/deviation-request.md explaining the conflict and stop without further edits.`,
    '',
    '## Approved plan',
    planApproved,
  ]
  if (isFix && review) lines.push('', '## Review to address', review)
  return lines.join('\n')
}

function blockGate(
  repoPath: string,
  taskId: string,
  check: ReturnType<typeof checkGateIntegrity>,
  scripts: ScriptResult[],
  attempts: number,
  note?: string
): ImplementResult {
  const planFiles = extractPlanFiles(readTaskFile(repoPath, taskId, 'plan-approved.md') ?? '')
  writeTaskFile(repoPath, taskId, 'gate-change-report.md', renderGateReport(taskId, check, planFiles, note))
  const meta = readTaskMeta(repoPath, taskId)
  meta.status = 'escalated-gate-change'
  if (check.fingerprint) meta.gateChangeFingerprint = check.fingerprint
  writeTaskMeta(repoPath, meta)
  return { scripts, deviationRequested: false, mechanicalAttempts: attempts, gateBlocked: true }
}

/** The task's base commit: where the task branch left its base branch. */
function gateBase(repoPath: string, taskId: string): string {
  const base = readTaskMeta(repoPath, taskId).baseBranch
  if (!base) {
    // Without a base there is nothing trustworthy to compare the gate with: fail closed.
    throw new Error(`Task ${taskId} has no baseBranch; cannot verify the gate definition.`)
  }
  try {
    return execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
  } catch {
    return base
  }
}

export async function implementAndGate(
  ai: AiRunner,
  repoPath: string,
  taskId: string,
  opts: ImplementOptions
): Promise<ImplementResult> {
  // Before codex runs: if the gate cannot be sandboxed, stop here rather than after codex worked.
  const sandbox = resolveGateSandbox()
  const planApproved = readTaskFile(repoPath, taskId, 'plan-approved.md') ?? ''
  const prompt = buildImplementPrompt(planApproved, taskId, Boolean(opts.isFix), opts.review)
  const deviationPath = path.join(taskDir(repoPath, taskId), 'deviation-request.md')

  let attempts = 0
  let scripts: ScriptResult[] = []

  while (attempts <= opts.maxMechanicalRetries) {
    attempts += 1

    // A deviation-request.md left over from a PREVIOUS attempt (e.g. before an
    // amend-plan + resume cycle) must not be mistaken for a deviation raised on
    // THIS attempt — otherwise a task can never recover from escalated-plan-deviation.
    // Clear it before invoking codex so the existence check below only reflects
    // what happened in this attempt.
    rmSync(deviationPath, { force: true })

    const commitBeforeAttempt = currentCommit(repoPath)
    const transcriptStamp = `${Date.now()}-${++transcriptSequence}-${randomBytes(8).toString('hex')}`

    // Outside the try below on purpose: a failing gate check must escalate, not be retried as a codex crash.
    let codexRan = false
    let gateNote = ''
    try {
      const codexOutput = await ai.codexExec(prompt, repoPath)
      // Persist codex's transcript per attempt — when an attempt produces nothing
      // (wrong sandbox, refusal, misunderstanding), this is the only record of why.
      writeTaskFile(
        repoPath,
        taskId,
        `codex-output-${transcriptStamp}-${commitBeforeAttempt}-attempt-${attempts}.log`,
        codexOutput
      )

      if (existsSync(deviationPath)) {
        const meta = readTaskMeta(repoPath, taskId)
        meta.status = 'escalated-plan-deviation'
        writeTaskMeta(repoPath, meta)
        return { scripts, deviationRequested: true, mechanicalAttempts: attempts }
      }

      codexRan = true
    } catch (error) {
      // codexExec itself failed (subprocess crashed/errored after its own internal
      // retry). Treat this exactly like a red script run: it consumes one mechanical
      // attempt, is recorded in test-log.md, and feeds the same allGreen/escalation
      // path below. There is nothing to test, so runAllScripts is not invoked.
      const message = error instanceof Error ? error.message : String(error)
      scripts = [{ name: 'codex exec', passed: false, output: message }]
    }

    if (codexRan) {
      // A green gate only means something if the implementer did not change the gate. Checked
      // on the working tree, before the scripts run and before anything is committed.
      const base = gateBase(repoPath, taskId)
      const gateCheck = checkGateIntegrity(repoPath, base)
      if (gateCheck.fingerprint && gateCheck.fingerprint !== opts.approvedGateFingerprint) {
        return blockGate(repoPath, taskId, gateCheck, scripts, attempts)
      }
      if (gateCheck.fingerprint) {
        gateNote = `> Gate differs from base (${gateCheck.changes.map((c) => c.path).join(', ')}); running it under human approval ${gateCheck.fingerprint} given on this run's command line.\n\n`
      }
      gateNote += `> ${sandbox.describe(repoPath)}\n\n`
      scripts = runAllScripts(repoPath, sandbox)
      // The gate runs implementer-written code with full user rights; it must not leave the gate
      // different from what was checked (or approved) just before it ran.
      const afterGate = checkGateIntegrity(repoPath, base)
      if (afterGate.fingerprint !== gateCheck.fingerprint) {
        return blockGate(repoPath, taskId, afterGate, scripts, attempts,
          `The gate definition CHANGED WHILE THE GATE WAS RUNNING (before: ${gateCheck.fingerprint ?? 'unchanged from base'}). Its result was discarded and nothing was committed.`)
      }
    }

    writeTaskFile(repoPath, taskId, 'test-log.md', gateNote + formatTestLog(scripts))
    if (allGreen(scripts)) {
      // codex's sandbox mounts .git read-only, so it physically cannot commit —
      // the orchestrator owns the git state transition (as it does for branches,
      // merges, and snapshots) and commits the implementation on codex's behalf.
      if (isWorkingTreeDirty(repoPath)) {
        commitAllChanges(
          repoPath,
          `subrev: ${opts.isFix ? 'fix' : 'implement'} ${taskId} (attempt ${attempts})`
        )
      }
      if (currentCommit(repoPath) === commitBeforeAttempt) {
        throw new Error(
          'codex exec completed but produced no changes and no commit — nothing for review to see'
        )
      }
      return { scripts, deviationRequested: false, mechanicalAttempts: attempts }
    }
  }

  const meta = readTaskMeta(repoPath, taskId)
  meta.status = 'escalated-mechanical'
  writeTaskMeta(repoPath, meta)
  return { scripts, deviationRequested: false, mechanicalAttempts: attempts }
}
