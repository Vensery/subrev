import test from 'node:test'
import assert from 'node:assert/strict'
import { dedupe } from '../src/dedupe.js'

test('keeps first occurrence order for numbers', () => assert.deepEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2]))
test('keeps first occurrence order for strings', () => assert.deepEqual(dedupe(['b', 'a', 'b']), ['b', 'a']))
test('returns items, not keys, when keyFn is given', () => {
  const items = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 1, n: 'c' }]
  assert.deepEqual(dedupe(items, (x) => x.id), [{ id: 1, n: 'a' }, { id: 2, n: 'b' }])
})
test('empty input', () => assert.deepEqual(dedupe([]), []))
test('NaN is treated as a single value', () => assert.equal(dedupe([NaN, NaN]).length, 1))
