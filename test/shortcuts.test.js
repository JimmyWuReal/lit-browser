const test = require('node:test')
const assert = require('node:assert/strict')
const { fromInput, problem, label } = require('../src/shortcuts')

const press = (code, held = {}) => fromInput({ code, key: '', control: false, alt: false, shift: false, meta: false, ...held })

test('turns key presses into canonical accelerators', () => {
  assert.equal(press('KeyT', { meta: true }), 'CmdOrCtrl+T')
  assert.equal(press('BracketRight', { meta: true, shift: true }), 'Shift+CmdOrCtrl+]')
  assert.equal(press('Tab', { control: true, shift: true }), 'Ctrl+Shift+Tab')
  assert.equal(press('Digit5', { alt: true }), 'Alt+5')
  assert.equal(press('F5'), 'F5')
})

test('records the typed letter, not its position, on other layouts', () => {
  // AZERTY: the key marked A sits where US has Q.
  assert.equal(fromInput({ code: 'KeyQ', key: 'a', meta: true }), 'CmdOrCtrl+A')
  assert.equal(fromInput({ code: 'KeyQ', key: 'A', meta: true, shift: true }), 'Shift+CmdOrCtrl+A')
  // ⇧ changes punctuation, so the position names the key.
  assert.equal(fromInput({ code: 'BracketRight', key: '}', meta: true, shift: true }), 'Shift+CmdOrCtrl+]')
  // ⌥ changes letters on macOS (⌥O types ø).
  assert.equal(fromInput({ code: 'KeyO', key: 'ø', meta: true, alt: true }), 'Alt+CmdOrCtrl+O')
})

test('ignores presses of modifiers alone', () => {
  assert.equal(press('MetaLeft', { meta: true }), null)
  assert.equal(press('ShiftRight', { shift: true }), null)
})

test('accepts shortcuts with ⌘, ⌃ or ⌥, and F-keys alone', () => {
  assert.equal(problem('CmdOrCtrl+T'), null)
  assert.equal(problem('F5'), null)
  assert.equal(problem('Shift+T'), 'Add ⌘, ⌃ or ⌥ to the key.')
  assert.equal(problem('CmdOrCtrl+1'), '⌘1 is used by Select Tab 1.')
})

test('rejects anything not canonical', () => {
  assert.equal(problem('CmdOrCtrl+Shift+W'), 'Not a shortcut.')
  assert.equal(problem('CmdOrCtrl+Nope'), 'Not a shortcut.')
  assert.equal(problem(42), 'Not a shortcut.')
})

test('labels shortcuts the way macOS menus do', () => {
  assert.equal(label('Shift+CmdOrCtrl+W'), '⇧⌘W')
  assert.equal(label('Ctrl+Tab'), '⌃⇥')
  assert.equal(label('Alt+CmdOrCtrl+I'), '⌥⌘I')
})
