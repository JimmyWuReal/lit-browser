const test = require('node:test')
const assert = require('node:assert/strict')
const { afterClose, step, byNumber, remember, keepNewest, reopenIndex, onScreen } = require('../src/tabs')

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

test('a window is on screen while it overlaps a display', () => {
  const displays = [{ x: 0, y: 0, width: 1440, height: 900 }, { x: 1440, y: 0, width: 1920, height: 1080 }]
  assert.equal(onScreen({ x: 100, y: 50, width: 800, height: 600 }, displays), true)
  assert.equal(onScreen({ x: 2000, y: 100, width: 800, height: 600 }, displays), true)
  assert.equal(onScreen({ x: 4000, y: 100, width: 800, height: 600 }, displays), false)
  assert.equal(onScreen({ x: 100, y: 50, width: 800, height: 600 }, []), false)
})

test('lowering the limit keeps only the newest closed entries', () => {
  const closed = [1, 2, 3, 4]
  keepNewest(closed, 2)
  assert.deepEqual(closed, [3, 4])
  keepNewest(closed, 5)
  assert.deepEqual(closed, [3, 4])
})
