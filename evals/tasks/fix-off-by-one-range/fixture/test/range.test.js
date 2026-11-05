import test from 'node:test'
import assert from 'node:assert/strict'
import { range } from '../src/range.js'

test('excludes the end', () => assert.deepEqual(range(0, 3), [0, 1, 2]))
test('empty when start equals end', () => assert.deepEqual(range(2, 2), []))
test('handles negatives', () => assert.deepEqual(range(-1, 2), [-1, 0, 1]))
test('empty when start is after end', () => assert.deepEqual(range(3, 1), []))
