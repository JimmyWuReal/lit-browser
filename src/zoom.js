// Page zoom: the steps ⌘+ and ⌘- move through, and the per-site zoom Lit
// remembers. Like Chrome, a site is its host name (http and https, and every
// port, share one; Chromium itself shares zoom that way), and
// only sites zoomed away from the default zoom are kept, in zoom.json.
// Plain Node, so it is tested in test/zoom.test.js.
const fs = require('node:fs')
const path = require('node:path')

// Chrome's zoom steps, as factors (1 is 100%).
const LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const MIN = LEVELS[0]
const MAX = LEVELS[LEVELS.length - 1]
// Factors read back from Chromium are not exact, so near a step counts as on it.
const EPSILON = 0.001

// The next step in `direction` (1 in, -1 out) from `factor`, which need not
// be a step itself; the end steps stay put.
function step(factor, direction) {
  if (direction > 0) return LEVELS.find((level) => level > factor + EPSILON) ?? MAX
  return LEVELS.findLast((level) => level < factor - EPSILON) ?? MIN
}

const same = (a, b) => Math.abs(a - b) < EPSILON

// The site a URL's zoom belongs to: its host name, or for pages without one
// its scheme ("file:"), so all local files share one zoom.
function siteOf(url) {
  try {
    const { hostname, protocol } = new URL(url)
    return hostname || protocol
  } catch {
    return null
  }
}

// "125%", as the address bar and menus show it.
const percent = (factor) => `${Math.round(factor * 100)}%`

const isLevel = (factor) => LEVELS.some((level) => same(level, factor))

// A Map of site -> factor from the file ({ host: factor }), keeping only
// valid entries. A Map, since a host can be any name, "__proto__" included.
// A missing or unreadable file means no site has its own zoom.
function load(file) {
  const sites = new Map()
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return sites
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return sites
  for (const [site, factor] of Object.entries(saved)) {
    if (typeof factor === 'number' && isLevel(factor)) sites.set(site, factor)
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

module.exports = { LEVELS, step, same, siteOf, percent, load, save }
