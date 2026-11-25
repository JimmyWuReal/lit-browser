const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isKind, isApp, opensApp, kindsOf, checkKindsOf, originOf, label, describe, status, undecided, choose, list, load, save } = require('../src/permissions')

test('kindsOf maps the requests Lit asks about, and leaves the rest alone', () => {
  assert.deepEqual(kindsOf('media', ['video', 'audio']), ['camera', 'microphone'])
  assert.deepEqual(kindsOf('media', ['audio']), ['microphone'])
  // Pan, tilt and zoom come without devices; they are asked on their own.
  assert.deepEqual(kindsOf('media', []), ['cameraControls'])
  assert.deepEqual(kindsOf('media'), ['cameraControls'])
  assert.deepEqual(kindsOf('deprecated-sync-clipboard-read'), [])
  assert.deepEqual(kindsOf('geolocation'), ['location'])
  assert.deepEqual(kindsOf('notifications'), ['notifications'])
  assert.deepEqual(kindsOf('clipboard-read'), ['clipboard'])
  assert.equal(kindsOf('fullscreen'), null)
  assert.equal(kindsOf('clipboard-sanitized-write'), null)
  assert.equal(kindsOf('constructor'), null)
})

test('opening another app is a kind per scheme', () => {
  assert.deepEqual(kindsOf('openExternal', undefined, 'mailto:a@b.com'), ['app:mailto'])
  assert.deepEqual(kindsOf('openExternal', [], 'ZOOMMTG://join?x=a:b'), ['app:zoommtg'])
  // Refused: nothing to open, or a scheme too long to name.
  assert.deepEqual(kindsOf('openExternal'), [])
  assert.deepEqual(kindsOf('openExternal', [], 'mailto'), [])
  assert.deepEqual(kindsOf('openExternal', [], `${'a'.repeat(101)}:x`), [])
  assert.deepEqual(checkKindsOf('openExternal'), [])
  assert.ok(isApp('app:mailto') && isKind('app:mailto') && isKind('camera'))
  for (const kind of ['app:', 'app:a b', 'app:__proto__', 'constructor', 'mailto', undefined, null]) assert.equal(isKind(kind), false)
  assert.equal(isApp('camera'), false)
  // Allowing one app leaves the others asking.
  const sites = choose(new Map(), 'https://a.com', ['app:mailto'], 'allow')
  assert.equal(status(sites, 'https://a.com', ['app:mailto']), 'allow')
  assert.equal(status(sites, 'https://a.com', ['app:zoommtg']), 'ask')
  assert.equal(describe(['app:mailto']), 'open mailto links in another app')
  assert.equal(describe([`app:${'a'.repeat(100)}`]), `open ${'a'.repeat(23)}… links in another app`)
})

test('opensApp leaves out the schemes Chromium handles itself', () => {
  for (const url of ['mailto:a@b.com', 'zoommtg://join', 'ssh://host']) assert.equal(opensApp(url), true)
  for (const url of ['https://a.com', 'HTTP://a.com', 'about:blank', 'blob:https://a.com/1', 'data:,hi', '', 'not a url']) assert.equal(opensApp(url), false)
})

test('checkKindsOf names one device, and an untyped media check is camera controls', () => {
  assert.deepEqual(checkKindsOf('media', 'audio'), ['microphone'])
  assert.deepEqual(checkKindsOf('media', 'video'), ['camera'])
  assert.deepEqual(checkKindsOf('media', 'unknown'), ['camera'])
  assert.deepEqual(checkKindsOf('media'), ['cameraControls'])
  assert.deepEqual(checkKindsOf('notifications'), ['notifications'])
  assert.equal(checkKindsOf('fullscreen'), null)
  // Allowing only the microphone never lets a camera check through.
  const sites = choose(new Map(), 'https://a.com', ['microphone'], 'allow')
  assert.equal(status(sites, 'https://a.com', checkKindsOf('media', 'unknown')), 'ask')
})

test('a site is an origin; local files and pages without one have none', () => {
  assert.equal(originOf('https://meet.example.com/abc?x'), 'https://meet.example.com')
  assert.equal(originOf('http://localhost:3000/a'), 'http://localhost:3000')
  assert.equal(originOf('https://example.com:443/'), 'https://example.com')
  assert.equal(originOf('file:///Users/me/a.html'), null)
  assert.equal(originOf('data:text/html,hi'), null)
  assert.equal(originOf('about:blank'), null)
  assert.equal(originOf(''), null)
})

test('label drops https only, and describe words the request', () => {
  assert.equal(label('https://example.com'), 'example.com')
  assert.equal(label('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(describe(['camera', 'microphone']), 'use your camera and microphone')
  assert.equal(describe(['location']), 'know your location')
})

test('status: any block blocks, every kind allowed allows, else ask', () => {
  const site = 'https://example.com'
  let sites = new Map()
  assert.equal(status(sites, site, ['camera']), 'ask')
  sites = choose(sites, site, ['camera'], 'allow')
  assert.equal(status(sites, site, ['camera']), 'allow')
  assert.equal(status(sites, site, ['camera', 'microphone']), 'ask')
  sites = choose(sites, site, ['microphone'], 'block')
  assert.equal(status(sites, site, ['camera', 'microphone']), 'block')
  assert.equal(status(sites, 'http://example.com', ['camera']), 'ask')
})

test('undecided leaves out kinds already chosen', () => {
  const site = 'https://example.com'
  const sites = choose(new Map(), site, ['camera'], 'allow')
  assert.deepEqual(undecided(sites, site, ['camera', 'microphone']), ['microphone'])
  assert.deepEqual(undecided(sites, 'https://other.com', ['camera']), ['camera'])
})

test('choose returns a new map, and forgetting the last kind drops the site', () => {
  const site = 'https://example.com'
  const empty = new Map()
  const one = choose(empty, site, ['camera', 'microphone'], 'allow')
  assert.equal(empty.size, 0)
  assert.deepEqual(one.get(site), { camera: 'allow', microphone: 'allow' })
  const fewer = choose(one, site, ['camera'], null)
  assert.deepEqual(fewer.get(site), { microphone: 'allow' })
  assert.deepEqual(one.get(site), { camera: 'allow', microphone: 'allow' })
  assert.equal(choose(fewer, site, ['microphone'], null).has(site), false)
})

test('list sorts sites by name and kinds in a fixed order', () => {
  const sites = new Map([
    ['https://b.com', { 'app:zoommtg': 'allow', notifications: 'block', 'app:mailto': 'block', camera: 'allow' }],
    ['https://a.com', { location: 'allow' }],
  ])
  assert.deepEqual(list(sites), [
    { site: 'https://a.com', label: 'a.com', kinds: [{ kind: 'location', label: 'Location', choice: 'allow' }] },
    { site: 'https://b.com', label: 'b.com', kinds: [
      { kind: 'camera', label: 'Camera', choice: 'allow' },
      { kind: 'notifications', label: 'Notifications', choice: 'block' },
      { kind: 'app:mailto', label: 'mailto links', choice: 'block' },
      { kind: 'app:zoommtg', label: 'zoommtg links', choice: 'allow' },
    ] },
  ])
})

test('save and load round-trip, keeping only valid sites, kinds and choices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-permissions-'))
  const file = path.join(dir, 'nested', 'permissions.json')
  assert.deepEqual(load(file), new Map())
  const sites = new Map([['https://example.com', { camera: 'allow', 'app:mailto': 'allow', location: 'block' }], ['http://localhost:3000', { microphone: 'allow' }]])
  save(file, sites)
  assert.deepEqual(load(file), sites)
  fs.writeFileSync(file, JSON.stringify({
    'https://a.com': { camera: 'allow', speakers: 'allow', location: 'maybe', 'app:a b': 'allow', 'app:mailto': 'maybe' },
    'https://b.com/path': { camera: 'allow' },
    'file://': { camera: 'allow' },
    'not a site': { camera: 'allow' },
    ['__proto__']: { camera: 'allow' },
    'https://c.com': 'allow',
    'https://d.com': { location: 'block' },
  }))
  assert.deepEqual(load(file), new Map([['https://a.com', { camera: 'allow' }], ['https://d.com', { location: 'block' }]]))
  fs.writeFileSync(file, '[1]')
  assert.deepEqual(load(file), new Map())
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(load(file), new Map())
  fs.rmSync(dir, { recursive: true })
})

test('a private window goes by its own choices, under the saved Blocks', () => {
  const { privateView } = require('../src/permissions')
  const saved = new Map([
    ['https://a.com', { camera: 'allow', location: 'block' }],
    ['https://b.com', { microphone: 'allow' }],
  ])
  assert.deepEqual(privateView(saved, new Map()), new Map([['https://a.com', { location: 'block' }]]))
  // A Block saved outside wins over the window's own Allow.
  const own = new Map([['https://a.com', { location: 'allow', camera: 'allow' }], ['https://c.com', { clipboard: 'block' }]])
  assert.deepEqual(privateView(saved, own), new Map([
    ['https://a.com', { location: 'block', camera: 'allow' }],
    ['https://c.com', { clipboard: 'block' }],
  ]))
  // Neither map is changed.
  assert.deepEqual(saved.get('https://a.com'), { camera: 'allow', location: 'block' })
  assert.deepEqual(own.get('https://a.com'), { location: 'allow', camera: 'allow' })
})
