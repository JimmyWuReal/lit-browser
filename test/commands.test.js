const test = require('node:test')
const assert = require('node:assert/strict')
const { menuCommands, tabCommands, settingCommands, allCommands, shown, match } = require('../src/commands')
const { SECTIONS, clean } = require('../src/settings')

const MENU = [
  { label: 'Lit', submenu: [{ role: 'about', label: 'About Lit' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,' }, { role: 'quit', label: 'Quit Lit' }] },
  {
    label: 'File',
    submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T' },
      { type: 'separator' },
      { label: 'Duplicate Tab' },
      { label: 'Hidden', visible: false, accelerator: 'CmdOrCtrl+1' },
      { label: 'Reopen Closed Tab', enabled: false },
    ],
  },
  { label: 'Edit', submenu: [{ label: 'Find', submenu: [{ label: 'Find…', accelerator: 'CmdOrCtrl+F' }] }, { label: 'Speech', submenu: [{ role: 'startSpeaking', label: 'Start Speaking' }] }] },
  { label: 'View', submenu: [{ id: 'commandPalette', label: 'Command Palette…', accelerator: 'Shift+CmdOrCtrl+P' }] },
  { label: 'Bookmarks', submenu: [{ label: 'Show Bookmark Bar', type: 'checkbox', checked: true, accelerator: 'Shift+CmdOrCtrl+B' }] },
  { label: 'Profiles', submenu: [{ label: 'Me', type: 'radio', checked: true }, { label: 'Work', type: 'radio', checked: false }] },
  // A menu with a role still lists its own items.
  { label: 'Window', role: 'window', submenu: [{ role: 'minimize', label: 'Minimize' }, { label: 'Show Previous Tab', accelerator: 'Ctrl+Shift+Tab' }] },
]

test('menuCommands lists enabled, visible menu commands with their group and keys', () => {
  const commands = menuCommands(MENU, { skip: 'commandPalette' })
  assert.deepEqual(commands.map(shown), [
    { id: 'menu:Lit/Settings…', label: 'Settings…', group: 'Lit', keys: '⌘,', detail: undefined, state: undefined, words: undefined },
    { id: 'menu:File/New Tab', label: 'New Tab', group: 'File', keys: '⌘T', detail: undefined, state: undefined, words: undefined },
    { id: 'menu:File/Duplicate Tab', label: 'Duplicate Tab', group: 'File', keys: undefined, detail: undefined, state: undefined, words: undefined },
    { id: 'menu:Edit/Find/Find…', label: 'Find…', group: 'Edit', keys: '⌘F', detail: undefined, state: undefined, words: undefined },
    { id: 'menu:Bookmarks/Show Bookmark Bar', label: 'Show Bookmark Bar', group: 'Bookmarks', keys: '⇧⌘B', detail: undefined, state: 'On', words: undefined },
    { id: 'menu:Profiles/Me', label: 'Me', group: 'Profiles', keys: undefined, detail: undefined, state: 'Current', words: undefined },
    { id: 'menu:Profiles/Work', label: 'Work', group: 'Profiles', keys: undefined, detail: undefined, state: undefined, words: undefined },
    { id: 'menu:Window/Show Previous Tab', label: 'Show Previous Tab', group: 'Window', keys: '⌃⇧⇥', detail: undefined, state: undefined, words: undefined },
  ])
  // Main runs the menu item itself.
  assert.equal(commands[1].item, MENU[1].submenu[0])
})

test('menuCommands reads Electron menus, whose submenus are Menus', () => {
  const commands = menuCommands([{ label: 'File', submenu: { items: [{ label: 'New Tab' }] } }])
  assert.deepEqual(commands.map((command) => command.id), ['menu:File/New Tab'])
})

test('tabCommands names each tab by its title, or address, or as a new tab', () => {
  assert.deepEqual(tabCommands([
    { id: 2, title: 'Example', url: 'https://www.example.com/a' },
    { id: 3, title: '', url: 'https://example.org/' },
    { id: 4, title: '', url: '' },
  ]).map(shown), [
    { id: 'tab:2', label: 'Example', group: 'Tab', keys: undefined, detail: 'example.com/a', state: undefined, words: undefined },
    { id: 'tab:3', label: 'https://example.org/', group: 'Tab', keys: undefined, detail: undefined, state: undefined, words: undefined },
    { id: 'tab:4', label: 'New Tab', group: 'Tab', keys: undefined, detail: undefined, state: undefined, words: undefined },
  ])
})

test('settingCommands flips toggles and picks choice options, but not text or shortcuts', () => {
  const values = clean()
  const commands = settingCommands(SECTIONS, values)
  const suggestions = commands.find((command) => command.id === 'setting:addressSuggestions')
  assert.equal(suggestions.label, 'Suggest pages as you type')
  assert.equal(suggestions.state, 'On')
  assert.equal(suggestions.value, false)
  const bing = commands.find((command) => command.id === 'setting:searchEngine=bing')
  assert.equal(bing.label, 'Search engine: Bing')
  assert.equal(bing.state, undefined)
  assert.equal(bing.value, 'bing')
  assert.equal(commands.find((command) => command.id === 'setting:searchEngine=google').state, 'Current')
  assert.ok(!commands.some((command) => command.key === 'newTabPage' || command.key.startsWith('shortcuts.')))
  assert.equal(settingCommands(SECTIONS, { ...values, addressSuggestions: false }).find((command) => command.id === 'setting:addressSuggestions').state, 'Off')
})

test('allCommands leaves out a setting the menu already has', () => {
  const menu = menuCommands(MENU)
  const all = allCommands({ menu, tabs: [], settings: settingCommands(SECTIONS, clean()) })
  assert.equal(all.filter((command) => command.label.toLowerCase() === 'show bookmark bar').length, 1)
  assert.equal(all[0].id, 'menu:Lit/Settings…')
})

test('match finds every word, best matches first', () => {
  const all = allCommands({ menu: menuCommands(MENU), tabs: tabCommands([{ id: 9, title: 'New York Times', url: 'https://nytimes.com/' }]), settings: settingCommands(SECTIONS, clean()) })
  const ids = (text) => match(all, text).map((command) => command.id)
  assert.equal(match(all, '  ').length, all.length)
  // Labels starting with the text first, then labels with words starting so.
  assert.deepEqual(ids('new t').slice(0, 3), ['menu:File/New Tab', 'setting:newTabPosition=end', 'setting:newTabPosition=next'])
  assert.ok(ids('new t').includes('tab:9'))
  assert.equal(ids('prev tab')[0], 'menu:Window/Show Previous Tab')
  // A longer form of a word in the label still finds it.
  assert.equal(ids('suggestions')[0], 'setting:addressSuggestions')
  assert.equal(ids('toggle suggestions')[0], 'setting:addressSuggestions')
  assert.ok(ids('turn off ads').includes('setting:blockAds'))
  assert.ok(ids('tabs').includes('menu:File/Duplicate Tab'))
  // The group, the section and the description find commands too.
  assert.ok(ids('privacy').includes('setting:blockAds'))
  assert.ok(ids('bing').includes('setting:searchEngine=bing'))
  assert.deepEqual(ids('nothing like this'), [])
})
