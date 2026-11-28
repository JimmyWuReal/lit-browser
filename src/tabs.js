// Pure tab and window rules, kept apart from Electron so they can be tested.

// The tab to show after closing `closingId`: the active tab stays active
// unless it is the one closing; then its right neighbor wins, else its left
// one, the way Chrome and Safari do it. Null when no tabs are left.
function afterClose(ids, activeId, closingId) {
  const rest = ids.filter((id) => id !== closingId)
  if (!rest.length) return null
  if (activeId !== closingId && rest.includes(activeId)) return activeId
  const index = ids.indexOf(closingId)
  return rest[Math.min(Math.max(index, 0), rest.length - 1)]
}

// The tab `delta` steps from the active one, wrapping around the ends.
function step(ids, activeId, delta) {
  if (!ids.length) return null
  const index = Math.max(ids.indexOf(activeId), 0)
  return ids[(((index + delta) % ids.length) + ids.length) % ids.length]
}

// Cmd+1 to Cmd+8 pick that tab; Cmd+9 always picks the last one.
function byNumber(ids, number) {
  if (!ids.length) return null
  return number === 9 ? ids[ids.length - 1] : ids[number - 1] ?? null
}

// The tabs with `id` moved before `beforeId`, or last (null). Unchanged when
// either is gone, as one can close while it is being dragged.
function moved(ids, id, beforeId) {
  if (id === beforeId || !ids.includes(id) || (beforeId !== null && !ids.includes(beforeId))) return ids
  const rest = ids.filter((each) => each !== id)
  rest.splice(beforeId === null ? rest.length : rest.indexOf(beforeId), 0, id)
  return rest
}

// The tabs with `id` moved one place left (-1) or right (1), if there is one.
function nudged(ids, id, direction) {
  const index = ids.indexOf(id)
  const to = index + direction
  if (index === -1 || to < 0 || to >= ids.length) return ids
  return moved(ids, id, direction < 0 ? ids[to] : ids[to + 1] ?? null)
}

// Closed tabs and windows, for Reopen Closed Tab: newest last, holding
// at most `limit` tabs (the Closed tabs to remember setting).
function remember(closed, entry, limit) {
  closed.push(entry)
  return keepNewest(closed, limit)
}

// Drops the oldest entries until the tabs left fit `limit`; a window
// ({ tabs, activeIndex }) counts each of its tabs. The newest entry always
// stays, and a window with more tabs than the limit keeps its active tab
// and the ones around it.
function keepNewest(closed, limit) {
  const newest = closed.at(-1)
  if (newest?.tabs?.length > limit) {
    const start = Math.min(Math.max(newest.activeIndex - Math.floor(limit / 2), 0), newest.tabs.length - limit)
    // Its split view keeps the tabs that stay, while two or more do.
    const { split, ...rest } = newest
    const shifted = split && tidy(mapPanes(split, (index) => (index >= start && index < start + limit ? index - start : null)))
    const kept = isGroup(shifted) && { split: shifted }
    closed[closed.length - 1] = { ...rest, tabs: newest.tabs.slice(start, start + limit), activeIndex: newest.activeIndex - start, ...kept }
  }
  let count = 0
  let keep = 0
  for (let i = closed.length - 1; i >= 0; i--) {
    count += closed[i].tabs?.length || 1
    if (count > limit) break
    keep++
  }
  closed.splice(0, closed.length - keep)
  return closed
}

// Where a reopened tab goes: back at its old place, or at the end if the
// window now has fewer tabs.
const reopenIndex = (index, count) => Math.min(Math.max(index, 0), count)

// Whether a window at `bounds` would show on any of the displays' work
// areas (all { x, y, width, height }), so a reopened window never lands
// off screen after a display is unplugged.
const onScreen = (bounds, areas) => areas.some((area) =>
  bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
  bounds.y < area.y + area.height && bounds.y + bounds.height > area.y)

// Where a window's tabs show, from the Tabs settings: across the top
// ('top'), in the sidebar down its left ('side'), or nowhere ('none'), while
// vertical tabs have their sidebar hidden.
const tabsPlace = ({ verticalTabs, tabSidebar }) => (!verticalTabs ? 'top' : tabSidebar ? 'side' : 'none')

// The settings Show Tab Sidebar changes, in order, as [key, value]: it hides
// a sidebar on show, and otherwise shows it, turning on vertical tabs if
// they are off. The sidebar is shown before vertical tabs turn on, so tabs
// never pass through being hidden.
function sidebarToggle(values) {
  if (tabsPlace(values) === 'side') return [['tabSidebar', false]]
  return [
    ...(values.tabSidebar ? [] : [['tabSidebar', true]]),
    ...(values.verticalTabs ? [] : [['verticalTabs', true]]),
  ]
}

// The tab sidebar's widths, in pixels: `rail`, its narrowest, a rail of the
// tabs' icons; `least`, the narrowest it is with titles; `most`, the widest;
// and `standard`, the default. It always leaves the toolbar's rows `room`
// (the window's minimum width), and in a window narrower than `fullFrom` it
// is the rail. Keep in sync with .vertical in index.html.
const SIDEBAR = { rail: 48, least: 140, most: 400, standard: 220, room: 480, fullFrom: 700 }

// The sidebar's width for its edge dragged to `x`: from `least` to `most`,
// or the rail once dragged past halfway from `least` to it, so it is never
// too narrow for titles yet wider than the icons.
function sidebarWidth(x) {
  if (x < (SIDEBAR.rail + SIDEBAR.least) / 2) return SIDEBAR.rail
  return Math.round(Math.min(Math.max(x, SIDEBAR.least), SIDEBAR.most))
}

// The width ← (`direction` -1) or → (1) moves the sidebar's edge to from
// `width`, `step` at a time; between the rail and `least` it goes all the way.
function sidebarNudged(width, direction, step) {
  if (direction > 0 && width < SIDEBAR.least) return SIDEBAR.least
  if (direction < 0 && width <= SIDEBAR.least) return SIDEBAR.rail
  return sidebarWidth(Math.max(width + direction * step, SIDEBAR.least))
}

// How wide the sidebar shows in a window `windowWidth` wide, for the
// `chosen` width (the setting).
const sidebarShowing = (chosen, windowWidth) =>
  (windowWidth < SIDEBAR.fullFrom ? SIDEBAR.rail : Math.min(chosen, windowWidth - SIDEBAR.room))

// Split view: up to SPLIT_MOST tabs of a window, laid out as a tree. A pane
// is a tab's id (or, saved, its place among the window's tabs); a group
// lays its `panes` side by side (`dir` 'row') or one above another
// ('column'), each taking its share of the room from `sizes`, fractions
// adding up to 1. A group always has two panes or more, and none of them is
// a group going its own way, so three side by side are one row, not a row
// in a row. It shows while any of its tabs is the active one.
const SPLIT_MOST = 4
const SIDES = ['left', 'right', 'top', 'bottom']

const isGroup = (node) => typeof node === 'object' && node !== null

// Its tabs, left to right and top to bottom.
const splitIds = (node) => (isGroup(node) ? node.panes.flatMap(splitIds) : node === null || node === undefined ? [] : [node])

// The same tree with each pane `fn(pane)`.
const mapPanes = (node, fn) => (isGroup(node) ? { ...node, panes: node.panes.map((pane) => mapPanes(pane, fn)) } : fn(node))

// The tree in the shape described above: groups of one pane give way to
// it, a group inside one going its way joins it, keeping each pane's share,
// and the shares add up to 1 again. Null when nothing is left.
function tidy(node) {
  if (!isGroup(node)) return node ?? null
  const panes = []
  const sizes = []
  node.panes.forEach((pane, index) => {
    const each = tidy(pane)
    if (each === null) return
    if (isGroup(each) && each.dir === node.dir) each.panes.forEach((inner, at) => { panes.push(inner); sizes.push(node.sizes[index] * each.sizes[at]) })
    else { panes.push(each); sizes.push(node.sizes[index]) }
  })
  if (panes.length < 2) return panes[0] ?? null
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return { dir: node.dir, sizes: sizes.map((size) => size / total), panes }
}

// The tree without tab `id`; the panes beside it share its room. Just the
// one tab left (not a group) or null when that is all there was.
const splitWithout = (node, id) => tidy(mapPanes(node, (pane) => (pane === id ? null : pane)))

// The tree with tab `id` beside tab `target` on its `side` (one of SIDES),
// moved there if it is in the tree already: `target`'s pane splits in two,
// the panes around it keeping their room. `node` can be a lone tab.
function splitBeside(node, target, id, side) {
  if (target === id || !SIDES.includes(side)) return node
  const dir = side === 'left' || side === 'right' ? 'row' : 'column'
  const pair = side === 'right' || side === 'bottom' ? [target, id] : [id, target]
  return tidy(mapPanes(splitWithout(node, id), (pane) => (pane === target ? { dir, sizes: [0.5, 0.5], panes: pair } : pane)))
}

// The tree with tabs `a` and `b` trading places, or `b` in place of `a`
// when it is not in the tree.
const splitSwap = (node, a, b) => mapPanes(node, (pane) => (pane === a ? b : pane === b ? a : pane))

// Where a group's panes go in `rect` ({ x, y, width, height }), `gap` apart.
// Each edge is rounded from the shares before it, so no pixel is lost.
function groupParts(group, rect, gap) {
  const across = group.dir === 'row'
  const start = across ? rect.x : rect.y
  const room = Math.max((across ? rect.width : rect.height) - gap * (group.panes.length - 1), 0)
  let share = 0
  return group.panes.map((_, index) => {
    const from = start + Math.round(share * room) + index * gap
    share += group.sizes[index]
    const to = Math.max(start + Math.round(share * room) + index * gap, from)
    return across ? { ...rect, x: from, width: to - from } : { ...rect, y: from, height: to - from }
  })
}

// Where everything goes in `rect`: `panes`, each tab's { id, x, y, width,
// height }, in splitIds order, and the `dividers` in the gaps between them,
// { path, index, dir, share, x, y, width, height }, `path` being the
// places that lead from the top of the tree to its group, `index` the pane
// it follows there, and `share` that pane's part of the two beside it. A
// 'row' group's dividers stand up between its panes.
function splitLayout(node, rect, gap) {
  const out = { panes: [], dividers: [] }
  const walk = (each, box, path) => {
    if (!isGroup(each)) return out.panes.push({ id: each, ...box })
    const parts = groupParts(each, box, gap)
    parts.forEach((part, index) => {
      walk(each.panes[index], part, [...path, index])
      if (index === parts.length - 1) return
      const end = each.dir === 'row' ? part.x + part.width : part.y + part.height
      const share = each.sizes[index] / (each.sizes[index] + each.sizes[index + 1])
      out.dividers.push({ path, index, dir: each.dir, share, ...(each.dir === 'row' ? { ...box, x: end, width: gap } : { ...box, y: end, height: gap }) })
    })
  }
  walk(node, rect, [])
  return out
}

// How narrow (along a 'row') or short (along a 'column') a pane can be
// dragged: `min` for a tab, more for a group with several going that way.
function least(node, dir, gap, min) {
  if (!isGroup(node)) return min
  const each = node.panes.map((pane) => least(pane, dir, gap, min))
  return node.dir === dir ? each.reduce((sum, size) => sum + size, 0) + gap * (each.length - 1) : Math.max(...each)
}

// The tree with the divider after pane `index` of the group at `path` (see
// splitLayout) moved so its gap's middle is at `at` across `rect`, as far
// as keeping both panes beside it at least `min` allows. Short of room for
// that, the minimums give way, so the divider always has half the two
// panes' room to move in. `at` null shares that group's room evenly.
// Unchanged when there is no such divider.
function splitResize(node, path, index, at, rect, gap, min) {
  let group = node
  let box = rect
  for (const place of path) {
    if (!isGroup(group) || !(place in group.panes)) return node
    box = groupParts(group, box, gap)[place]
    group = group.panes[place]
  }
  if (!isGroup(group) || !Number.isInteger(index) || index < 0 || index >= group.panes.length - 1) return node
  let sizes = group.sizes.map(() => 1 / group.sizes.length)
  if (at !== null) {
    const across = group.dir === 'row'
    const room = Math.max((across ? box.width : box.height) - gap * (group.panes.length - 1), 1)
    const before = group.sizes.slice(0, index).reduce((sum, size) => sum + size, 0)
    const pair = group.sizes[index] + group.sizes[index + 1]
    const first = least(group.panes[index], group.dir, gap, min)
    const second = least(group.panes[index + 1], group.dir, gap, min)
    const give = pair * room >= first + second ? 1 : (pair * room) / (2 * (first + second))
    const low = (first * give) / room
    const high = pair - (second * give) / room
    const share = Math.min(Math.max((at - (across ? box.x : box.y) - index * gap - gap / 2) / room - before, low), high)
    sizes = group.sizes.map((size, at) => (at === index ? share : at === index + 1 ? pair - share : size))
  }
  const swap = (each, depth) => (depth === path.length ? { ...each, sizes } : { ...each, panes: each.panes.map((pane, at) => (at === path[depth] ? swap(pane, depth + 1) : pane)) })
  return swap(node, 0)
}

// Where a tab dragged over the pages to `point` ({ x, y }) would go: the
// pane under it, or the nearest one when it is in a gap, as { id, side },
// `side` being the edge it is nearest (one of SIDES), or, with `center`,
// 'center' while it is well inside the pane. Null with no panes.
function splitDrop(panes, { x, y }, center) {
  const distance = (pane) => Math.hypot(Math.max(pane.x - x, 0, x - pane.x - pane.width), Math.max(pane.y - y, 0, y - pane.y - pane.height))
  const pane = panes.reduce((best, each) => (best && distance(best) <= distance(each) ? best : each), null)
  if (!pane) return null
  const u = Math.min(Math.max((x - pane.x) / (pane.width || 1), 0), 1)
  const v = Math.min(Math.max((y - pane.y) / (pane.height || 1), 0), 1)
  const [side, near] = Object.entries({ left: u, right: 1 - u, top: v, bottom: 1 - v }).reduce((best, each) => (each[1] < best[1] ? each : best))
  return { id: pane.id, side: center && near > 0.25 ? 'center' : side }
}

// The split once tab `id` is dropped at `drop` (see splitDrop) on what
// shows: the split, or, with none (null), the active tab alone. Beside a
// tab, it goes there (moving, if it is in the split already, or making a
// new split with the active tab); in the middle of one, the two trade
// places, or it takes that tab's place. Null when that changes nothing or
// the split is full.
function splitDropped(split, activeId, id, drop) {
  if (!drop || drop.id === id) return null
  const tree = split ?? activeId
  const ids = splitIds(tree)
  if (!ids.includes(drop.id)) return null
  if (drop.side === 'center') return isGroup(tree) ? splitSwap(tree, drop.id, id) : null
  if (!ids.includes(id) && ids.length >= SPLIT_MOST) return null
  const next = splitBeside(tree, drop.id, id, drop.side)
  return JSON.stringify(next) === JSON.stringify(tree) ? null : next
}

// The split once tab `id` goes beside the active one: a new pair, the active
// tab on the left, or, while the active tab is in a split with room, beside
// it: right of its pane `pane` ({ width, height }) if that is wider than
// tall, else under it. Null for no change: the tab is the active one or
// already in its split, or the split is full.
function splitWith(split, activeId, id, pane) {
  if (id === activeId) return null
  const ids = splitIds(split)
  if (!ids.includes(activeId)) return { dir: 'row', sizes: [0.5, 0.5], panes: [activeId, id] }
  if (ids.includes(id) || ids.length >= SPLIT_MOST) return null
  return splitBeside(split, activeId, id, !pane || pane.width >= pane.height ? 'right' : 'bottom')
}

// A saved split (see src/session.js) as a tree of places among `length`
// tabs, or undefined if it is not one: a well-formed tree of two to
// SPLIT_MOST different places. A file from before (two places side by
// side, { indexes, ratio }) is read as a row.
function cleanSplit(saved, length) {
  const old = Array.isArray(saved?.indexes) && saved.indexes.length === 2 && Number.isFinite(saved.ratio)
  const node = old ? { dir: 'row', sizes: [saved.ratio, 1 - saved.ratio], panes: saved.indexes } : saved
  const places = []
  const valid = (each, parentDir) => {
    if (!isGroup(each)) {
      places.push(each)
      return Number.isInteger(each) && each >= 0 && each < length
    }
    return ['row', 'column'].includes(each.dir) && each.dir !== parentDir && Array.isArray(each.panes) && each.panes.length >= 2 &&
      Array.isArray(each.sizes) && each.sizes.length === each.panes.length && each.sizes.every((size) => Number.isFinite(size) && size > 0) &&
      each.panes.every((pane) => valid(pane, each.dir))
  }
  if (!isGroup(node) || !valid(node, null) || places.length > SPLIT_MOST || new Set(places).size !== places.length) return undefined
  return tidy(node)
}

// Whether a tab may go to sleep (the Sleep tabs setting): its page closes,
// keeping its title, icon and back/forward list, and loads again when the
// tab is shown. Only a tab out of sight (not `shown`: the active one, or
// all of a split view's) for `minutes` (0 is never), whose page has settled
// and can be loaded again from its address (not a blob: document a page
// made, or an about:blank one its opener wrote into), and that is doing
// nothing you would miss: playing sound, full screen, asking something,
// edited by hand (a draft could be lost), or `inUse` (main's say: a camera,
// a microphone or a screen it was given, being shared, notifications, its
// Developer Tools). `keepAwake` is a page that wouldn't close without
// asking you first. `seen` is when it was last on show, in milliseconds.
const sleepy = (tab, now, minutes) => minutes > 0 && !tab.shown && !tab.asleep && /^(https?|file):/.test(tab.url || '') &&
  !tab.loading && !tab.error && !tab.audible && !tab.fullScreen && !tab.asking && !tab.edited && !tab.inUse && !tab.keepAwake &&
  now - tab.seen >= minutes * 60_000

module.exports = { afterClose, step, byNumber, moved, nudged, remember, keepNewest, reopenIndex, onScreen, tabsPlace, sidebarToggle, SIDEBAR, sidebarWidth, sidebarNudged, sidebarShowing, SPLIT_MOST, splitIds, mapPanes, splitWithout, splitBeside, splitSwap, splitLayout, splitResize, splitDrop, splitDropped, splitWith, cleanSplit, sleepy }
