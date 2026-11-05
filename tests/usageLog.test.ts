import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scaffoldTask, type TaskMeta } from '../src/taskStore.js'
import { createUsageLogger, readUsageLog, summarizeUsage, formatUsageSummary } from '../src/usageLog.js'
import { createSubprocessAiRunner, FIX_REVIEW_PREFIX, type CallRecord } from '../src/aiRunner.js'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function seed(taskId: string): void {
  const meta: TaskMeta = {
    taskId, project: 'p', repoKey: 'r', branch: `task/${taskId}`, status: 'in-progress', round: 2,
    planVersion: 1, retrospectivePending: false, createdAt: '2026-11-04T00:00:00.000Z',
  }
  scaffoldTask(dir, meta, 'brief')
}

describe('usage log', () => {
  it('appends one line per call with the current round, and summarizes per stage', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'subrev-usage-'))
    seed('t1')
    seed('t2')
    const log1 = createUsageLogger(dir, 't1')
    log1({ stage: 'review', ms: 100_000, ok: true, costUsd: 0.4 })
    log1({ stage: 'fix-review', ms: 50_000, ok: true, costUsd: 0.2 })
    log1({ stage: 'implement', ms: 50_000, ok: true })
    createUsageLogger(dir, 't2')({ stage: 'review', ms: 100_000, ok: true, costUsd: 0.4 })

    expect(readUsageLog(dir, 't1')).toHaveLength(3)
    expect(readUsageLog(dir, 't1')[0].round).toBe(2)

    const all = summarizeUsage(dir)
    expect(all.tasks).toBe(2)
    expect(all.stages.map((s) => s.stage)).toEqual(['implement', 'review', 'fix-review'])
    const review = all.stages.find((s) => s.stage === 'review')!
    expect(review).toMatchObject({ calls: 2, tasks: 2, totalMs: 200_000, callsWithCost: 2 })
    expect(review.costUsd).toBeCloseTo(0.8)
    expect(all.totalCostUsd).toBeCloseTo(1.0)

    const text = formatUsageSummary(all)
    expect(text).toContain('Fix re-reviews: 1 call(s) in 1 task(s); 16.7% of AI time, 20.0% of cost.')
    expect(summarizeUsage(dir, ['t2']).stages.map((s) => s.stage)).toEqual(['review'])
  })

  it('says so when nothing has been logged yet', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'subrev-usage-'))
    seed('t1')
    expect(formatUsageSummary(summarizeUsage(dir))).toContain('No ai-calls.jsonl found yet')
  })
})

describe('createSubprocessAiRunner usage observer', () => {
  it('asks claude for JSON, returns the result text, and reports stage, time and cost per call', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'subrev-shim-'))
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    // Shim CLI: echoes its own argv back inside the JSON result so the test can check the flags.
    writeFileSync(
      path.join(bin, 'claude'),
      `#!/usr/bin/env node\nconst a = process.argv.slice(2)\nprocess.stdout.write(JSON.stringify({ result: 'ARGS ' + JSON.stringify(a), total_cost_usd: 0.25, usage: { input_tokens: 1000, output_tokens: 50 } }))\n`
    )
    chmodSync(path.join(bin, 'claude'), 0o755)
    const records: CallRecord[] = []
    const oldPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`
    try {
      const ai = createSubprocessAiRunner({ plan: 'p-model', review: 'r-model' }, 10_000, (r) => records.push(r))
      const out = await ai.claudeReview(`${FIX_REVIEW_PREFIX}\nreview this`, dir, { denyReadPaths: ['/repo/.ai'] })
      const args = JSON.parse(out.slice('ARGS '.length)) as string[]
      expect(args.slice(0, 2)).toEqual(['--output-format', 'json'])
      expect(args).toContain('r-model')
      expect(args.slice(-3)).toEqual(['--disallowedTools', 'Bash', 'Read(//repo/.ai/**)'])
      await ai.claudeAudit('audit this', dir)
    } finally {
      process.env.PATH = oldPath
    }
    expect(records.map((r) => r.stage)).toEqual(['fix-review', 'audit'])
    expect(records[0]).toMatchObject({ ok: true, costUsd: 0.25, inputTokens: 1000, outputTokens: 50 })
    expect(records[0].ms).toBeGreaterThanOrEqual(0)
  })
})
