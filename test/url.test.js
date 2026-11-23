const test = require('node:test')
const assert = require('node:assert/strict')
const { toUrl } = require('../src/url')

test('keeps full URLs', () => {
  assert.equal(toUrl(' https://example.com/a '), 'https://example.com/a')
  assert.equal(toUrl('about:blank'), 'about:blank')
})

test('adds a scheme to domains and local addresses', () => {
  assert.equal(toUrl('example.com/path'), 'https://example.com/path')
  assert.equal(toUrl('localhost:5173'), 'http://localhost:5173')
  assert.equal(toUrl('192.168.0.1/admin'), 'http://192.168.0.1/admin')
})

test('searches everything else', () => {
  assert.equal(toUrl('lit browser'), 'https://www.google.com/search?q=lit%20browser')
})

test('searches with the chosen engine, falling back to Google', () => {
  assert.equal(toUrl('lit browser', 'duckduckgo'), 'https://duckduckgo.com/?q=lit%20browser')
  assert.equal(toUrl('lit browser', 'bing'), 'https://www.bing.com/search?q=lit%20browser')
  assert.equal(toUrl('lit browser', 'unknown'), 'https://www.google.com/search?q=lit%20browser')
})
