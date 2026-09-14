import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadModelTiers } from '../src/cli.js'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function makeRepo(): string {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'subrev-test-'))
  tempDirs.push(repoPath)
  return repoPath
}

describe('loadModelTiers', () => {
  it('loads both tiers from PROTOCOL.md', () => {
    const repoPath = makeRepo()
    mkdirSync(path.join(repoPath, '.ai'), { recursive: true })
    writeFileSync(
      path.join(repoPath, '.ai', 'PROTOCOL.md'),
      ['# subrev PROTOCOL', '', '## Model tiers', '- plan: opus', '- review: opus', ''].join('\n'),
      'utf8',
    )

    expect(loadModelTiers(repoPath)).toEqual({ plan: 'opus', review: 'opus' })
  })

  it('defaults when PROTOCOL.md is missing', () => {
    const repoPath = makeRepo()

    expect(loadModelTiers(repoPath)).toEqual({ plan: 'default', review: 'default' })
  })

  it('defaults when the Model tiers heading is absent', () => {
    const repoPath = makeRepo()
    mkdirSync(path.join(repoPath, '.ai'), { recursive: true })
    writeFileSync(path.join(repoPath, '.ai', 'PROTOCOL.md'), ['# subrev PROTOCOL', '', '## Other section', '- plan: opus'].join('\n'), 'utf8')

    expect(loadModelTiers(repoPath)).toEqual({ plan: 'default', review: 'default' })
  })

  it('defaults missing tiers independently', () => {
    const repoPath = makeRepo()
    mkdirSync(path.join(repoPath, '.ai'), { recursive: true })
    writeFileSync(
      path.join(repoPath, '.ai', 'PROTOCOL.md'),
      ['# subrev PROTOCOL', '', '## Model tiers', '- plan:  opus  ', '', '## Something else'].join('\n'),
      'utf8',
    )

    expect(loadModelTiers(repoPath)).toEqual({ plan: 'opus', review: 'default' })
  })

  it('defaults missing plan independently when only review is present', () => {
    const repoPath = makeRepo()
    mkdirSync(path.join(repoPath, '.ai'), { recursive: true })
    writeFileSync(
      path.join(repoPath, '.ai', 'PROTOCOL.md'),
      ['# subrev PROTOCOL', '', '## Model tiers', '- review:  opus  ', '', '## Something else'].join('\n'),
      'utf8',
    )

    expect(loadModelTiers(repoPath)).toEqual({ plan: 'default', review: 'opus' })
  })
})
