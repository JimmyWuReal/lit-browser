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
    // Its split view stays only while both its tabs do.
    const { split, ...rest } = newest
    const indexes = split?.indexes.map((index) => index - start)
    const kept = indexes?.every((index) => index >= 0 && index < limit) && { split: { ...split, indexes } }
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

// Split view: two tabs of a window side by side, as { ids: [left, right],
// ratio }, `ratio` being the left pane's share of the width. It shows while
// either of its tabs is the active one.

// The two panes ({ x, width }) across `area` ({ x, width }), `gap` apart:
// the left one `ratio` of the room, neither narrower than `min`, unless the
// room is too small for that, when they share it evenly.
function splitPanes(area, ratio, gap, min) {
  const room = Math.max(area.width - gap, 0)
  const least = Math.min(min, room / 2)
  const left = Math.round(Math.min(Math.max(room * ratio, least), room - least))
  return [{ x: area.x, width: left }, { x: area.x + left + gap, width: room - left }]
}

// The ratio that puts the middle of the gap at `x`, keeping both panes at
// least `min` wide as splitPanes does.
function splitRatio(area, x, gap, min) {
  const room = Math.max(area.width - gap, 1)
  const least = Math.min(min, room / 2)
  return Math.min(Math.max(x - area.x - gap / 2, least), room - least) / room
}

// The split once tab `id` goes beside the active one: a new pair, the active
// tab on the left, or, while the active tab is in one already, `id` in place
// of the other tab. Pairing a tab with itself changes nothing.
function splitWith(split, activeId, id) {
  if (id === activeId) return split
  if (split?.ids.includes(activeId)) return { ...split, ids: split.ids.map((each) => (each === activeId ? each : id)) }
  return { ids: [activeId, id], ratio: 0.5 }
}

// Whether a tab may go to sleep (the Sleep tabs setting): its page closes,
// keeping its title, icon and back/forward list, and loads again when the
// tab is shown. Only a tab out of sight (not `shown`: the active one, or
// both in split view) for `minutes` (0 is never), whose page has settled
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

module.exports = { afterClose, step, byNumber, moved, nudged, remember, keepNewest, reopenIndex, onScreen, tabsPlace, sidebarToggle, splitPanes, splitRatio, splitWith, sleepy }
