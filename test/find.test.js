const test = require('node:test')
const assert = require('node:assert/strict')
const { open, setText, reset, result } = require('../src/find')

test('open starts empty, or with the last search, and keeps an open field', () => {
  assert.deepEqual(open(null), { text: '', active: 0, matches: null, requestId: null })
  assert.equal(open(null, 'light').text, 'light')
  const find = { text: 'keeper', active: 2, matches: 3, requestId: 7 }
  assert.equal(open(find, 'light'), find)
})

test('new text clears the counts until the page answers', () => {
  const find = setText({ text: 'li', active: 2, matches: 9, requestId: 4 }, 'lig')
  assert.deepEqual(find, { text: 'lig', active: 0, matches: null, requestId: null })
})

test('a result for the latest request updates the counts', () => {
  const find = { text: 'light', active: 0, matches: null, requestId: 5 }
  assert.deepEqual(result(find, { requestId: 5, activeMatchOrdinal: 1, matches: 12 }), { ...find, active: 1, matches: 12 })
  // Partial updates keep what they leave out.
  assert.deepEqual(result({ ...find, active: 1, matches: 12 }, { requestId: 5, activeMatchOrdinal: 2 }), { ...find, active: 2, matches: 12 })
})

test('results for older requests, or a closed field, change nothing', () => {
  const find = { text: 'light', active: 0, matches: null, requestId: 6 }
  assert.equal(result(find, { requestId: 5, activeMatchOrdinal: 1, matches: 30 }), find)
  assert.equal(result(null, { requestId: 6, activeMatchOrdinal: 1, matches: 3 }), null)
})

test('a navigation keeps the text but starts the search over', () => {
  assert.deepEqual(reset({ text: 'light', active: 3, matches: 9, requestId: 8 }), { text: 'light', active: 0, matches: null, requestId: null })
  assert.equal(reset(null), null)
})
