export function dedupe(items, keyFn = (x) => x) {
  return [...new Set(items.map(keyFn))].sort()
}
