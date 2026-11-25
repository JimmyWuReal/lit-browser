// Profiles: each has its own session (sign-ins, cookies, site data), history,
// bookmarks, zooms, site permissions and profile settings (see SECTIONS in
// src/settings.js). Their list is saved to profiles.json in the app's data
// folder. Plain Node, so it is tested in test/profiles.test.js; main opens
// each one's session and files.
//
// The list is { profiles: [{ id, name, color }], last, removed }. The first
// profile is always DEFAULT, which keeps its data where Lit kept it before
// profiles, and can't be removed. `last` is the profile used last, for the
// next launch. `removed` are ids of deleted profiles whose files are still to
// be deleted: Chromium holds a session's files until Lit quits, so the next
// launch deletes them.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { save } = require('./settings')

const DEFAULT = 'default'
const NAME_LIMIT = 40
// Each is light enough for dark text on it.
const COLORS = [
  { id: 'gray', label: 'Gray', value: '#b4b4b4' },
  { id: 'blue', label: 'Blue', value: '#7cb3ff' },
  { id: 'green', label: 'Green', value: '#7fd6a1' },
  { id: 'yellow', label: 'Yellow', value: '#f2cf6b' },
  { id: 'orange', label: 'Orange', value: '#f5a66b' },
  { id: 'pink', label: 'Pink', value: '#f59ac0' },
  { id: 'teal', label: 'Teal', value: '#74d3d9' },
]

// Ids name files and folders, so only ones made by `add` count.
const isId = (id) => typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
const colorOf = (id) => COLORS.find((color) => color.id === id) || COLORS[0]

// Where a profile keeps its files, under the app's data folder, and its
// session: undefined for the default profile's, Electron's default session.
const folder = (root, id) => (id === DEFAULT ? root : path.join(root, 'Profiles', id))
const partition = (id) => (id === DEFAULT ? undefined : `persist:profile-${id}`)

// Whether a profile other than `id` already has the name.
const taken = (state, name, id) => state.profiles.some((profile) => profile.id !== id && profile.name.toLowerCase() === name.toLowerCase())

// "Profile 2", or the next number free.
function freshName(state) {
  let number = state.profiles.length + 1
  while (taken(state, `Profile ${number}`)) number++
  return `Profile ${number}`
}

// The color fewest profiles have, the earliest of those.
function freshColor(state) {
  const uses = (color) => state.profiles.filter((profile) => profile.color === color.id).length
  return COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best)).id
}

// A new profile at the end of the list: { state, profile }.
function add(state) {
  const profile = { id: randomUUID(), name: freshName(state), color: freshColor(state) }
  return { state: { ...state, profiles: [...state.profiles, profile] }, profile }
}

// Renames or recolors one: { state }, or { state, error } unchanged.
function update(state, id, { name, color }) {
  const current = state.profiles.find((profile) => profile.id === id)
  if (!current) return { state, error: 'This profile was deleted.' }
  const next = { ...current }
  if (name !== undefined) {
    next.name = String(name).trim()
    if (!next.name) return { state, error: 'Give the profile a name.' }
    if (next.name.length > NAME_LIMIT) return { state, error: 'That name is too long.' }
    if (taken(state, next.name, id)) return { state, error: 'Another profile has that name.' }
  }
  if (color !== undefined) {
    if (!COLORS.some((each) => each.id === color)) return { state, error: 'Not one of the colors.' }
    next.color = color
  }
  return { state: { ...state, profiles: state.profiles.map((profile) => (profile === current ? next : profile)) } }
}

// Takes one off the list, its files to be deleted. Never the default one.
function remove(state, id) {
  if (id === DEFAULT || !state.profiles.some((profile) => profile.id === id)) return state
  return {
    profiles: state.profiles.filter((profile) => profile.id !== id),
    last: state.last === id ? DEFAULT : state.last,
    removed: [...state.removed, id],
  }
}

// Only well-formed profiles survive a hand-edited file.
function clean(saved) {
  const profiles = []
  for (const item of Array.isArray(saved?.profiles) ? saved.profiles : []) {
    if (!item || (item.id !== DEFAULT && !isId(item.id)) || profiles.some((profile) => profile.id === item.id)) continue
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, NAME_LIMIT) : ''
    profiles.push({
      id: item.id,
      name: name && !taken({ profiles }, name) ? name : freshName({ profiles }),
      color: colorOf(item.color).id,
    })
  }
  const first = profiles.find((profile) => profile.id === DEFAULT) || { id: DEFAULT, name: taken({ profiles }, 'Personal') ? freshName({ profiles }) : 'Personal', color: COLORS[0].id }
  const list = [first, ...profiles.filter((profile) => profile !== first)]
  const listed = (id) => list.some((profile) => profile.id === id)
  return {
    profiles: list,
    last: listed(saved?.last) ? saved.last : DEFAULT,
    // A profile still listed is never deleted.
    removed: (Array.isArray(saved?.removed) ? saved.removed : []).filter((id) => isId(id) && !listed(id)),
  }
}

// A file Lit can't read is kept as profiles.json.bad, since the next save
// replaces it. The folders of profiles it named stay, as only those in
// `removed` are ever deleted.
function load(file) {
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(saved?.profiles)) throw new Error('Not a list.')
  } catch (error) {
    if (error.code !== 'ENOENT') try { fs.renameSync(file, `${file}.bad`) } catch {}
    return clean()
  }
  return clean(saved)
}

// Deletes what is left of removed profiles, before any session is opened.
// Those that can't be deleted stay in `removed` for next time.
function sweep(root, state) {
  const removed = state.removed.filter((id) => {
    try {
      fs.rmSync(folder(root, id), { recursive: true, force: true })
      // Where Electron keeps a "persist:" partition.
      fs.rmSync(path.join(root, 'Partitions', `profile-${id}`), { recursive: true, force: true })
      return false
    } catch {
      return true
    }
  })
  return removed.length === state.removed.length ? state : { ...state, removed }
}

module.exports = { DEFAULT, NAME_LIMIT, COLORS, colorOf, folder, partition, add, update, remove, clean, load, save, sweep }
