const test = require('node:test')
const assert = require('node:assert/strict')
const { afterClose, step, byNumber, moved, nudged, remember, keepNewest, reopenIndex, onScreen, tabsPlace, sidebarToggle, splitPanes, splitRatio, splitWith, sleepy } = require('../src/tabs')

test('closing a background tab keeps the active one', () => {
  assert.equal(afterClose([1, 2, 3], 1, 3), 1)
})

test('closing the active tab picks its right neighbor, then its left', () => {
  assert.equal(afterClose([1, 2, 3], 2, 2), 3)
  assert.equal(afterClose([1, 2, 3], 3, 3), 2)
})

test('closing the last tab leaves nothing to show', () => {
  assert.equal(afterClose([1], 1, 1), null)
})

test('step wraps around both ends', () => {
  assert.equal(step([1, 2, 3], 3, 1), 1)
  assert.equal(step([1, 2, 3], 1, -1), 3)
  assert.equal(step([], 1, 1), null)
})

test('numbers pick tabs and 9 picks the last', () => {
  assert.equal(byNumber([1, 2, 3], 2), 2)
  assert.equal(byNumber([1, 2, 3], 5), null)
  assert.equal(byNumber([1, 2, 3], 9), 3)
})

test('a tab moves before another, or last', () => {
  assert.deepEqual(moved([1, 2, 3], 3, 1), [3, 1, 2])
  assert.deepEqual(moved([1, 2, 3], 1, 3), [2, 1, 3])
  assert.deepEqual(moved([1, 2, 3], 1, null), [2, 3, 1])
})

test('a move that goes nowhere, or of a tab that is gone, changes nothing', () => {
  assert.deepEqual(moved([1, 2, 3], 2, 2), [1, 2, 3])
  assert.deepEqual(moved([1, 2, 3], 2, 3), [1, 2, 3])
  assert.deepEqual(moved([1, 2, 3], 9, 1), [1, 2, 3])
  assert.deepEqual(moved([1, 2, 3], 1, 9), [1, 2, 3])
})

test('a tab moves one place either way, and stops at the ends', () => {
  assert.deepEqual(nudged([1, 2, 3], 2, -1), [2, 1, 3])
  assert.deepEqual(nudged([1, 2, 3], 2, 1), [1, 3, 2])
  assert.deepEqual(nudged([1, 2, 3], 1, 1), [2, 1, 3])
  assert.deepEqual(nudged([1, 2, 3], 1, -1), [1, 2, 3])
  assert.deepEqual(nudged([1, 2, 3], 3, 1), [1, 2, 3])
  assert.deepEqual(nudged([1, 2, 3], 9, 1), [1, 2, 3])
})

test('remember keeps the newest closed entries last, up to the limit', () => {
  const closed = []
  for (const entry of [1, 2, 3, 4]) remember(closed, entry, 3)
  assert.deepEqual(closed, [2, 3, 4])
  assert.equal(closed.pop(), 4)
})

test('a reopened tab goes back to its place, or the end', () => {
  assert.equal(reopenIndex(1, 3), 1)
  assert.equal(reopenIndex(5, 2), 2)
  assert.equal(reopenIndex(-1, 2), 0)
})

test('a window is on screen while it overlaps a display', () => {
  const displays = [{ x: 0, y: 0, width: 1440, height: 900 }, { x: 1440, y: 0, width: 1920, height: 1080 }]
  assert.equal(onScreen({ x: 100, y: 50, width: 800, height: 600 }, displays), true)
  assert.equal(onScreen({ x: 2000, y: 100, width: 800, height: 600 }, displays), true)
  assert.equal(onScreen({ x: 4000, y: 100, width: 800, height: 600 }, displays), false)
  assert.equal(onScreen({ x: 100, y: 50, width: 800, height: 600 }, []), false)
})

test('lowering the limit keeps only the newest closed entries', () => {
  const closed = [1, 2, 3, 4]
  keepNewest(closed, 2)
  assert.deepEqual(closed, [3, 4])
  keepNewest(closed, 5)
  assert.deepEqual(closed, [3, 4])
})

test('a closed window counts each of its tabs', () => {
  const tab = { history: null }
  const closed = [tab, tab, { tabs: [null, null, null], activeIndex: 0 }, tab]
  keepNewest(closed, 4)
  assert.deepEqual(closed, [{ tabs: [null, null, null], activeIndex: 0 }, tab])
})

test('a window bigger than the limit keeps its active tab and its neighbors', () => {
  const big = [{ history: null }, { tabs: [0, 1, 2, 3, 4, 5, 6], activeIndex: 5 }]
  keepNewest(big, 3)
  assert.deepEqual(big, [{ tabs: [4, 5, 6], activeIndex: 1 }])
  const start = [{ tabs: [0, 1, 2, 3, 4], activeIndex: 0 }]
  keepNewest(start, 2)
  assert.deepEqual(start, [{ tabs: [0, 1], activeIndex: 0 }])
})

test('tabsPlace puts tabs on top, in the sidebar, or nowhere while it is hidden', () => {
  assert.equal(tabsPlace({ verticalTabs: false, tabSidebar: true }), 'top')
  assert.equal(tabsPlace({ verticalTabs: false, tabSidebar: false }), 'top')
  assert.equal(tabsPlace({ verticalTabs: true, tabSidebar: true }), 'side')
  assert.equal(tabsPlace({ verticalTabs: true, tabSidebar: false }), 'none')
})

test('sidebarToggle hides a shown sidebar, else shows it, turning vertical tabs on last', () => {
  assert.deepEqual(sidebarToggle({ verticalTabs: true, tabSidebar: true }), [['tabSidebar', false]])
  assert.deepEqual(sidebarToggle({ verticalTabs: true, tabSidebar: false }), [['tabSidebar', true]])
  assert.deepEqual(sidebarToggle({ verticalTabs: false, tabSidebar: true }), [['verticalTabs', true]])
  assert.deepEqual(sidebarToggle({ verticalTabs: false, tabSidebar: false }), [['tabSidebar', true], ['verticalTabs', true]])
})

test('a split window bigger than the limit keeps its split only with both its tabs', () => {
  const kept = [{ tabs: [0, 1, 2, 3, 4], activeIndex: 4, split: { indexes: [3, 4], ratio: 0.4 } }]
  keepNewest(kept, 2)
  assert.deepEqual(kept, [{ tabs: [3, 4], activeIndex: 1, split: { indexes: [0, 1], ratio: 0.4 } }])
  const dropped = [{ tabs: [0, 1, 2, 3, 4], activeIndex: 4, split: { indexes: [0, 4], ratio: 0.5 } }]
  keepNewest(dropped, 2)
  assert.deepEqual(dropped, [{ tabs: [3, 4], activeIndex: 1 }])
})

test('splitPanes shares the width at the ratio, gap apart', () => {
  assert.deepEqual(splitPanes({ x: 10, width: 1008 }, 0.5, 8, 200), [{ x: 10, width: 500 }, { x: 518, width: 500 }])
  assert.deepEqual(splitPanes({ x: 0, width: 1008 }, 0.25, 8, 200), [{ x: 0, width: 250 }, { x: 258, width: 750 }])
})

test('splitPanes keeps both panes at least the minimum, or even when there is no room', () => {
  assert.deepEqual(splitPanes({ x: 0, width: 1008 }, 0.05, 8, 200), [{ x: 0, width: 200 }, { x: 208, width: 800 }])
  assert.deepEqual(splitPanes({ x: 0, width: 1008 }, 0.99, 8, 200), [{ x: 0, width: 800 }, { x: 808, width: 200 }])
  assert.deepEqual(splitPanes({ x: 0, width: 308 }, 0.1, 8, 200), [{ x: 0, width: 150 }, { x: 158, width: 150 }])
  assert.deepEqual(splitPanes({ x: 0, width: 0 }, 0.5, 8, 200), [{ x: 0, width: 0 }, { x: 8, width: 0 }])
})

test('splitRatio puts the gap under the pointer, within the minimum', () => {
  const area = { x: 100, width: 1008 }
  assert.equal(splitRatio(area, 354, 8, 200), 0.25)
  assert.deepEqual(splitPanes(area, splitRatio(area, 354, 8, 200), 8, 200)[0], { x: 100, width: 250 })
  assert.equal(splitRatio(area, 0, 8, 200), 0.2)
  assert.equal(splitRatio(area, 5000, 8, 200), 0.8)
})

test('splitWith pairs a tab with the active one, or swaps in the other side', () => {
  assert.deepEqual(splitWith(null, 1, 2), { ids: [1, 2], ratio: 0.5 })
  assert.deepEqual(splitWith({ ids: [3, 1], ratio: 0.3 }, 1, 2), { ids: [2, 1], ratio: 0.3 })
  // A split the active tab is not in gives way to a new one.
  assert.deepEqual(splitWith({ ids: [3, 4], ratio: 0.3 }, 1, 2), { ids: [1, 2], ratio: 0.5 })
  const split = { ids: [1, 2], ratio: 0.5 }
  assert.equal(splitWith(split, 1, 1), split)
})

// A background tab on a settled page, last on show at 0.
const idle = { shown: false, asleep: null, url: 'https://example.com/', loading: false, error: null, audible: false, fullScreen: null, asking: false, edited: false, inUse: false, keepAwake: false, seen: 0 }
const minutes = (count) => count * 60_000

test('a tab out of sight for the setting\'s minutes goes to sleep', () => {
  assert.equal(sleepy(idle, minutes(30), 30), true)
  assert.equal(sleepy(idle, minutes(30) - 1, 30), false)
  assert.equal(sleepy(idle, minutes(120), 0), false)
})

test('a tab on show, asleep already, or on no page stays as it is', () => {
  assert.equal(sleepy({ ...idle, shown: true }, minutes(60), 30), false)
  assert.equal(sleepy({ ...idle, asleep: { history: {} } }, minutes(60), 30), false)
  assert.equal(sleepy({ ...idle, url: '' }, minutes(60), 30), false)
})

test('only a page that loads again from its address sleeps', () => {
  assert.equal(sleepy({ ...idle, url: 'file:///Users/me/notes.html' }, minutes(60), 30), true)
  assert.equal(sleepy({ ...idle, url: 'blob:https://example.com/4f1c' }, minutes(60), 30), false)
  assert.equal(sleepy({ ...idle, url: 'about:blank' }, minutes(60), 30), false)
})

test('a tab doing something you would miss stays awake', () => {
  for (const busy of [{ loading: true }, { error: { kind: 'crash' } }, { audible: true }, { fullScreen: 'on' }, { asking: true }, { edited: true }, { inUse: true }, { keepAwake: true }]) {
    assert.equal(sleepy({ ...idle, ...busy }, minutes(60), 30), false, JSON.stringify(busy))
  }
})
