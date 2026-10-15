import assert from 'node:assert/strict'
import { connectedSpread } from '../src/floodSpread/connectivity.ts'

const result = connectedSpread({
  cols: 5,
  rows: 2,
  mask: Uint8Array.from([2, 1, 1, 0, 1, 0, 0, 0, 0, 1]),
  prob: Uint8Array.from([0, 200, 220, 0, 220, 0, 0, 0, 0, 220]),
  hand: Float32Array.from([0, 1, 2, 0, 9, 0, 0, 0, 0, 10]),
  res: 0.0018,
  latitude: 26.7,
})

assert.deepEqual([...result.mask], [2, 1, 1, 0, 0, 0, 0, 0, 0, 0])
assert.equal(result.summary.riverCells, 1)
assert.equal(result.summary.connectedCells, 2)
assert.equal(result.summary.frontierCells, 2)
assert.equal(result.summary.maxHandM, 2)
console.log('flood-spread connectivity smoke test passed')
