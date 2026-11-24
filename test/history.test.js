const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LIMIT, visit, unvisit, retitle, remove, suggest, suggestWithBookmarks, load, save } = require('../src/history')

test('a visit puts its page first, once', () => {
  let entries = visit([], { url: 'https://a.com/', title: 'A', time: 1 })
  entries = visit(entries, { url: 'https://b.com/', title: 'B', time: 2 })
  entries = visit(entries, { url: 'https://a.com/', time: 3 })
  assert.deepEqual(entries, [
    { url: 'https://a.com/', title: 'A', time: 3 },
    { url: 'https://b.com/', title: 'B', time: 2 },
  ])
})

test('only real pages are recorded', () => {
  for (const url of ['about:blank', 'data:text/html,hi', 'chrome://gpu', 'devtools://x']) {
    assert.deepEqual(visit([], { url, time: 1 }), [])
  }
  assert.equal(visit([], { url: 'file:///tmp/a.html', time: 1 }).length, 1)
})

test('history keeps only the newest entries', () => {
  let entries = []
  for (let i = 0; i <= LIMIT; i++) entries = visit(entries, { url: `https://x.com/${i}`, time: i })
  assert.equal(entries.length, LIMIT)
  assert.equal(entries[0].url, `https://x.com/${LIMIT}`)
  assert.equal(entries.at(-1).url, 'https://x.com/1')
})

test('retitle and remove change only their page', () => {
  const entries = [{ url: 'https://a.com/', title: '', time: 2 }, { url: 'https://b.com/', title: 'B', time: 1 }]
  assert.equal(retitle(entries, 'https://a.com/', 'A')[0].title, 'A')
  assert.equal(retitle(entries, 'https://c.com/', 'C'), entries)
  assert.equal(retitle(entries, 'https://a.com/', ''), entries)
  assert.deepEqual(remove(entries, 'https://a.com/').map((entry) => entry.url), ['https://b.com/'])
})

test('load keeps only well-formed entries, newest first', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lit-history-')), 'history.json')
  assert.deepEqual(load(file), [])
  save(file, [
    { url: 'https://old.com/', title: 'Old', time: 1 },
    { url: 'https://new.com/', time: 5, extra: true },
    { url: 'about:blank', time: 3 },
    { url: 'https://no-time.com/' },
    null,
  ])
  assert.deepEqual(load(file), [
    { url: 'https://new.com/', title: '', time: 5 },
    { url: 'https://old.com/', title: 'Old', time: 1 },
  ])
  fs.writeFileSync(file, '{ broken')
  assert.deepEqual(load(file), [])
})

test('unvisit takes a visit back and puts the older one in its place', () => {
  const entries = [
    { url: 'https://c.com/', title: 'C', time: 30 },
    { url: 'https://b.com/', title: 'B', time: 20 },
    { url: 'https://a.com/', title: 'A', time: 10 },
  ]
  const previous = entries[2]
  const visited = visit(entries, { url: 'https://a.com/', time: 40 })
  assert.deepEqual(unvisit(visited, { url: 'https://a.com/', time: 40, previous }), entries)
  // A first visit just goes.
  const fresh = visit(entries, { url: 'https://d.com/', time: 40 })
  assert.deepEqual(unvisit(fresh, { url: 'https://d.com/', time: 40, previous: null }), entries)
  // An older page comes back at the end, too.
  const oldest = { url: 'https://z.com/', title: 'Z', time: 1 }
  const replaced = visit(entries, { url: 'https://z.com/', time: 40 })
  assert.deepEqual(unvisit(replaced, { url: 'https://z.com/', time: 40, previous: oldest }).at(-1), oldest)
})

test('unvisit leaves a page visited again since', () => {
  const entries = [{ url: 'https://a.com/', title: 'A', time: 50 }]
  assert.equal(unvisit(entries, { url: 'https://a.com/', time: 40, previous: null }), entries)
  assert.equal(unvisit(entries, { url: 'https://b.com/', time: 40, previous: null }), entries)
})

test('suggest matches every word in the title or address', () => {
  const entries = [
    { url: 'https://news.example.com/rust', title: 'Rust release notes', time: 3 },
    { url: 'https://github.com/rust-lang/rust', title: 'GitHub - rust-lang/rust', time: 2 },
    { url: 'https://www.example.com/', title: 'Example Domain', time: 1 },
  ]
  assert.deepEqual(suggest(entries, '').map((e) => e.url), [])
  assert.deepEqual(suggest(entries, '  ').map((e) => e.url), [])
  assert.deepEqual(suggest(entries, 'RUST notes').map((e) => e.url), ['https://news.example.com/rust'])
  assert.deepEqual(suggest(entries, 'domain').map((e) => e.url), ['https://www.example.com/'])
  assert.deepEqual(suggest(entries, 'nothing'), [])
  assert.deepEqual(suggest(entries, 'domain')[0], { url: 'https://www.example.com/', title: 'Example Domain' })
})

test('suggest puts addresses that start with the text first, then word starts', () => {
  const entries = [
    { url: 'https://blog.dev/agitate', title: 'Agitate', time: 4 },
    { url: 'https://docs.dev/git', title: 'Docs', time: 3 },
    { url: 'https://www.github.com/', title: 'GitHub', time: 2 },
    { url: 'https://gitlab.com/', title: 'GitLab', time: 1 },
  ]
  assert.deepEqual(suggest(entries, 'git').map((e) => e.url), [
    'https://www.github.com/',
    'https://gitlab.com/',
    'https://docs.dev/git',
    'https://blog.dev/agitate',
  ])
  // Typing the scheme or www. still finds the address.
  assert.equal(suggest(entries, 'https://www.git')[0].url, 'https://www.github.com/')
  assert.equal(suggest(entries, 'git', 2).length, 2)
})

test('bookmarks come first in suggestions, each address once', () => {
  const bookmarks = [{ url: 'https://lit.dev/', title: 'Lit' }, { url: 'https://lit.dev/', title: 'Lit again' }, { url: 'https://other.com/', title: 'Other' }]
  const visits = [{ url: 'https://lit.dev/', title: 'Lit', time: 2 }, { url: 'https://lithub.com/', title: 'Hub', time: 1 }]
  assert.deepEqual(suggestWithBookmarks(bookmarks, visits, 'lit'), [
    { url: 'https://lit.dev/', title: 'Lit', bookmarked: true },
    { url: 'https://lithub.com/', title: 'Hub' },
  ])
  assert.equal(suggestWithBookmarks(bookmarks, visits, 'lit', 1).length, 1)
})
