const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { uniquePath, sizeLabel, timeLeft, row, summary } = require('../src/downloads')

test('numbers a download whose name is taken', () => {
  const taken = new Set([path.join('/d', 'a.pdf'), path.join('/d', 'a (1).pdf')])
  assert.equal(uniquePath('/d', 'b.pdf', (p) => taken.has(p)), path.join('/d', 'b.pdf'))
  assert.equal(uniquePath('/d', 'a.pdf', (p) => taken.has(p)), path.join('/d', 'a (2).pdf'))
  assert.equal(uniquePath('/d', '', () => false), path.join('/d', 'download'))
})

test('sizes read like Finder', () => {
  assert.equal(sizeLabel(0), '0 bytes')
  assert.equal(sizeLabel(1), '1 byte')
  assert.equal(sizeLabel(999), '999 bytes')
  assert.equal(sizeLabel(1000), '1 KB')
  assert.equal(sizeLabel(1_550_000), '1.6 MB')
  assert.equal(sizeLabel(12_400_000), '12 MB')
  assert.equal(sizeLabel(240_000_000), '240 MB')
  assert.equal(sizeLabel(3_200_000_000), '3.2 GB')
})

test('time left rounds up', () => {
  assert.equal(timeLeft(0.2), '1 sec left')
  assert.equal(timeLeft(42), '42 sec left')
  assert.equal(timeLeft(61), '2 min left')
  assert.equal(timeLeft(3600), '1 hr left')
  assert.equal(timeLeft(3601), '2 hr left')
})

test('a running download shows its progress and time left', () => {
  const download = { id: 1, path: '/d/a.zip', state: 'progressing', received: 5_000_000, total: 20_000_000, speed: 1_000_000 }
  assert.deepEqual(row(download), { id: 1, name: 'a.zip', state: 'active', progress: 0.25, status: '5 MB of 20 MB · 15 sec left' })
  // Without a speed yet, or a size, there is nothing to estimate.
  assert.equal(row({ ...download, speed: 0 }).status, '5 MB of 20 MB')
  assert.deepEqual(row({ ...download, total: 0 }), { id: 1, name: 'a.zip', state: 'active', progress: null, status: '5 MB' })
  assert.equal(row({ ...download, state: 'interrupted' }).status, 'Interrupted, waiting to resume')
})

test('a finished download says how it ended', () => {
  const download = { id: 2, path: '/d/a.zip', received: 20_000_000, total: 20_000_000 }
  assert.deepEqual(row({ ...download, state: 'completed' }), { id: 2, name: 'a.zip', state: 'done', progress: null, status: '20 MB' })
  assert.equal(row({ ...download, state: 'completed', missing: true }).state, 'stopped')
  assert.equal(row({ ...download, state: 'completed', missing: true }).status, 'Moved or deleted')
  assert.equal(row({ ...download, state: 'cancelled' }).status, 'Cancelled')
  assert.equal(row({ ...download, state: 'failed' }).status, 'Failed')
})

test('the indicator sums running downloads and spins for an unknown size', () => {
  assert.deepEqual(summary([]), { count: 0, active: 0, progress: null })
  const done = { state: 'completed', received: 9, total: 9 }
  const a = { state: 'progressing', received: 10, total: 40 }
  const b = { state: 'interrupted', received: 30, total: 60 }
  assert.deepEqual(summary([done, a, b]), { count: 3, active: 2, progress: 0.4 })
  assert.deepEqual(summary([done]), { count: 1, active: 0, progress: null })
  assert.deepEqual(summary([a, { state: 'progressing', received: 5, total: 0 }]), { count: 2, active: 2, progress: null })
})
