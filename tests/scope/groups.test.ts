import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createTempGitRepo, commitAll, type TempRepo } from '../helpers/tempGitRepo.js'
import { currentCommit } from '../../src/git.js'
import { buildPatch, gitDiffZeroContext, parseUnifiedDiff } from '../../src/scope/diff.js'
import { groupHunks } from '../../src/scope/groups.js'
import { collectSymbols, compareSymbols } from '../../src/scope/symbols.js'

let repo: TempRepo
afterEach(() => repo?.cleanup())

const BEFORE = `import { x } from './x.js'

export function alpha(a) {
  return a + 1
}

export const beta = (b) => {
  return b * 2
}

class Gamma {
  run() { return 1 }
}
`

describe('symbols', () => {
  it('collects top-level declarations, class members and imports', () => {
    const names = collectSymbols(BEFORE, 'a.js').map((s) => `${s.kind}:${s.name}`)
    expect(names).toEqual(expect.arrayContaining(['function:alpha', 'function:beta', 'class:Gamma', 'method:Gamma.run', 'imports:(imports)']))
  })

  it('reports new callables and new branches, not comments that mention "function"', () => {
    const after = BEFORE.replace('return a + 1', '// this function now clamps\n  if (a > 9) return 9\n  return a + 1') +
      '\nexport function delta() { return 0 }\n'
    const s = compareSymbols(collectSymbols(BEFORE, 'a.js'), collectSymbols(after, 'a.js'))
    expect(s.newCallables).toEqual(['delta'])
    expect(s.branchIncreases).toEqual(['alpha'])
    const commentOnly = BEFORE.replace('return b * 2', '// a function-free comment about function\n  return b * 2')
    expect(compareSymbols(collectSymbols(BEFORE, 'a.js'), collectSymbols(commentOnly, 'a.js'))).toEqual({
      newCallables: [], newDeclarations: [], branchIncreases: [],
    })
  })
})

describe('groupHunks', () => {
  it('groups hunks by the declaration they touch and keeps each group revertible on its own', () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'a.js'), BEFORE)
    writeFileSync(path.join(repo.repoPath, 'notes.txt'), 'one\ntwo\n')
    commitAll(repo.repoPath, 'base')
    const base = currentCommit(repo.repoPath)
    writeFileSync(
      path.join(repo.repoPath, 'a.js'),
      BEFORE.replace('return a + 1', 'return a + 2').replace('return b * 2', 'return b * 3').replace('run() { return 1 }', 'run() { return 2 }')
    )
    writeFileSync(path.join(repo.repoPath, 'notes.txt'), 'one\nTWO\n')
    writeFileSync(path.join(repo.repoPath, 'new.js'), 'export const n = 1\n')
    commitAll(repo.repoPath, 'change')

    const files = parseUnifiedDiff(gitDiffZeroContext(repo.repoPath, base))
    const groups = groupHunks(repo.repoPath, files)
    expect(groups.map((g) => `${g.id} ${g.file}::${g.symbol} [${g.source}]`)).toEqual([
      'G1 a.js::alpha [ast]',
      'G2 a.js::beta [ast]',
      'G3 a.js::Gamma.run [ast]',
      'G4 new.js::(new file) [file]',
      'G5 notes.txt::one [hunk-context]', // git's own heading guess for non-JS files,
    ])
    expect(groups[0].locations).toEqual(['a.js:4'])
    const patch = buildPatch([{ file: groups[1].fileDiff, hunkIndexes: groups[1].hunkIndexes }])
    expect(patch).toContain('-  return b * 2')
    expect(patch).not.toContain('return a + 1')
  })
})

describe('groupHunks hunk splitting', () => {
  it('splits one contiguous hunk that spans a changed function and an appended unrelated one, and each piece reverts alone', async () => {
    repo = createTempGitRepo()
    writeFileSync(path.join(repo.repoPath, 'r.js'), 'export function range(a, b) {\n  return []\n}\n')
    commitAll(repo.repoPath, 'base')
    const base = currentCommit(repo.repoPath)
    writeFileSync(
      path.join(repo.repoPath, 'r.js'),
      'export function range(a, b) {\n  const out = []\n  for (let i = a; i < b; i++) out.push(i)\n  return out\n}\n\nexport function formatBytes(n) {\n  return n + " B"\n}\n'
    )
    commitAll(repo.repoPath, 'change')
    const files = parseUnifiedDiff(gitDiffZeroContext(repo.repoPath, base))
    expect(files[0].hunks).toHaveLength(1)
    const groups = groupHunks(repo.repoPath, files)
    expect(groups.map((g) => g.symbol)).toEqual(['range', 'formatBytes'])

    const { execFileSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    for (const [g, mustKeep, mustDrop] of [[groups[1], 'out.push(i)', 'formatBytes'], [groups[0], 'formatBytes', 'out.push(i)']] as const) {
      const patchFile = path.join(repo.repoPath, '..', `${path.basename(repo.repoPath)}-${g.id}.patch`)
      writeFileSync(patchFile, buildPatch([{ file: g.fileDiff, hunkIndexes: g.hunkIndexes }]))
      execFileSync('git', ['apply', '-R', '--unidiff-zero', patchFile], { cwd: repo.repoPath })
      const text = readFileSync(path.join(repo.repoPath, 'r.js'), 'utf8')
      expect(text).toContain(mustKeep)
      expect(text).not.toContain(mustDrop)
      execFileSync('git', ['checkout', '-q', 'HEAD', '--', 'r.js'], { cwd: repo.repoPath })
    }
  })
})

