const test = require('node:test')
const assert = require('node:assert/strict')
const { afterClose, step, byNumber, remember, reopenIndex, withPending } = require('../src/tabs')

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

test('remember keeps the newest closed entries last, up to the limit', () => {
  const closed = []
  for (const entry of [1, 2, 3, 4]) remember(closed, entry, 3)
  assert.deepEqual(closed, [2, 3, 4])
  assert.equal(closed.pop(), 4)
})

test('a reopened tab goes back to its place, or the end', () => {
  assert.equal(reopenIndex(1, 3), 1)
  assert.equal(reopenIndex(5, 2), 2)
  assert.equal(reopenIndex(-1, 2), 0)
})

test('a page still loading is added to the history it leaves', () => {
  const a = { url: 'a', title: 'A' }
  const b = { url: 'b', title: 'B' }
  const c = { url: 'c', title: 'C' }
  const history = { entries: [a, b, c], index: 1 }
  assert.equal(withPending(history, ''), history)
  assert.deepEqual(withPending(null, 'x'), { entries: [{ url: 'x', title: '' }], index: 0 })
  // A new page replaces what was ahead.
  assert.deepEqual(withPending(history, 'x'), { entries: [a, b, { url: 'x', title: '' }], index: 2 })
  // Back, forward and reload only move the index.
  assert.equal(withPending(history, 'a').index, 0)
  assert.equal(withPending(history, 'c').index, 2)
  assert.deepEqual(withPending(history, 'b'), history)
})
