import { describe, it, expect } from 'vitest'
import { parseVerdict } from '../src/verdict.js'

describe('parseVerdict', () => {
  it('parses PASS on the last line', () => {
    expect(parseVerdict('Looks fine.\n\nVERDICT: PASS')).toBe('PASS')
  })

  it('parses FAIL on the last line', () => {
    expect(parseVerdict('Found an issue.\nVERDICT: FAIL')).toBe('FAIL')
  })

  it('returns null when there is no verdict line', () => {
    expect(parseVerdict('Looks fine, ship it.')).toBeNull()
  })

  it('returns null when the verdict is not on the last line', () => {
    expect(parseVerdict('VERDICT: PASS\nOne more note after.')).toBeNull()
  })

  it('returns null on wrong wording', () => {
    expect(parseVerdict('Verdict: Passed')).toBeNull()
  })
})
