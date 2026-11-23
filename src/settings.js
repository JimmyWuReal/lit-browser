// Every user setting lives in SECTIONS, grouped the way the Settings popup
// shows them. Adding an entry here is all it takes for the popup to draw it
// and for load/update to check it; main then reads it from `settings`.
// Plain Node, so it is tested in test/settings.test.js.
const fs = require('node:fs')
const path = require('node:path')
const { SEARCH_ENGINES } = require('./url')
const shortcuts = require('./shortcuts')

// Each setting: { key, label, description?, type, default, ...type fields }.
// Types the popup can draw:
//   choice    `options` is [{ value, label }]; a segmented control.
//   toggle    true or false; a switch.
//   text      a string up to 2048 characters, `placeholder` while empty.
//   shortcut  an accelerator from src/shortcuts.js, or '' for none; recorded
//             by pressing it. Each one is a menu command (see buildMenu).
const shortcut = (command, label, accelerator) => ({ key: `shortcuts.${command}`, label, type: 'shortcut', default: accelerator })

const SECTIONS = [
  {
    id: 'general',
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
  {
    id: 'tabs',
    title: 'Tabs',
    settings: [
      {
        key: 'newTabPage',
        label: 'New tabs open',
        description: 'An address or search. Leave empty for the search box.',
        type: 'text',
        placeholder: 'Search box',
        default: '',
      },
      {
        key: 'newTabPosition',
        label: 'New tab position',
        type: 'choice',
        options: [{ value: 'end', label: 'At the end' }, { value: 'next', label: 'Next to current' }],
        default: 'end',
      },
      {
        key: 'switchToNewTabs',
        label: 'Switch to ⌘-clicked links',
        description: 'Otherwise they open in the background.',
        type: 'toggle',
        default: false,
      },
      {
        key: 'closeWindowWithLastTab',
        label: 'Close window with its last tab',
        description: 'Otherwise closing the last tab leaves a new one.',
        type: 'toggle',
        default: true,
      },
    ],
  },
  {
    id: 'downloads',
    title: 'Downloads',
    settings: [
      {
        key: 'downloadLocation',
        label: 'Save downloads',
        type: 'choice',
        options: [{ value: 'ask', label: 'Ask each time' }, { value: 'downloads', label: 'To Downloads' }],
        default: 'ask',
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy',
    settings: [
      {
        key: 'saveHistory',
        label: 'Save history',
        description: 'Pages you visit, and closed tabs to reopen. When off, neither is kept.',
        type: 'toggle',
        default: true,
      },
      {
        key: 'closedTabsFor',
        label: 'Forget closed tabs after',
        description: 'Closed tabs are kept in memory only, for Reopen Closed Tab.',
        type: 'choice',
        options: [{ value: '10m', label: '10 minutes' }, { value: '1h', label: '1 hour' }, { value: '1d', label: '1 day' }],
        default: '1h',
      },
      {
        key: 'doNotTrack',
        label: 'Ask sites not to track me',
        description: 'Sends Do Not Track and Global Privacy Control with every request.',
        type: 'toggle',
        default: false,
      },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard Shortcuts',
    settings: [
      shortcut('newTab', 'New Tab', 'CmdOrCtrl+T'),
      shortcut('newWindow', 'New Window', 'CmdOrCtrl+N'),
      shortcut('reopenTab', 'Reopen Closed Tab', 'Shift+CmdOrCtrl+T'),
      shortcut('history', 'Show History', 'CmdOrCtrl+Y'),
      shortcut('openLocation', 'Open Location', 'CmdOrCtrl+L'),
      shortcut('closeTab', 'Close Tab', 'CmdOrCtrl+W'),
      shortcut('closeWindow', 'Close Window', 'Shift+CmdOrCtrl+W'),
      shortcut('duplicateTab', 'Duplicate Tab', ''),
      shortcut('closeOtherTabs', 'Close Other Tabs', 'Alt+CmdOrCtrl+W'),
      shortcut('closeTabsToRight', 'Close Tabs to the Right', ''),
      shortcut('reload', 'Reload', 'CmdOrCtrl+R'),
      shortcut('back', 'Back', 'CmdOrCtrl+['),
      shortcut('forward', 'Forward', 'CmdOrCtrl+]'),
      shortcut('nextTab', 'Show Next Tab', 'Ctrl+Tab'),
      shortcut('previousTab', 'Show Previous Tab', 'Ctrl+Shift+Tab'),
      shortcut('devTools', 'Developer Tools', 'Alt+CmdOrCtrl+I'),
      shortcut('settings', 'Settings', 'CmdOrCtrl+,'),
    ],
  },
]

const SETTINGS = SECTIONS.flatMap((section) => section.settings)

// Why `value` cannot be saved for `setting`, or null if it can.
// `values` lets a shortcut check it is not taken by another command.
function problem(setting, value, values) {
  switch (setting.type) {
    case 'choice':
      return setting.options.some((option) => option.value === value) ? null : 'Not one of the options.'
    case 'toggle':
      return typeof value === 'boolean' ? null : 'Not on or off.'
    case 'text':
      return typeof value === 'string' && value.length <= 2048 ? null : 'Too long.'
    case 'shortcut': {
      if (value === '') return null
      const reason = shortcuts.problem(value)
      if (reason) return reason
      const taken = SETTINGS.find((other) => other.type === 'shortcut' && other !== setting && values[other.key] === value)
      return taken ? `${shortcuts.label(value)} is used by ${taken.label}.` : null
    }
    default:
      return 'Unknown setting type.'
  }
}

// The defaults, overlaid with every saved value that is still a known
// setting and still valid (settings get renamed, options get removed).
function clean(saved = {}) {
  const values = {}
  for (const setting of SETTINGS) {
    const value = Object.hasOwn(saved, setting.key) ? saved[setting.key] : setting.default
    values[setting.key] = problem(setting, value, {}) ? setting.default : value
  }
  // Two commands can end up on one shortcut (an edited file, or a saved
  // shortcut that is now another command's default). A shortcut someone
  // chose beats a default, so a new command never takes theirs; otherwise
  // the later command gets none.
  const used = new Set()
  const chosen = (setting) => Object.hasOwn(saved, setting.key) && saved[setting.key] === values[setting.key]
  const shortcutSettings = SETTINGS.filter((setting) => setting.type === 'shortcut')
  for (const setting of [...shortcutSettings.filter(chosen), ...shortcutSettings.filter((setting) => !chosen(setting))]) {
    if (!values[setting.key]) continue
    if (used.has(values[setting.key])) values[setting.key] = ''
    used.add(values[setting.key])
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

// { values } with the change made, or { values, error } unchanged.
function update(values, key, value) {
  const setting = SETTINGS.find((item) => item.key === key)
  if (!setting) return { values, error: 'Unknown setting.' }
  if (typeof value === 'string' && setting.type === 'text') value = value.trim()
  const error = problem(setting, value, values)
  if (error) return { values, error }
  return { values: { ...values, [key]: value } }
}

// Writes JSON to a sibling file and renames it over the old one, so an
// interrupted write never leaves a half-written file. History uses it too.
function save(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

module.exports = { SECTIONS, SETTINGS, clean, load, update, save }
