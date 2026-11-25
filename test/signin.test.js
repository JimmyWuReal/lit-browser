const test = require('node:test')
const assert = require('node:assert/strict')
const signIn = require('../src/signin')

const MAIN = { isMainFrame: true, isRequestForNavigation: true, firstAuthAttempt: true }
const FRAME = { isMainFrame: false, isRequestForNavigation: true, firstAuthAttempt: true }
const FETCH = { isMainFrame: false, isRequestForNavigation: false, firstAuthAttempt: true }
const server = (host, port, more) => ({ isProxy: false, scheme: 'basic', host, port, realm: 'Files', ...more })
const PROXY = { isProxy: true, scheme: 'basic', host: 'proxy.corp', port: 3128, realm: '' }

test('a page being opened asks, named by its host and not its realm', () => {
  const asked = signIn.describe({ ...MAIN, url: 'https://example.com/a' }, server('example.com', 443, { realm: 'bank.com' }), 'https://other.com/')
  assert.equal(asked.name, 'example.com')
  assert.equal(asked.main, true)
  assert.equal(asked.note, '')
  assert.ok(!signIn.asks(asked).includes('bank.com'))
})

test('the host asking is named, whatever the address says', () => {
  assert.equal(signIn.describe({ ...MAIN, url: 'https://bank.com@evil.com/' }, server('evil.com', 443), '').name, 'evil.com')
  assert.equal(signIn.describe({ ...MAIN, url: 'http://u:p@[::1]:8080/a' }, server('[::1]', 8080), '').name, 'http://[::1]:8080')
})

test('a username and password in the address are not shown', () => {
  assert.equal(signIn.describe({ ...MAIN, url: 'https://u:p@example.com/a' }, server('example.com', 443), '').url, 'https://example.com/a')
})

test('warns over an unencrypted connection', () => {
  const asked = signIn.describe({ ...MAIN, url: 'http://example.com/' }, server('example.com', 80), '')
  assert.equal(asked.name, 'http://example.com')
  assert.match(asked.note, /^Not encrypted/)
  // To an encrypted site through a proxy, the proxy itself may not be.
  assert.match(signIn.describe({ ...MAIN, url: 'https://example.com/' }, PROXY, '').note, /^May not be encrypted/)
})

test('what a page loads asks only for its own site', () => {
  const page = 'https://example.com/page'
  for (const kind of [FRAME, FETCH]) {
    assert.equal(signIn.describe({ ...kind, url: 'https://example.com/b' }, server('example.com', 443), page).main, false)
    assert.equal(signIn.describe({ ...kind, url: 'https://evil.com/b' }, server('evil.com', 443), page), null)
    assert.equal(signIn.describe({ ...kind, url: 'http://example.com/b' }, server('example.com', 80), page), null)
    assert.equal(signIn.describe({ ...kind, url: 'https://example.com:8443/b' }, server('example.com', 8443), page), null)
    for (const blank of ['', 'about:blank', 'data:text/html,x']) assert.equal(signIn.describe({ ...kind, url: 'https://example.com/b' }, server('example.com', 443), blank), null)
  }
  assert.ok(signIn.describe({ ...FETCH, url: 'wss://example.com/s' }, server('example.com', 443), page))
  assert.equal(signIn.describe({ ...FETCH, url: 'ws://example.com/s' }, server('example.com', 80), page), null)
})

test('a proxy asks whatever the request, named as one', () => {
  const asked = signIn.describe({ ...FETCH, url: 'https://elsewhere.com/' }, PROXY, 'https://example.com/')
  assert.equal(asked.name, 'proxy.corp:3128')
  assert.equal(signIn.asks(asked), '(your proxy) wants you to sign in')
})

test('requests one answer fits share a key', () => {
  const key = (details, info, page = 'https://example.com/') => signIn.describe({ ...FETCH, ...details }, info, page).key
  const first = key({ url: 'https://example.com/a' }, server('example.com', 443))
  assert.equal(key({ url: 'https://example.com/b' }, server('example.com', 443)), first)
  assert.notEqual(key({ url: 'https://example.com/b' }, server('example.com', 443, { realm: 'Other' })), first)
  assert.notEqual(key({ url: 'https://example.com/b' }, server('example.com', 443, { scheme: 'digest' })), first)
  assert.notEqual(key({ url: 'https://example.com/b' }, { ...PROXY, host: 'example.com', port: 443, realm: 'Files' }), first)
})

test('says when an answer was wrong', () => {
  const asked = signIn.describe({ ...MAIN, firstAuthAttempt: false, url: 'https://example.com/' }, server('example.com', 443), '')
  assert.equal(signIn.asks(asked), 'didn’t accept that, try again')
})
