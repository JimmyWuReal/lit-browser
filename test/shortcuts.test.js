const test = require('node:test')
const assert = require('node:assert/strict')
const { fromInput, problem, label } = require('../src/shortcuts')

const press = (code, held = {}) => fromInput({ code, control: false, alt: false, shift: false, meta: false, ...held })

test('turns key presses into canonical accelerators', () => {
  assert.equal(press('KeyT', { meta: true }), 'CmdOrCtrl+T')
  assert.equal(press('BracketRight', { meta: true, shift: true }), 'Shift+CmdOrCtrl+]')
  assert.equal(press('Tab', { control: true, shift: true }), 'Ctrl+Shift+Tab')
  assert.equal(press('Digit5', { alt: true }), 'Alt+5')
  assert.equal(press('F5'), 'F5')
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
