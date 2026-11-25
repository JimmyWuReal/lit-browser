const test = require('node:test')
const assert = require('node:assert/strict')
const { toUrl, searchUrl, addressParts } = require('../src/url')

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
  assert.equal(toUrl('lit browser', 'constructor'), 'https://www.google.com/search?q=lit%20browser')
})

test('searchUrl searches even for text that looks like an address', () => {
  assert.equal(searchUrl(' example.com ', 'bing'), 'https://www.bing.com/search?q=example.com')
  assert.equal(searchUrl('a b', 'nope'), 'https://www.google.com/search?q=a%20b')
  // Half of an emoji's surrogate pair becomes U+FFFD instead of throwing.
  assert.equal(searchUrl('hi \uD83D'), 'https://www.google.com/search?q=hi%20%EF%BF%BD')
})

test('addressParts leaves out https:// and a lone slash', () => {
  assert.deepEqual(addressParts('https://example.com/'), { before: '', host: 'example.com', after: '' })
  assert.deepEqual(addressParts('https://docs.example.com:8443/a/b?q=1#top'), { before: '', host: 'docs.example.com:8443', after: '/a/b?q=1#top' })
  assert.deepEqual(addressParts('https://example.com/?q=1'), { before: '', host: 'example.com', after: '/?q=1' })
  // Not encrypted, so it still says so.
  assert.deepEqual(addressParts('http://example.com/'), { before: 'http://', host: 'example.com', after: '' })
})

test('addressParts keeps www., apart from the host', () => {
  assert.deepEqual(addressParts('https://www.example.com/a'), { before: 'www.', host: 'example.com', after: '/a' })
  assert.deepEqual(addressParts('http://www.example.com/'), { before: 'http://www.', host: 'example.com', after: '' })
  assert.deepEqual(addressParts('https://www.co.uk/'), { before: 'www.', host: 'co.uk', after: '' })
  assert.deepEqual(addressParts('https://www.com/'), { before: '', host: 'www.com', after: '' })
})

test('addressParts keeps everything when full', () => {
  for (const url of ['https://www.example.com/', 'https://example.com/?#', 'http://example.com/a?b#c', 'https://example.com/#']) {
    assert.equal(Object.values(addressParts(url, true)).join(''), url)
  }
  assert.deepEqual(addressParts('https://www.example.com/', true), { before: 'https://www.', host: 'example.com', after: '/' })
})

test('addressParts leaves other addresses as they are', () => {
  for (const url of ['', 'about:blank', 'file:///Users/me/page.html', 'data:text/html,hi', 'https://bank.com@evil.com/', 'https://']) {
    assert.equal(addressParts(url), null, url)
  }
})
