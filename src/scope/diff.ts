import { execFileSync } from 'node:child_process'

/**
 * Minimal unified-diff model for `git diff -U0 --no-renames`. Zero context lines keep every hunk
 * independent, so any subset of hunks can be reverse-applied on its own (`git apply -R
 * --unidiff-zero`), which is what the revert experiment in ablation.ts relies on.
 */

export interface Hunk {
  /** 1-based start line and line count on the old (base) side. */
  oldStart: number
  oldLines: number
  /** 1-based start line and line count on the new (HEAD) side. */
  newStart: number
  newLines: number
  /** Text git prints after the second @@ (its guess at the enclosing function). */
  context: string
  header: string
  /** Body lines, each still prefixed with '+', '-' or '\'. */
  lines: string[]
}

export interface FileDiff {
  /** Path on the new side, or the old path for deletions. */
  path: string
  oldPath: string | null
  newPath: string | null
  status: 'added' | 'deleted' | 'modified'
  binary: boolean
  /** The "diff --git ..." header block up to (not including) the first hunk. */
  headerLines: string[]
  hunks: Hunk[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | null = null
  let hunk: Hunk | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      current = {
        path: m ? m[2] : line,
        oldPath: m ? m[1] : null,
        newPath: m ? m[2] : null,
        status: 'modified',
        binary: false,
        headerLines: [line],
        hunks: [],
      }
      hunk = null
      files.push(current)
      continue
    }
    if (!current) continue
    const hm = line.match(HUNK_HEADER)
    if (hm) {
      hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        context: hm[5].trim(),
        header: line,
        lines: [],
      }
      current.hunks.push(hunk)
      continue
    }
    if (hunk) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\')) {
        hunk.lines.push(line)
      }
      continue
    }
    current.headerLines.push(line)
    if (line.startsWith('new file mode')) current.status = 'added'
    else if (line.startsWith('deleted file mode')) current.status = 'deleted'
    else if (line.startsWith('Binary files') || line === 'GIT binary patch') current.binary = true
    else if (line.startsWith('--- ')) current.oldPath = stripPrefix(line.slice(4).trim())
    else if (line.startsWith('+++ ')) current.newPath = stripPrefix(line.slice(4).trim())
  }
  for (const f of files) {
    f.path = f.newPath ?? f.oldPath ?? f.path
  }
  return files
}

export function gitDiffZeroContext(repoPath: string, base: string, head = 'HEAD'): string {
  return execFileSync(
    'git',
    ['-c', 'color.ui=false', 'diff', '-U0', '--no-renames', '--no-ext-diff', `${base}...${head}`],
    { cwd: repoPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
}

/** Build a patch containing only the selected hunks of each file (by index). */
export function buildPatch(selection: Array<{ file: FileDiff; hunkIndexes: number[] }>): string {
  const out: string[] = []
  for (const { file, hunkIndexes } of selection) {
    if (hunkIndexes.length === 0) continue
    out.push(...file.headerLines)
    for (const i of [...hunkIndexes].sort((a, b) => a - b)) {
      const h = file.hunks[i]
      out.push(h.header, ...h.lines)
    }
  }
  return out.length ? out.join('\n') + '\n' : ''
}

export function hunkAddedText(h: Hunk): string {
  return h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n')
}

/** Human-facing location for a hunk on the new side, e.g. "src/a.ts:12-20" or "src/a.ts:-7" for a pure deletion. */
export function hunkLocation(file: FileDiff, h: Hunk): string {
  if (h.newLines === 0) return `${file.path}:-${h.oldStart}`
  const end = h.newStart + h.newLines - 1
  return end === h.newStart ? `${file.path}:${h.newStart}` : `${file.path}:${h.newStart}-${end}`
}
