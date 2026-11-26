const test = require('node:test')
const assert = require('node:assert/strict')
const { VALUE_LIMIT, domainOf, isHostOnly, list, isTarget, pick, urlOf, lost, detailsOf } = require('../src/cookies')

const cookie = (fields) => ({ path: '/', secure: false, httpOnly: false, session: true, ...fields })

test('domainOf drops the dot a domain cookie has', () => {
  assert.equal(domainOf({ domain: '.Example.com' }), 'example.com')
  assert.equal(domainOf({ domain: 'example.com' }), 'example.com')
  assert.equal(domainOf({}), '')
  assert.equal(isHostOnly({ domain: '.example.com' }), false)
  assert.equal(isHostOnly({ domain: 'example.com' }), true)
})

test('list groups cookies by domain, related domains together', () => {
  const domains = list([
    cookie({ domain: 'b.com', name: 'z' }),
    cookie({ domain: '.accounts.google.com', name: 'SID' }),
    cookie({ domain: 'a.com', name: 'x' }),
    cookie({ domain: '.google.com', name: 'NID', session: false, expirationDate: 1800000000.4, secure: true, httpOnly: true }),
    cookie({ domain: 'google.com', name: 'AEC' }),
    cookie({ domain: '', name: 'nowhere' }),
  ])
  assert.deepEqual(domains.map((item) => item.domain), ['a.com', 'b.com', 'google.com', 'accounts.google.com'])
  // A host's own cookies and its domain cookies are one domain, by name.
  assert.deepEqual(domains[2].cookies, [
    { name: 'AEC', value: '', path: '/', hostOnly: true, copies: 1, expires: null, secure: false, httpOnly: false },
    { name: 'NID', value: '', path: '/', hostOnly: false, copies: 1, expires: 1800000000400, secure: true, httpOnly: true },
  ])
})

test('list makes copies kept for each embedding site one entry', () => {
  const [{ cookies }] = list([
    cookie({ domain: 'embed.com', name: 'pc', value: 'one' }),
    cookie({ domain: 'embed.com', name: 'pc', value: 'two' }),
    cookie({ domain: '.embed.com', name: 'pc' }),
  ])
  assert.deepEqual(cookies.map(({ value, hostOnly, copies }) => [value, hostOnly, copies]), [['one', true, 2], ['', false, 1]])
})

test('list cuts long values', () => {
  const [{ cookies: [long, short] }] = list([
    cookie({ domain: 'a.com', name: 'a', value: 'x'.repeat(VALUE_LIMIT + 1) }),
    cookie({ domain: 'a.com', name: 'b', value: 'x'.repeat(VALUE_LIMIT) }),
  ])
  assert.equal(long.value, `${'x'.repeat(VALUE_LIMIT)}…`)
  assert.equal(short.value, 'x'.repeat(VALUE_LIMIT))
})

test('pick finds a domain’s cookies, or one of them', () => {
  const cookies = [
    cookie({ domain: '.a.com', name: 'id' }),
    cookie({ domain: 'a.com', name: 'id', path: '/app' }),
    cookie({ domain: 'sub.a.com', name: 'id' }),
    cookie({ domain: 'b.com', name: 'id' }),
  ]
  assert.deepEqual(pick(cookies, { domain: 'a.com' }), cookies.slice(0, 2))
  assert.deepEqual(pick(cookies, { domain: 'a.com', name: 'id', path: '/app', hostOnly: true }), [cookies[1]])
  assert.deepEqual(pick(cookies, { domain: 'a.com', name: 'gone', path: '/', hostOnly: true }), [])
  // The host's own and the domain cookie of one name and path are told apart.
  const both = [cookie({ domain: '.a.com', name: 'sid' }), cookie({ domain: 'a.com', name: 'sid' })]
  assert.deepEqual(pick(both, { domain: 'a.com', name: 'sid', path: '/', hostOnly: false }), [both[0]])
  assert.deepEqual(pick(both, { domain: 'a.com', name: 'sid', path: '/', hostOnly: true }), [both[1]])
  assert.deepEqual(list(both)[0].cookies.map((item) => item.hostOnly), [true, false])
})

test('pick names nothing for anything but a domain or a cookie', () => {
  const cookies = [cookie({ domain: 'a.com', name: 'id' })]
  for (const target of [null, undefined, {}, { domain: '' }, { domain: 1 }, { domain: 'a.com', name: 'id' }, { domain: 'a.com', path: '/' }, { domain: 'a.com', name: 1, path: '/', hostOnly: true }, { domain: 'a.com', name: 'id', path: '/' }, { domain: 'a.com', hostOnly: true }]) {
    assert.equal(isTarget(target), false)
    assert.deepEqual(pick(cookies, target), [])
  }
})

test('urlOf is an address the cookie is sent to', () => {
  assert.equal(urlOf({ domain: '.a.com', path: '/app', secure: true }), 'https://a.com/app')
  assert.equal(urlOf({ domain: 'a.com', secure: false }), 'https://a.com/')
})

test('lost finds cookies a removal took but did not name', () => {
  const root = cookie({ domain: 'a.com', name: 'sid' })
  const app = cookie({ domain: 'a.com', name: 'sid', path: '/app' })
  const parent = cookie({ domain: '.a.com', name: 'sid' })
  const other = cookie({ domain: 'b.com', name: 'x' })
  // Removing sid at /app took both others named sid; b.com's stayed.
  assert.deepEqual(lost([root, app, parent, other], [app], [other]), [root, parent])
  assert.deepEqual(lost([root, app], [app], [root]), [])
  // Other names that went meanwhile, by a site or another removal, stay gone.
  assert.deepEqual(lost([root, app, other], [app], [root]), [])
})

test('detailsOf puts a cookie back as it was', () => {
  assert.deepEqual(detailsOf({ domain: '.a.com', name: 'sid', value: 'v', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, expirationDate: 1800000000 }),
    { url: 'https://a.com/', name: 'sid', value: 'v', path: '/', domain: '.a.com', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 1800000000 })
  // A host's own cookie, kept until Lit quits.
  assert.deepEqual(detailsOf({ domain: 'a.com', name: 'n', value: '', path: '/app', secure: false, httpOnly: false, sameSite: 'unspecified', session: true }),
    { url: 'https://a.com/app', name: 'n', value: '', path: '/app', secure: false, httpOnly: false, sameSite: 'unspecified' })
})
