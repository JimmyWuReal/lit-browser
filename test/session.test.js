const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { clean, load, save, forget } = require('../src/session')

const page = (url, title = '') => ({ url, title })

test('a saved session loads back as it was', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lit-session-')), 'session.json')
  const windows = [
    {
      key: 3,
      tabs: [{ entries: [page('https://a.com/', 'A'), { ...page('https://b.com/', 'B'), pageState: 'xyz' }], index: 1 }, null],
      activeIndex: 1,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      maximized: false,
      fullScreen: true,
    },
  ]
  save(file, windows)
  const { key, ...saved } = windows[0]
  assert.equal(key, 3)
  assert.deepEqual(load(file), [saved])
  forget(file)
  assert.deepEqual(load(file), [])
  forget(file)
})

test('load reopens nothing from a missing or broken file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lit-session-')), 'session.json')
  assert.deepEqual(load(file), [])
  fs.writeFileSync(file, '{ broken')
  assert.deepEqual(load(file), [])
})

test('clean keeps only well-formed windows and tabs', () => {
  assert.deepEqual(clean(null), [])
  assert.deepEqual(clean({ windows: 'no' }), [])
  const [win, ...rest] = clean({
    windows: [
      {
        tabs: [
          { entries: [page('https://a.com/'), { url: 5 }, page('https://c.com/')], index: 2 },
          { entries: [{ url: '' }], index: 0 },
          'junk',
        ],
        activeIndex: 7,
        bounds: { x: 0, y: 0, width: -1, height: 10 },
        maximized: 'yes',
      },
      { tabs: [] },
      null,
    ],
  })
  assert.equal(rest.length, 0)
  // The broken entry goes and the current page stays current.
  assert.deepEqual(win.tabs[0], { entries: [page('https://a.com/'), page('https://c.com/')], index: 1 })
  assert.equal(win.tabs[1], null)
  assert.equal(win.tabs[2], null)
  assert.equal(win.activeIndex, 0)
  assert.equal(win.bounds, undefined)
  assert.equal(win.maximized, false)
  assert.equal(win.fullScreen, false)
})
