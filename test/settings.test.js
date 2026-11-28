const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SECTIONS, SETTINGS, isProfile, combine, ownOf, clean, load, update, save } = require('../src/settings')

const defaults = clean()

test('sections and settings have unique ids and keys', () => {
  assert.equal(new Set(SECTIONS.map((s) => s.id)).size, SECTIONS.length)
  assert.equal(new Set(SETTINGS.map((s) => s.key)).size, SETTINGS.length)
})

test('each heading in a section covers one run of its settings', () => {
  for (const { id, settings } of SECTIONS) {
    const headings = settings.map(({ group }) => group).filter((group, i, all) => group !== all[i - 1])
    assert.equal(new Set(headings).size, headings.length, id)
  }
})

test('each list has words to find it by', () => {
  for (const { id, list, listWords } of SECTIONS) assert.equal(Boolean(list), Boolean(listWords), id)
})

test('every default is valid, so clean keeps them all', () => {
  for (const setting of SETTINGS) assert.equal(defaults[setting.key], setting.default, setting.key)
})

test('clean keeps valid saved values and drops the rest', () => {
  const values = clean({ searchEngine: 'bing', doNotTrack: 'yes', 'shortcuts.reload': 'Alt+CmdOrCtrl+R', removed: true })
  assert.equal(values.searchEngine, 'bing')
  assert.equal(values.doNotTrack, false)
  assert.equal(values['shortcuts.reload'], 'Alt+CmdOrCtrl+R')
  assert.equal('removed' in values, false)
})

test('clean gives a clashing shortcut to the saved command, else the earlier one', () => {
  const values = clean({ 'shortcuts.newTab': 'CmdOrCtrl+R' })
  assert.equal(values['shortcuts.newTab'], 'CmdOrCtrl+R')
  assert.equal(values['shortcuts.reload'], '')
  // A saved shortcut keeps its keys when a command declared before it
  // (here Zoom In and Reset Zoom, added later) has them as its default.
  const kept = clean({ 'shortcuts.nextTab': 'CmdOrCtrl+=', 'shortcuts.settings': 'CmdOrCtrl+0' })
  assert.equal(kept['shortcuts.nextTab'], 'CmdOrCtrl+=')
  assert.equal(kept['shortcuts.settings'], 'CmdOrCtrl+0')
  assert.equal(kept['shortcuts.zoomIn'], '')
  assert.equal(kept['shortcuts.resetZoom'], '')
  // Two saved commands on one shortcut: the earlier keeps it.
  const both = clean({ 'shortcuts.newTab': 'CmdOrCtrl+R', 'shortcuts.reload': 'CmdOrCtrl+R' })
  assert.equal(both['shortcuts.newTab'], 'CmdOrCtrl+R')
  assert.equal(both['shortcuts.reload'], '')
})

test('clean gives a saved shortcut precedence over a new default', () => {
  // Saved before Find existed: Developer Tools on ⌘F, now Find's default.
  const values = clean({ 'shortcuts.devTools': 'CmdOrCtrl+F' })
  assert.equal(values['shortcuts.devTools'], 'CmdOrCtrl+F')
  assert.equal(values['shortcuts.find'], '')
})

test('clean keeps a chosen shortcut over a newer default', () => {
  const values = clean({ 'shortcuts.reload': 'Shift+CmdOrCtrl+T' })
  assert.equal(values['shortcuts.reload'], 'Shift+CmdOrCtrl+T')
  assert.equal(values['shortcuts.reopenTab'], '')
})

test('clean moves a former default to the new one, keeping a chosen shortcut', () => {
  assert.equal(clean({ 'shortcuts.tabSidebar': 'Shift+CmdOrCtrl+L' })['shortcuts.tabSidebar'], 'CmdOrCtrl+B')
  assert.equal(clean({ 'shortcuts.tabSidebar': 'Alt+CmdOrCtrl+B' })['shortcuts.tabSidebar'], 'Alt+CmdOrCtrl+B')
  // Someone who put another command on ⌘B keeps it, and the sidebar gets none.
  const taken = clean({ 'shortcuts.tabSidebar': 'Shift+CmdOrCtrl+L', 'shortcuts.history': 'CmdOrCtrl+B' })
  assert.equal(taken['shortcuts.history'], 'CmdOrCtrl+B')
  assert.equal(taken['shortcuts.tabSidebar'], '')
})

test('update checks each type', () => {
  assert.equal(update(defaults, 'searchEngine', 'duckduckgo').values.searchEngine, 'duckduckgo')
  assert.ok(update(defaults, 'searchEngine', 'nope').error)
  assert.equal(update(defaults, 'doNotTrack', true).values.doNotTrack, true)
  assert.ok(update(defaults, 'doNotTrack', 1).error)
  assert.equal(update(defaults, 'newTabPage', '  example.com ').values.newTabPage, 'example.com')
  assert.ok(update(defaults, 'newTabPage', 'x'.repeat(3000)).error)
  assert.ok(update(defaults, 'nope', 'bing').error)
  assert.equal(update(defaults, 'defaultZoom', 1.25).values.defaultZoom, 1.25)
  assert.ok(update(defaults, 'defaultZoom', 1.23).error)
})

test('update refuses shortcuts that are taken or reserved, and allows none', () => {
  assert.equal(update(defaults, 'shortcuts.reload', 'Shift+CmdOrCtrl+R').values['shortcuts.reload'], 'Shift+CmdOrCtrl+R')
  assert.equal(update(defaults, 'shortcuts.reload', 'CmdOrCtrl+T').error, '⌘T is used by New Tab.')
  assert.equal(update(defaults, 'shortcuts.reload', 'CmdOrCtrl+Q').error, '⌘Q is used by Quit Lit.')
  assert.equal(update(defaults, 'shortcuts.reload', 'R').error, 'Add ⌘, ⌃ or ⌥ to the key.')
  assert.equal(update(defaults, 'shortcuts.reload', '').values['shortcuts.reload'], '')
  // A command can keep its own shortcut.
  assert.equal(update(defaults, 'shortcuts.reload', 'CmdOrCtrl+R').error, undefined)
})

test('save and load round-trip, and a bad file loads defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-settings-'))
  const file = path.join(dir, 'nested', 'settings.json')
  assert.deepEqual(load(file), defaults)
  const values = { ...defaults, searchEngine: 'bing' }
  save(file, values)
  assert.deepEqual(load(file), values)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(load(file), defaults)
  fs.rmSync(dir, { recursive: true })
})

test('a profile has its own search engine, and every profile the same shortcuts', () => {
  assert.ok(['searchEngine', 'newTabPage', 'downloadLocation', 'saveHistory', 'blockAds'].every(isProfile))
  assert.ok(['shortcuts.newTab', 'quickSearch', 'restoreSession', 'nope'].every((key) => !isProfile(key)))
  const own = { ...defaults, searchEngine: 'bing', 'shortcuts.reload': 'F5' }
  const shared = { ...defaults, searchEngine: 'duckduckgo', 'shortcuts.reload': 'F6' }
  const values = combine(own, shared)
  assert.equal(values.searchEngine, 'bing')
  assert.equal(values['shortcuts.reload'], 'F6')
  assert.deepEqual(Object.keys(values), Object.keys(defaults))
  // A profile's file holds only its own, which load back the same.
  assert.equal(ownOf(values).searchEngine, 'bing')
  assert.ok(Object.keys(ownOf(values)).every(isProfile))
  assert.deepEqual(combine(clean(ownOf(values)), shared), values)
})
