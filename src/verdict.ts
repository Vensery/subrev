export type Verdict = 'PASS' | 'FAIL' | null

export function parseVerdict(reviewText: string): Verdict {
  const lines = reviewText.split('\n').map((line) => line.trim()).filter(Boolean)
  const lastLine = lines[lines.length - 1] ?? ''
  const match = lastLine.match(/^VERDICT:\s*(PASS|FAIL)$/)
  return match ? (match[1] as 'PASS' | 'FAIL') : null
}

export type Consistency = 'CONSISTENT' | 'CONTRADICTION' | null

/** Same strict last-line contract as parseVerdict, for the report-audit phase. */
export function parseConsistency(auditText: string): Consistency {
  const lines = auditText.split('\n').map((line) => line.trim()).filter(Boolean)
  const lastLine = lines[lines.length - 1] ?? ''
  const match = lastLine.match(/^CONSISTENCY:\s*(CONSISTENT|CONTRADICTION)$/)
  return match ? (match[1] as 'CONSISTENT' | 'CONTRADICTION') : null
}
