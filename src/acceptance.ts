/**
 * Stable acceptance-criterion IDs for approved plans.
 *
 * Layer-2 scope review and the eval harness both need to point at a specific acceptance item
 * ("this hunk exists for AC-3"). That only works if the IDs are written into
 * plan-approved.md once and never renumbered, so approval rewrites a plain numbered list
 * ("1. ...") into explicit IDs ("- AC-1: ...") and later amendments keep explicit IDs as-is.
 *
 * Accepted item forms inside the "## Acceptance criteria" section:
 *   - AC-3: text            explicit ID (preferred)
 *   AC-3: text              explicit ID without a bullet
 *   1. AC-3: text           numbered + explicit ID (the explicit ID wins)
 *   1. text                 implicit ID, normalized to AC-1 at approval
 * An optional trailing "[tests: name-or-path, other]" binds the item to tests; it is used as a
 * hint when a revert experiment turns the gate red, never as proof on its own.
 * Indented lines directly under an item are treated as its continuation.
 */

export interface AcceptanceCriterion {
  id: string
  text: string
  tests: string[]
  /** true when the ID came from list numbering rather than being written explicitly. */
  implicit: boolean
}

export interface AcceptanceParse {
  /** false when the plan has no "## Acceptance criteria" heading at all. */
  found: boolean
  criteria: AcceptanceCriterion[]
  errors: string[]
  warnings: string[]
}

const SECTION_HEADING = /^##\s+acceptance criteria\s*$/i
const EXPLICIT = /^(?:[-*]\s+|\d+[.)]\s+)?(AC-\d+)\s*[:.)\-–—]\s*(.+)$/i
const NUMBERED = /^(\d+)[.)]\s+(.+)$/
const TESTS_SUFFIX = /\s*\[tests?:\s*([^\]]*)\]\s*$/i

function sectionBounds(lines: string[]): [number, number] | null {
  const start = lines.findIndex((line) => SECTION_HEADING.test(line.trim()))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return [start + 1, end]
}

function splitTests(text: string): { text: string; tests: string[] } {
  const match = text.match(TESTS_SUFFIX)
  if (!match) return { text: text.trim(), tests: [] }
  const tests = match[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  return { text: text.slice(0, match.index).trim(), tests }
}

export function parseAcceptanceCriteria(planText: string): AcceptanceParse {
  const lines = planText.split(/\r?\n/)
  const bounds = sectionBounds(lines)
  if (!bounds) {
    return { found: false, criteria: [], errors: ['plan has no "## Acceptance criteria" section'], warnings: [] }
  }
  const criteria: AcceptanceCriterion[] = []
  const errors: string[] = []
  const warnings: string[] = []

  for (let i = bounds[0]; i < bounds[1]; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (line === '') continue
    const explicit = line.match(EXPLICIT)
    const numbered = explicit ? null : line.match(NUMBERED)
    if (explicit || numbered) {
      const id = explicit ? explicit[1].toUpperCase() : `AC-${Number(numbered![1])}`
      const body = splitTests(explicit ? explicit[2] : numbered![2])
      criteria.push({ id, text: body.text, tests: body.tests, implicit: !explicit })
      continue
    }
    const previous = criteria[criteria.length - 1]
    if (previous && /^\s+/.test(raw)) {
      const body = splitTests(`${previous.text} ${line}`)
      previous.text = body.text
      previous.tests.push(...body.tests)
      continue
    }
    warnings.push(`line ignored inside acceptance criteria (not a numbered or AC-n item): "${line.slice(0, 80)}"`)
  }

  if (criteria.length === 0) errors.push('acceptance criteria section is empty')
  const seen = new Map<string, number>()
  for (const c of criteria) seen.set(c.id, (seen.get(c.id) ?? 0) + 1)
  for (const [id, count] of seen) if (count > 1) errors.push(`duplicate acceptance criterion id ${id} (${count}x)`)
  if (criteria.some((c) => c.implicit) && criteria.some((c) => !c.implicit)) {
    warnings.push('acceptance criteria mix explicit AC-n ids with plain numbering; plain items were numbered by position')
  }
  for (const c of criteria) if (c.text.length < 8) warnings.push(`${c.id} is very short and may not be checkable: "${c.text}"`)

  return { found: true, criteria, errors, warnings }
}

function renderCriterion(c: AcceptanceCriterion): string {
  return `- ${c.id}: ${c.text}${c.tests.length ? ` [tests: ${c.tests.join(', ')}]` : ''}`
}

export interface NormalizeResult {
  plan: string
  parse: AcceptanceParse
  changed: boolean
}

/**
 * Rewrite the acceptance section with explicit, stable IDs. Leaves the plan untouched when the
 * section is missing or has errors (the caller decides whether that blocks approval).
 */
export function normalizePlanAcceptance(planText: string): NormalizeResult {
  const parse = parseAcceptanceCriteria(planText)
  if (!parse.found || parse.errors.length > 0) return { plan: planText, parse, changed: false }
  const lines = planText.split(/\r?\n/)
  const [start, end] = sectionBounds(lines)!
  const rendered = ['', ...parse.criteria.map(renderCriterion), '']
  const next = [...lines.slice(0, start), ...rendered, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
  const parsedAgain = parseAcceptanceCriteria(next)
  return { plan: next, parse: parsedAgain, changed: next !== planText }
}

/**
 * IDs that existed in the previous approved plan but are gone or reworded in the new one. An
 * amendment may add criteria; silently renumbering or rewriting old ones would make earlier
 * scope reports and eval labels point at the wrong item.
 */
export function diffCriteria(
  previous: AcceptanceCriterion[],
  next: AcceptanceCriterion[]
): { removed: string[]; reworded: string[]; added: string[] } {
  const prevById = new Map(previous.map((c) => [c.id, c]))
  const nextById = new Map(next.map((c) => [c.id, c]))
  return {
    removed: previous.filter((c) => !nextById.has(c.id)).map((c) => c.id),
    reworded: previous.filter((c) => nextById.has(c.id) && nextById.get(c.id)!.text !== c.text).map((c) => c.id),
    added: next.filter((c) => !prevById.has(c.id)).map((c) => c.id),
  }
}
