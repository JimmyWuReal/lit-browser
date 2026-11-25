// Every user setting lives in SECTIONS, grouped the way the Settings popup
// shows them. Adding an entry here is all it takes for the popup to draw it
// and for load/update to check it; main then reads it from `settings`.
// Plain Node, so it is tested in test/settings.test.js.
const fs = require('node:fs')
const path = require('node:path')
const { SEARCH_ENGINES } = require('./url')
const zoom = require('./zoom')
const shortcuts = require('./shortcuts')
const quickSearch = require('./quicksearch')

// A section is either for one profile (`scope: 'profile'`: each profile has
// its own values, and the popup says whose) or shared by every profile. The
// section a setting is in therefore decides which it is; what belongs to a
// person or their accounts goes in a profile's, how Lit itself works (tabs,
// shortcuts) in a shared one. The profile ones come first.
// A section can also name a `list` the popup draws after its settings, from
// state main sends with them (sitePermissions, quickSearchSites, profiles).
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
    scope: 'profile',
    settings: [
      {
        key: 'searchEngine',
        label: 'Search engine',
        description: 'Used for anything typed that is not an address.',
        type: 'choice',
        options: Object.entries(SEARCH_ENGINES).map(([value, { name }]) => ({ value, label: name })),
        default: 'google',
      },
      {
        key: 'newTabPage',
        label: 'New tabs open',
        description: 'An address or search. Leave empty for the search box.',
        type: 'text',
        placeholder: 'Search box',
        default: '',
      },
      {
        key: 'defaultZoom',
        label: 'Page zoom',
        description: 'For sites you have not zoomed yourself.',
        type: 'choice',
        options: [0.8, 0.9, 1, 1.1, 1.25, 1.5].map((value) => ({ value, label: zoom.percent(value) })),
        default: 1,
      },
      {
        key: 'addressSuggestions',
        label: 'Suggest pages as you type',
        description: 'In the address bar, show bookmarks and visited pages whose title or address matches.',
        type: 'toggle',
        default: true,
      },
      {
        key: 'bookmarkBar',
        label: 'Show bookmark bar',
        description: 'A row of your bookmarks below the address bar.',
        type: 'toggle',
        default: true,
      },
    ],
  },
  {
    id: 'downloads',
    title: 'Downloads',
    scope: 'profile',
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
    scope: 'profile',
    // Also lists the sites given or refused a permission (see
    // src/permissions.js), after the settings.
    list: 'sitePermissions',
    settings: [
      {
        key: 'saveHistory',
        label: 'Save history',
        description: 'Pages you visit, and closed tabs to reopen. When off, neither is kept, and reopened windows keep only each tab’s page, not its back and forward history or what was typed into it.',
        type: 'toggle',
        default: true,
      },
      {
        key: 'blockAds',
        label: 'Block ads and trackers',
        description: 'Stops requests to ad and tracking servers and hides the space ads leave, using Ghostery’s lists, which download the first time and refresh weekly. Reload open pages to show or hide their ads.',
        type: 'toggle',
        default: true,
      },
      {
        key: 'screenSharing',
        label: 'Let sites ask to share your screen',
        description: 'You choose the tab, window or screen each time. When off, sites are refused.',
        type: 'toggle',
        default: true,
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
    id: 'quickSearch',
    title: 'Quick Search',
    // Also lists every site and its shortcuts, after the settings.
    list: 'quickSearchSites',
    settings: [
      {
        key: 'quickSearch',
        label: 'Search sites with shortcuts',
        description: 'Type a shortcut with your search, such as !yt lofi, to search YouTube instead of your search engine. A shortcut alone opens the site.',
        type: 'toggle',
        default: true,
      },
      {
        key: 'quickSearchPrefix',
        label: 'Shortcut prefix',
        description: 'The character that starts a shortcut.',
        type: 'choice',
        options: quickSearch.PREFIXES.map((value) => ({ value, label: value })),
        default: '!',
      },
    ],
  },
  {
    id: 'tabs',
    title: 'Tabs',
    settings: [
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
      {
        key: 'restoreSession',
        label: 'Reopen windows from last time',
        description: 'Lit opens with the windows and tabs that were open when it quit.',
        type: 'toggle',
        default: true,
      },
      {
        key: 'closedTabsLimit',
        label: 'Closed tabs to remember',
        description: 'For Reopen Closed Tab; a closed window counts each of its tabs. Kept in memory only, and forgotten when Lit quits.',
        type: 'choice',
        options: [10, 25, 50, 100].map((value) => ({ value, label: String(value) })),
        default: 50,
      },
    ],
  },
  {
    id: 'profiles',
    title: 'Profiles',
    // Only the profiles themselves (src/profiles.js), to manage.
    list: 'profiles',
    settings: [],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard Shortcuts',
    settings: [
      shortcut('newTab', 'New Tab', 'CmdOrCtrl+T'),
      shortcut('newWindow', 'New Window', 'CmdOrCtrl+N'),
      shortcut('newPrivateWindow', 'New Private Window', 'Shift+CmdOrCtrl+N'),
      shortcut('reopenTab', 'Reopen Closed Tab', 'Shift+CmdOrCtrl+T'),
      shortcut('history', 'Show History', 'CmdOrCtrl+Y'),
      shortcut('downloads', 'Show Downloads', 'Alt+CmdOrCtrl+L'),
      shortcut('openLocation', 'Open Location', 'CmdOrCtrl+L'),
      shortcut('closeTab', 'Close Tab', 'CmdOrCtrl+W'),
      shortcut('closeWindow', 'Close Window', 'Shift+CmdOrCtrl+W'),
      shortcut('duplicateTab', 'Duplicate Tab', ''),
      shortcut('closeOtherTabs', 'Close Other Tabs', 'Alt+CmdOrCtrl+W'),
      shortcut('closeTabsToRight', 'Close Tabs to the Right', ''),
      shortcut('bookmarkPage', 'Bookmark This Page', 'CmdOrCtrl+D'),
      shortcut('bookmarkBar', 'Show Bookmark Bar', 'Shift+CmdOrCtrl+B'),
      shortcut('print', 'Print', 'CmdOrCtrl+P'),
      shortcut('reload', 'Reload', 'CmdOrCtrl+R'),
      shortcut('back', 'Back', 'CmdOrCtrl+['),
      shortcut('forward', 'Forward', 'CmdOrCtrl+]'),
      shortcut('zoomIn', 'Zoom In', 'CmdOrCtrl+='),
      shortcut('zoomOut', 'Zoom Out', 'CmdOrCtrl+-'),
      shortcut('resetZoom', 'Reset Zoom', 'CmdOrCtrl+0'),
      shortcut('find', 'Find', 'CmdOrCtrl+F'),
      shortcut('findNext', 'Find Next', 'CmdOrCtrl+G'),
      shortcut('findPrevious', 'Find Previous', 'Shift+CmdOrCtrl+G'),
      shortcut('nextTab', 'Show Next Tab', 'Ctrl+Tab'),
      shortcut('previousTab', 'Show Previous Tab', 'Ctrl+Shift+Tab'),
      shortcut('devTools', 'Developer Tools', 'Alt+CmdOrCtrl+I'),
      shortcut('newProfile', 'New Profile', ''),
      shortcut('profiles', 'Manage Profiles', 'Shift+CmdOrCtrl+M'),
      shortcut('settings', 'Settings', 'CmdOrCtrl+,'),
    ],
  },
]

const SETTINGS = SECTIONS.flatMap((section) => section.settings)
const PROFILE_KEYS = new Set(SECTIONS.filter((section) => section.scope === 'profile').flatMap((section) => section.settings.map((setting) => setting.key)))
// Whether each profile has its own value for a setting.
const isProfile = (key) => PROFILE_KEYS.has(key)

// A profile's settings: its own values, and `shared`'s for the rest.
const combine = (own, shared) => Object.fromEntries(SETTINGS.map(({ key }) => [key, (isProfile(key) ? own : shared)[key]]))
// Only the values a profile has for itself, which its file holds. (The
// default profile's file holds every setting, so also the shared ones.)
const ownOf = (values) => Object.fromEntries(Object.entries(values).filter(([key]) => isProfile(key)))

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

module.exports = { SECTIONS, SETTINGS, isProfile, combine, ownOf, clean, load, update, save }
