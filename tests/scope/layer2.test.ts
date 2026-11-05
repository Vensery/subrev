import { describe, it, expect } from 'vitest'
import type { AcceptanceCriterion } from '../../src/acceptance.js'
import type { AblationReport } from '../../src/scope/ablation.js'
import type { ChangeGroup } from '../../src/scope/groups.js'
import { buildLayer2Prompt, decideScope, parseLayer2Response, renderScopeReport } from '../../src/scope/layer2.js'

const criteria: AcceptanceCriterion[] = [
  { id: 'AC-1', text: 'add() returns the sum', tests: [], implicit: false },
  { id: 'AC-2', text: 'label() returns y', tests: [], implicit: false },
]

function group(id: string, file: string, symbol: string, location: string): ChangeGroup {
  return {
    id, file, symbol, source: 'ast', fileStatus: 'modified', binary: false, hunkIndexes: [0], locations: [location], added: 1, removed: 1,
    fileDiff: { path: file, oldPath: file, newPath: file, status: 'modified', binary: false, headerLines: [], hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, context: '', header: '@@ -2 +2 @@', lines: ['-old', '+new'] }] },
  }
}
const groups = [group('G1', 'lib.js', 'add', 'lib.js:2'), group('G2', 'lib.js', 'label', 'lib.js:6'), group('G3', 'extra.js', 'telemetry', 'extra.js:1')]
const ablation: AblationReport = {
  ran: true, gateRuns: 4,
  results: [
    { group: 'G1', loadBearing: true, implicatedAcs: [], outputTail: '' },
    { group: 'G2', loadBearing: false, implicatedAcs: [], outputTail: '' },
    { group: 'G3', loadBearing: false, implicatedAcs: [], outputTail: '' },
  ],
}
const CF = 'without it add(2, 3) returns 0 and the sum test fails'

function reply(items: unknown[]): string {
  return 'Here is my mapping.\n```json\n' + JSON.stringify({ groups: items }) + '\n```\n'
}

describe('layer 2', () => {
  it('builds a prompt with AC ids, group locations and revert evidence', () => {
    const prompt = buildLayer2Prompt(criteria, groups, ablation)
    expect(prompt).toContain('- AC-2: label() returns y')
    expect(prompt).toContain('### G1 — lib.js :: add')
    expect(prompt).toContain('turns the gate RED')
    expect(prompt).toContain('leaves the gate GREEN')
  })

  it('parses fenced JSON and rejects invalid categories', () => {
    expect(parseLayer2Response(reply([{ group: 'G1', category: 'direct', acceptance: ['ac-1'], hunks: ['lib.js:2'], counterfactual: CF, reason: '' }])).groups[0].acceptance).toEqual(['AC-1'])
    expect(() => parseLayer2Response(reply([{ group: 'G1', category: 'maybe' }]))).toThrow(/invalid category/)
    expect(() => parseLayer2Response('no json here')).toThrow(/no parseable JSON/)
  })

  it('escalates unmapped groups, unknown AC ids and thin counterfactuals; marks untested claims unverified', () => {
    const response = parseLayer2Response(reply([
      { group: 'G1', category: 'direct', acceptance: ['AC-1'], hunks: ['lib.js:2'], counterfactual: CF, reason: '' },
      { group: 'G2', category: 'direct', acceptance: ['AC-2'], hunks: ['lib.js:6'], counterfactual: 'label() would still return x, not y', reason: '' },
      { group: 'G3', category: 'unmapped', acceptance: [], hunks: ['extra.js:1'], counterfactual: '', reason: 'telemetry flag not requested' },
    ]))
    const d = decideScope(criteria, groups, ablation, response)
    expect(d.groups.map((g) => `${g.group}:${g.decision}`)).toEqual(['G1:accept', 'G2:unverified', 'G3:escalate'])
    expect(d.escalate).toBe(true)
    expect(decideScope(criteria, groups, ablation, response, { strictUnverified: true }).groups[1].decision).toBe('escalate')

    const sloppy = parseLayer2Response(reply([
      { group: 'G1', category: 'direct', acceptance: ['AC-9'], hunks: ['lib.js:2'], counterfactual: CF, reason: '' },
      { group: 'G2', category: 'supporting', acceptance: ['AC-2'], hunks: ['lib.js:6'], counterfactual: 'needed', reason: '' },
    ]))
    const d2 = decideScope(criteria, groups, ablation, sloppy)
    expect(d2.groups[0].why.join(' ')).toMatch(/not in the plan: AC-9/)
    expect(d2.groups[1].why.join(' ')).toMatch(/counterfactual/)
    expect(d2.groups[2].why.join(' ')).toMatch(/did not classify/)
    expect(d2.groups.every((g) => g.decision === 'escalate')).toBe(true)
  })

  it('does not escalate when every group maps cleanly, and escalates everything without a usable review', () => {
    const clean = parseLayer2Response(reply([
      { group: 'G1', category: 'direct', acceptance: ['AC-1'], hunks: ['lib.js:2'], counterfactual: CF, reason: '' },
    ]))
    expect(decideScope(criteria, [groups[0]], ablation, clean).escalate).toBe(false)
    const none = decideScope(criteria, [groups[0]], ablation, null)
    expect(none.escalate).toBe(true)
    expect(renderScopeReport(none, ['lib.js: new branch in add'], ablation)).toContain('ESCALATE')
  })
})
