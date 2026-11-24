// The windows and tabs open when Lit quit, saved to session.json in the
// app's data folder so the next launch can reopen them (the Reopen windows
// from last time setting). Plain Node, so it is tested in
// test/session.test.js; main takes the snapshot and opens the windows.
//
// The file is { windows: [window] }, oldest-focused window first, so the
// last one opened is the one that was in front. A window is { tabs:
// [history | null], activeIndex, pinned, bounds, maximized, fullScreen },
// the same shape Reopen Closed Tab uses; a null history is a tab on the
// search box. Its first `pinned` tabs are pinned (pinned tabs are always
// at the left). A history is { entries: [{ url, title, pageState? }], index }.
//
// With Reopen windows turned off, the file holds only the pinned tabs, as
// one window (pinnedWindow), which the next launch opens with a new tab.
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
// Dropping a broken entry moves the ones after it; the current page stays
// current, or the closest page before it does.
function cleanHistory(history) {
  if (!history || !Array.isArray(history.entries)) return null
  const entries = []
  let index = 0
  history.entries.forEach((entry, i) => {
    const kept = cleanEntry(entry)
    if (!kept) return
    if (i <= history.index) index = entries.length
    entries.push(kept)
  })
  return entries.length ? { entries, index } : null
}

const cleanBounds = (bounds) => (bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0
  ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  : undefined)

// Only well-formed windows survive a hand-edited or older file. A pinned
// tab whose page is gone is dropped, as a pinned tab always has one; the
// rest stay pinned, and the active tab stays active (or the first does).
function clean(saved) {
  if (!saved || !Array.isArray(saved.windows)) return []
  return saved.windows
    .filter((win) => win && Array.isArray(win.tabs) && win.tabs.length)
    .map((win) => {
      const most = Number.isInteger(win.pinned) ? Math.min(Math.max(win.pinned, 0), win.tabs.length) : 0
      const active = isIndex(win.activeIndex, win.tabs.length) ? win.activeIndex : 0
      const kept = win.tabs.map((tab, i) => ({ history: cleanHistory(tab), i })).filter(({ history, i }) => history || i >= most)
      return {
        tabs: kept.map(({ history }) => history),
        activeIndex: Math.max(kept.findIndex(({ i }) => i === active), 0),
        pinned: kept.filter(({ i }) => i < most).length,
        bounds: cleanBounds(win.bounds),
        maximized: win.maximized === true,
        fullScreen: win.fullScreen === true,
      }
    })
    .filter((win) => win.tabs.length)
}

// Every window's pinned tabs together in one window, in window order,
// where the window in front (the last) was; null without any. What Lit
// keeps, and opens at launch, while Reopen windows is off.
function pinnedWindow(windows) {
  const tabs = windows.flatMap((win) => win.tabs.slice(0, win.pinned))
  if (!tabs.length) return null
  const front = windows.at(-1)
  return { tabs, activeIndex: 0, pinned: tabs.length, bounds: front.bounds, maximized: front.maximized, fullScreen: front.fullScreen }
}

// A missing or unreadable file reopens nothing.
function load(file) {
  try {
    return clean(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

const save = (file, windows) => write(file, { windows: windows.map(({ tabs, activeIndex, pinned = 0, bounds, maximized, fullScreen }) => ({ tabs, activeIndex, pinned, bounds, maximized, fullScreen })) })

// Nothing left to reopen: no file at all.
const forget = (file) => fs.rmSync(file, { force: true })

module.exports = { clean, pinnedWindow, load, save, forget }
