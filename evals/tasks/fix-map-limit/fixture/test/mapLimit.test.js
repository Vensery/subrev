import test from 'node:test'
import assert from 'node:assert/strict'
import { mapLimit } from '../src/mapLimit.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('preserves result order', async () => {
  const out = await mapLimit([30, 5, 15], 2, async (ms, i) => { await sleep(ms); return i })
  assert.deepEqual(out, [0, 1, 2])
})

test('never exceeds the concurrency limit, and does use it', async () => {
  let active = 0
  let peak = 0
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
    active++
    peak = Math.max(peak, active)
    await sleep(10)
    active--
    return x
  })
  assert.equal(peak, 2)
})

test('limit 1 is sequential', async () => {
  const order = []
  await mapLimit([1, 2, 3], 1, async (x) => { order.push(`start${x}`); await sleep(5); order.push(`end${x}`) })
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'])
})

test('empty input resolves to an empty array', async () => assert.deepEqual(await mapLimit([], 3, async (x) => x), []))
test('rejects with the failing call error', async () => {
  await assert.rejects(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x }), /boom/)
})
test('rejects an invalid limit', async () => {
  await assert.rejects(mapLimit([1], 0, async (x) => x), RangeError)
  await assert.rejects(mapLimit([1], 1.5, async (x) => x), RangeError)
})
