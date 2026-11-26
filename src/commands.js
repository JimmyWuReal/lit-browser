// What the command palette (⇧⌘P, src/palette.html) lists, kept apart from
// Electron so it can be tested. Main gathers three kinds of command:
//   menu      every visible, enabled item of the application menu, so each
//             menu command (and its shortcut) is in the palette by itself
//   tab       each of the window's other tabs, to switch to
//   setting   each on/off setting, to flip, and each option of a choice
//             setting, to pick
// Each command is { id, label, group, keys?, detail?, state?, words? }:
// `keys` its shortcut as macOS draws it (⇧⌘T), `detail` dim text after the
// label, `state` 'On' or 'Off' for a switch, or 'Current' for the option in
// use, and `words` more text that finds it. Main matches what is typed
// (`match`) and runs the one picked; the palette only draws them.
// Main keeps what runs each one (`item`, the menu item) off what it sends.
const shortcuts = require('./shortcuts')

// Every command of a menu, from Electron's MenuItems (or plain objects
// shaped like them): { label, type, role, visible, enabled, accelerator,
// checked, submenu, id }. Items with a role (Copy, Minimize…) are left out:
// they act on whatever has focus, which is the palette while it is open,
// though a menu with a role (Window) still has its own items listed. So is
// the item with id `skip`, the palette's own.
function menuCommands(items, { skip } = {}, path = []) {
  const commands = []
  for (const item of items) {
    if (item.type === 'separator' || item.visible === false || item.enabled === false) continue
    if (skip && item.id === skip) continue
    const trail = [...path, item.label]
    const submenu = item.submenu?.items ?? item.submenu
    if (Array.isArray(submenu)) {
      commands.push(...menuCommands(submenu, { skip }, trail))
      continue
    }
    if (item.role || !item.label || !path.length) continue
    commands.push({
      id: `menu:${trail.join('/')}`,
      label: item.label,
      // The top menu's name: "File", "Bookmarks".
      group: path[0],
      ...(typeof item.accelerator === 'string' && item.accelerator && { keys: shortcuts.label(item.accelerator) }),
      // Show Bookmark Bar, and the Profiles menu's profile in use.
      ...(item.type === 'checkbox' && { state: item.checked ? 'On' : 'Off' }),
      ...(item.type === 'radio' && item.checked && { state: 'Current' }),
      item,
    })
  }
  return commands
}

// The window's other tabs, [{ id, title, url }], to switch to.
const tabCommands = (tabs) => tabs.map(({ id, title, url }) => ({
  id: `tab:${id}`,
  label: title || url || 'New Tab',
  group: 'Tab',
  ...(title && url && { detail: url.replace(/^https?:\/\/(www\.)?/, '') }),
  tabId: id,
}))

// Settings from SECTIONS that one press can change: toggles flip, and each
// option of a choice picks it ("Search engine: Bing"). The section's title
// and the setting's description also find it, and "toggle" or "turn off" a
// toggle. Text and shortcut settings
// need typing, so Settings itself is the place for those.
function settingCommands(sections, values) {
  const commands = []
  for (const section of sections) {
    for (const setting of section.settings) {
      const words = `${section.title} ${setting.description || ''}`
      if (setting.type === 'toggle') {
        // "toggle suggestions", "turn off ads"
        commands.push({ id: `setting:${setting.key}`, label: setting.label, group: 'Settings', state: values[setting.key] ? 'On' : 'Off', words: `${words} toggle turn on off`, key: setting.key, value: !values[setting.key] })
      } else if (setting.type === 'choice') {
        for (const option of setting.options) {
          commands.push({ id: `setting:${setting.key}=${option.value}`, label: `${setting.label}: ${option.label}`, group: 'Settings', ...(values[setting.key] === option.value && { state: 'Current' }), words, key: setting.key, value: option.value })
        }
      }
    }
  }
  return commands
}

// Every command, menu ones first, without a setting the menu already
// offers under the same name (Show Bookmark Bar).
function allCommands({ menu, tabs, settings }) {
  const names = new Set(menu.map((command) => command.label.toLowerCase()))
  return [...menu, ...tabs, ...settings.filter((command) => !names.has(command.label.toLowerCase()))]
}

// What main sends the palette: only what it draws and searches.
const shown = ({ id, label, group, keys, detail, state, words }) => ({ id, label, group, keys, detail, state, words })

// The commands that match `text`, best first. Each word typed must be in
// the command's label, group, detail or words, or start with one of its
// words of 3 letters or more, so "suggestions" finds "Suggest pages as you
// type" and "tabs" finds "Tab". Labels that start with what was typed come
// first, then those with a word starting with each word typed, then other
// label matches, then the rest, each in the order given.
function match(commands, text) {
  const typed = text.toLowerCase().trim().replace(/\s+/g, ' ')
  if (!typed) return commands
  const queries = typed.split(' ')
  const wordsOf = (value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const fits = (value, query) => value.toLowerCase().includes(query) || wordsOf(value).some((word) => word.length >= 3 && query.startsWith(word))
  const rank = ({ label, group, detail = '', words = '' }) => {
    const all = `${label} ${group} ${detail} ${words}`
    if (!queries.every((query) => fits(all, query))) return -1
    const lower = label.toLowerCase()
    if (lower.startsWith(typed)) return 0
    if (queries.every((query) => wordsOf(label).some((word) => word.startsWith(query)))) return 1
    if (queries.every((query) => fits(label, query))) return 2
    return 3
  }
  return commands
    .map((command, index) => ({ command, index, rank: rank(command) }))
    .filter(({ rank: r }) => r >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ command }) => command)
}

module.exports = { menuCommands, tabCommands, settingCommands, allCommands, shown, match }
