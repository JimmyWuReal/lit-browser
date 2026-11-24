// Site permissions: which Chromium permission requests Lit asks about, and
// the Allow or Block each site was given, kept in permissions.json the way
// zoom.json keeps zoom. A site is an origin (scheme, host and port), as in
// Chrome, so http and https, or two ports, are asked separately.
// Plain Node, so it is tested in test/permissions.test.js.
const fs = require('node:fs')
const path = require('node:path')

// What Lit asks about, in the order Settings lists them. `does` finishes
// "example.com wants to …".
const KINDS = {
  camera: { label: 'Camera', does: 'use your camera' },
  microphone: { label: 'Microphone', does: 'use your microphone' },
  location: { label: 'Location', does: 'know your location' },
  notifications: { label: 'Notifications', does: 'show notifications' },
  // Chromium asks one permission for reading and for some writing.
  clipboard: { label: 'Clipboard', does: 'read and change your clipboard' },
}
const CHOICES = ['allow', 'block']

// Chromium permission names -> kinds. A camera or microphone request is
// `media`, with its devices in `mediaTypes`.
const BY_PERMISSION = {
  geolocation: 'location',
  'geolocation-approximate': 'location',
  notifications: 'notifications',
  'clipboard-read': 'clipboard',
  // document.execCommand('paste') reads the clipboard with no prompt of
  // its own; Electron refuses it by default, and so does Lit (no kinds).
  'deprecated-sync-clipboard-read': null,
}
const BY_MEDIA = { video: 'camera', audio: 'microphone' }

// The kinds a request needs: [] for one that is always refused, or null
// for a permission Lit does not ask about, which keeps Electron's default
// (allowed): fullscreen, pointer lock, protected video and the like.
// A `media` request without devices is camera pan, tilt and zoom, which
// the prompt has no words for yet, so it is refused.
function kindsOf(permission, mediaTypes = []) {
  if (permission === 'media') return [...new Set(mediaTypes.filter((type) => Object.hasOwn(BY_MEDIA, type)).map((type) => BY_MEDIA[type]))]
  if (!Object.hasOwn(BY_PERMISSION, permission)) return null
  return BY_PERMISSION[permission] ? [BY_PERMISSION[permission]] : []
}

// The kinds a check (Notification.permission, navigator.permissions.query)
// is about, as in kindsOf. A media check names one device, or 'unknown'
// for the camera's other streams; one without is pan, tilt and zoom.
function checkKindsOf(permission, mediaType) {
  if (permission === 'media') return mediaType === undefined ? [] : [mediaType === 'audio' ? 'microphone' : 'camera']
  return kindsOf(permission)
}

// "https://example.com". Pages with no origin of their own (data:,
// about:blank) have none, and neither do local files: one origin would
// cover every file on disk, so they are refused instead of asked.
function originOf(url) {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

// How the prompt and Settings name a site: https is left out, as Chrome's
// prompts do; anything else is kept.
const label = (site) => site.replace(/^https:\/\//, '')

// "use your camera and microphone", "know your location".
function describe(kinds) {
  if (kinds.length === 2 && kinds.includes('camera') && kinds.includes('microphone')) return 'use your camera and microphone'
  return kinds.map((kind) => KINDS[kind].does).join(' and ')
}

// 'allow' when the site was allowed every kind, 'block' when it was
// blocked any of them, else 'ask'.
function status(sites, site, kinds) {
  const saved = sites.get(site) || {}
  if (kinds.some((kind) => saved[kind] === 'block')) return 'block'
  return kinds.every((kind) => saved[kind] === 'allow') ? 'allow' : 'ask'
}

// The kinds the site has no choice for yet: what a prompt asks about, so
// answering it never changes an earlier choice.
function undecided(sites, site, kinds) {
  const saved = sites.get(site) || {}
  return kinds.filter((kind) => !saved[kind])
}

// A new Map with `choice` saved for each kind, or the kinds forgotten
// when `choice` is null. A site with nothing left is dropped.
function choose(sites, site, kinds, choice) {
  const next = new Map(sites)
  const saved = { ...next.get(site) }
  for (const kind of kinds) {
    if (choice) saved[kind] = choice
    else delete saved[kind]
  }
  if (Object.keys(saved).length) next.set(site, saved)
  else next.delete(site)
  return next
}

// What Settings lists: sites by name, each kind in KINDS order.
function list(sites) {
  return [...sites]
    .map(([site, saved]) => ({
      site,
      label: label(site),
      kinds: Object.keys(KINDS).filter((kind) => saved[kind]).map((kind) => ({ kind, label: KINDS[kind].label, choice: saved[kind] })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// A Map of site -> { kind: 'allow' | 'block' } from the file, keeping only
// known kinds and choices. A missing or unreadable file means no choices.
function load(file) {
  const sites = new Map()
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return sites
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return sites
  for (const [site, choices] of Object.entries(saved)) {
    if (originOf(site) !== site || !choices || typeof choices !== 'object') continue
    const kept = {}
    for (const kind of Object.keys(KINDS)) {
      if (CHOICES.includes(choices[kind])) kept[kind] = choices[kind]
    }
    if (Object.keys(kept).length) sites.set(site, kept)
  }
  return sites
}

// Writes a sibling file and renames it over the old one, like settings.
function save(file, sites) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(sites), null, 2)}\n`)
  fs.renameSync(temporary, file)
}

module.exports = { KINDS, CHOICES, kindsOf, checkKindsOf, originOf, label, describe, status, undecided, choose, list, load, save }
