// Every user setting lives in SECTIONS, grouped the way the Settings window
// shows them. Adding an entry here is all it takes: the window draws it,
// and load/update keep only known keys with valid values. Plain Node, so it
// is tested in test/settings.test.js.
const fs = require('node:fs')
const path = require('node:path')
const { SEARCH_ENGINES } = require('./url')

// Each setting: { key, label, description?, type, default, ...type fields }.
// Types the window can draw:
//   choice: `options` is [{ value, label }], shown as a segmented control.
const SECTIONS = [
  {
    title: 'General',
    settings: [
      {
        key: 'searchEngine',
        label: 'Search engine',
        description: 'Used for anything typed that is not an address.',
        type: 'choice',
        options: Object.entries(SEARCH_ENGINES).map(([value, { name }]) => ({ value, label: name })),
        default: 'google',
      },
    ],
  },
]

const SETTINGS = SECTIONS.flatMap((section) => section.settings)

function isValid(setting, value) {
  if (setting.type === 'choice') return setting.options.some((option) => option.value === value)
  return false
}

// The defaults, overlaid with every saved value that is still a known
// setting and still valid (settings get renamed, options get removed).
function clean(saved = {}) {
  const values = {}
  for (const setting of SETTINGS) {
    values[setting.key] = isValid(setting, saved[setting.key]) ? saved[setting.key] : setting.default
  }
  return values
}

// A missing or unreadable file means every setting is at its default.
function load(file) {
  try {
    return clean(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return clean()
  }
}

// Returns the new values, or the same ones if `key` or `value` is invalid.
function update(values, key, value) {
  const setting = SETTINGS.find((item) => item.key === key)
  if (!setting || !isValid(setting, value)) return values
  return { ...values, [key]: value }
}

function save(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`)
}

module.exports = { SECTIONS, clean, load, update, save }
