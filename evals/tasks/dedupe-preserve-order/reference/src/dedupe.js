export function dedupe(items, keyFn = (x) => x) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
