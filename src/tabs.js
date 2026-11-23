// Pure tab-order rules, kept apart from Electron so they can be tested.

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

// Closed tabs and windows, for Reopen Closed Tab: newest last, and only
// the `limit` newest are kept.
function remember(closed, entry, limit = 25) {
  closed.push(entry)
  if (closed.length > limit) closed.splice(0, closed.length - limit)
  return closed
}

// Where a reopened tab goes: back at its old place, or at the end if the
// window now has fewer tabs.
const reopenIndex = (index, count) => Math.min(Math.max(index, 0), count)

// A tab's back/forward list ({ entries, index }, or null before its first
// page) with the page it was still loading, the way Chrome reopens a tab
// closed mid-load. Back, forward and reload load a page already in the
// list, so those only move the index; anything else replaces what was ahead.
function withPending(history, url) {
  if (!url) return history
  if (!history) return { entries: [{ url, title: '' }], index: 0 }
  const { entries, index } = history
  const near = [index, index - 1, index + 1].find((i) => entries[i]?.url === url)
  if (near !== undefined) return { entries, index: near }
  return { entries: [...entries.slice(0, index + 1), { url, title: '' }], index: index + 1 }
}

module.exports = { afterClose, step, byNumber, remember, reopenIndex, withPending }
