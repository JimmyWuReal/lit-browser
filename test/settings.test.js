const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SECTIONS, clean, load, update, save } = require('../src/settings')

test('every setting has a unique key and a valid default', () => {
  const settings = SECTIONS.flatMap((section) => section.settings)
  assert.equal(new Set(settings.map((s) => s.key)).size, settings.length)
  const defaults = clean()
  for (const setting of settings) assert.equal(defaults[setting.key], setting.default)
})

test('clean keeps valid saved values and drops the rest', () => {
  assert.deepEqual(clean({ searchEngine: 'bing', removed: true }), { searchEngine: 'bing' })
  assert.deepEqual(clean({ searchEngine: 'altavista' }), { searchEngine: 'google' })
})

test('update ignores unknown keys and invalid values', () => {
  const values = clean()
  assert.equal(update(values, 'searchEngine', 'duckduckgo').searchEngine, 'duckduckgo')
  assert.equal(update(values, 'searchEngine', 'nope'), values)
  assert.equal(update(values, 'nope', 'bing'), values)
})

test('save and load round-trip, and a bad file loads defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-settings-'))
  const file = path.join(dir, 'nested', 'settings.json')
  assert.deepEqual(load(file), clean())
  save(file, { searchEngine: 'bing' })
  assert.deepEqual(load(file), { searchEngine: 'bing' })
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json'])
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(load(file), clean())
  fs.rmSync(dir, { recursive: true })
})
