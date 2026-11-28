const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const chrome = require('../src/chrome')
const bookmarkStore = require('../src/bookmarks')
const historyStore = require('../src/history')

const EPOCH = 11644473600000
const toChrome = (ms) => (ms + EPOCH) * 1000
const NOW = Date.UTC(2026, 10, 28)
const DAY = 24 * 60 * 60 * 1000

function fakeChrome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-chrome-test-'))
  test.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function makeHistory(folder, rows) {
  const db = new DatabaseSync(path.join(folder, 'History'))
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0)')
  const insert = db.prepare('INSERT INTO urls (url, title, last_visit_time, hidden) VALUES (?, ?, ?, ?)')
  for (const { url, title = '', time, hidden = 0 } of rows) insert.run(url, title, BigInt(toChrome(time)), hidden)
  db.close()
}

const SECRET = 'chrome-safe-storage-password'
const KEY = chrome.deriveKey(SECRET)
function encrypt(password) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(password, 'utf8'), cipher.final()])
}

function makeLogins(folder, file, rows) {
  const db = new DatabaseSync(path.join(folder, file))
  db.exec('CREATE TABLE logins (origin_url VARCHAR NOT NULL, username_value VARCHAR, password_value BLOB, blacklisted_by_user INTEGER NOT NULL, scheme INTEGER NOT NULL)')
  const insert = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, ?)')
  for (const { url, username = '', password = null, never = 0, scheme = 0 } of rows) insert.run(url, username, password, never, scheme)
  db.close()
}

test('profiles: Chrome’s own folders with data, named from Local State', () => {
  const root = fakeChrome()
  for (const id of ['Default', 'Profile 10', 'Profile 2', 'Empty', 'System Profile', 'Profile 3']) fs.mkdirSync(path.join(root, id))
  for (const id of ['Default', 'Profile 10', 'Profile 2', 'System Profile']) fs.writeFileSync(path.join(root, id, 'Bookmarks'), '{}')
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Me' }, 'Profile 2': { name: '  Work ' }, 'Profile 10': { name: '' } } } }))
  assert.deepEqual(chrome.profiles(root), [
    { id: 'Default', name: 'Me' },
    { id: 'Profile 2', name: 'Work' },
    { id: 'Profile 10', name: 'Profile 10' },
  ])
})

test('profiles: none without Chrome, folder names without Local State', () => {
  assert.deepEqual(chrome.profiles(path.join(os.tmpdir(), 'no-such-chrome')), [])
  const root = fakeChrome()
  fs.mkdirSync(path.join(root, 'Default'))
  fs.writeFileSync(path.join(root, 'Default', 'History'), '')
  assert.deepEqual(chrome.profiles(root), [{ id: 'Default', name: 'Default' }])
})

test('isProfileId refuses anything but Chrome’s profile folders', () => {
  for (const id of ['Default', 'Profile 1', 'Profile 23']) assert.ok(chrome.isProfileId(id), id)
  for (const id of ['../Default', 'Profile 1/..', 'Guest Profile', '', null]) assert.ok(!chrome.isProfileId(id), String(id))
})

test('readBookmarks flattens folders into Lit’s one level', () => {
  const folder = fakeChrome()
  const url = (name, address) => ({ type: 'url', name, url: address })
  const dir = (name, children) => ({ type: 'folder', name, children })
  fs.writeFileSync(path.join(folder, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: dir('Bookmarks bar', [
        url('A', 'https://a.com/'),
        dir('Work', [url('B', 'https://b.com'), dir('Deep', [url('C', 'https://c.com/x')]), url('Script', 'javascript:alert(1)')]),
        dir('Empty', [dir('Also empty', [])]),
        url('Settings', 'chrome://settings'),
      ]),
      other: dir('Other bookmarks', [url('D', 'https://d.com/')]),
      synced: dir('Mobile bookmarks', []),
    },
  }))
  assert.deepEqual(chrome.readBookmarks(folder), [
    { title: 'A', url: 'https://a.com/' },
    { title: 'Work', items: [{ title: 'B', url: 'https://b.com/' }, { title: 'C', url: 'https://c.com/x' }] },
    { title: 'Other bookmarks', items: [{ title: 'D', url: 'https://d.com/' }] },
  ])
  assert.equal(chrome.countBookmarks(chrome.readBookmarks(folder)), 4)
})

test('readBookmarks reads the Google account’s bookmarks first, and counts each once', () => {
  const folder = fakeChrome()
  const roots = (bar, other = []) => JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: bar }, other: { type: 'folder', children: other } } })
  fs.writeFileSync(path.join(folder, 'AccountBookmarks'), roots([{ type: 'url', name: 'Account', url: 'https://account.com/' }, { type: 'url', name: 'Both', url: 'https://both.com/' }]))
  fs.writeFileSync(path.join(folder, 'Bookmarks'), roots([{ type: 'url', name: 'Both', url: 'https://both.com/' }], [{ type: 'url', name: 'Local', url: 'https://local.com/' }]))
  const items = chrome.readBookmarks(folder)
  assert.deepEqual(items.map((item) => item.url || item.title), ['https://account.com/', 'https://both.com/', 'https://both.com/', 'Other bookmarks'])
  assert.equal(chrome.countBookmarks(items), 3)
})

test('readBookmarks: none without a file, throws on a broken one', () => {
  const folder = fakeChrome()
  assert.deepEqual(chrome.readBookmarks(folder), [])
  fs.writeFileSync(path.join(folder, 'Bookmarks'), '{ not json')
  assert.throws(() => chrome.readBookmarks(folder))
})

test('mergeBookmarks adds to the bar and to folders by name, skipping what is there', () => {
  let list = [bookmarkStore.page({ title: 'A', url: 'https://a.com/' }), bookmarkStore.folder('Work')]
  list = bookmarkStore.add(list, bookmarkStore.page({ title: 'B', url: 'https://b.com/' }), list[1].id)
  const imported = [
    { title: 'A again', url: 'https://a.com/' },
    { title: 'E', url: 'https://e.com/' },
    { title: 'Work', items: [{ title: 'B', url: 'https://b.com/' }, { title: 'A', url: 'https://a.com/' }] },
    { title: 'Other bookmarks', items: [{ title: 'D', url: 'https://d.com/' }] },
  ]
  const { list: merged, added } = chrome.mergeBookmarks(list, imported)
  assert.equal(added, 3)
  const shape = (items) => items.map((item) => (item.items ? { title: item.title, items: shape(item.items) } : item.url))
  assert.deepEqual(shape(merged), [
    'https://a.com/',
    { title: 'Work', items: ['https://b.com/', 'https://a.com/'] },
    'https://e.com/',
    { title: 'Other bookmarks', items: ['https://d.com/'] },
  ])
  // Again, nothing new.
  const again = chrome.mergeBookmarks(merged, imported)
  assert.equal(again.added, 0)
  assert.equal(again.list, merged)
})

test('readHistory reads pages since a time, newest first, from a copy', () => {
  const folder = fakeChrome()
  makeHistory(folder, [
    { url: 'https://old.com/', title: 'Old', time: NOW - 40 * DAY },
    { url: 'https://new.com/', title: 'New', time: NOW - DAY },
    { url: 'https://mid.com/', title: null, time: NOW - 10 * DAY },
    { url: 'https://frame.com/', time: NOW - DAY, hidden: 1 },
    { url: 'chrome://history/', time: NOW - DAY },
    { url: 'about:blank', time: NOW - DAY },
  ])
  assert.deepEqual(chrome.readHistory(folder, chrome.since('month', NOW)), [
    { url: 'https://new.com/', title: 'New', time: NOW - DAY },
    { url: 'https://mid.com/', title: '', time: NOW - 10 * DAY },
  ])
  assert.equal(chrome.readHistory(folder).length, 3)
  assert.deepEqual(chrome.countHistory(folder, NOW), { week: 1, month: 2, quarter: 3, all: 3 })
  // Nothing left behind.
  assert.ok(!fs.readdirSync(os.tmpdir()).some((name) => name.startsWith('lit-chrome-') && fs.existsSync(path.join(os.tmpdir(), name, 'db'))))
})

test('readHistory reads a copy while Chrome holds the file locked', () => {
  const folder = fakeChrome()
  makeHistory(folder, [{ url: 'https://a.com/', title: 'A', time: NOW - DAY }])
  // As a running Chrome does: an exclusive lock, kept after a write.
  const chromeOpen = new DatabaseSync(path.join(folder, 'History'))
  chromeOpen.exec('PRAGMA locking_mode = EXCLUSIVE; UPDATE urls SET title = title')
  try {
    assert.throws(() => new DatabaseSync(path.join(folder, 'History'), { readOnly: true }).prepare('SELECT 1 FROM urls').get(), /locked/)
    assert.deepEqual(chrome.readHistory(folder).map((entry) => entry.url), ['https://a.com/'])
  } finally {
    chromeOpen.close()
  }
})

test('readHistory and countHistory: nothing without a History file', () => {
  const folder = fakeChrome()
  assert.deepEqual(chrome.readHistory(folder), [])
  assert.deepEqual(chrome.countHistory(folder, NOW), { week: 0, month: 0, quarter: 0, all: 0 })
})

test('since: a range’s oldest time, 0 for all', () => {
  assert.equal(chrome.since('week', NOW), NOW - 7 * DAY)
  assert.equal(chrome.since('quarter', NOW), NOW - 90 * DAY)
  assert.equal(chrome.since('all', NOW), 0)
})

test('mergeHistory keeps the later visit and a title, within the limit', () => {
  const entries = [
    { url: 'https://both.com/', title: 'Lit title', time: 50 },
    { url: 'https://lit.com/', title: 'Lit', time: 40 },
    { url: 'https://untitled.com/', title: '', time: 10 },
  ]
  const imported = [
    { url: 'https://chrome.com/', title: 'Chrome', time: 60 },
    { url: 'https://both.com/', title: 'Chrome title', time: 20 },
    { url: 'https://untitled.com/', title: 'Found', time: 5 },
    { url: 'javascript:void(0)', title: '', time: 70 },
  ]
  const { entries: merged, added } = chrome.mergeHistory(entries, imported)
  assert.equal(added, 1)
  assert.deepEqual(merged, [
    { url: 'https://chrome.com/', title: 'Chrome', time: 60 },
    { url: 'https://both.com/', title: 'Lit title', time: 50 },
    { url: 'https://lit.com/', title: 'Lit', time: 40 },
    { url: 'https://untitled.com/', title: 'Found', time: 10 },
  ])
  // A later visit in Chrome moves Lit's entry up.
  assert.deepEqual(chrome.mergeHistory(entries, [{ url: 'https://lit.com/', title: '', time: 99 }]).entries[0], { url: 'https://lit.com/', title: 'Lit', time: 99 })
})

test('mergeHistory counts only added pages that fit in the limit', () => {
  const entries = Array.from({ length: historyStore.LIMIT }, (_, i) => ({ url: `https://lit.com/${i}`, title: '', time: 1000 + i }))
  const imported = [{ url: 'https://new.com/', title: '', time: 99999 }, { url: 'https://old.com/', title: '', time: 1 }]
  const { entries: merged, added } = chrome.mergeHistory(entries, imported)
  assert.equal(merged.length, historyStore.LIMIT)
  assert.equal(added, 1)
  assert.equal(merged[0].url, 'https://new.com/')
})

test('decrypt reads Chrome’s v10 passwords with its key', () => {
  assert.equal(chrome.decrypt(encrypt('hunter2 ✓'), KEY), 'hunter2 ✓')
  assert.equal(chrome.decrypt(encrypt('hunter2'), chrome.deriveKey('wrong')), null)
  assert.equal(chrome.decrypt(Buffer.from('v11whatever'), KEY), null)
})

test('readLogins reads both stores, the account’s first, without duplicates', () => {
  const folder = fakeChrome()
  makeLogins(folder, 'Login Data For Account', [
    { url: 'https://a.com/login', username: 'me', password: encrypt('account') },
  ])
  makeLogins(folder, 'Login Data', [
    { url: 'https://a.com/other', username: 'me', password: encrypt('local') },
    { url: 'https://a.com/', username: '', password: encrypt('nameless') },
    { url: 'http://b.com:8080/x', username: 'b', password: encrypt('b') },
    { url: 'https://basic.com/', username: 'x', password: encrypt('x'), scheme: 1 },
    { url: 'android://hash@com.app/', username: 'x', password: encrypt('x') },
    { url: 'https://federated.com/', username: 'x', password: null },
    { url: 'https://never.com/', never: 1 },
  ])
  const { logins, never } = chrome.readLogins(folder)
  assert.deepEqual(logins.map(({ site, username, copies }) => [site, username, ...copies.map((copy) => chrome.decrypt(copy, KEY))]), [
    ['https://a.com', 'me', 'account', 'local'],
    ['https://a.com', '', 'nameless'],
    ['http://b.com:8080', 'b', 'b'],
  ])
  assert.deepEqual(never, ['https://never.com'])
  assert.deepEqual(chrome.countLogins(folder), { logins: 3, never: 1 })
  assert.deepEqual(chrome.readLogins(fakeChrome()), { logins: [], never: [] })
})

test('mergeLogins re-encrypts new logins from a copy that reads, and keeps Lit’s own', () => {
  const hide = (text) => `lit:${text}`
  const store = { logins: [{ id: 'x', site: 'https://a.com', username: 'me', secret: hide('mine') }], never: [] }
  const imported = {
    logins: [
      { site: 'https://a.com', username: 'me', copies: [encrypt('theirs')] },
      { site: 'https://a.com', username: 'other', copies: [encrypt('other')] },
      { site: 'https://b.com', username: 'b', copies: [Buffer.from('v10garbage'), encrypt('local copy')] },
      { site: 'https://c.com', username: '', copies: [Buffer.from('v10garbage')] },
    ],
    never: ['https://never.com'],
  }
  const result = chrome.mergeLogins(store, imported, KEY, hide)
  assert.equal(result.added, 2)
  assert.equal(result.unreadable, 1)
  assert.deepEqual(result.store.logins.map(({ site, username, secret }) => [site, username, secret]), [
    ['https://a.com', 'me', 'lit:mine'],
    ['https://a.com', 'other', 'lit:other'],
    ['https://b.com', 'b', 'lit:local copy'],
  ])
  assert.deepEqual(result.store.never, ['https://never.com'])
  assert.deepEqual(chrome.mergeLogins(store, imported, KEY, () => null), { error: 'Couldn’t encrypt passwords with the Keychain.' })
})
