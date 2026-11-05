import { execFileSync } from 'node:child_process'
import type { FileDiff, Hunk } from './diff.js'
import { hunkLocation } from './diff.js'
import { collectSymbols, isJsLike, symbolAt, type SourceSymbol } from './symbols.js'

/**
 * A change group is the unit that layer-2 review classifies and the revert experiment reverts:
 * all hunks in one file that touch the same top-level declaration (or class member). Grouping is
 * deterministic so the review model never decides where one "change" ends and the next begins.
 */
export interface ChangeGroup {
  id: string
  file: string
  symbol: string
  /** 'ast' when the symbol came from parsing the file, 'hunk-context' when from git's heading guess, 'file' for whole-file changes. */
  source: 'ast' | 'hunk-context' | 'file'
  fileStatus: FileDiff['status']
  binary: boolean
  hunkIndexes: number[]
  locations: string[]
  added: number
  removed: number
  fileDiff: FileDiff
}

export function showFile(repoPath: string, rev: string, filePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${rev}:${filePath}`], {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function countLines(h: Hunk, sign: '+' | '-'): number {
  return h.lines.filter((l) => l.startsWith(sign)).length
}

function symbolForHunk(symbols: SourceSymbol[], h: Hunk): SourceSymbol | null {
  // Pure deletion: newStart is the line *after which* lines were removed.
  const probe = h.newLines === 0 ? [h.newStart, h.newStart + 1] : [h.newStart, h.newStart + h.newLines - 1]
  return symbolAt(symbols, probe[0]) ?? symbolAt(symbols, probe[1])
}

/**
 * With zero context, one contiguous edited region is one hunk even when it spans several
 * declarations (e.g. a rewritten function plus an unrelated function appended right after it).
 * Split such hunks so each piece belongs to one symbol: added lines are bucketed by the symbol
 * on their new-side line, removed lines stay with the first piece, and later pieces become pure
 * additions. Every piece stays independently reverse-appliable.
 */
export function splitHunkBySymbols(h: Hunk, symbols: SourceSymbol[]): Hunk[] {
  const plusLines: Array<{ text: string; line: number; noNewline: boolean }> = []
  let newLine = h.newStart
  for (let i = 0; i < h.lines.length; i++) {
    const l = h.lines[i]
    if (l.startsWith('+')) {
      plusLines.push({ text: l, line: newLine++, noNewline: h.lines[i + 1]?.startsWith('\\') === true && h.lines.slice(i + 1).every((x) => !x.startsWith('+')) })
    }
  }
  if (plusLines.length === 0) return [h]
  const names = plusLines.map((p) => symbolAt(symbols, p.line)?.name ?? null)
  // Lines outside any declaration (blank lines, comments between declarations) join the previous piece.
  for (let i = 0; i < names.length; i++) if (names[i] === null) names[i] = i > 0 ? names[i - 1] : null
  for (let i = names.length - 1; i >= 0; i--) if (names[i] === null) names[i] = i < names.length - 1 ? names[i + 1] : '(between declarations)'
  if (names.every((n) => n === names[0])) return [h]

  const pieces: Hunk[] = []
  const oldAnchor = h.oldLines > 0 ? h.oldStart + h.oldLines - 1 : h.oldStart
  let i = 0
  while (i < plusLines.length) {
    let j = i
    while (j + 1 < plusLines.length && names[j + 1] === names[i]) j++
    const chunk = plusLines.slice(i, j + 1)
    const first = pieces.length === 0
    const removedHere = first ? h.lines.filter((l) => l.startsWith('-')) : []
    const removedNoNewline = first && h.lines.some((l, k) => l.startsWith('\\') && h.lines[k - 1]?.startsWith('-'))
    const body = [...removedHere, ...(removedNoNewline ? ['\\ No newline at end of file'] : []), ...chunk.map((c) => c.text), ...(chunk[chunk.length - 1].noNewline ? ['\\ No newline at end of file'] : [])]
    const oldStart = first ? h.oldStart : oldAnchor
    const oldLines = first ? h.oldLines : 0
    const newStart = chunk[0].line
    const newLines = chunk.length
    pieces.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      context: h.context,
      header: `@@ -${oldStart}${oldLines === 1 ? '' : `,${oldLines}`} +${newStart}${newLines === 1 ? '' : `,${newLines}`} @@`,
      lines: body,
    })
    i = j + 1
  }
  return pieces
}

export function groupHunks(repoPath: string, files: FileDiff[], head = 'HEAD'): ChangeGroup[] {
  const groups: ChangeGroup[] = []
  for (let file of files) {
    const base = {
      file: file.path,
      fileStatus: file.status,
      binary: file.binary,
      fileDiff: file,
    }
    if (file.binary || file.hunks.length === 0 || file.status !== 'modified') {
      groups.push({
        ...base,
        id: '',
        symbol: file.status === 'added' ? '(new file)' : file.status === 'deleted' ? '(deleted file)' : '(whole file)',
        source: 'file',
        hunkIndexes: file.hunks.map((_, i) => i),
        locations: file.hunks.length ? file.hunks.map((h) => hunkLocation(file, h)) : [file.path],
        added: file.hunks.reduce((n, h) => n + countLines(h, '+'), 0),
        removed: file.hunks.reduce((n, h) => n + countLines(h, '-'), 0),
      })
      continue
    }
    const content = isJsLike(file.path) ? showFile(repoPath, head, file.path) : null
    const symbols = content !== null ? collectSymbols(content, file.path) : null
    if (symbols) file = { ...file, hunks: file.hunks.flatMap((h) => splitHunkBySymbols(h, symbols)) }
    const fileDiff = file
    const byKey = new Map<string, ChangeGroup>()
    file.hunks.forEach((h, i) => {
      let symbol: string
      let source: ChangeGroup['source']
      if (symbols) {
        symbol = symbolForHunk(symbols, h)?.name ?? '(between declarations)'
        source = 'ast'
      } else if (h.context) {
        symbol = h.context.slice(0, 80)
        source = 'hunk-context'
      } else {
        symbol = `(hunk @${h.newStart})`
        source = 'hunk-context'
      }
      let g = byKey.get(symbol)
      if (!g) {
        g = { ...base, fileDiff, id: '', symbol, source, hunkIndexes: [], locations: [], added: 0, removed: 0 }
        byKey.set(symbol, g)
        groups.push(g)
      }
      g.hunkIndexes.push(i)
      g.locations.push(hunkLocation(fileDiff, h))
      g.added += countLines(h, '+')
      g.removed += countLines(h, '-')
    })
  }
  groups.forEach((g, i) => (g.id = `G${i + 1}`))
  return groups
}

/** The group's own diff text, for showing to a reviewer. */
export function groupDiffText(g: ChangeGroup, maxLines = 120): string {
  const lines: string[] = []
  for (const i of g.hunkIndexes) {
    const h = g.fileDiff.hunks[i]
    lines.push(h.header, ...h.lines)
  }
  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines truncated)`].join('\n')
  }
  return lines.join('\n')
}
