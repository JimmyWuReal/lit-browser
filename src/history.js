// Browsing history: one entry per address, newest visit first, saved to
// history.json in the app's data folder. Plain Node, so it is tested in
// test/history.test.js; main records visits only while the Save history
// setting is on, and decides which navigations count as visits.
const fs = require('node:fs')
const { save } = require('./settings')

// Enough for months of browsing while the file stays small.
const LIMIT = 5000
// How many pages the address bar suggests at most.
const SUGGESTIONS = 6

// Only real pages; not about:blank, data: URLs or Chromium's own pages.
const recordable = (url) => /^(https?|file):/i.test(url)

// The entry for `url` moves to the top with its new visit time. A title is
// kept until the page reports a new one.
function visit(entries, { url, title = '', time }) {
  if (!recordable(url)) return entries
  const old = entries.find((entry) => entry.url === url)
  const next = { url, title: title || old?.title || '', time }
  return [next, ...entries.filter((entry) => entry !== old)].slice(0, LIMIT)
}

// Takes back a visit whose page turned out to be a step on the way to
// another (a redirect, or an address the page replaced). `previous` is the
// entry the visit replaced, which comes back in its place by time. Does
// nothing once the page has been visited again since.
function unvisit(entries, { url, time, previous }) {
  const index = entries.findIndex((entry) => entry.url === url)
  if (index === -1 || entries[index].time !== time) return entries
  const rest = entries.filter((_, i) => i !== index)
  if (!previous) return rest
  const at = rest.findIndex((entry) => entry.time < previous.time)
  return at === -1 ? [...rest, previous] : [...rest.slice(0, at), previous, ...rest.slice(at)]
}

function retitle(entries, url, title) {
  const index = entries.findIndex((entry) => entry.url === url)
  if (index === -1 || !title || entries[index].title === title) return entries
  return entries.map((entry, i) => (i === index ? { ...entry, title } : entry))
}

const remove = (entries, url) => entries.filter((entry) => entry.url !== url)

// The address without its scheme and www., as people type it.
const bare = (url) => url.toLowerCase().replace(/^[a-z]+:\/\/(www\.)?/, '')

// Pages for the address bar: every typed word must be in the title or the
// address. Addresses that start with what was typed come first, then pages
// where a word starts one of the title's or address's words, then the
// rest; newest first within each.
function suggest(entries, query, limit = SUGGESTIONS) {
  if (limit <= 0) return []
  const text = query.trim().toLowerCase()
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const typed = bare(text)
  const ranked = [[], [], []]
  for (const entry of entries) {
    const url = entry.url.toLowerCase()
    const address = bare(url)
    const title = entry.title.toLowerCase()
    if (!words.every((word) => url.includes(word) || title.includes(word))) continue
    const startsWord = (haystack) => words.some((word) => haystack.startsWith(word) || haystack.includes(` ${word}`) || haystack.includes(`.${word}`) || haystack.includes(`/${word}`))
    const rank = address.startsWith(typed) ? 0 : startsWord(title) || startsWord(address) ? 1 : 2
    ranked[rank].push({ url: entry.url, title: entry.title })
    // Nothing can outrank a full first group.
    if (ranked[0].length === limit) break
  }
  return ranked.flat().slice(0, limit)
}

// The address bar's list: bookmarks ({ url, title }) that match come first,
// marked `bookmarked`, then visited pages, each address once.
function suggestWithBookmarks(bookmarks, entries, query, limit = SUGGESTIONS) {
  // Two bookmarks of one address (with different titles) show once.
  const shown = new Set()
  const first = suggest(bookmarks, query, bookmarks.length)
    .filter((item) => !shown.has(item.url) && shown.add(item.url))
    .slice(0, limit)
    .map((item) => ({ ...item, bookmarked: true }))
  return [...first, ...suggest(entries.filter((entry) => !shown.has(entry.url)), query, limit - first.length)]
}

// Only well-formed entries survive a hand-edited or older file.
function load(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(saved)) return []
    return saved
      .filter((entry) => entry && typeof entry.url === 'string' && recordable(entry.url) && Number.isFinite(entry.time))
      .map(({ url, title, time }) => ({ url, title: typeof title === 'string' ? title : '', time }))
      .sort((a, b) => b.time - a.time)
      .slice(0, LIMIT)
  } catch {
    return []
  }
}

module.exports = { LIMIT, recordable, visit, unvisit, retitle, remove, suggest, suggestWithBookmarks, load, save }
