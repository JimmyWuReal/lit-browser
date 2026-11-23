// Browsing history: one entry per address, newest visit first, saved to
// history.json in the app's data folder. Plain Node, so it is tested in
// test/history.test.js; main records visits only while the Save history
// setting is on.
const fs = require('node:fs')
const { save } = require('./settings')

// Enough for months of browsing while the file stays small.
const LIMIT = 5000

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

function retitle(entries, url, title) {
  const index = entries.findIndex((entry) => entry.url === url)
  if (index === -1 || !title || entries[index].title === title) return entries
  return entries.map((entry, i) => (i === index ? { ...entry, title } : entry))
}

const remove = (entries, url) => entries.filter((entry) => entry.url !== url)

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

module.exports = { LIMIT, visit, retitle, remove, load, save }
