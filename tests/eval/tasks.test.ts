import { describe, it, expect } from 'vitest'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_TASKS_DIR } from '../../src/commands/eval.js'
import { runGate } from '../../src/eval/runner.js'
import { loadTasks, validateSpec } from '../../src/eval/tasks.js'

describe('validateSpec', () => {
  const ok = { id: 'x', title: 't', prompt: 'p', gate: 'true', protectedPaths: [], maxAttempts: 1 }
  it('accepts a valid spec', () => expect(validateSpec(ok, 'x').id).toBe('x'))
  it('rejects a mismatched id', () => expect(() => validateSpec(ok, 'y')).toThrow(/match the directory/))
  it('rejects a bad maxAttempts', () => expect(() => validateSpec({ ...ok, maxAttempts: 0 }, 'x')).toThrow(/maxAttempts/))
  it('rejects missing strings', () => expect(() => validateSpec({ ...ok, gate: '' }, 'x')).toThrow(/gate/))
})

describe('starter tasks verify their own gate', () => {
  const bundles = loadTasks(DEFAULT_TASKS_DIR)

  it('ships at least five tasks, each with a reference solution', () => {
    expect(bundles.length).toBeGreaterThanOrEqual(5)
    for (const b of bundles) expect(b.referenceDir, b.spec.id).toBeDefined()
  })

  for (const bundle of bundles) {
    it(`${bundle.spec.id}: gate is red on the fixture and green with the reference`, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'subrev-gatecheck-'))
      try {
        cpSync(bundle.fixtureDir, dir, { recursive: true })
        expect(runGate(dir, bundle.spec.gate, 60_000).passed).toBe(false)
        cpSync(bundle.referenceDir!, dir, { recursive: true, force: true })
        const green = runGate(dir, bundle.spec.gate, 60_000)
        expect(green.passed, green.output).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)
  }

  it('rejects unknown task ids', () => expect(() => loadTasks(DEFAULT_TASKS_DIR, ['nope'])).toThrow(/unknown task/))
})
