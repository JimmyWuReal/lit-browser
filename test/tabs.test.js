const test = require('node:test')
const assert = require('node:assert/strict')
const { afterClose, step, byNumber, moved, nudged, remember, keepNewest, reopenIndex, onScreen, tabsPlace, sidebarToggle, SIDEBAR, sidebarWidth, sidebarNudged, sidebarShowing, SPLIT_MOST, splitIds, splitWithout, splitBeside, splitSwap, splitLayout, splitResize, splitDrop, splitDropped, dropRect, splitWith, cleanSplit, sleepy } = require('../src/tabs')

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

test('a split window bigger than the limit keeps its split with the tabs that stay', () => {
  const kept = [{ tabs: [0, 1, 2, 3, 4], activeIndex: 4, split: { dir: 'row', sizes: [0.4, 0.6], panes: [3, 4] } }]
  keepNewest(kept, 2)
  assert.deepEqual(kept, [{ tabs: [3, 4], activeIndex: 1, split: { dir: 'row', sizes: [0.4, 0.6], panes: [0, 1] } }])
  // Of three, the two kept stay split.
  const three = [{ tabs: [0, 1, 2, 3, 4], activeIndex: 4, split: { dir: 'row', sizes: [0.5, 0.25, 0.25], panes: [0, 3, 4] } }]
  keepNewest(three, 2)
  assert.deepEqual(three[0].split, { dir: 'row', sizes: [0.5, 0.5], panes: [0, 1] })
  const dropped = [{ tabs: [0, 1, 2, 3, 4], activeIndex: 4, split: { dir: 'row', sizes: [0.5, 0.5], panes: [0, 4] } }]
  keepNewest(dropped, 2)
  assert.deepEqual(dropped, [{ tabs: [3, 4], activeIndex: 1 }])
})

test('sidebarWidth follows the edge within its limits, snapping to the rail past halfway to it', () => {
  assert.equal(sidebarWidth(260.4), 260)
  assert.equal(sidebarWidth(1000), SIDEBAR.most)
  assert.equal(sidebarWidth(120), SIDEBAR.least)
  assert.equal(sidebarWidth(94), SIDEBAR.least)
  assert.equal(sidebarWidth(93), SIDEBAR.rail)
  assert.equal(sidebarWidth(-20), SIDEBAR.rail)
})

test('sidebarNudged steps the width, jumping between the rail and the narrowest with titles', () => {
  assert.equal(sidebarNudged(220, 1, 20), 240)
  assert.equal(sidebarNudged(220, -1, 60), 160)
  assert.equal(sidebarNudged(160, -1, 60), SIDEBAR.least)
  assert.equal(sidebarNudged(SIDEBAR.least, -1, 20), SIDEBAR.rail)
  assert.equal(sidebarNudged(SIDEBAR.rail, -1, 20), SIDEBAR.rail)
  assert.equal(sidebarNudged(SIDEBAR.rail, 1, 20), SIDEBAR.least)
  assert.equal(sidebarNudged(390, 1, 60), SIDEBAR.most)
})

test('sidebarShowing leaves the toolbar its room, and is the rail in a narrow window', () => {
  assert.equal(sidebarShowing(300, 1400), 300)
  assert.equal(sidebarShowing(400, 800), 320)
  assert.equal(sidebarShowing(400, 699), SIDEBAR.rail)
  assert.equal(sidebarShowing(SIDEBAR.rail, 1400), SIDEBAR.rail)
})

const row = (panes, sizes = panes.map(() => 1 / panes.length)) => ({ dir: 'row', sizes, panes })
const column = (panes, sizes = panes.map(() => 1 / panes.length)) => ({ dir: 'column', sizes, panes })

test('splitIds lists a split\'s tabs left to right, top to bottom', () => {
  assert.deepEqual(splitIds(row([1, column([2, 3])])), [1, 2, 3])
  assert.deepEqual(splitIds(null), [])
  assert.deepEqual(splitIds(5), [5])
})

test('splitBeside splits a pane on the side asked, keeping the rest', () => {
  assert.deepEqual(splitBeside(1, 1, 2, 'right'), row([1, 2]))
  assert.deepEqual(splitBeside(1, 1, 2, 'top'), column([2, 1]))
  // The same way as its group: the pane's room is shared, the others keep theirs.
  assert.deepEqual(splitBeside(row([1, 2]), 2, 3, 'right'), row([1, 2, 3], [0.5, 0.25, 0.25]))
  // Across it: a group of its own.
  assert.deepEqual(splitBeside(row([1, 2]), 2, 3, 'bottom'), row([1, column([2, 3])]))
  // A grid.
  assert.deepEqual(splitBeside(row([1, column([2, 3])]), 1, 4, 'bottom'), row([column([1, 4]), column([2, 3])]))
  // A tab already there moves.
  assert.deepEqual(splitBeside(row([1, 2]), 2, 1, 'bottom'), column([2, 1]))
  assert.deepEqual(splitBeside(row([1, 2, 3]), 1, 3, 'left'), row([3, 1, 2], [0.25, 0.25, 0.5]))
  const split = row([1, 2])
  assert.equal(splitBeside(split, 1, 1, 'left'), split)
  assert.equal(splitBeside(split, 1, 3, 'middle'), split)
})

test('splitWithout gives a tab\'s room to the panes beside it, ending at one tab', () => {
  assert.deepEqual(splitWithout(row([1, 2, 3], [0.5, 0.25, 0.25]), 3), row([1, 2], [2 / 3, 1 / 3]))
  // A group of one gives way to its tab, and one going the same way joins.
  assert.deepEqual(splitWithout(row([1, column([2, 3])]), 2), row([1, 3]))
  assert.deepEqual(splitWithout(column([row([1, 2]), 3]), 3), row([1, 2]))
  assert.equal(splitWithout(row([1, 2]), 1), 2)
  assert.equal(splitWithout(row([1, 2]), 9).panes.length, 2)
})

test('splitSwap trades two tabs, or puts one in another\'s place', () => {
  assert.deepEqual(splitSwap(row([1, column([2, 3])]), 1, 3), row([3, column([2, 1])]))
  assert.deepEqual(splitSwap(row([1, 2]), 2, 7), row([1, 7]))
})

test('splitLayout places panes and the dividers between them, gap apart', () => {
  const rect = { x: 10, y: 50, width: 1008, height: 608 }
  const { panes, dividers } = splitLayout(row([1, column([2, 3], [0.25, 0.75])]), rect, 8)
  assert.deepEqual(panes, [
    { id: 1, x: 10, y: 50, width: 500, height: 608 },
    { id: 2, x: 518, y: 50, width: 500, height: 150 },
    { id: 3, x: 518, y: 208, width: 500, height: 450 },
  ])
  assert.deepEqual(dividers, [
    { path: [], index: 0, dir: 'row', share: 0.5, x: 510, y: 50, width: 8, height: 608 },
    { path: [1], index: 0, dir: 'column', share: 0.25, x: 518, y: 200, width: 500, height: 8 },
  ])
  // Rounded edges still fill the room exactly.
  const thirds = splitLayout(row([1, 2, 3]), { x: 0, y: 0, width: 1000, height: 10 }, 8).panes
  assert.equal(thirds.at(-1).x + thirds.at(-1).width, 1000)
  assert.deepEqual(splitLayout(row([1, 2]), { x: 0, y: 0, width: 0, height: 0 }, 8).panes.map((pane) => pane.width), [0, 0])
})

test('splitResize moves a divider under the pointer, keeping panes at least the minimum', () => {
  const rect = { x: 100, y: 0, width: 1008, height: 600 }
  const split = row([1, 2])
  const sizes = (node) => node.sizes.map((size) => Math.round(size * 1000) / 1000)
  assert.deepEqual(splitResize(split, [], 0, 354, rect, 8, 200), row([1, 2], [0.25, 0.75]))
  assert.deepEqual(sizes(splitResize(split, [], 0, 0, rect, 8, 200)), [0.2, 0.8])
  assert.deepEqual(sizes(splitResize(split, [], 0, 5000, rect, 8, 200)), [0.8, 0.2])
  // Only the two panes beside it change.
  assert.deepEqual(sizes(splitResize(row([1, 2, 3]), [], 1, 100 + 992 * 0.5 + 8 + 4, rect, 8, 100)), [0.333, 0.167, 0.5])
  // A divider lying down, in a group inside the split.
  const nested = splitResize(row([1, column([2, 3])]), [1], 0, 152, rect, 8, 100)
  assert.deepEqual(nested.panes[1].sizes, [0.25, 0.75])
  assert.deepEqual(nested.sizes, [0.5, 0.5])
  // A pane with two side by side in it needs room for both.
  const wide = splitResize(row([1, column([row([2, 3]), 4])]), [], 0, 5000, rect, 8, 200)
  assert.equal(Math.round(wide.sizes[1] * 1000), 408)
  // Too little room for the minimum: no further than even.
  assert.deepEqual(sizes(splitResize(split, [], 0, 0, { ...rect, width: 308 }, 8, 200)), [0.5, 0.5])
  // Even again, and no such divider.
  assert.deepEqual(sizes(splitResize(row([1, 2, 3], [0.5, 0.25, 0.25]), [], 1, null, rect, 8, 200)), [0.333, 0.333, 0.333])
  assert.equal(splitResize(split, [], 1, 300, rect, 8, 200), split)
  assert.equal(splitResize(split, [0], 0, 300, rect, 8, 200), split)
})

test('splitDrop picks the pane and the edge nearest the pointer', () => {
  const panes = [{ id: 1, x: 0, y: 0, width: 400, height: 400 }, { id: 2, x: 408, y: 0, width: 400, height: 400 }]
  assert.deepEqual(splitDrop(panes, { x: 10, y: 200 }, true), { id: 1, side: 'left' })
  assert.deepEqual(splitDrop(panes, { x: 600, y: 390 }, true), { id: 2, side: 'bottom' })
  assert.deepEqual(splitDrop(panes, { x: 200, y: 200 }, true), { id: 1, side: 'center' })
  assert.deepEqual(splitDrop(panes, { x: 200, y: 200 }, false), { id: 1, side: 'left' })
  // In the gap, or off the panes, the nearest one.
  assert.deepEqual(splitDrop(panes, { x: 406, y: 100 }, true), { id: 2, side: 'left' })
  assert.deepEqual(splitDrop(panes, { x: -20, y: 100 }, true), { id: 1, side: 'left' })
  assert.equal(splitDrop([], { x: 0, y: 0 }, true), null)
})

test('splitDropped splits, moves, swaps, or refuses a full split', () => {
  // Over the active tab alone: a new split.
  assert.deepEqual(splitDropped(null, 1, 2, { id: 1, side: 'bottom' }), column([1, 2]))
  assert.equal(splitDropped(null, 1, 1, { id: 1, side: 'left' }), null)
  assert.equal(splitDropped(null, 1, 2, { id: 1, side: 'center' }), null)
  const split = row([1, 2])
  assert.deepEqual(splitDropped(split, 1, 3, { id: 2, side: 'bottom' }), row([1, column([2, 3])]))
  assert.deepEqual(splitDropped(split, 1, 2, { id: 1, side: 'top' }), column([2, 1]))
  assert.deepEqual(splitDropped(split, 1, 3, { id: 2, side: 'center' }), row([1, 3]))
  assert.deepEqual(splitDropped(split, 1, 2, { id: 1, side: 'center' }), row([2, 1]))
  // Where it already is changes nothing.
  assert.equal(splitDropped(split, 1, 2, { id: 1, side: 'right' }), null)
  assert.equal(splitDropped(split, 1, 2, { id: 2, side: 'left' }), null)
  assert.equal(splitDropped(split, 1, 2, { id: 9, side: 'left' }), null)
  // A full split takes no more, but trades and moves within.
  const full = row([column([1, 2]), column([3, 4])])
  assert.equal(SPLIT_MOST, 4)
  assert.equal(splitDropped(full, 1, 5, { id: 2, side: 'right' }), null)
  assert.deepEqual(splitDropped(full, 1, 5, { id: 2, side: 'center' }), row([column([1, 5]), column([3, 4])]))
  assert.deepEqual(splitDropped(full, 1, 4, { id: 1, side: 'left' }), row([column([row([4, 1]), 2]), 3]))
})

test('dropRect is the half of the pane on the side, or all of it', () => {
  const pane = { id: 1, x: 10, y: 20, width: 400, height: 300 }
  assert.deepEqual(dropRect(pane, 'left'), { x: 10, y: 20, width: 200, height: 300 })
  assert.deepEqual(dropRect(pane, 'bottom'), { x: 10, y: 170, width: 400, height: 150 })
  assert.deepEqual(dropRect(pane, 'center'), { x: 10, y: 20, width: 400, height: 300 })
})

test('splitWith pairs a tab with the active one, or adds it beside it the way its pane is longer', () => {
  assert.deepEqual(splitWith(null, 1, 2), row([1, 2]))
  // A split the active tab is not in gives way to a new one.
  assert.deepEqual(splitWith(row([3, 4]), 1, 2), row([1, 2]))
  assert.deepEqual(splitWith(row([1, 3]), 1, 2, { width: 800, height: 600 }), row([1, 2, 3], [0.25, 0.25, 0.5]))
  assert.deepEqual(splitWith(row([1, 3]), 3, 2, { width: 400, height: 600 }), row([1, column([3, 2])]))
  assert.equal(splitWith(row([1, 2]), 1, 1), null)
  assert.equal(splitWith(row([1, 2]), 1, 2), null)
  assert.equal(splitWith(row([column([1, 2]), column([3, 4])]), 1, 5), null)
})

test('cleanSplit keeps a well-formed split of different places, reading the old pair as a row', () => {
  assert.deepEqual(cleanSplit(row([0, column([1, 2])]), 3), row([0, column([1, 2])]))
  assert.deepEqual(cleanSplit({ indexes: [2, 0], ratio: 0.4 }, 3), row([2, 0], [0.4, 0.6]))
  assert.equal(cleanSplit(undefined, 3), undefined)
  assert.equal(cleanSplit(row([0, 0]), 3), undefined)
  assert.equal(cleanSplit(row([0, 3]), 3), undefined)
  assert.equal(cleanSplit(row([0]), 3), undefined)
  assert.equal(cleanSplit(row([0, 1, 2, 3, 4]), 5), undefined)
  assert.equal(cleanSplit(row([0, row([1, 2])]), 3), undefined)
  assert.equal(cleanSplit({ dir: 'diagonal', sizes: [0.5, 0.5], panes: [0, 1] }, 3), undefined)
  assert.equal(cleanSplit(row([0, 1], [1, 0]), 3), undefined)
  assert.equal(cleanSplit(row([0, 1], [0.5]), 3), undefined)
  assert.equal(cleanSplit({ indexes: [0, 1], ratio: 1 }, 3), undefined)
  // Shares are made to add up.
  assert.deepEqual(cleanSplit(row([0, 1], [1, 3]), 3).sizes, [0.25, 0.75])
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
