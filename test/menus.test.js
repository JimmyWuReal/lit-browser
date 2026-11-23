const test = require('node:test')
const assert = require('node:assert/strict')
const { pageMenu, tabMenu } = require('../src/menus')

const labels = (items) => items.map((item) => item.label || '—')
const commands = (items) => items.filter((item) => item.command).map((item) => item.command)

test('a right-click on nothing offers back, forward, reload and inspect', () => {
  const items = pageMenu({}, { canGoBack: true, keys: { reload: 'CmdOrCtrl+R' } })
  assert.deepEqual(labels(items), ['Back', 'Forward', 'Reload', '—', 'Inspect Element'])
  assert.equal(items[0].enabled, true)
  assert.equal(items[1].enabled, false)
  assert.equal(items[2].accelerator, 'CmdOrCtrl+R')
})

test('a web link can be opened, saved and copied', () => {
  const items = pageMenu({ linkURL: 'https://example.com/' })
  assert.deepEqual(labels(items), ['Open Link in New Tab', 'Save Link As…', 'Copy Link Address', '—', 'Inspect Element'])
  assert.ok(items.slice(0, 3).every((item) => item.arg === 'https://example.com/'))
})

test('selected link text can still be copied and searched', () => {
  const items = pageMenu({ linkURL: 'https://example.com/', linkText: 'Example', selectionText: 'Example' })
  assert.deepEqual(commands(items), ['openInNewTab', 'download', 'copyText', 'copy', 'search', 'inspect'])
})

test('other links can only be copied', () => {
  for (const linkURL of ['javascript:void(0)', 'mailto:a@b.c', 'file:///etc/passwd']) {
    assert.deepEqual(labels(pageMenu({ linkURL })), ['Copy Link Address', '—', 'Inspect Element'])
  }
})

test('save labels follow the Downloads setting', () => {
  const items = pageMenu({ linkURL: 'https://example.com/a.zip' }, { askWhereToSave: false })
  assert.equal(items[1].label, 'Download Linked File')
})

test('an image inside a link gets both groups', () => {
  const items = pageMenu({ linkURL: 'https://example.com/', mediaType: 'image', srcURL: 'https://example.com/a.png', hasImageContents: true })
  assert.deepEqual(labels(items), [
    'Open Link in New Tab', 'Save Link As…', 'Copy Link Address', '—',
    'Open Image in New Tab', 'Save Image As…', 'Copy Image', 'Copy Image Address', '—',
    'Inspect Element',
  ])
})

test('only web media opens in a new tab, and images copy by their pixels', () => {
  assert.deepEqual(labels(pageMenu({ mediaType: 'image', srcURL: 'data:image/png;base64,AA', hasImageContents: true })),
    ['Save Image As…', 'Copy Image', 'Copy Image Address', '—', 'Inspect Element'])
  assert.deepEqual(labels(pageMenu({ mediaType: 'video', srcURL: 'blob:https://a.b/1', mediaFlags: { canSave: true } })),
    ['Save Video As…', 'Copy Video Address', '—', 'Inspect Element'])
  assert.deepEqual(labels(pageMenu({ mediaType: 'video' })), ['Back', 'Forward', 'Reload', '—', 'Inspect Element'])
  assert.deepEqual(labels(pageMenu({ mediaType: 'image', srcURL: 'https://example.com/broken.png' })).slice(0, 3),
    ['Open Image in New Tab', 'Save Image As…', 'Copy Image Address'])
  assert.deepEqual(labels(pageMenu({ mediaType: 'video', srcURL: 'https://example.com/a.mp4', mediaFlags: { canSave: true } })).slice(0, 3),
    ['Open Video in New Tab', 'Save Video As…', 'Copy Video Address'])
})

test('file: media cannot be saved or opened', () => {
  assert.deepEqual(labels(pageMenu({ mediaType: 'image', srcURL: 'file:///etc/a.png' })), ['Copy Image Address', '—', 'Inspect Element'])
})

test('streams cannot be saved, and iframe images cannot be copied', () => {
  assert.deepEqual(labels(pageMenu({ mediaType: 'video', srcURL: 'blob:https://a.b/stream', mediaFlags: { canSave: false } })),
    ['Copy Video Address', '—', 'Inspect Element'])
  const image = { mediaType: 'image', srcURL: 'https://a.b/c.png', hasImageContents: true }
  assert.ok(commands(pageMenu(image)).includes('copyImage'))
  assert.ok(!commands(pageMenu(image, { inSubframe: true })).includes('copyImage'))
})

test('selected text can be copied and searched with the chosen engine', () => {
  const items = pageMenu({ selectionText: '  hello\n  world  ' }, { engineName: 'DuckDuckGo' })
  assert.deepEqual(labels(items), ['Copy', '—', 'Search DuckDuckGo for “hello world”', '—', 'Inspect Element'])
  assert.equal(items[2].arg, 'hello\n  world')
})

test('long selections are cut short in the search label only', () => {
  const text = 'a'.repeat(50)
  const search = pageMenu({ selectionText: text }).find((item) => item.command === 'search')
  assert.equal(search.label, `Search Google for “${'a'.repeat(29)}…”`)
  assert.equal(search.arg, text)
})

test('text fields get editing items enabled by their flags', () => {
  const items = pageMenu({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } })
  assert.deepEqual(labels(items), ['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', 'Select All', '—', 'Inspect Element'])
  assert.deepEqual(items.filter((item) => item.enabled === false).map((item) => item.label), ['Undo', 'Redo', 'Cut', 'Copy'])
})

test('a misspelled word offers its suggestions first', () => {
  const items = pageMenu({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] })
  assert.deepEqual(labels(items).slice(0, 4), ['the', 'tech', 'Add to Dictionary', '—'])
  assert.deepEqual(items.slice(0, 3).map((item) => item.arg), ['the', 'tech', 'teh'])
  const none = pageMenu({ isEditable: true, misspelledWord: 'qzx' })
  assert.deepEqual(labels(none).slice(0, 2), ['No Guesses Found', 'Add to Dictionary'])
  assert.equal(none[0].enabled, false)
})

test("Lit's own fields get only editing items, and nothing elsewhere", () => {
  assert.deepEqual(commands(pageMenu({ isEditable: true, selectionText: 'x', linkURL: 'https://a.b/' }, { isPage: false })),
    ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  assert.deepEqual(labels(pageMenu({ selectionText: 'x' }, { isPage: false })), ['Copy'])
  assert.deepEqual(pageMenu({}, { isPage: false }), [])
})

test('tab menu enables what fits the tab', () => {
  const only = tabMenu({ index: 0, count: 1, started: false })
  assert.deepEqual(labels(only), ['Reload', 'Duplicate', '—', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right'])
  assert.deepEqual(only.filter((item) => item.enabled === false).map((item) => item.label), ['Reload', 'Close Other Tabs', 'Close Tabs to the Right'])
  const middle = tabMenu({ index: 1, count: 3, started: true })
  assert.ok(middle.every((item) => item.enabled !== false))
  assert.equal(tabMenu({ index: 2, count: 3, started: true }).at(-1).enabled, false)
  const keys = { reload: 'R', duplicateTab: 'D', closeTab: 'W', closeOtherTabs: 'O', closeTabsToRight: 'T' }
  assert.deepEqual(tabMenu({ index: 0, count: 1, started: true, keys }).map((item) => item.accelerator), ['R', 'D', undefined, 'W', 'O', 'T'])
})
