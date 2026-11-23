const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { uniquePath } = require('../src/downloads')

test('numbers a download whose name is taken', () => {
  const taken = new Set([path.join('/d', 'a.pdf'), path.join('/d', 'a (1).pdf')])
  assert.equal(uniquePath('/d', 'b.pdf', (p) => taken.has(p)), path.join('/d', 'b.pdf'))
  assert.equal(uniquePath('/d', 'a.pdf', (p) => taken.has(p)), path.join('/d', 'a (2).pdf'))
  assert.equal(uniquePath('/d', '', () => false), path.join('/d', 'download'))
})
