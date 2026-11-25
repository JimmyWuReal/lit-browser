// Saved passwords, per profile, kept in passwords.json. A password belongs to
// a site, an origin (scheme, host and port), and is only ever offered there.
// Each one is encrypted before it gets here (main uses Electron's safeStorage,
// whose key is in the macOS Keychain); sites and usernames are not.
// Plain Node, so it is tested in test/passwords.test.js.
//
// A store is { logins: [{ id, site, username, secret }], never: [site] }:
// `secret` is the encrypted password in base64, and `never` the sites Lit was
// told not to ask about. Changes make a new store.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Longer than any real username or password.
const MAX_TEXT = 1024

// The origin of a web page, or null for anything that can't have passwords.
function siteOf(url) {
  try {
    const { origin, protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' ? origin : null
  } catch {
    return null
  }
}

const isText = (value) => typeof value === 'string' && value.length <= MAX_TEXT
const forSite = (store, site) => store.logins.filter((login) => login.site === site)

// What to do about a password just used to sign in: null (nothing new, or the
// site is never asked about), 'save', or 'update' a saved one, whose `id` and
// `secret` come with it. Without a username it could be any account, so it
// updates one only when the password it replaces (`old`, typed with the new
// one) is that of just one login. `decrypt` answers a secret's password, or
// null if it can't be read.
function offerFor(store, { site, username, password, old = '' }, decrypt) {
  if (!site || !password || store.never.includes(site)) return null
  const saved = forSite(store, site)
  const replaced = !username && old ? saved.filter((each) => decrypt(each.secret) === old) : []
  const login = replaced.length ? (replaced.length === 1 ? replaced[0] : null) : saved.find((each) => each.username === username)
  if (!login && !username && saved.some((each) => decrypt(each.secret) === password)) return null
  if (!login) return { action: 'save', username }
  return decrypt(login.secret) === password ? null : { action: 'update', id: login.id, secret: login.secret, username: login.username }
}

// Saves a login, over the one with its site and username if there is one.
function put(store, { site, username, secret }) {
  const old = store.logins.find((login) => login.site === site && login.username === username)
  const logins = old
    ? store.logins.map((login) => (login === old ? { ...old, secret } : login))
    : [...store.logins, { id: randomUUID(), site, username, secret }]
  return { ...store, logins }
}

const remove = (store, id) => ({ ...store, logins: store.logins.filter((login) => login.id !== id) })
const neverFor = (store, site) => (store.never.includes(site) ? store : { ...store, never: [...store.never, site] })
const askAgain = (store, site) => ({ ...store, never: store.never.filter((each) => each !== site) })

// What Settings lists, by site then username: never a password.
const label = (site) => site.replace(/^https:\/\//, '')
function list(store) {
  return {
    logins: store.logins
      .map(({ id, site, username }) => ({ id, site: label(site), username }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)),
    never: store.never.map((site) => ({ site, label: label(site) })).sort((a, b) => a.label.localeCompare(b.label)),
  }
}

// A file Lit can't read is kept as passwords.json.bad, since the next save
// replaces it. Entries that make no sense are dropped.
function load(file) {
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(saved?.logins)) throw new Error('Not a list.')
  } catch (error) {
    if (error.code !== 'ENOENT') try { fs.renameSync(file, `${file}.bad`) } catch {}
    return { logins: [], never: [] }
  }
  const isSite = (site) => typeof site === 'string' && siteOf(site) === site
  return {
    logins: saved.logins
      .filter((login) => login && isSite(login.site) && isText(login.username) && typeof login.secret === 'string')
      .map(({ id, site, username, secret }) => ({ id: typeof id === 'string' ? id : randomUUID(), site, username, secret })),
    never: (Array.isArray(saved.never) ? saved.never : []).filter(isSite),
  }
}

// Writes a sibling file and renames it over the old one, like settings,
// readable only by this user.
function save(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

module.exports = { siteOf, isText, forSite, offerFor, put, remove, neverFor, askAgain, label, list, load, save }
