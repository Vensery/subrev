const UNITS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 }

export function parseDuration(input) {
  if (typeof input !== 'string' || input === '') throw new RangeError('empty duration')
  const part = /(\d+)(ms|d|h|m|s)/y
  let total = 0
  let pos = 0
  while (pos < input.length) {
    part.lastIndex = pos
    const match = part.exec(input)
    if (!match) throw new RangeError(`invalid duration: ${input}`)
    total += Number(match[1]) * UNITS[match[2]]
    pos = part.lastIndex
  }
  return total
}
