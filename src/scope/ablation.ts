import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AcceptanceCriterion } from '../acceptance.js'
import { allGreen, formatTestLog, runAllScripts } from '../scripts.js'
import { buildPatch } from './diff.js'
import { showFile, type ChangeGroup } from './groups.js'
import { collectSymbols } from './symbols.js'

/**
 * Revert experiment: for each change group, reverse-apply only that group's hunks to the working
 * tree, run the gate, and restore. If the gate turns red, the tests depend on that change — hard
 * evidence that it is load-bearing, which no amount of model reasoning can provide. If the gate
 * stays green, the change is not required by any test; that is NOT proof of scope creep (tests
 * are incomplete, and imports or types may be needed only at build time), so a green revert is
 * passed to layer-2 review as "unverified" rather than treated as a verdict.
 */

export interface GateRun {
  passed: boolean
  output: string
}

export type GateFn = (cwd: string) => GateRun

export const scriptsGate: GateFn = (cwd) => {
  const results = runAllScripts(cwd)
  return { passed: allGreen(results), output: formatTestLog(results) }
}

export interface GroupAblation {
  group: string
  /** null when the experiment did not run for this group (binary, budget, apply failure). */
  loadBearing: boolean | null
  note?: string
  /** AC ids whose bound tests ("[tests: ...]") appear in the red gate output. A hint, not proof. */
  implicatedAcs: string[]
  outputTail: string
}

export interface AblationReport {
  ran: boolean
  skippedReason?: string
  results: GroupAblation[]
  gateRuns: number
}

export interface AblationOptions {
  gate?: GateFn
  /** Upper bound on gate runs spent on reverts (the baseline run is extra). */
  maxGroups?: number
  acceptance?: AcceptanceCriterion[]
  /**
   * Revision the diff starts from. When given, a JS/TS group is reverted at symbol level
   * (the declaration's old text is put back, or a new declaration is removed whole) instead of by
   * reverse-applying hunks: git's line alignment often hands a new function's closing brace to
   * the neighbouring hunk, so a hunk-level revert of "just the new function" leaves a stray brace
   * and turns the gate red for the wrong reason.
   */
  baseRev?: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function trackedDirty(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no']).trim().length > 0
}

function restore(cwd: string, group: ChangeGroup): void {
  if (group.fileStatus === 'deleted') {
    // Reverse-applying a deletion re-creates a file HEAD does not track.
    rmSync(path.join(cwd, group.file), { force: true })
  } else {
    git(cwd, ['checkout', '-q', 'HEAD', '--', group.file])
  }
  if (trackedDirty(cwd)) git(cwd, ['checkout', '-q', 'HEAD', '--', '.'])
}

/** Returns true when the symbol-level revert was applied; false means fall back to the patch. */
function revertSymbol(repoPath: string, g: ChangeGroup, baseRev: string): boolean {
  if (g.source !== 'ast' || g.symbol.startsWith('(')) return false
  const file = path.join(repoPath, g.file)
  const head = readFileSync(file, 'utf8')
  const headHits = collectSymbols(head, g.file).filter((s) => s.name === g.symbol)
  if (headHits.length !== 1) return false
  const old = showFile(repoPath, baseRev, g.file)
  const oldHits = old === null ? [] : collectSymbols(old, g.file).filter((s) => s.name === g.symbol)
  if (oldHits.length > 1) return false
  const lines = head.split('\n')
  const [h] = headHits
  const replacement = oldHits.length === 1 ? old!.split('\n').slice(oldHits[0].startLine - 1, oldHits[0].endLine) : []
  lines.splice(h.startLine - 1, h.endLine - h.startLine + 1, ...replacement)
  writeFileSync(file, lines.join('\n'))
  return true
}

function implicated(output: string, acceptance: AcceptanceCriterion[] | undefined): string[] {
  if (!acceptance) return []
  return acceptance.filter((ac) => ac.tests.some((t) => t.length >= 3 && output.includes(t))).map((ac) => ac.id)
}

export function runRevertAblation(repoPath: string, groups: ChangeGroup[], opts: AblationOptions = {}): AblationReport {
  const gate = opts.gate ?? scriptsGate
  const maxGroups = opts.maxGroups ?? 12
  if (trackedDirty(repoPath)) {
    return { ran: false, skippedReason: 'working tree has uncommitted tracked changes', results: [], gateRuns: 0 }
  }
  const baseline = gate(repoPath)
  if (!baseline.passed) {
    return { ran: false, skippedReason: 'gate is not green at HEAD, so a red revert would prove nothing', results: [], gateRuns: 1 }
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'subrev-ablation-'))
  const results: GroupAblation[] = []
  let gateRuns = 1
  try {
    for (const g of groups) {
      const base: GroupAblation = { group: g.id, loadBearing: null, implicatedAcs: [], outputTail: '' }
      if (g.binary || g.hunkIndexes.length === 0) {
        results.push({ ...base, note: 'binary or empty change; not reverted' })
        continue
      }
      if (gateRuns - 1 >= maxGroups) {
        results.push({ ...base, note: `revert budget of ${maxGroups} gate runs used up` })
        continue
      }
      let applied = false
      try {
        applied = opts.baseRev !== undefined && revertSymbol(repoPath, g, opts.baseRev)
      } catch {
        restore(repoPath, g)
        applied = false
      }
      if (!applied) {
        const patchFile = path.join(tmp, `${g.id}.patch`)
        writeFileSync(patchFile, buildPatch([{ file: g.fileDiff, hunkIndexes: g.hunkIndexes }]))
        try {
          git(repoPath, ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', patchFile])
        } catch (error) {
          const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
          results.push({ ...base, note: `reverse patch did not apply: ${reason}` })
          restore(repoPath, g)
          continue
        }
      }
      try {
        const run = gate(repoPath)
        gateRuns += 1
        results.push({
          ...base,
          loadBearing: !run.passed,
          implicatedAcs: run.passed ? [] : implicated(run.output, opts.acceptance),
          outputTail: run.passed ? '' : run.output.slice(-1500),
        })
      } finally {
        restore(repoPath, g)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (trackedDirty(repoPath)) throw new Error('revert experiment could not restore the working tree to HEAD')
  return { ran: true, results, gateRuns }
}
