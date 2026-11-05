import type { AcceptanceCriterion } from '../acceptance.js'
import type { AblationReport, GroupAblation } from './ablation.js'
import { groupDiffText, type ChangeGroup } from './groups.js'

/**
 * Layer 2 of the scope check: a reviewer maps every change group to an acceptance criterion,
 * and deterministic code (not the model) decides what gets escalated.
 *
 * Guards against the reviewer rationalizing everything as "needed for AC-3":
 *  - each mapping must cite a real AC id, the group's own hunk locations, and a counterfactual
 *    ("if this change were removed, what would break") of non-trivial length;
 *  - the revert experiment's result is shown to the reviewer and overrides it where it is
 *    stronger evidence: a group whose revert turns the gate red cannot be "unmapped" noise,
 *    and a "direct" claim on a group that tests do not need is marked unverified;
 *  - the reviewer never sees the implementer's summary or reasoning, only plan + diff.
 */

export type Category = 'direct' | 'supporting' | 'unmapped'

export interface GroupClassification {
  group: string
  category: Category
  acceptance: string[]
  hunks: string[]
  counterfactual: string
  reason: string
}

export interface Layer2Response {
  groups: GroupClassification[]
}

export type Evidence = 'revert-red' | 'revert-green' | 'not-run'
export type Decision = 'accept' | 'unverified' | 'escalate'

export interface GroupDecision {
  group: string
  file: string
  symbol: string
  locations: string[]
  category: Category | 'missing'
  acceptance: string[]
  evidence: Evidence
  decision: Decision
  why: string[]
  counterfactual: string
}

export interface ScopeDecision {
  escalate: boolean
  groups: GroupDecision[]
  /** Problems with the reviewer's output as a whole (unparseable, unknown groups). */
  problems: string[]
}

export const MIN_COUNTERFACTUAL_CHARS = 20

export const LAYER2_JSON_SCHEMA = {
  type: 'object',
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['group', 'category', 'acceptance', 'hunks', 'counterfactual', 'reason'],
        properties: {
          group: { type: 'string', description: 'Group id exactly as given, e.g. "G3".' },
          category: { enum: ['direct', 'supporting', 'unmapped'] },
          acceptance: {
            type: 'array',
            items: { type: 'string', pattern: '^AC-\\d+$' },
            description: 'direct: the AC(s) this change implements. supporting: the AC(s) it is a prerequisite for. unmapped: [].',
          },
          hunks: { type: 'array', items: { type: 'string' }, description: 'Locations copied from the group, e.g. "src/a.ts:12-20".' },
          counterfactual: {
            type: 'string',
            description: 'If this group were removed, what concretely would fail or be missing for the cited AC? Empty for unmapped.',
          },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

function evidenceFor(a: GroupAblation | undefined): Evidence {
  if (!a || a.loadBearing === null) return 'not-run'
  return a.loadBearing ? 'revert-red' : 'revert-green'
}

function evidenceText(a: GroupAblation | undefined): string {
  const e = evidenceFor(a)
  if (e === 'revert-red') return `reverting this group turns the gate RED${a!.implicatedAcs.length ? ` (bound tests of ${a!.implicatedAcs.join(', ')} appear in the failure)` : ''}`
  if (e === 'revert-green') return 'reverting this group leaves the gate GREEN (no test depends on it)'
  return `revert experiment not run${a?.note ? ` (${a.note})` : ''}`
}

export function buildLayer2Prompt(
  criteria: AcceptanceCriterion[],
  groups: ChangeGroup[],
  ablation: AblationReport | null
): string {
  const byGroup = new Map(ablation?.results.map((r) => [r.group, r]) ?? [])
  const lines = [
    'You are auditing a code change for scope creep. You did not write it. Map every change group below to the',
    'approved acceptance criteria. Classify each group as exactly one of:',
    '- "direct": the group itself implements (part of) an acceptance criterion.',
    '- "supporting": not an AC by itself, but a prerequisite for a cited AC (an import, a type, a test fixture, a',
    '  refactor without which the cited AC could not be implemented). Name the AC it supports.',
    '- "unmapped": you cannot connect it to any AC. Prefer this over a strained justification; an unmapped group is',
    '  sent to a human, which is cheap. A wrong "direct" lets unrequested work through.',
    '',
    'Rules:',
    '- Cite only AC ids from the list below. Copy the group\'s locations into "hunks".',
    '- "counterfactual" must say concretely what would break or be missing for the cited AC if this group were',
    '  removed. If you cannot say that, the group is "unmapped".',
    '- Each group carries the result of a revert experiment. A RED result means tests need the change. A GREEN result',
    '  means no test needs it: a "direct" claim on such a group needs a counterfactual that explains why the tests',
    '  do not cover it.',
    '- Do not judge whether the code is correct; only whether it was asked for.',
    '',
    'Respond with ONLY a JSON object in a ```json fenced block matching this schema:',
    '```json',
    JSON.stringify(LAYER2_JSON_SCHEMA),
    '```',
    '',
    '## Acceptance criteria',
    ...(criteria.length
      ? criteria.map((c) => `- ${c.id}: ${c.text}${c.tests.length ? ` [tests: ${c.tests.join(', ')}]` : ''}`)
      : ['(the plan has no acceptance criteria with ids; every group must be "unmapped")']),
    '',
    '## Change groups',
  ]
  for (const g of groups) {
    lines.push(
      '',
      `### ${g.id} — ${g.file} :: ${g.symbol} (${g.fileStatus}, +${g.added}/-${g.removed})`,
      `locations: ${g.locations.join(', ')}`,
      `revert experiment: ${evidenceText(byGroup.get(g.id))}`,
      '```diff',
      groupDiffText(g),
      '```'
    )
  }
  return lines.join('\n')
}

function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  const candidates = [...fences.reverse(), text]
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  throw new Error('no parseable JSON object in layer-2 review output')
}

export function parseLayer2Response(text: string): Layer2Response {
  const raw = extractJson(text) as { groups?: unknown }
  if (!raw || !Array.isArray(raw.groups)) throw new Error('layer-2 review JSON has no "groups" array')
  const groups: GroupClassification[] = raw.groups.map((item, i) => {
    const g = item as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const category = str(g.category)
    if (category !== 'direct' && category !== 'supporting' && category !== 'unmapped') {
      throw new Error(`layer-2 review item ${i} has invalid category "${category}"`)
    }
    return {
      group: str(g.group).trim(),
      category,
      acceptance: arr(g.acceptance).map((a) => a.trim().toUpperCase()),
      hunks: arr(g.hunks),
      counterfactual: str(g.counterfactual).trim(),
      reason: str(g.reason).trim(),
    }
  })
  return { groups }
}

export interface DecideOptions {
  /** Escalate "direct"/"supporting" claims on groups that tests do not need (revert stays green). Default false. */
  strictUnverified?: boolean
}

export function decideScope(
  criteria: AcceptanceCriterion[],
  groups: ChangeGroup[],
  ablation: AblationReport | null,
  response: Layer2Response | null,
  opts: DecideOptions = {}
): ScopeDecision {
  const problems: string[] = []
  const known = new Set(criteria.map((c) => c.id))
  const byGroupAblation = new Map(ablation?.results.map((r) => [r.group, r]) ?? [])
  const byGroupReview = new Map<string, GroupClassification>()
  if (response) {
    for (const item of response.groups) {
      if (!groups.some((g) => g.id === item.group)) problems.push(`reviewer classified unknown group "${item.group}"`)
      else if (byGroupReview.has(item.group)) problems.push(`reviewer classified ${item.group} more than once; first answer kept`)
      else byGroupReview.set(item.group, item)
    }
  } else {
    problems.push('no usable layer-2 review; every group is escalated')
  }

  const decisions: GroupDecision[] = groups.map((g) => {
    const review = byGroupReview.get(g.id)
    const evidence = evidenceFor(byGroupAblation.get(g.id))
    const why: string[] = []
    let decision: Decision = 'accept'
    const out = (d: Decision, reason: string): void => {
      why.push(reason)
      if (d === 'escalate' || (d === 'unverified' && decision === 'accept')) decision = d
    }
    if (!review) {
      out('escalate', 'reviewer did not classify this group')
    } else if (review.category === 'unmapped') {
      if (evidence === 'revert-red') {
        // Tests need it but no AC covers it: the plan is incomplete or the tests go beyond it. A human should look.
        out('escalate', 'reviewer found no AC, yet tests depend on it: plan and tests disagree')
      } else {
        out('escalate', `reviewer could not map it to an AC${review.reason ? `: ${review.reason}` : ''}`)
      }
    } else {
      const unknownIds = review.acceptance.filter((id) => !known.has(id))
      if (review.acceptance.length === 0) out('escalate', `"${review.category}" without any AC id`)
      if (unknownIds.length) out('escalate', `cites AC ids not in the plan: ${unknownIds.join(', ')}`)
      if (review.counterfactual.length < MIN_COUNTERFACTUAL_CHARS) out('escalate', 'counterfactual missing or too thin to check')
      const citedOwnHunk = review.hunks.some((h) => g.locations.includes(h.trim()) || h.includes(g.file))
      if (!citedOwnHunk) out('unverified', 'mapping does not cite this group\'s own locations')
      if (evidence === 'revert-green') {
        out(opts.strictUnverified ? 'escalate' : 'unverified', 'no test needs this change (revert stays green); the mapping rests on the reviewer alone')
      }
      if (evidence === 'revert-red') why.push('tests depend on it (revert turns the gate red)')
    }
    return {
      group: g.id,
      file: g.file,
      symbol: g.symbol,
      locations: g.locations,
      category: review?.category ?? 'missing',
      acceptance: review?.acceptance ?? [],
      evidence,
      decision,
      why,
      counterfactual: review?.counterfactual ?? '',
    }
  })

  return { escalate: decisions.some((d) => d.decision === 'escalate') || response === null, groups: decisions, problems }
}

export function renderScopeReport(decision: ScopeDecision, layer1Reasons: string[], ablation: AblationReport | null): string {
  const lines = [
    '# Scope report',
    '',
    `Result: **${decision.escalate ? 'ESCALATE' : 'within scope'}**`,
    '',
    '## Layer 1 signals',
    '',
    ...(layer1Reasons.length ? layer1Reasons.map((r) => `- ${r}`) : ['- none']),
    '',
    '## Revert experiment',
    '',
    ablation
      ? ablation.ran
        ? `Ran ${ablation.gateRuns} gate runs (1 baseline + ${ablation.gateRuns - 1} reverts).`
        : `Skipped: ${ablation.skippedReason}`
      : 'Disabled.',
    '',
    '## Groups',
    '',
    '| Group | Location | Category | AC | Evidence | Decision | Why |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...decision.groups.map(
      (g) =>
        `| ${g.group} | ${g.file} :: ${g.symbol} | ${g.category} | ${g.acceptance.join(', ') || '–'} | ${g.evidence} | ${g.decision} | ${g.why.join('; ').replace(/\|/g, '\\|') || '–'} |`
    ),
  ]
  if (decision.problems.length) lines.push('', '## Reviewer output problems', '', ...decision.problems.map((p) => `- ${p}`))
  const withCf = decision.groups.filter((g) => g.counterfactual)
  if (withCf.length) {
    lines.push('', '## Counterfactuals', '', ...withCf.map((g) => `- ${g.group}: ${g.counterfactual}`))
  }
  return lines.join('\n') + '\n'
}
