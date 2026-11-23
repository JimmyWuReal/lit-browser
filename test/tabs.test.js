const test = require('node:test')
const assert = require('node:assert/strict')
const { afterClose, step, byNumber } = require('../src/tabs')

test('closing a background tab keeps the active one', () => {
  assert.equal(afterClose([1, 2, 3], 1, 3), 1)
})

test('closing the active tab picks its right neighbor, then its left', () => {
  assert.equal(afterClose([1, 2, 3], 2, 2), 3)
  assert.equal(afterClose([1, 2, 3], 3, 3), 2)
})

test('closing the last tab leaves nothing to show', () => {
  assert.equal(afterClose([1], 1, 1), null)
})

test('step wraps around both ends', () => {
  assert.equal(step([1, 2, 3], 3, 1), 1)
  assert.equal(step([1, 2, 3], 1, -1), 3)
  assert.equal(step([], 1, 1), null)
})

test('numbers pick tabs and 9 picks the last', () => {
  assert.equal(byNumber([1, 2, 3], 2), 2)
  assert.equal(byNumber([1, 2, 3], 5), null)
  assert.equal(byNumber([1, 2, 3], 9), 3)
})
