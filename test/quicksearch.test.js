const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const quickSearch = require('../src/quicksearch')
const { parse, resolve, complete, list, urlFor, SITES, PREFIXES } = quickSearch

test('a shortcut at the start searches its site', () => {
  assert.equal(resolve('!yt lofi beats'), 'https://www.youtube.com/results?search_query=lofi%20beats')
  assert.equal(resolve('  !wiki   Taiwan '), 'https://en.wikipedia.org/w/index.php?search=Taiwan')
  assert.equal(resolve('!YT Theo'), 'https://www.youtube.com/results?search_query=Theo')
})

test('a shortcut at the end works too', () => {
  assert.equal(resolve('react hooks !gh'), 'https://github.com/search?q=react%20hooks')
  assert.deepEqual(parse('react !gh').query, 'react')
})

test('the search keeps its spacing, and dots survive in Maps', () => {
  assert.equal(parse('!gh "a  b"').query, '"a  b"')
  assert.equal(parse('"a  b"  !gh').query, '"a  b"')
  assert.equal(resolve('!maps ..'), 'https://www.google.com/maps/search/?api=1&query=..')
})

test('a shortcut alone opens the site', () => {
  assert.equal(resolve('!yt'), 'https://www.youtube.com/')
  assert.equal(resolve('!maps '), 'https://maps.google.com/')
})

test('anything else is not a quick search', () => {
  assert.equal(resolve('youtube lofi'), null)
  assert.equal(resolve('!nope lofi'), null)
  assert.equal(resolve('lofi !yt beats'), null)
  assert.equal(resolve('!'), null)
  assert.equal(resolve(''), null)
  assert.equal(resolve(42), null)
  assert.equal(resolve('!constructor x'), null)
})

test('uses the chosen prefix only', () => {
  assert.equal(resolve('@yt lofi', '@'), 'https://www.youtube.com/results?search_query=lofi')
  assert.equal(resolve('!yt lofi', '@'), null)
  assert.equal(resolve('?yt lofi', '?'), null)
})

test('encodes the search, even half an emoji', () => {
  assert.equal(resolve('!g a&b=c #1'), 'https://www.google.com/search?q=a%26b%3Dc%20%231')
  assert.equal(urlFor(SITES[0], 'hi \uD83D'), 'https://www.youtube.com/results?search_query=hi%20%EF%BF%BD')
})

test('completes a half-typed shortcut, exact alias first', () => {
  // `!y` is Yahoo's whole alias, so it comes before YouTube's `yt`.
  assert.deepEqual(complete('!y').map((site) => [site.id, site.alias]), [['yahoo', 'y'], ['youtube', 'yt']])
  assert.equal(complete('!y')[0].icon.startsWith('data:image/svg+xml;base64,'), true)
  // `!g` is Google exactly, ahead of GitHub's `gh`, and Gemini, Grok.
  assert.deepEqual(complete('!g').map((site) => site.id).slice(0, 2), ['google', 'github'])
  assert.equal(complete('!').length, 6)
  assert.equal(complete('!', '!', 50).length, SITES.length)
})

test('completes nothing once a search follows, or without the prefix', () => {
  assert.deepEqual(complete('!yt lofi'), [])
  assert.deepEqual(complete('yt'), [])
  assert.deepEqual(complete('!zzz'), [])
  assert.deepEqual(complete('!y', '?'), [])
})

test('every site has a unique id and aliases, a search, and an icon', () => {
  const aliases = SITES.flatMap((site) => site.aliases)
  assert.equal(new Set(aliases).size, aliases.length)
  assert.equal(new Set(SITES.map((site) => site.id)).size, SITES.length)
  for (const site of SITES) {
    assert.match(site.search, /^https:\/\/.+\{query\}/)
    assert.match(site.home, /^https:\/\//)
    for (const alias of site.aliases) assert.match(alias, /^[a-z]+$/)
  }
  assert.equal(list().length, SITES.length)
  for (const file of fs.readdirSync(path.join(__dirname, '../src/sites'))) {
    assert.ok(SITES.some((site) => `${site.icon || site.id}.svg` === file), `${file} is used`)
  }
  assert.ok(PREFIXES.includes('!'))
})
