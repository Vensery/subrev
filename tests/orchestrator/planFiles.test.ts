import { describe, it, expect } from 'vitest'
import { extractPlanFiles } from '../../src/orchestrator/planFiles.js'

describe('extractPlanFiles', () => {
  it('extracts bullet items under the Files section', () => {
    const plan = '## Files\n- src/a.ts\n- src/b.ts\n\n## Acceptance criteria\n\n1. thing\n'
    expect(extractPlanFiles(plan)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('returns an empty array when there is no Files section', () => {
    expect(extractPlanFiles('## Acceptance criteria\n\n1. thing\n')).toEqual([])
  })
})
