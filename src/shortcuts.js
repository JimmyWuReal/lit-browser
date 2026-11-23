// Keyboard shortcuts as Electron accelerator strings ("Shift+CmdOrCtrl+W").
// Every accelerator Lit stores is canonical: modifiers in macOS menu order
// (⌃ ⌥ ⇧ ⌘), then one key, so two equal shortcuts are equal strings.

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl']
const MODIFIER_LABELS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', CmdOrCtrl: '⌘' }

// KeyboardEvent.code -> accelerator key, for keys that are not letters,
// digits or F-keys. Codes are US layout positions; fromInput prefers the
// typed character, as macOS menus match by character, not position.
const CODE_KEYS = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  Tab: 'Tab', Space: 'Space', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
}
const KEY_LABELS = {
  Tab: '⇥', Space: 'Space', Return: '↩', Backspace: '⌫', Delete: '⌦',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟',
}
const KEYS = new Set(Object.values(CODE_KEYS))
const isFunctionKey = (key) => /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
const isKey = (key) => /^[A-Z0-9]$/.test(key) || isFunctionKey(key) || KEYS.has(key)

// Shortcuts that menus Lit does not let people change already use.
const RESERVED = {
  'CmdOrCtrl+Q': 'Quit Lit', 'CmdOrCtrl+H': 'Hide Lit', 'Alt+CmdOrCtrl+H': 'Hide Others',
  'CmdOrCtrl+M': 'Minimize', 'Ctrl+CmdOrCtrl+F': 'Full Screen',
  'CmdOrCtrl+Z': 'Undo', 'Shift+CmdOrCtrl+Z': 'Redo', 'CmdOrCtrl+X': 'Cut', 'CmdOrCtrl+C': 'Copy',
  'CmdOrCtrl+V': 'Paste', 'Alt+Shift+CmdOrCtrl+V': 'Paste and Match Style', 'CmdOrCtrl+A': 'Select All',
  'Shift+CmdOrCtrl+]': 'Show Next Tab', 'Shift+CmdOrCtrl+[': 'Show Previous Tab',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`CmdOrCtrl+${i + 1}`, `Select Tab ${i + 1}`])),
}

// The accelerator for a key press from Electron's before-input-event, or
// null while only modifiers are held. macOS menus match keys by character,
// so the key is, in order: the typed character when it is a letter, digit
// or unshifted punctuation (on AZERTY the key marked A records ⌘A); else
// the key's own character in the active layout, from the page's
// navigator.keyboard.getLayoutMap() (⌥ and ⇧ change what is typed); else,
// for keys without a character such as Tab, its position. A character no
// accelerator can name comes back as is, and problem() refuses it.
function fromInput({ key: typed, code, control, alt, shift, meta }, layout = {}) {
  const character = typed?.length === 1 ? typed.toUpperCase() : ''
  const base = typeof layout[code] === 'string' && layout[code].length === 1 ? layout[code].toUpperCase() : ''
  let key = /^[A-Z0-9]$/.test(character) || (KEYS.has(character) && !shift) ? character : base || CODE_KEYS[code]
  if (!key) key = /^Key([A-Z])$/.exec(code)?.[1] || /^Digit(\d)$/.exec(code)?.[1]
  if (!key && isFunctionKey(code)) key = code
  if (!key) return null
  const held = { Ctrl: control, Alt: alt, Shift: shift, CmdOrCtrl: meta }
  return [...MODIFIERS.filter((modifier) => held[modifier]), key].join('+')
}

// Why `accelerator` cannot be a shortcut, or null if it can. Shortcuts need
// ⌘, ⌃ or ⌥ (F-keys excepted), so typing in pages keeps working.
function problem(accelerator) {
  if (typeof accelerator !== 'string') return 'That key can’t be used in a shortcut.'
  const parts = accelerator.split('+')
  const key = parts.pop()
  const canonical = MODIFIERS.filter((modifier) => parts.includes(modifier))
  if (!isKey(key) || canonical.join('+') !== parts.join('+')) return 'That key can’t be used in a shortcut.'
  if (!isFunctionKey(key) && !parts.some((modifier) => modifier !== 'Shift')) return 'Add ⌘, ⌃ or ⌥ to the key.'
  if (RESERVED[accelerator]) return `${label(accelerator)} is used by ${RESERVED[accelerator]}.`
  return null
}

// "Shift+CmdOrCtrl+W" -> "⇧⌘W", as macOS menus show it.
function label(accelerator) {
  const parts = accelerator.split('+')
  const key = parts.pop()
  return parts.map((modifier) => MODIFIER_LABELS[modifier] || modifier).join('') + (KEY_LABELS[key] || key)
}

module.exports = { fromInput, problem, label }
