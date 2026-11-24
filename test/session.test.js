const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { clean, pinnedWindow, load, save, forget } = require('../src/session')

const page = (url, title = '') => ({ url, title })

test('a saved session loads back as it was', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lit-session-')), 'session.json')
  const windows = [
    {
      key: 3,
      tabs: [{ entries: [page('https://a.com/', 'A'), { ...page('https://b.com/', 'B'), pageState: 'xyz' }], index: 1 }, null],
      activeIndex: 1,
      pinned: 1,
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
  assert.equal(win.pinned, 0)
  assert.equal(win.bounds, undefined)
  assert.equal(win.maximized, false)
  assert.equal(win.fullScreen, false)
})

test('the current page stays current when entries are dropped', () => {
  const a = page('https://a.com/'), b = page('https://b.com/')
  // The same address twice: the later one is still the current one.
  assert.equal(clean({ windows: [{ tabs: [{ entries: [a, b, a], index: 2 }] }] })[0].tabs[0].index, 2)
  // A broken current entry falls back to the page before it.
  assert.deepEqual(clean({ windows: [{ tabs: [{ entries: [a, { url: 1 }, b], index: 1 }] }] })[0].tabs[0], { entries: [a, b], index: 0 })
})

test('pinned tabs are a run from the left, each with a page', () => {
  const a = { entries: [page('https://a.com/')], index: 0 }
  const pinnedOf = (tabs, pinned) => clean({ windows: [{ tabs, pinned }] })[0].pinned
  assert.equal(pinnedOf([a, a, a], 2), 2)
  assert.equal(pinnedOf([a, a], 9), 2)
  assert.equal(pinnedOf([a, a], -1), 0)
  assert.equal(pinnedOf([a, a], '2'), 0)
  // A pinned tab whose page is gone ends the pinned ones there.
  assert.equal(pinnedOf([a, { entries: [{ url: '' }], index: 0 }, a], 3), 1)
})

test("pinnedWindow gathers every window's pinned tabs where the front one was", () => {
  const tab = (url) => ({ entries: [page(url)], index: 0 })
  const bounds = { x: 1, y: 2, width: 800, height: 600 }
  const windows = [
    { tabs: [tab('https://a.com/'), tab('https://x.com/')], activeIndex: 1, pinned: 1, maximized: false, fullScreen: false },
    { tabs: [tab('https://y.com/')], activeIndex: 0, pinned: 0, maximized: false, fullScreen: false },
    { tabs: [tab('https://b.com/'), tab('https://c.com/'), null], activeIndex: 2, pinned: 2, bounds, maximized: true, fullScreen: false },
  ]
  assert.deepEqual(pinnedWindow(windows), {
    tabs: [tab('https://a.com/'), tab('https://b.com/'), tab('https://c.com/')],
    activeIndex: 0,
    pinned: 3,
    bounds,
    maximized: true,
    fullScreen: false,
  })
  assert.equal(pinnedWindow([windows[1]]), null)
  assert.equal(pinnedWindow([]), null)
})
