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

module.exports = { afterClose, step, byNumber }
