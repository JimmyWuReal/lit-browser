const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { MAX_BYTES, isName, adopt, dataUrl, sweep } = require('../src/background')

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lit-background-'))

test('isName takes only names adopt makes', () => {
  assert.ok(isName('background-0123456789ab.png'))
  assert.ok(isName('background-0123456789ab.jpeg'))
  assert.ok(!isName('background-0123456789ab.svg'))
  assert.ok(!isName('background-0123.png'))
  assert.ok(!isName('../background-0123456789ab.png'))
  assert.ok(!isName('settings.json'))
  assert.ok(!isName(''))
  assert.ok(!isName(null))
})

test('adopt copies an image into the folder, and dataUrl reads it back', () => {
  const dir = temporary()
  const source = path.join(dir, 'Cat Photo.JPG')
  fs.writeFileSync(source, Buffer.from([1, 2, 3]))
  const folder = path.join(dir, 'profile')
  const { name, error } = adopt(folder, source)
  assert.equal(error, undefined)
  assert.ok(isName(name))
  assert.ok(name.endsWith('.jpg'))
  // A copy, so the original can go.
  fs.rmSync(source)
  assert.equal(dataUrl(folder, name), 'data:image/jpeg;base64,AQID')
})

test('adopt refuses other files, missing ones and huge ones', () => {
  const dir = temporary()
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi')
  assert.ok(adopt(dir, path.join(dir, 'notes.txt')).error)
  assert.ok(adopt(dir, path.join(dir, 'gone.png')).error)
  const huge = path.join(dir, 'huge.png')
  fs.writeFileSync(huge, '')
  fs.truncateSync(huge, MAX_BYTES + 1)
  assert.match(adopt(dir, huge).error, /20 MB/)
  assert.deepEqual(fs.readdirSync(dir).filter(isName), [])
})

test('dataUrl is null for no image, a gone one, or a name adopt never made', () => {
  const dir = temporary()
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}')
  assert.equal(dataUrl(dir, ''), null)
  assert.equal(dataUrl(dir, 'background-0123456789ab.png'), null)
  assert.equal(dataUrl(dir, 'settings.json'), null)
})

test('sweep deletes every background but the one kept, and nothing else', () => {
  const dir = temporary()
  for (const name of ['background-000000000000.png', 'background-111111111111.gif', 'settings.json']) fs.writeFileSync(path.join(dir, name), '')
  sweep(dir, 'background-111111111111.gif')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['background-111111111111.gif', 'settings.json'])
  sweep(dir, '')
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
  sweep(path.join(dir, 'missing'), '')
})
