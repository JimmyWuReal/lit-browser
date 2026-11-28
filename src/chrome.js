// Importing from Google Chrome: reads a Chrome profile's bookmarks, history
// and saved passwords, and merges them into a Lit profile's. Plain Node, so it
// is tested in test/chrome.test.js against a made-up Chrome folder; main asks
// the Keychain for Chrome's key (chromeKey) and saves what comes back.
//
// Chrome keeps each profile in a folder ("Default", "Profile 2") under ROOT:
// `Bookmarks` is JSON, while `History`, `Login Data` and `Login Data For
// Account` (passwords kept in the Google account) are SQLite databases that a
// running Chrome holds locked, so they are read from a copy.
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const bookmarkStore = require('./bookmarks')
const historyStore = require('./history')
const passwords = require('./passwords')

const ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

// How much history to import: pages last visited within `days`, or all.
const RANGES = [
  { value: 'week', label: 'Past week', days: 7 },
  { value: 'month', label: 'Past month', days: 30 },
  { value: 'quarter', label: 'Past 3 months', days: 90 },
  { value: 'all', label: 'All', days: null },
]
const DAY = 24 * 60 * 60 * 1000
// The oldest visit time (ms) a range takes in, or 0 for all.
const since = (range, now) => {
  const days = RANGES.find((item) => item.value === range)?.days
  return days ? now - days * DAY : 0
}

// Chrome counts time in microseconds since 1601; this is 1970 in its
// milliseconds. In SQL, `last_visit_time / 1000 - EPOCH` is a Unix time in
// milliseconds, which (unlike the raw value) fits in a JavaScript number.
const EPOCH = 11644473600000

// Only Chrome's own profile folders, so an id sent back from Settings can't
// name any other folder.
const isProfileId = (id) => typeof id === 'string' && /^(Default|Profile \d+)$/.test(id)
const hasData = (folder) => ['Bookmarks', 'History', 'Login Data'].some((file) => fs.existsSync(path.join(folder, file)))

// Chrome's profiles that hold anything, as [{ id, name }]: Default first, then
// in the order Chrome made them. Names come from Chrome's Local State; a
// profile it doesn't name is called by its folder.
function profiles(root = ROOT) {
  let names = {}
  try {
    names = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'))?.profile?.info_cache || {}
  } catch {}
  let folders = []
  try {
    folders = fs.readdirSync(root).filter(isProfileId)
  } catch {
    return []
  }
  const order = (id) => (id === 'Default' ? 0 : Number(id.slice('Profile '.length)))
  return folders
    .filter((id) => hasData(path.join(root, id)))
    .sort((a, b) => order(a) - order(b))
    .map((id) => ({ id, name: typeof names[id]?.name === 'string' && names[id].name.trim() ? names[id].name.trim() : id }))
}

function readDatabase(file, read, options = {}) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file, options)
  try {
    return read(db)
  } finally {
    db.close()
  }
}

// Runs `read` on an SQLite file of Chrome's. Returns `empty` when there is no
// such file. With Chrome closed it reads the file itself, read-only. A running
// Chrome locks it, so then it reads a copy (with its journal, so a write Chrome
// was in the middle of is rolled back), deleted after. Copying while Chrome
// writes can catch the two files apart, so a copy that won't read is made
// once more.
function withCopy(file, empty, read) {
  if (!fs.existsSync(file)) return empty
  try {
    return readDatabase(file, read, { readOnly: true })
  } catch {}
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-chrome-'))
  try {
    const copy = path.join(folder, 'db')
    for (let tries = 2; ; tries--) {
      for (const suffix of ['', '-journal', '-wal']) {
        fs.rmSync(copy + suffix, { force: true })
        // A clone on APFS: instant, whatever the size.
        if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix, fs.constants.COPYFILE_FICLONE)
      }
      try {
        return readDatabase(copy, read)
      } catch (error) {
        if (tries === 1) throw error
      }
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

// Bookmarks, in the shape Lit keeps them (without ids): pages { title, url }
// and folders { title, items: [page] }. Lit's folders are one level deep, so
// the bookmark bar's pages stay on the bar, each of its folders becomes a
// folder holding every page inside it, however deep, and Other bookmarks and
// Mobile bookmarks become a folder each. Pages Lit can't keep (javascript:
// bookmarklets, chrome:// pages) and folders left empty are dropped.
function readBookmarks(folder) {
  let roots
  try {
    roots = JSON.parse(fs.readFileSync(path.join(folder, 'Bookmarks'), 'utf8'))?.roots
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const text = (value) => (typeof value === 'string' ? value : '')
  const toPage = (node) => {
    const url = node?.type === 'url' && bookmarkStore.address(node.url)
    return url ? { title: text(node.name), url } : null
  }
  const pagesIn = (node) => (Array.isArray(node?.children) ? node.children.flatMap((child) => (child?.type === 'folder' ? pagesIn(child) : toPage(child) || [])) : [])
  const folderOf = (title, node) => {
    const items = pagesIn(node)
    return items.length ? [{ title, items }] : []
  }
  const bar = Array.isArray(roots?.bookmark_bar?.children) ? roots.bookmark_bar.children : []
  return [
    ...bar.flatMap((child) => (child?.type === 'folder' ? folderOf(text(child.name), child) : toPage(child) || [])),
    ...folderOf('Other bookmarks', roots?.other),
    ...folderOf('Mobile bookmarks', roots?.synced),
  ]
}

const countBookmarks = (items) => bookmarkStore.pages(items).length

// Adds imported bookmarks to Lit's `list`: pages to the end of the bar, and
// each folder's pages to the folder with its name, made if there is none.
// A page already where it would go is skipped, so importing again adds only
// what is new. Returns { list, added }.
function mergeBookmarks(list, imported) {
  let added = 0
  const addPages = (pages, folderId) => {
    for (const { title, url } of pages) {
      const there = folderId === null ? list.filter((item) => !bookmarkStore.isFolder(item)) : bookmarkStore.get(list, folderId).items
      if (there.some((item) => item.url === url)) continue
      list = bookmarkStore.add(list, bookmarkStore.page({ title, url }), folderId)
      added++
    }
  }
  for (const item of imported) {
    if (!bookmarkStore.isFolder(item)) {
      addPages([item], null)
      continue
    }
    let target = bookmarkStore.folders(list).find((each) => each.title === item.title)
    if (!target) {
      target = bookmarkStore.folder(item.title)
      list = bookmarkStore.add(list, target)
    }
    addPages(item.items, target.id)
  }
  return { list, added }
}

// Web and file pages, as `WHERE` text for the urls table. Chrome also keeps
// pages it never showed in its history (`hidden`), such as frames.
const PAGES = "hidden = 0 AND (url LIKE 'http:%' OR url LIKE 'https:%' OR url LIKE 'file:%')"

// Pages visited since `from` (ms), newest first, as Lit keeps history
// ({ url, title, time }), at most Lit's limit.
function readHistory(folder, from = 0) {
  return withCopy(path.join(folder, 'History'), [], (db) => db
    .prepare(`SELECT url, title, last_visit_time / 1000 - ${EPOCH} AS time FROM urls WHERE ${PAGES} AND last_visit_time / 1000 - ${EPOCH} >= ? ORDER BY last_visit_time DESC LIMIT ?`)
    .all(from, historyStore.LIMIT)
    .map(({ url, title, time }) => ({ url, title: typeof title === 'string' ? title : '', time })))
}

// How many pages each range would import: { week, month, quarter, all },
// before Lit's limit.
function countHistory(folder, now = Date.now()) {
  const counts = Object.fromEntries(RANGES.map((range) => [range.value, 0]))
  return withCopy(path.join(folder, 'History'), counts, (db) => {
    const row = db
      .prepare(`SELECT ${RANGES.map((range) => `COALESCE(SUM(last_visit_time / 1000 - ${EPOCH} >= ${since(range.value, now)}), 0) AS "${range.value}"`).join(', ')} FROM urls WHERE ${PAGES}`)
      .get()
    return Object.fromEntries(RANGES.map((range) => [range.value, Number(row[range.value])]))
  })
}

// Imported pages join Lit's history: a page Lit has too keeps the later visit,
// and its title if the other has none. Returns { entries, added }, `added`
// being the pages new to Lit that fit in its limit.
function mergeHistory(entries, imported) {
  const byUrl = new Map(entries.map((entry) => [entry.url, entry]))
  for (const entry of imported) {
    if (!historyStore.recordable(entry.url)) continue
    const old = byUrl.get(entry.url)
    const newer = !old || entry.time > old.time ? entry : old
    const older = newer === entry ? old : entry
    byUrl.set(entry.url, { url: entry.url, title: newer.title || older?.title || '', time: newer.time })
  }
  const merged = [...byUrl.values()].sort((a, b) => b.time - a.time).slice(0, historyStore.LIMIT)
  const had = new Set(entries.map((entry) => entry.url))
  return { entries: merged, added: merged.filter((entry) => !had.has(entry.url)).length }
}

// Saved passwords from both of Chrome's stores, the Google account's first:
// { logins: [{ site, username, encrypted }], never: [site] }. Only logins for
// web forms that Lit could fill; `encrypted` is still Chrome's (a Buffer).
function readLogins(folder) {
  const read = (file) => withCopy(path.join(folder, file), [], (db) => db
    .prepare('SELECT origin_url, username_value, password_value, blacklisted_by_user FROM logins WHERE scheme = 0')
    .all())
  const rows = [...read('Login Data For Account'), ...read('Login Data')]
  const logins = []
  const never = new Set()
  for (const row of rows) {
    const site = passwords.siteOf(row.origin_url)
    if (!site) continue
    if (row.blacklisted_by_user) {
      never.add(site)
      continue
    }
    const username = typeof row.username_value === 'string' ? row.username_value : ''
    const encrypted = row.password_value ? Buffer.from(row.password_value) : null
    if (!encrypted?.length || !passwords.isText(username)) continue
    if (logins.some((login) => login.site === site && login.username === username)) continue
    logins.push({ site, username, encrypted })
  }
  return { logins, never: [...never] }
}

function countLogins(folder) {
  return readLogins(folder).logins.length
}

// Chrome on a Mac encrypts each password with AES-128-CBC under a key made
// from the "Chrome Safe Storage" password in the Keychain, marked "v10".
const deriveKey = (secret) => crypto.pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')
function decrypt(encrypted, key) {
  if (encrypted.subarray(0, 3).toString() !== 'v10') return null
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

// Chrome's key, from the Keychain, which first asks the person whether Lit may
// read it. Rejects when they don't allow it, or Chrome never saved one.
function chromeKey() {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { timeout: 5 * 60 * 1000 }, (error, stdout) => {
      const secret = stdout?.trim()
      if (error || !secret) reject(error || new Error('No key.'))
      else resolve(deriveKey(secret))
    })
  })
}

// Adds imported logins to Lit's password `store`: each decrypted with
// Chrome's `key` and encrypted again with Lit's `encrypt` (null when it
// can't). A login Lit already has for the site and username keeps Lit's
// password, and sites Chrome never saves for are never saved for here either.
// Returns { store, added, unreadable }, or { error } when Lit can't encrypt.
function mergeLogins(store, imported, key, encrypt) {
  let added = 0
  let unreadable = 0
  for (const { site, username, encrypted } of imported.logins) {
    if (store.logins.some((login) => login.site === site && login.username === username)) continue
    const password = decrypt(encrypted, key)
    if (!password) {
      unreadable++
      continue
    }
    const secret = encrypt(password)
    if (secret === null) return { error: 'Couldn’t encrypt passwords with the Keychain.' }
    store = passwords.put(store, { site, username, secret })
    added++
  }
  for (const site of imported.never) store = passwords.neverFor(store, site)
  return { store, added, unreadable }
}

module.exports = {
  ROOT, RANGES, since, isProfileId, profiles,
  readBookmarks, countBookmarks, mergeBookmarks,
  readHistory, countHistory, mergeHistory,
  readLogins, countLogins, deriveKey, decrypt, chromeKey, mergeLogins,
}
