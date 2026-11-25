const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const p = require('../src/passwords')

const site = 'https://a.com'
const empty = { logins: [], never: [] }
// Secrets are their password reversed.
const hide = (text) => [...text].reverse().join('')
const put = (store, username, password, at = site) => p.put(store, { site: at, username, secret: hide(password) })
const offer = (store, username, password, at = site) => p.offerFor(store, { site: at, username, password }, hide)

test('siteOf takes web origins only', () => {
  assert.equal(p.siteOf('https://a.com/x?y'), site)
  assert.equal(p.siteOf('http://localhost:80/'), 'http://localhost')
  for (const bad of ['null', 'file:///a', 'about:blank', 'data:text/html,a', '']) assert.equal(p.siteOf(bad), null, bad)
})

test('offers to save what is new, update what changed, and nothing else', () => {
  const store = put(empty, 'jo', 'one')
  assert.equal(offer(store, 'jo', 'one'), null)
  assert.equal(offer(store, 'jo', 'two').action, 'update')
  assert.equal(offer(store, 'al', 'one').action, 'save')
  assert.equal(offer(store, 'jo', 'one', 'http://a.com').action, 'save')
  assert.equal(offer(store, 'jo', ''), null)
  assert.equal(offer(p.neverFor(store, site), 'al', 'x'), null)
  // Unreadable (another Keychain key) can be saved over.
  assert.equal(p.offerFor(store, { site, username: 'jo', password: 'one' }, () => null).action, 'update')
})

test('changing a password without a username, the only login is meant', () => {
  const one = put(empty, 'jo', 'one')
  const change = (store, password) => p.offerFor(store, { site, username: '', password, changing: true }, hide)
  assert.deepEqual(change(one, 'two'), { action: 'update', id: one.logins[0].id, secret: hide('one'), username: 'jo' })
  assert.equal(change(one, 'one'), null)
  assert.equal(change(put(one, 'al', 'x'), 'two').action, 'save')
  // Signing in, it could be another account.
  assert.deepEqual(offer(one, '', 'two'), { action: 'save', username: '' })
  assert.equal(offer(one, '', 'one'), null)
})

test('put replaces the same login, and remove and askAgain undo', () => {
  let store = put(put(put(empty, 'jo', 'one'), 'jo', 'two'), 'jo', 'one', 'https://b.com')
  assert.equal(store.logins.length, 2)
  assert.equal(p.forSite(store, site)[0].secret, hide('two'))
  store = p.remove(store, store.logins[0].id)
  assert.deepEqual(store.logins.map((login) => login.site), ['https://b.com'])
  const never = p.neverFor(p.neverFor(empty, site), site)
  assert.deepEqual(never.never, [site])
  assert.deepEqual(p.askAgain(never, site).never, [])
})

test('list never holds a secret', () => {
  const listed = p.list(p.neverFor(put(empty, 'jo', 'one'), 'http://c.com'))
  assert.deepEqual(Object.keys(listed.logins[0]).sort(), ['id', 'site', 'username'])
  assert.equal(listed.logins[0].site, 'a.com')
  assert.deepEqual(listed.never, [{ site: 'http://c.com', label: 'http://c.com' }])
})

test('saves privately, loads back, and keeps a file it can’t read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-'))
  const file = path.join(dir, 'in', 'passwords.json')
  assert.deepEqual(p.load(file), empty)
  const store = p.neverFor(put(empty, 'jo', 'one'), 'https://n.com')
  p.save(file, store)
  assert.deepEqual(p.load(file), store)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  fs.writeFileSync(file, JSON.stringify({ logins: [null, { site: 'https://a.com/x', username: 'a', secret: 'a' }, { site, username: 1, secret: 'a' }], never: [1, 'file:///'] }))
  assert.deepEqual(p.load(file), empty)
  fs.writeFileSync(file, 'nope')
  assert.deepEqual(p.load(file), empty)
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), 'nope')
  fs.rmSync(dir, { recursive: true })
})
