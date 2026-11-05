// tools/subrev/src/integrity/gateIntegrity.ts
//
// The gate (scripts/check.sh, build.sh, test.sh) lives in the repo the implementer can
// write to, so "all three scripts are green" means nothing if the implementer changed what
// they run. Before every gate run, the working tree's gate definition is compared with the
// task's base commit; any difference blocks the run unless a human approved that exact
// difference (see gateApproval.ts). The scripts themselves are still executed in place,
// because they locate the repo via `dirname "$0"` and must not be moved.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Everything under scripts/ is gate code: test.sh calls helpers such as scripts/validate-knowledge.mjs. */
const GATE_SCRIPT_DIR = /^scripts\//
/** Test-runner configuration: changing it can silently stop tests from being collected. */
const TEST_CONFIG = [
  /(^|\/)(vitest|vite|jest|playwright|cypress|karma|ava)\.config\.[cm]?[jt]s$/,
  /(^|\/)vitest\.workspace\.[cm]?[jt]s$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)pytest\.ini$/,
]
const PACKAGE_JSON = /(^|\/)package\.json$/
/** package.json keys that decide what `npm test` runs or how a runner is configured. */
const TEST_SCRIPT_KEY = /^(pre|post)?test(:.*)?$/
const RUNNER_CONFIG_KEYS = ['jest', 'vitest', 'mocha', 'ava'] as const

export type GateFileKind = 'gate-script' | 'test-config' | 'package-json-test-fields'

export interface GateFileChange {
  path: string
  kind: GateFileKind
  status: 'added' | 'deleted' | 'modified'
  /** Unified diff (scripts/config) or before/after of the test fields (package.json). */
  detail: string
  beforeHash: string | null
  afterHash: string | null
}

export interface GateIntegrityResult {
  base: string
  changes: GateFileChange[]
  /** Identifies this exact set of changes; null when nothing changed. */
  fingerprint: string | null
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function classify(file: string): GateFileKind | null {
  if (GATE_SCRIPT_DIR.test(file)) return 'gate-script'
  if (TEST_CONFIG.some((p) => p.test(file))) return 'test-config'
  if (PACKAGE_JSON.test(file)) return 'package-json-test-fields'
  return null
}

function baseContent(repoPath: string, base: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${base}:${file}`], {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function workingContent(repoPath: string, file: string): string | null {
  const abs = path.join(repoPath, file)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Stable JSON of only the test-relevant fields; unparseable JSON is kept verbatim so it counts as a change. */
function packageTestFields(text: string | null): string | null {
  if (text === null) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return `UNPARSEABLE package.json:\n${text}`
  }
  const scripts = (parsed.scripts ?? {}) as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of Object.keys(scripts).sort()) if (TEST_SCRIPT_KEY.test(key)) picked[`scripts.${key}`] = scripts[key]
  for (const key of RUNNER_CONFIG_KEYS) if (key in parsed) picked[key] = parsed[key]
  return JSON.stringify(picked, null, 2)
}

function unifiedDiff(file: string, before: string | null, after: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'subrev-gatediff-'))
  try {
    const a = path.join(dir, 'before')
    const b = path.join(dir, 'after')
    writeFileSync(a, before ?? '')
    writeFileSync(b, after ?? '')
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return ''
    } catch (error) {
      // `git diff --no-index` exits 1 when the files differ; the diff is on stdout.
      const out = String((error as { stdout?: string }).stdout ?? '')
      return out.replaceAll(a, `a/${file}`).replaceAll(b, `b/${file}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Compare the working tree (committed and uncommitted, tracked and untracked-but-not-ignored)
 * with `base` for every gate-relevant file.
 */
export function checkGateIntegrity(repoPath: string, base: string): GateIntegrityResult {
  const baseFiles = git(repoPath, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean)
  const workFiles = git(repoPath, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
  const candidates = [...new Set([...baseFiles, ...workFiles])].filter((f) => classify(f) !== null).sort()

  const changes: GateFileChange[] = []
  for (const file of candidates) {
    const kind = classify(file)!
    const rawBefore = baseContent(repoPath, base, file)
    const rawAfter = workingContent(repoPath, file)
    const before = kind === 'package-json-test-fields' ? packageTestFields(rawBefore) : rawBefore
    const after = kind === 'package-json-test-fields' ? packageTestFields(rawAfter) : rawAfter
    // For package.json, a file that appears/disappears with no test fields is not a gate change.
    const empty = (v: string | null) => v === null || v === '{}'
    if (kind === 'package-json-test-fields' ? (empty(before) && empty(after)) || before === after : before === after) continue
    const status = rawBefore === null ? 'added' : rawAfter === null ? 'deleted' : 'modified'
    changes.push({
      path: file,
      kind,
      status,
      detail: unifiedDiff(file, before, after),
      beforeHash: before === null ? null : sha(before),
      afterHash: after === null ? null : sha(after),
    })
  }
  const fingerprint = changes.length
    ? sha(JSON.stringify(changes.map((c) => [c.path, c.kind, c.beforeHash, c.afterHash]))).slice(0, 16)
    : null
  return { base, changes, fingerprint }
}

export function renderGateReport(taskId: string, result: GateIntegrityResult, planFiles: string[]): string {
  const lines = [
    `# Gate change blocked — ${taskId}`,
    '',
    `The gate definition in the working tree differs from base \`${result.base.slice(0, 12)}\`. The gate was NOT run and nothing was committed.`,
    '',
    `Fingerprint: \`${result.fingerprint}\``,
    '',
    'To accept exactly these changes after checking them yourself:',
    '',
    '```',
    `subrev approve-gate ${taskId}                      # re-shows the diff from git, not from this file`,
    `subrev approve-gate ${taskId} --fingerprint ${result.fingerprint}`,
    `subrev resume ${taskId}`,
    '```',
    '',
    'Being listed in the plan does not approve a gate change; it is shown below only as context.',
    'Any further change produces a new fingerprint and blocks again.',
    '',
    '| File | Kind | Status | Listed in plan |',
    '| --- | --- | --- | --- |',
    ...result.changes.map((c) => `| ${c.path} | ${c.kind} | ${c.status} | ${planFiles.includes(c.path) ? 'yes' : 'no'} |`),
  ]
  for (const c of result.changes) lines.push('', `## ${c.path}`, '', '```diff', c.detail.trimEnd(), '```')
  return lines.join('\n') + '\n'
}
