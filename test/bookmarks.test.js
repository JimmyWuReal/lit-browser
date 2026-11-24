const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b = require('../src/bookmarks')

const item = (id) => ({ id, title: id, url: `https://${id}.com/`, icon: '' })
const list = [item('a'), { id: 'f', title: 'Folder', items: [item('b'), item('c')] }, item('d')]
// 'a f(b c) d'
const order = (items) => items.map((each) => (each.items ? `${each.id}(${order(each.items)})` : each.id)).join(' ')

test('address keeps web and file addresses as pages report them, and refuses the rest', () => {
  assert.equal(b.address('example.com'), 'https://example.com/')
  assert.equal(b.address(' https://Example.com/a '), 'https://example.com/a')
  assert.equal(b.address('localhost:3000'), 'http://localhost:3000/')
  assert.equal(b.address('file:///tmp/a.html'), 'file:///tmp/a.html')
  for (const bad of ['', 'two words', 'word', 'javascript:alert(1)', 'data:text/html,hi', 'https://', null, 5]) assert.equal(b.address(bad), null, String(bad))
})

test('pages and folders are found, folders included', () => {
  assert.deepEqual(b.pages(list).map((each) => each.id), ['a', 'b', 'c', 'd'])
  assert.equal(b.get(list, 'f').title, 'Folder')
  assert.equal(b.get(list, 'c').title, 'c')
  assert.equal(b.folderOf(list, 'c'), 'f')
  assert.equal(b.folderOf(list, 'a'), null)
})

test('update and remove reach into folders', () => {
  assert.equal(b.get(b.update(list, 'c', { title: 'C' }), 'c').title, 'C')
  assert.equal(order(b.remove(list, 'b')), 'a f(c) d')
  assert.equal(order(b.remove(list, 'f')), 'a d')
})

test('move places an item before another, last, in a folder or out of it', () => {
  assert.equal(order(b.move(list, 'd', null, 'a')), 'd a f(b c)')
  assert.equal(order(b.move(list, 'a')), 'f(b c) d a')
  assert.equal(order(b.move(list, 'a', 'f')), 'f(b c a) d')
  assert.equal(order(b.move(list, 'c', 'f', 'b')), 'a f(c b) d')
  assert.equal(order(b.move(list, 'b', null, 'f')), 'a b f(c) d')
})

test('move changes nothing when there is nowhere to go', () => {
  for (const args of [['f', 'f'], ['a', 'gone'], ['gone'], ['a', null, 'a'], ['a', 'd']]) assert.equal(b.move(list, ...args), list)
})

test('clean drops broken items and nested folders, and fixes ids', () => {
  const cleaned = b.clean([
    item('a'), item('a'), null, { title: 'no url' }, { url: 'javascript:1' },
    { ...item('i'), icon: 'https://tracker.example/i.png' },
    { title: 'F', items: [item('b'), { title: 'nested', items: [] }] },
  ])
  assert.equal(cleaned.length, 4)
  assert.notEqual(cleaned[1].id, 'a')
  assert.equal(cleaned[2].icon, '')
  assert.deepEqual(cleaned[3].items.map((each) => each.id), ['b'])
})

test('save and load round-trip, and an unreadable file is kept aside', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lit-')), 'bookmarks.json')
  assert.deepEqual(b.load(file), [])
  b.save(file, list)
  assert.deepEqual(b.load(file), list)
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(b.load(file), [])
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{ not json')
})
