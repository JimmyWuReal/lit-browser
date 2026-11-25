const test = require('node:test')
const assert = require('node:assert/strict')
const { sourceRows, tabStreams, sourceStreams } = require('../src/share')

const image = (url) => ({ isEmpty: () => !url, toDataURL: () => url })

test('sources are split into windows and screens, with their pictures', () => {
  assert.deepEqual(sourceRows([
    { id: 'screen:1:0', name: 'Screen 1', thumbnail: image('data:a'), appIcon: null },
    { id: 'window:2:0', name: 'Notes', thumbnail: image('data:b'), appIcon: image('data:c') },
    { id: 'window:3:0', name: 'Hidden', thumbnail: image(''), appIcon: image('') },
  ]), {
    screens: [{ id: 'screen:1:0', name: 'Screen 1', thumbnail: 'data:a', icon: null }],
    windows: [
      { id: 'window:2:0', name: 'Notes', thumbnail: 'data:b', icon: 'data:c' },
      { id: 'window:3:0', name: 'Hidden', thumbnail: null, icon: null },
    ],
  })
})

test('windows without a title are left out', () => {
  assert.deepEqual(sourceRows([{ id: 'window:2:0', name: ' ', thumbnail: image('data:b') }]), { windows: [], screens: [] })
})

test('a tab is shared with its sound only when asked, and still heard here', () => {
  const frame = {}
  assert.deepEqual(tabStreams(frame, false), { video: frame })
  assert.deepEqual(tabStreams(frame, true), { video: frame, audio: frame, enableLocalEcho: true })
})

test('a window or screen is shared by id and name, without its picture', () => {
  assert.deepEqual(sourceStreams({ id: 'screen:1:0', name: 'Screen 1', thumbnail: 'data:a' }), { video: { id: 'screen:1:0', name: 'Screen 1' } })
})
