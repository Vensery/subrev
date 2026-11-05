import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.js'

test('seconds', () => assert.equal(parseDuration('45s'), 45_000))
test('hours and minutes', () => assert.equal(parseDuration('1h30m'), 5_400_000))
test('days', () => assert.equal(parseDuration('2d'), 172_800_000))
test('all units', () => assert.equal(parseDuration('1d2h3m4s'), 93_784_000))
test('milliseconds are not minutes', () => assert.equal(parseDuration('500ms'), 500))
test('empty string throws', () => assert.throws(() => parseDuration(''), RangeError))
test('garbage throws', () => assert.throws(() => parseDuration('abc'), RangeError))
test('unknown unit throws', () => assert.throws(() => parseDuration('10x'), RangeError))
test('spaces throw', () => assert.throws(() => parseDuration('1h 30m'), RangeError))
test('non-string throws', () => assert.throws(() => parseDuration(5), RangeError))
