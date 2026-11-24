// The windows and tabs open when Lit quit, saved to session.json in the
// app's data folder so the next launch can reopen them (the Reopen windows
// from last time setting). Plain Node, so it is tested in
// test/session.test.js; main takes the snapshot and opens the windows.
//
// The file is { windows: [window] }, oldest-focused window first, so the
// last one opened is the one that was in front. A window is { tabs:
// [history | null], activeIndex, bounds, maximized, fullScreen }, the
// same shape Reopen Closed Tab uses; a null history is a tab on the search
// box. A history is { entries: [{ url, title, pageState? }], index }.
const fs = require('node:fs')
const { save: write } = require('./settings')

const isIndex = (value, length) => Number.isInteger(value) && value >= 0 && value < length

function cleanEntry(entry) {
  if (!entry || typeof entry.url !== 'string' || !entry.url) return null
  return {
    url: entry.url,
    title: typeof entry.title === 'string' ? entry.title : '',
    ...(typeof entry.pageState === 'string' && { pageState: entry.pageState }),
  }
}

// A back/forward list, or null (a blank tab) when nothing usable is left.
function cleanHistory(history) {
  if (!history || !Array.isArray(history.entries)) return null
  const current = history.entries[history.index]
  const entries = history.entries.map(cleanEntry).filter(Boolean)
  if (!entries.length) return null
  // Dropping a broken entry moves the ones after it; the current page stays current.
  const index = entries.findIndex((entry) => entry.url === current?.url)
  return { entries, index: index === -1 ? entries.length - 1 : index }
}

const cleanBounds = (bounds) => (bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0
  ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  : undefined)

// Only well-formed windows survive a hand-edited or older file.
function clean(saved) {
  if (!saved || !Array.isArray(saved.windows)) return []
  return saved.windows
    .filter((win) => win && Array.isArray(win.tabs) && win.tabs.length)
    .map((win) => ({
      tabs: win.tabs.map(cleanHistory),
      activeIndex: isIndex(win.activeIndex, win.tabs.length) ? win.activeIndex : 0,
      bounds: cleanBounds(win.bounds),
      maximized: win.maximized === true,
      fullScreen: win.fullScreen === true,
    }))
}

// A missing or unreadable file reopens nothing.
function load(file) {
  try {
    return clean(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

const save = (file, windows) => write(file, { windows: windows.map(({ tabs, activeIndex, bounds, maximized, fullScreen }) => ({ tabs, activeIndex, bounds, maximized, fullScreen })) })

// Restoring turned off: nothing of the last session stays on disk.
const forget = (file) => fs.rmSync(file, { force: true })

module.exports = { clean, load, save, forget }
