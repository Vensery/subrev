import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockAdapter, parseAdapterSpec, parseClaudeJson } from '../../src/eval/adapters.js'
import { DEFAULT_TASKS_DIR } from '../../src/commands/eval.js'
import { buildPrompt, changedPaths, runTrial, snapshotPaths } from '../../src/eval/runner.js'
import { loadTasks } from '../../src/eval/tasks.js'

const [bundle] = loadTasks(DEFAULT_TASKS_DIR, ['implement-slugify'])
const opts = { runId: 'test' }

describe('runTrial with the deterministic mock agent', () => {
  it('solve: passes on the first attempt', async () => {
    const r = await runTrial(bundle, createMockAdapter('solve'), 1, opts)
    expect(r.outcome).toBe('pass')
    expect(r.attemptsToPass).toBe(1)
    expect(r.attempts[0].gatePassed).toBe(true)
  }, 30_000)

  it('retry: fails attempt 1, then passes on attempt 2 using feedback', async () => {
    const r = await runTrial(bundle, createMockAdapter('retry'), 1, opts)
    expect(r.outcome).toBe('pass')
    expect(r.attemptsToPass).toBe(2)
    expect(r.attempts[0].gatePassed).toBe(false)
    expect(r.attempts[0].gateOutputTail).toMatch(/not implemented/)
  }, 30_000)

  it('fail: exhausts the attempt budget', async () => {
    const r = await runTrial(bundle, createMockAdapter('fail'), 1, opts)
    expect(r.outcome).toBe('fail')
    expect(r.attemptsUsed).toBe(bundle.spec.maxAttempts)
    expect(r.attemptsToPass).toBeNull()
  }, 30_000)

  it('tamper: a green gate reached by rewriting the tests is NOT a pass', async () => {
    const r = await runTrial(bundle, createMockAdapter('tamper'), 1, opts)
    expect(r.outcome).toBe('tampered')
    expect(r.passed).toBe(false)
    expect(r.tamperedPaths).toEqual(['test/slugify.test.js'])
    expect(r.attemptsUsed).toBe(1)
  }, 30_000)

  it('flaky: is deterministic per (task, trial) but mixed across trials', async () => {
    const outcomes: string[] = []
    for (let trial = 1; trial <= 6; trial++) {
      outcomes.push((await runTrial(bundle, createMockAdapter('flaky'), trial, opts)).outcome)
    }
    const again: string[] = []
    for (let trial = 1; trial <= 6; trial++) {
      again.push((await runTrial(bundle, createMockAdapter('flaky'), trial, opts)).outcome)
    }
    expect(again).toEqual(outcomes)
    expect(new Set(outcomes).size).toBeGreaterThan(1)
  }, 60_000)

  it('records an agent crash as an error when every attempt crashes', async () => {
    const crashing = { name: 'crash', run: async () => { throw new Error('cli exploded') } }
    const r = await runTrial(bundle, crashing, 1, opts)
    expect(r.outcome).toBe('error')
    expect(r.attempts[0].agentError).toBe('cli exploded')
  }, 30_000)

  it('sums usage across attempts when the adapter reports it', async () => {
    const reporting = {
      name: 'reporting',
      run: async () => ({ stdout: '', usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 } }),
    }
    const r = await runTrial(bundle, reporting, 1, opts)
    expect(r.attemptsUsed).toBe(bundle.spec.maxAttempts)
    expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 40, costUsd: 1 })
  }, 30_000)
})

describe('integrity helpers', () => {
  it('detects changed, removed, and added files under protected paths', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'subrev-snap-'))
    try {
      mkdirSync(path.join(dir, 'test'))
      writeFileSync(path.join(dir, 'test', 'a.js'), 'a')
      writeFileSync(path.join(dir, 'test', 'b.js'), 'b')
      const before = snapshotPaths(dir, ['test'])
      writeFileSync(path.join(dir, 'test', 'a.js'), 'changed')
      rmSync(path.join(dir, 'test', 'b.js'))
      writeFileSync(path.join(dir, 'test', 'c.js'), 'new')
      expect(changedPaths(before, snapshotPaths(dir, ['test']))).toEqual(['test/a.js', 'test/b.js', 'test/c.js'])
      expect(changedPaths(before, before)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildPrompt', () => {
  it('states the gate and protected paths on the first attempt', () => {
    const p = buildPrompt(bundle, 1)
    expect(p).toContain('node --test')
    expect(p).toContain('Do NOT modify')
    expect(p).not.toContain('previous attempt')
  })
  it('feeds the failing gate output back on later attempts', () => {
    expect(buildPrompt(bundle, 2, 'AssertionError: expected 1 to equal 2')).toContain('AssertionError: expected 1 to equal 2')
  })
})

describe('adapter parsing', () => {
  it('parses known specs and rejects unknown ones', () => {
    expect(parseAdapterSpec('mock:solve').name).toBe('mock:solve')
    expect(parseAdapterSpec('claude:opus').name).toBe('claude:opus')
    expect(parseAdapterSpec('codex').name).toBe('codex')
    expect(() => parseAdapterSpec('mock:nope')).toThrow(/unknown mock mode/)
    expect(() => parseAdapterSpec('gpt')).toThrow(/unknown agent/)
  })
  it('extracts usage from claude json output and tolerates plain text', () => {
    const parsed = parseClaudeJson(JSON.stringify({ result: 'done', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 4 } }))
    expect(parsed.stdout).toBe('done')
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4, costUsd: 0.12 })
    expect(parseClaudeJson('just text')).toEqual({ stdout: 'just text' })
  })
})
