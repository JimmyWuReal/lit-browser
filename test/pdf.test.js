const test = require('node:test')
const assert = require('node:assert/strict')
const { VIEWER, viewerOf, zoomScript } = require('../src/pdf')

test('zoom in, out and reset each call the viewer', () => {
  assert.match(zoomScript(1), /\.zoomIn\(\)$/)
  assert.match(zoomScript(-1), /\.zoomOut\(\)$/)
  assert.match(zoomScript(0), /\.fitToWidth\(\)$/)
})

test('a zoom script does nothing where there is no viewer', () => {
  const document = { querySelector: () => null }
  assert.equal(new Function('document', `return ${zoomScript(1)}`)(document), undefined)
})

test('the viewer is the frame of the PDF extension', () => {
  const viewer = { origin: VIEWER }
  assert.equal(viewerOf({ mainFrame: { frames: [{ origin: 'https://example.com' }, viewer] } }), viewer)
  assert.equal(viewerOf({ mainFrame: { frames: [{ origin: 'https://example.com' }] } }), undefined)
})
