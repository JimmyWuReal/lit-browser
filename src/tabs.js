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
    closed[closed.length - 1] = { ...newest, tabs: newest.tabs.slice(start, start + limit), activeIndex: newest.activeIndex - start }
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

module.exports = { afterClose, step, byNumber, moved, nudged, remember, keepNewest, reopenIndex, onScreen }
