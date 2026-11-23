const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LIMIT, visit, retitle, remove, load, save } = require('../src/history')

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
