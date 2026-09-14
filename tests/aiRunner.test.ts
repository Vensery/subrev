import { describe, it, expect } from 'vitest'
import os from 'node:os'
import { runProcess, runWithRetry, createSubprocessAiRunner } from '../src/aiRunner.js'
import { FakeAiRunner } from '../src/testing/fakeAiRunner.js'

describe('runProcess', () => {
  it('resolves with stdout on success', async () => {
    const output = await runProcess(process.execPath, ['-e', 'process.stdout.write("hi")'], os.tmpdir(), 5000)
    expect(output).toBe('hi')
  })

  it('rejects on non-zero exit code', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.exit(1)'], os.tmpdir(), 5000)
    ).rejects.toThrow()
  })

  it('rejects on timeout', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], os.tmpdir(), 100)
    ).rejects.toThrow(/timed out/)
  })
})

describe('runWithRetry', () => {
  it('retries once before succeeding', async () => {
    let attempts = 0
    const result = await runWithRetry(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('fail once')
      return 'ok'
    }, 1)
    expect(result).toBe('ok')
    expect(attempts).toBe(2)
  })

  it('throws after exhausting retries', async () => {
    await expect(runWithRetry(async () => { throw new Error('always fails') }, 1)).rejects.toThrow('always fails')
  })
})

describe('createSubprocessAiRunner', () => {
  it('exposes the AiRunner contract', () => {
    const runner = createSubprocessAiRunner({ plan: 'default', review: 'default' })
    expect(typeof runner.claudePlan).toBe('function')
    expect(typeof runner.claudeReview).toBe('function')
    expect(typeof runner.codexExec).toBe('function')
  })
})

describe('FakeAiRunner', () => {
  it('serves scripted responses in order and runs codex effects', async () => {
    const fake = new FakeAiRunner()
    fake.planResponses.push('plan text')
    fake.reviewResponses.push('VERDICT: PASS')
    let effectRan = false
    fake.codexEffects.push(() => { effectRan = true })

    expect(await fake.claudePlan('prompt', '/cwd')).toBe('plan text')
    expect(await fake.claudeReview('prompt', '/cwd')).toBe('VERDICT: PASS')
    await fake.codexExec('prompt', '/cwd')
    expect(effectRan).toBe(true)
  })

  it('throws once its scripted queue is exhausted', async () => {
    const fake = new FakeAiRunner()
    await expect(fake.claudePlan('p', '/cwd')).rejects.toThrow(/no more/)
  })
})
