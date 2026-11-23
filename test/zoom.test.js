const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LEVELS, step, siteOf, percent, load, save } = require('../src/zoom')

test('step moves one zoom level and stops at the ends', () => {
  assert.equal(step(1, 1), 1.1)
  assert.equal(step(1, -1), 0.9)
  assert.equal(step(LEVELS.at(-1), 1), LEVELS.at(-1))
  assert.equal(step(LEVELS[0], -1), LEVELS[0])
  // Off-step factors, and Chromium's inexact read-backs, land on a step.
  assert.equal(step(1.2, 1), 1.25)
  assert.equal(step(1.2, -1), 1.1)
  assert.equal(step(1.0999999, 1), 1.25)
})

test('a site is its host name, shared by http, https and every port', () => {
  assert.equal(siteOf('https://example.com/a?b'), 'example.com')
  assert.equal(siteOf('http://example.com/'), 'example.com')
  assert.equal(siteOf('http://localhost:3000/'), 'localhost')
  assert.equal(siteOf('file:///Users/me/a.html'), 'file:')
  assert.equal(siteOf('not a url'), null)
})

test('percent rounds to whole percents', () => {
  assert.equal(percent(1), '100%')
  assert.equal(percent(0.33), '33%')
  assert.equal(percent(1.25), '125%')
})

test('save and load round-trip, keeping only valid zooms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-zoom-'))
  const file = path.join(dir, 'nested', 'zoom.json')
  assert.deepEqual(load(file), new Map())
  const sites = new Map([['example.com', 1.25], ['__proto__', 0.9]])
  save(file, sites)
  assert.deepEqual(load(file), sites)
  fs.writeFileSync(file, JSON.stringify({ 'a.com': 1.5, 'b.com': 1.23, 'c.com': '2', 'd.com': 9 }))
  assert.deepEqual(load(file), new Map([['a.com', 1.5]]))
  fs.writeFileSync(file, '[1]')
  assert.deepEqual(load(file), new Map())
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(load(file), new Map())
  fs.rmSync(dir, { recursive: true })
})
