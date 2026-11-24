// Bookmarks, in the order the bookmark bar shows them, saved to
// bookmarks.json in the app's data folder. Plain Node, so it is tested in
// test/bookmarks.test.js; every function returns a new list.
//
// The list holds pages, { id, title, url, icon }, and folders, { id, title,
// items: [page] }, one level deep. `icon` is the site's icon as a data: URL,
// so drawing the bar never contacts a site, or ''.
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { save } = require('./settings')
const { recordable } = require('./history')
const { toUrl } = require('./url')

const isFolder = (item) => Array.isArray(item.items)
const text = (value) => (typeof value === 'string' ? value : '')

// The address as pages report it, or null when it is not one Lit bookmarks
// (a web or file address; not a search).
function address(input) {
  const typed = text(input).trim()
  if (!typed) return null
  const scheme = /^[a-z][a-z\d+.-]*:/i.test(typed) && !/^[^/:]+:\d+(\/|$)/.test(typed)
  const url = scheme ? typed : toUrl(typed)
  // toUrl makes anything else a search.
  if (!scheme && url.replace(/^https?:\/\//, '') !== typed) return null
  return recordable(url) && URL.canParse(url) ? new URL(url).href : null
}

const page = ({ title, url, icon = '' }) => ({ id: randomUUID(), title, url, icon })
const folder = (title) => ({ id: randomUUID(), title, items: [] })

const folders = (list) => list.filter(isFolder)
const pages = (list) => list.flatMap((item) => (isFolder(item) ? item.items : item))
const get = (list, id) => list.find((item) => item.id === id) || pages(list).find((item) => item.id === id)
// The id of the folder holding `id`, or null for the bar itself.
const folderOf = (list, id) => folders(list).find((each) => each.items.some((item) => item.id === id))?.id ?? null

const update = (list, id, changes) => list.map((item) => {
  if (item.id === id) return { ...item, ...changes }
  return isFolder(item) ? { ...item, items: update(item.items, id, changes) } : item
})

const remove = (list, id) => list
  .filter((item) => item.id !== id)
  .map((item) => (isFolder(item) ? { ...item, items: remove(item.items, id) } : item))

// Puts `item` in a folder (or the bar, for null), before the item `beforeId`
// there, or last.
function add(list, item, folderId = null, beforeId = null) {
  if (folderId !== null) {
    return list.map((each) => (each.id === folderId ? { ...each, items: add(each.items, item, null, beforeId) } : each))
  }
  const at = list.findIndex((each) => each.id === beforeId)
  return at === -1 ? [...list, item] : [...list.slice(0, at), item, ...list.slice(at)]
}

// Moves an item; unchanged when there is nowhere to put it (a folder only
// goes on the bar).
function move(list, id, folderId = null, beforeId = null) {
  const item = get(list, id)
  if (!item || id === beforeId) return list
  if (folderId !== null && (isFolder(item) || !folders(list).some((each) => each.id === folderId))) return list
  return add(remove(list, id), item, folderId, beforeId)
}

// Only well-formed items survive a hand-edited file; each gets an id of its
// own, kept when it has one.
function clean(saved, nested = false, ids = new Set()) {
  if (!Array.isArray(saved)) return []
  const items = []
  for (const item of saved) {
    if (!item || typeof item !== 'object') continue
    const id = item.id && typeof item.id === 'string' && !ids.has(item.id) ? item.id : randomUUID()
    ids.add(id)
    if (Array.isArray(item.items)) {
      if (!nested) items.push({ id, title: text(item.title), items: clean(item.items, true, ids) })
      continue
    }
    const url = address(item.url)
    if (url) items.push({ id, title: text(item.title), url, icon: /^data:image\//.test(text(item.icon)) ? item.icon : '' })
  }
  return items
}

// A file that can't be read as bookmarks is kept as bookmarks.json.bad,
// since the next save replaces it.
function load(file) {
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(saved)) throw new Error('Not a list.')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try { fs.copyFileSync(file, `${file}.bad`) } catch {}
    }
    return []
  }
  return clean(saved)
}

module.exports = { isFolder, address, page, folder, folders, pages, get, folderOf, update, remove, add, move, clean, load, save }
