import { describe, it, expect } from 'vitest'
import { diffCriteria, normalizePlanAcceptance, parseAcceptanceCriteria } from '../src/acceptance.js'

describe('parseAcceptanceCriteria', () => {
  it('reads explicit ids, test bindings and continuation lines', () => {
    const plan = [
      '## Files', '- a.ts', '',
      '## Acceptance criteria', '',
      '- AC-1: parses hours and minutes [tests: parses 1h30m, duration.test.js]',
      '- AC-2: throws RangeError for',
      '  strings that contain spaces',
      '',
      '## Notes', 'ignored',
    ].join('\n')
    const parsed = parseAcceptanceCriteria(plan)
    expect(parsed.errors).toEqual([])
    expect(parsed.criteria).toEqual([
      { id: 'AC-1', text: 'parses hours and minutes', tests: ['parses 1h30m', 'duration.test.js'], implicit: false },
      { id: 'AC-2', text: 'throws RangeError for strings that contain spaces', tests: [], implicit: false },
    ])
  })

  it('numbers a plain list by position and flags duplicates', () => {
    expect(parseAcceptanceCriteria('## Acceptance criteria\n1. first thing\n2. second thing\n').criteria.map((c) => c.id))
      .toEqual(['AC-1', 'AC-2'])
    expect(parseAcceptanceCriteria('## Acceptance criteria\n- AC-1: one thing\n1. other thing\n').errors[0])
      .toMatch(/duplicate acceptance criterion id AC-1/)
  })

  it('reports a missing or empty section', () => {
    expect(parseAcceptanceCriteria('## Files\n- a.ts\n').found).toBe(false)
    expect(parseAcceptanceCriteria('## Acceptance criteria\n\n## Next\n').errors).toContain('acceptance criteria section is empty')
  })
})

describe('normalizePlanAcceptance', () => {
  it('rewrites implicit numbering into explicit ids and leaves other sections alone', () => {
    const { plan, changed } = normalizePlanAcceptance('## Files\n- a.ts\n\n## Acceptance criteria\n\n1. does the thing\n2. handles empty input\n')
    expect(changed).toBe(true)
    expect(plan).toContain('## Files\n- a.ts')
    expect(plan).toContain('- AC-1: does the thing\n- AC-2: handles empty input')
    expect(normalizePlanAcceptance(plan).changed).toBe(false)
  })
})

describe('diffCriteria', () => {
  it('finds removed, reworded and added ids', () => {
    const a = parseAcceptanceCriteria('## Acceptance criteria\n- AC-1: keep this one\n- AC-2: old wording here\n- AC-3: will be removed\n').criteria
    const b = parseAcceptanceCriteria('## Acceptance criteria\n- AC-1: keep this one\n- AC-2: new wording here\n- AC-4: brand new item\n').criteria
    expect(diffCriteria(a, b)).toEqual({ removed: ['AC-3'], reworded: ['AC-2'], added: ['AC-4'] })
  })
})
