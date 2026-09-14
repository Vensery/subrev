export function extractPlanFiles(planApprovedText: string): string[] {
  const match = planApprovedText.match(/## Files\n([\s\S]*?)(\n##|$)/)
  if (!match) return []
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}
