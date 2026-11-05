import { describe, it, expect } from 'vitest'
import { DEFAULT_TASKS_DIR } from '../../src/commands/eval.js'
import { createScopeReviewer, renderScopeEval, runScopeCase, runScopeEval } from '../../src/eval/scopeEval.js'
import { loadTasks } from '../../src/eval/tasks.js'

const [range] = loadTasks(DEFAULT_TASKS_DIR, ['fix-off-by-one-range'])

describe('scope-detector eval', () => {
  it('flags injected creep and leaves the clean reference alone (revert-only detector)', async () => {
    const clean = await runScopeCase(range, 'clean', 1, null)
    expect(clean.error).toBeUndefined()
    expect(clean.flagged.layer1).toBe(false)
    expect(clean.flagged['revert-only']).toBe(false)
    expect(clean.flagged.layered).toBeNull()

    const extra = await runScopeCase(range, 'extra-export', 1, createScopeReviewer('mock:strict'))
    expect(extra.flagged.layer1).toBe(true)
    expect(extra.flagged['revert-only']).toBe(true)
    expect(extra.flagged.layered).toBe(true)
    expect(extra.groupDecisions.map((g) => g.where)).toContain('src/range.js :: formatBytes')
  }, 60_000)

  it('renders recall and false-positive rates with intervals', async () => {
    const results = await runScopeEval([range], { reviewer: createScopeReviewer('mock:lenient'), kinds: ['clean', 'config-edit'] })
    const md = renderScopeEval(results, 'mock:lenient')
    expect(md).toMatch(/\| revert-only \| 1\/1 \(100%\) \|/)
    expect(md).toMatch(/\| layered \| 0\/1 \(0%\) \|/)
    expect(md).toContain('upper bound')
  }, 60_000)

  it('rejects unknown reviewers', () => {
    expect(() => createScopeReviewer('mock:sometimes')).toThrow(/unknown mock reviewer/)
  })
})
