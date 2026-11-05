import { FIX_REVIEW_PREFIX } from '../../src/aiRunner.js'
import { describe, it, expect } from 'vitest'
import { cpSync } from 'node:fs'
import { DEFAULT_TASKS_DIR } from '../../src/commands/eval.js'
import { parseAdapterSpec } from '../../src/eval/adapters.js'
import { createPipelineAdapter, parsePipelineSpec, StageRecorder } from '../../src/eval/pipelineAdapter.js'
import { runTrial } from '../../src/eval/runner.js'
import { loadTasks } from '../../src/eval/tasks.js'
import type { AiRunner } from '../../src/aiRunner.js'

const [bundle] = loadTasks(DEFAULT_TASKS_DIR, ['fix-off-by-one-range'])

describe('parsePipelineSpec', () => {
  it('parses flags and rejects unknown options', () => {
    expect(parsePipelineSpec('impl=claude,model=sonnet,noplan,layered,rounds=2')).toMatchObject({
      impl: 'claude', model: 'sonnet', plan: false, review: true, scopeCheck: 'layered', rounds: 2,
    })
    expect(() => parsePipelineSpec('turbo')).toThrow(/unknown option "turbo"/)
    expect(parseAdapterSpec('subrev:mock').ownsRetries).toBe(true)
  })
})

describe('subrev pipeline adapter', () => {
  it('runs plan -> approve -> implement -> review once per trial and records per-stage cost', async () => {
    const r = await runTrial(bundle, createPipelineAdapter('mock'), 1, { runId: 't' })
    expect(r.outcome).toBe('pass')
    expect(r.attemptsUsed).toBe(1)
    expect(r.pipeline).toMatchObject({ status: 'awaiting-judgment', reviewRounds: 1, escalations: 0 })
    expect(r.stages?.map((s) => s.stage).sort()).toEqual(['audit', 'implement', 'plan', 'review'])
  }, 60_000)

  it('the eval gate, not the pipeline verdict, decides the outcome', async () => {
    // Reviewer always PASSes, implementer does nothing useful: the pipeline thinks it is done.
    const lazy = (): AiRunner => ({
      claudePlan: async () => '## Files\n\n## Acceptance criteria\n\n- AC-1: range excludes end\n',
      claudeReview: async () => 'VERDICT: PASS',
      claudeAudit: async () => 'CONSISTENCY: CONSISTENT',
      codexExec: async () => 'did nothing',
    })
    const r = await runTrial(bundle, createPipelineAdapter(undefined, lazy), 1, { runId: 't' })
    expect(r.passed).toBe(false)
  }, 60_000)

  it('noreview ablation skips the review stage; scope-layered with an injected creep escalates', async () => {
    const noreview = await runTrial(bundle, createPipelineAdapter('mock,noreview'), 1, { runId: 't' })
    expect(noreview.outcome).toBe('pass')
    expect(noreview.stages?.map((s) => s.stage)).not.toContain('review')

    let codexCalls = 0
    const creepy = (request: Parameters<NonNullable<Parameters<typeof createPipelineAdapter>[1]>>[0]): AiRunner => ({
      claudePlan: async () => '## Files\n- src/range.js\n\n## Acceptance criteria\n\n- AC-1: range(start, end) excludes end\n',
      claudeReview: async (prompt) =>
        prompt.startsWith('You are auditing')
          ? '```json\n' + JSON.stringify({ groups: [...prompt.matchAll(/^### (G\d+) /gm)].map((m) => ({ group: m[1], category: 'unmapped', acceptance: [], hunks: [], counterfactual: '', reason: 'not asked for' })) }) + '\n```'
          : codexCalls === 1 ? 'VERDICT: FAIL' : 'VERDICT: PASS',
      claudeAudit: async () => 'CONSISTENCY: CONSISTENT',
      codexExec: async (_p, cwd) => {
        codexCalls++
        if (codexCalls === 1) cpSync(request.referenceDir!, cwd, { recursive: true, force: true })
        else {
          const { appendFileSync } = await import('node:fs')
          appendFileSync(`${cwd}/src/range.js`, '\nexport function sneaky(x) {\n  if (x) return 1\n  return 0\n}\n')
        }
        return 'ok'
      },
    })
    const r = await runTrial(bundle, createPipelineAdapter('layered', creepy), 1, { runId: 't' })
    expect(r.pipeline?.scopeEscalations).toBe(1)
    expect(r.pipeline?.reviewRounds).toBe(2)
    expect(r.stages?.map((s) => s.stage)).toContain('scope')
  }, 60_000)
})

describe('fix re-review accounting', () => {
  it('nofixreview selects the previous fix-review policy; the default re-reviews non-test fixes', () => {
    expect(parsePipelineSpec('').fixReview).toBe('non-test')
    expect(parsePipelineSpec('nofixreview').fixReview).toBe('scope-only')
  })

  it('StageRecorder attributes fix re-reviews to their own stage', async () => {
    const recorder = new StageRecorder()
    const ai = recorder.wrap({
      claudePlan: async () => '',
      claudeReview: async () => 'VERDICT: PASS',
      claudeAudit: async () => 'CONSISTENCY: CONSISTENT',
      codexExec: async () => '',
    })
    await ai.claudeReview('This is PHASE 1', '/x')
    await ai.claudeReview(`${FIX_REVIEW_PREFIX}\nThis is PHASE 1`, '/x')
    await ai.claudeReview('You are auditing a code change for scope creep. ...', '/x')
    expect(recorder.list().map((s) => s.stage).sort()).toEqual(['fix-review', 'review', 'scope'])
  })
})
