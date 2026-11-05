// tools/subrev/src/orchestrator/judgmentBrief.ts
//
// What a human needs at the awaiting-judgment gate. The reviewer is told not to judge
// business logic, so whatever the fixes changed in non-test code has to be put in front of
// the human explicitly rather than left for them to dig out of the full diff.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { readTaskFile, readTaskMeta, taskDir, writeTaskFile } from '../taskStore.js'

function reviewFile(round: number): string {
  return round === 1 ? 'review.md' : `review-${round}.md`
}

interface FixRow {
  round: number
  decision: string
  reReviewedIn: string | null
  declarations: string[]
  codeFiles: string[]
}

function readFixRows(repoPath: string, taskId: string, lastRound: number): FixRow[] {
  const rows: FixRow[] = []
  for (let round = 1; round <= lastRound; round++) {
    const text = readTaskFile(repoPath, taskId, `fix-round-${round}.md`)
    if (text === null) continue
    const decision = text.match(/^Decision: \*\*(.+?)\*\*/m)?.[1] ?? 'unknown'
    const next = reviewFile(round + 1)
    const reReviewedIn = existsSync(path.join(taskDir(repoPath, taskId), next)) ? next : null
    const declSection = text.split('## Changed declarations in non-test files')[1] ?? ''
    const declarations = declSection.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
    const codeFiles = text
      .split('\n')
      .filter((l) => /^\| .+ \| code \| /.test(l))
      .map((l) => l.split('|')[1].trim())
    rows.push({ round, decision, reReviewedIn, declarations, codeFiles })
  }
  return rows
}

export function renderJudgmentBrief(repoPath: string, taskId: string): string {
  const meta = readTaskMeta(repoPath, taskId)
  const rows = readFixRows(repoPath, taskId, meta.round)
  const warnings: string[] = []

  if (meta.unreviewedFixRound !== undefined) {
    warnings.push(
      `The last review (${reviewFile(meta.unreviewedFixRound)}) FAILED, and the fix after it was **not re-reviewed** ` +
        `(see fix-round-${meta.unreviewedFixRound}.md). Check that it really addresses every finding.`
    )
  }
  for (const r of rows) {
    if (r.codeFiles.length > 0) {
      warnings.push(
        `Fix after round ${r.round} changed non-test code (${r.codeFiles.join(', ')}). The reviewer does not judge ` +
          `business logic: read fix-round-${r.round}.patch and decide whether those behaviour changes are wanted.`
      )
    }
  }
  const dir = taskDir(repoPath, taskId)
  const integrityFiles = existsSync(dir) ? readdirSync(dir).filter((f) => /^test-integrity-.+\.md$/.test(f)).sort() : []
  for (const f of integrityFiles) {
    const text = readTaskFile(repoPath, taskId, f) ?? ''
    if (!text.includes('FLAGGED')) continue
    const findings = text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
    warnings.push(`Tests may have been weakened (${f}): ${findings.join('; ')}. The reviewer saw this; check its verdict covered each item.`)
  }
  if (meta.auditResult && meta.auditResult !== 'consistent') {
    warnings.push(`Report audit: ${meta.auditResult} (auxiliary signal; see the latest *-audit.md).`)
  }
  if (meta.undisclosedFileCount) {
    warnings.push(`${meta.undisclosedFileCount} changed file(s) are not mentioned in any implementer report.`)
  }

  const lines = [
    `# Judgment brief — ${taskId}`,
    '',
    `- Review rounds: ${meta.round}; last verdict: **${meta.lastVerdict ?? 'unknown'}** (${reviewFile(meta.round)})`,
    `- Fixes applied: ${meta.fixCount ?? 0}`,
    `- Report audit: ${meta.auditResult ?? 'not run'}`,
    '',
    '## Look at these first',
    '',
    ...(warnings.length ? warnings.map((w) => `- ⚠ ${w}`) : ['- Nothing flagged. Business logic is still yours to judge.']),
  ]
  if (rows.length) {
    lines.push(
      '',
      '## Fixes',
      '',
      '| After round | Decision | Re-reviewed in | Non-test files | Patch |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map(
        (r) =>
          `| ${r.round} | ${r.decision} | ${r.reReviewedIn ?? '— (not re-reviewed)'} | ${r.codeFiles.length ? r.codeFiles.join(', ') : '–'} | fix-round-${r.round}.patch |`
      )
    )
    const decl = rows.flatMap((r) => r.declarations.map((d) => `- (after round ${r.round}) ${d}`))
    if (decl.length) lines.push('', '## Declarations changed by fixes (non-test)', '', ...decl)
  }
  return lines.join('\n') + '\n'
}

export function writeJudgmentBrief(repoPath: string, taskId: string): void {
  writeTaskFile(repoPath, taskId, 'judgment-brief.md', renderJudgmentBrief(repoPath, taskId))
}
