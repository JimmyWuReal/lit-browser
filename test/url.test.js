const test = require('node:test')
const assert = require('node:assert/strict')
const { toUrl, searchUrl } = require('../src/url')

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

test('searches what only looks like an address', () => {
  assert.equal(toUrl('http://'), 'https://www.google.com/search?q=http%3A%2F%2F')
  assert.equal(toUrl('example.com:99999'), 'https://www.google.com/search?q=example.com%3A99999')
})

test('searches with the chosen engine, falling back to Google', () => {
  assert.equal(toUrl('lit browser', 'duckduckgo'), 'https://duckduckgo.com/?q=lit%20browser')
  assert.equal(toUrl('lit browser', 'bing'), 'https://www.bing.com/search?q=lit%20browser')
  assert.equal(toUrl('lit browser', 'unknown'), 'https://www.google.com/search?q=lit%20browser')
  assert.equal(toUrl('lit browser', 'constructor'), 'https://www.google.com/search?q=lit%20browser')
})

test('searchUrl searches even for text that looks like an address', () => {
  assert.equal(searchUrl(' example.com ', 'bing'), 'https://www.bing.com/search?q=example.com')
  assert.equal(searchUrl('a b', 'nope'), 'https://www.google.com/search?q=a%20b')
  // Half of an emoji's surrogate pair becomes U+FFFD instead of throwing.
  assert.equal(searchUrl('hi \uD83D'), 'https://www.google.com/search?q=hi%20%EF%BF%BD')
})

test('toUrl never gives an address that opens another app', () => {
  const { opensApp } = require('../src/permissions')
  for (const input of ['mailto:a@b.com', 'zoommtg://zoom.us/join', 'slack://open', 'tel:123', 'javascript:alert(1)', 'x:a.com', 'itms-apps://apps.apple.com/app']) {
    assert.equal(opensApp(toUrl(input)), false, input)
  }
})
