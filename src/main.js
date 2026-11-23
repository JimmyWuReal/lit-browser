// Lit's main process. Each window has a toolbar on top (src/index.html,
// the window's own page) and one Chromium WebContentsView per tab below it.
// Only the active tab's view is visible. The Settings popup is one more
// view, transparent and over everything, shown only while open. Find in
// page lives in the toolbar; each tab keeps its own search (src/find.js).
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { toUrl } = require('./url')
const { afterClose, step, byNumber } = require('./tabs')
const settingsStore = require('./settings')
const shortcuts = require('./shortcuts')
const { uniquePath } = require('./downloads')
const findState = require('./find')

// Keep in sync with .strip and .bar heights in index.html.
const STRIP_HEIGHT = 38
const BAR_HEIGHT = STRIP_HEIGHT + 44
const PRELOAD = path.join(__dirname, 'preload.js')

// The toolbar's webContents -> its window's controls, so toolbar messages
// only ever act on their own window. The same for each Settings popup.
const windowsByToolbar = new WeakMap()
const windowsBySettings = new WeakMap()
const openWindows = new Set()
let nextTabId = 1

// Settings are read once at launch and saved on every change.
let settingsFile
let settings = settingsStore.clean()

// What the Settings popup draws: the values, plus each shortcut as ⌘ symbols.
function settingsState(error) {
  const labels = {}
  for (const setting of settingsStore.SETTINGS) {
    if (setting.type === 'shortcut') labels[setting.key] = settings[setting.key] ? shortcuts.label(settings[setting.key]) : ''
  }
  return { sections: settingsStore.SECTIONS, values: settings, labels, ...(error && { error }) }
}

// Do Not Track and Global Privacy Control headers, only while turned on.
function applyDoNotTrack() {
  session.defaultSession.webRequest.onBeforeSendHeaders(settings.doNotTrack
    ? (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } })
    : null)
}

// After a change: rebuild the menu for new shortcuts, and tell every window.
function applySettings() {
  Menu.setApplicationMenu(buildMenu())
  applyDoNotTrack()
  for (const controls of openWindows) controls.settingsChanged()
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#090909',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: { preload: PRELOAD },
  })

  const tabs = []
  let activeId = null
  const find = (id) => tabs.find((tab) => tab.id === id)
  const active = () => find(activeId)
  const ids = () => tabs.map((tab) => tab.id)
  // The Settings popup's view, made on first open (see openSettings).
  let settingsView = null
  let settingsOpen = false
  let recording = false
  // Whether the toolbar had focus when Settings opened, to give it back.
  let toolbarHadFocus = false
  // The keyboard layout's code -> character map, sent by the popup.
  let keyboardLayout = {}

  // Everything the toolbar draws. Sent whenever any of it changes.
  function sync() {
    if (win.isDestroyed()) return
    const current = active()
    win.setTitle(current?.title || (current?.started ? current.url : '') || 'New Tab')
    win.webContents.send('tabs', {
      activeId,
      tabs: tabs.map(({ id, title, url, favicon, loading, started, find }) => ({
        id, title, url, favicon, loading, started,
        find: find && { text: find.text, active: find.active, matches: find.matches },
      })),
    })
  }

  // The toolbar's tooltips show the current shortcuts.
  const sendShortcuts = () => { if (!win.isDestroyed()) win.webContents.send('shortcuts', settingsState().labels) }

  function layout() {
    const { width, height } = win.getContentBounds()
    for (const tab of tabs) tab.view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: height - BAR_HEIGHT })
    settingsView?.setBounds({ x: 0, y: 0, width, height })
  }

  function focusAddress() {
    win.webContents.focus()
    win.webContents.send('focus-address')
  }

  // A blank tab shows the toolbar's centered search box; a tab that has
  // loaded something shows its page.
  // `focus` is false when the toolbar keeps focus, as when arrow keys
  // move along the tabs.
  function show(tab, focus = true) {
    for (const other of tabs) other.view.setVisible(other === tab && tab.started)
    if (!focus || settingsOpen) return
    if (tab.started) tab.page.focus()
    else focusAddress()
  }

  function activate(id, focus = true) {
    const tab = find(id)
    if (!tab) return
    activeId = id
    show(tab, focus)
    sync()
  }

  // `webContents` is passed when a page opens the tab itself, so the new
  // page keeps its link back to the opener (sign-in popups need it).
  function addTab({ url, webContents, background = false, index = tabs.length } = {}) {
    const view = new WebContentsView(webContents ? { webContents } : {})
    // `page` keeps the WebContents itself: once it is destroyed (a popup
    // calling window.close()), Electron clears `view.webContents`.
    const page = view.webContents
    const tab = { id: nextTabId++, view, page, title: '', url: '', favicon: null, loading: false, started: Boolean(url || webContents), find: null }
    tabs.splice(index, 0, tab)
    view.setVisible(false)
    win.contentView.addChildView(view)
    // Re-adding a view moves it to the top, so Settings stays over new tabs.
    if (settingsView) win.contentView.addChildView(settingsView)
    layout()

    page.on('did-start-loading', () => { tab.loading = true; tab.started = true; refresh(tab) })
    page.on('did-stop-loading', () => { tab.loading = false; sync() })
    page.on('did-navigate', (_event, url) => { tab.url = url; tab.title = ''; tab.favicon = null; tab.find = findState.reset(tab.find); sync() })
    page.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) { tab.url = url; sync() } })
    page.on('page-title-updated', (_event, title) => { tab.title = title; sync() })
    page.on('page-favicon-updated', (_event, favicons) => { tab.favicon = favicons[0] || null; sync() })
    // A new page (or a reload) gets the open search run again once it loads.
    page.on('did-finish-load', () => { if (tab.find?.text && tab.find.requestId === null) search(tab) })
    page.on('found-in-page', (_event, result) => {
      const next = findState.result(tab.find, result)
      if (next !== tab.find) { tab.find = next; sync() }
    })
    // Every tab leaves through here: after closeTab's request, or when a
    // page closes itself (window.close() on a popup it opened).
    page.on('destroyed', () => removeTab(tab))
    // Electron cancels an unload a page objects to without asking; ask the
    // way other browsers do, both for closing the tab and for leaving the page.
    page.on('will-prevent-unload', (event) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave this page?',
        detail: 'Changes you made may not be saved.',
      })
      if (choice === 0) event.preventDefault()
    })

    // Links and window.open become tabs right after the opener: Cmd-click
    // opens in the background (unless Settings says to switch to it),
    // everything else comes to the front.
    // The new tab outlives its opener, so closing the page a link came from
    // keeps the link's tab.
    page.setWindowOpenHandler(({ disposition }) => ({
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => addTab({
        webContents: options.webContents,
        background: disposition === 'background-tab' && !settings.switchToNewTabs,
        index: tabs.indexOf(tab) + 1,
      }).page,
    }))

    if (url) page.loadURL(url).catch(() => {})
    if (background) sync()
    else activate(tab.id)
    return tab
  }

  // A new tab from ⌘T or the + button, placed and filled as Settings says.
  function newTab() {
    const current = active()
    addTab({
      url: settings.newTabPage ? toUrl(settings.newTabPage, settings.searchEngine) : undefined,
      index: settings.newTabPosition === 'next' && current ? tabs.indexOf(current) + 1 : tabs.length,
    })
  }

  // A tab's first load turns it from the search box into its page.
  function refresh(tab) {
    if (tab.id === activeId && !tab.view.getVisible()) show(tab)
    sync()
  }

  // Asks the page to close, so its beforeunload can still keep it open;
  // removeTab runs once it is gone.
  function closeTab(id, focus = true) {
    const tab = find(id)
    if (!tab) return
    tab.closeFocus = focus
    if (tab.page.isDestroyed()) removeTab(tab)
    else tab.page.close({ waitForBeforeUnload: true })
  }

  function removeTab(tab) {
    if (!find(tab.id)) return
    const nextId = afterClose(ids(), activeId, tab.id)
    const focus = tab.closeFocus ?? true
    tabs.splice(tabs.indexOf(tab), 1)
    if (win.isDestroyed()) return
    win.contentView.removeChildView(tab.view)
    // Closing the last tab closes the window, as in Chrome and Safari,
    // unless Settings says to keep it open with a new tab.
    if (nextId === null) return settings.closeWindowWithLastTab ? win.close() : newTab()
    if (nextId !== activeId) activate(nextId, focus)
    else sync()
  }

  function navigate(input) {
    const tab = active()
    if (!tab || !input.trim()) return
    tab.started = true
    show(tab)
    tab.page.loadURL(toUrl(input, settings.searchEngine)).catch(() => {})
  }

  // Starts a new search for the tab's find text; results come back through
  // found-in-page.
  function search(tab) {
    if (tab.page.isDestroyed()) return
    tab.find = { ...tab.find, requestId: tab.page.findInPage(tab.find.text, { findNext: true }) }
  }

  // Find in page. ⌘F opens the active tab's find field in the toolbar (or
  // selects its text again); a tab on the search box has nothing to search.
  // Reopening brings back the tab's last search and runs it again.
  function openFind() {
    const tab = active()
    if (!tab?.started || tab.page.isDestroyed()) return
    closeSettings()
    if (!tab.find) {
      tab.find = findState.open(null, tab.lastFindText)
      if (tab.find.text) search(tab)
    }
    sync()
    win.webContents.focus()
    win.webContents.send('focus-find')
  }

  // Searches as the field changes; empty text clears the highlights.
  function findText(text) {
    const tab = active()
    if (!tab?.find || tab.page.isDestroyed()) return
    tab.find = findState.setText(tab.find, text)
    if (text) search(tab)
    else tab.page.stopFindInPage('clearSelection')
    sync()
  }

  // The next or previous match (Enter, ⇧Enter, ⌘G, ⇧⌘G). Without text yet,
  // it opens the field instead. After a navigation it starts a new search.
  function findAgain(forward) {
    const tab = active()
    if (!tab?.find?.text) return openFind()
    if (tab.page.isDestroyed()) return
    const findNext = tab.find.requestId === null
    tab.find = { ...tab.find, requestId: tab.page.findInPage(tab.find.text, { forward, findNext }) }
  }

  // Escape or the close button: the page keeps the selected match, and
  // focus goes back to the page, like other browsers.
  function closeFind() {
    const tab = active()
    if (!tab?.find) return
    tab.lastFindText = tab.find.text
    tab.find = null
    if (!tab.page.isDestroyed()) tab.page.stopFindInPage('keepSelection')
    sync()
    show(tab)
  }

  // The Settings popup (src/settings.html): made on first use, then hidden
  // and shown. While a shortcut is being recorded, key presses go to it
  // instead of the menu, so ⌘T records ⌘T rather than opening a tab.
  function openSettings() {
    if (!settingsView) {
      settingsView = new WebContentsView({ webPreferences: { preload: PRELOAD } })
      settingsView.setBackgroundColor('#00000000')
      windowsBySettings.set(settingsView.webContents, controls)
      settingsView.webContents.on('before-input-event', (event, input) => {
        if (!recording || input.type !== 'keyDown') return
        event.preventDefault()
        const plain = !input.control && !input.alt && !input.shift && !input.meta
        if (input.key === 'Escape') settingsView.webContents.send('shortcut-pressed', { cancel: true })
        else if (plain && (input.code === 'Backspace' || input.code === 'Delete')) settingsView.webContents.send('shortcut-pressed', { accelerator: '' })
        else {
          const accelerator = shortcuts.fromInput(input, keyboardLayout)
          if (accelerator) settingsView.webContents.send('shortcut-pressed', { accelerator })
        }
      })
      settingsView.webContents.loadFile(path.join(__dirname, 'settings.html'))
    }
    if (!settingsOpen) toolbarHadFocus = win.webContents.isFocused()
    settingsOpen = true
    win.contentView.addChildView(settingsView)
    layout()
    settingsView.setVisible(true)
    settingsView.webContents.focus()
    settingsView.webContents.send('settings-open', settingsState())
  }

  // The popup has no exit animation, so it just hides. Focus goes back
  // where it was: the toolbar (its settings button, or the address bar)
  // keeps its own focused element, otherwise the page gets it.
  function closeSettings() {
    if (!settingsOpen) return
    settingsOpen = false
    recording = false
    settingsView.setVisible(false)
    if (toolbarHadFocus) return win.webContents.focus()
    const tab = active()
    if (tab) show(tab)
  }

  const controls = {
    win,
    newTab,
    closeTab: (id = activeId, focus = true) => closeTab(id, focus),
    activate,
    navigate,
    focusAddress,
    step: (delta) => activate(step(ids(), activeId, delta)),
    byNumber: (number) => activate(byNumber(ids(), number)),
    // The active page, for reload, back, forward and its developer tools.
    page: () => (active()?.started && !active().page.isDestroyed() ? active().page : null),
    openSettings,
    closeSettings,
    isActive: (id) => id === activeId,
    openFind,
    findText,
    findAgain,
    closeFind,
    settingsOpen: () => settingsOpen,
    setRecording: (on, keys) => {
      recording = on
      keyboardLayout = on && keys && typeof keys === 'object' ? keys : {}
    },
    settingsChanged() {
      sendShortcuts()
      if (settingsView) settingsView.webContents.send('settings-changed', settingsState())
    },
  }
  windowsByToolbar.set(win.webContents, controls)
  openWindows.add(controls)

  win.on('resize', layout)
  // The toolbar asks for the tabs once it has loaded (and again if reloaded).
  win.webContents.on('did-finish-load', () => { sync(); sendShortcuts() })
  win.on('closed', () => {
    openWindows.delete(controls)
    for (const tab of tabs.splice(0)) {
      if (!tab.page.isDestroyed()) tab.page.close()
    }
    settingsView?.webContents.close()
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  newTab()
  return controls
}

// Menu actions go to the focused window, which Electron passes to `click`.
const controlsOf = (win) => (win && !win.isDestroyed() ? windowsByToolbar.get(win.webContents) : undefined)
const inFocused = (action) => (_item, win) => {
  const controls = controlsOf(win)
  if (controls) action(controls)
}

// The menu holds every shortcut, so they work whether the toolbar or a page
// has focus. Most come from Settings; hidden items still answer their
// shortcuts on macOS. Keep the fixed ones in RESERVED in src/shortcuts.js.
function buildMenu() {
  const key = (command) => settings[`shortcuts.${command}`] || undefined
  const hidden = (label, accelerator, click) => ({ label, accelerator, click, visible: false })
  const numbers = Array.from({ length: 9 }, (_, i) =>
    hidden(`Select Tab ${i + 1}`, `CmdOrCtrl+${i + 1}`, inFocused((c) => c.byNumber(i + 1))))
  const pageAction = (action) => inFocused((c) => { const page = c.page(); if (page) action(page) })

  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: key('settings'),
          click: (_item, win) => {
            const c = controlsOf(win) || createWindow()
            if (c.settingsOpen()) c.closeSettings()
            else c.openSettings()
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: key('newTab'), click: (_item, win) => { const c = controlsOf(win); if (c) c.newTab(); else createWindow() } },
        { label: 'New Window', accelerator: key('newWindow'), click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: key('openLocation'), click: inFocused((c) => { c.closeSettings(); c.focusAddress() }) },
        { type: 'separator' },
        // With Settings open, Close Tab closes Settings instead.
        { label: 'Close Tab', accelerator: key('closeTab'), click: inFocused((c) => (c.settingsOpen() ? c.closeSettings() : c.closeTab())) },
        { label: 'Close Window', accelerator: key('closeWindow'), click: inFocused((c) => c.win.close()) },
      ],
    },
    {
      // Electron's Edit menu, spelled out to hold Find.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          submenu: [
            { label: 'Find…', accelerator: key('find'), click: inFocused((c) => c.openFind()) },
            { label: 'Find Next', accelerator: key('findNext'), click: inFocused((c) => c.findAgain(true)) },
            { label: 'Find Previous', accelerator: key('findPrevious'), click: inFocused((c) => c.findAgain(false)) },
          ],
        },
        { type: 'separator' },
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: key('reload'), click: pageAction((page) => page.reload()) },
        { type: 'separator' },
        { label: 'Back', accelerator: key('back'), click: pageAction((page) => page.navigationHistory.goBack()) },
        { label: 'Forward', accelerator: key('forward'), click: pageAction((page) => page.navigationHistory.goForward()) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: key('devTools'), click: pageAction((page) => page.toggleDevTools()) },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Next Tab', accelerator: key('nextTab'), click: inFocused((c) => c.step(1)) },
        { label: 'Show Previous Tab', accelerator: key('previousTab'), click: inFocused((c) => c.step(-1)) },
        hidden('Show Next Tab', 'Shift+CmdOrCtrl+]', inFocused((c) => c.step(1))),
        hidden('Show Previous Tab', 'Shift+CmdOrCtrl+[', inFocused((c) => c.step(-1))),
        ...numbers,
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ])
}

// Toolbar messages, each checked against the window that sent it.
const fromToolbar = (handler) => (event, ...args) => {
  const controls = windowsByToolbar.get(event.sender)
  if (controls) handler(controls, ...args)
}
ipcMain.on('navigate', fromToolbar((c, input) => typeof input === 'string' && c.navigate(input)))
ipcMain.on('new-tab', fromToolbar((c) => c.newTab()))
ipcMain.on('close-tab', fromToolbar((c, id, focus) => c.closeTab(id, focus !== false)))
ipcMain.on('activate-tab', fromToolbar((c, id, focus) => c.activate(id, focus !== false)))
ipcMain.on('open-settings', fromToolbar((c) => c.openSettings()))
// Find messages name the tab the toolbar showed, so a tab switch the
// toolbar has not drawn yet never sends them to another tab.
ipcMain.on('find', fromToolbar((c, tabId, text) => c.isActive(tabId) && typeof text === 'string' && text.length <= findState.MAX_TEXT && c.findText(text)))
ipcMain.on('find-again', fromToolbar((c, tabId, forward) => c.isActive(tabId) && c.findAgain(forward !== false)))
ipcMain.on('close-find', fromToolbar((c, tabId) => c.isActive(tabId) && c.closeFind()))

// Settings messages, answered only for a Settings popup.
const fromSettings = (handler) => (event, ...args) => {
  const controls = windowsBySettings.get(event.sender)
  if (controls) return handler(controls, ...args)
}
ipcMain.handle('settings-get', fromSettings(() => settingsState()))
ipcMain.handle('settings-set', fromSettings((_c, key, value) => {
  const { values, error } = settingsStore.update(settings, key, value)
  if (error) return settingsState(error)
  if (values === settings) return settingsState()
  // Saved first, so a failed write leaves the old settings in use.
  try {
    settingsStore.save(settingsFile, values)
  } catch {
    return settingsState('Couldn’t save settings.')
  }
  settings = values
  applySettings()
  return settingsState()
}))
ipcMain.on('settings-record', fromSettings((c, on, keys) => c.setRecording(on === true, keys)))
ipcMain.on('settings-close', fromSettings((c) => c.closeSettings()))

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = settingsStore.load(settingsFile)
  applyDoNotTrack()
  // Saving straight to Downloads, when Settings says so; otherwise
  // Electron asks where to save. Paths of unfinished downloads count as
  // taken, so two same-name downloads never share one.
  const downloading = new Set()
  session.defaultSession.on('will-download', (_event, item) => {
    if (settings.downloadLocation !== 'downloads') return
    const file = uniquePath(app.getPath('downloads'), item.getFilename(), (candidate) => downloading.has(candidate) || fs.existsSync(candidate))
    downloading.add(file)
    item.setSavePath(file)
    item.once('done', () => downloading.delete(file))
  })
  // The packaged app gets its icon from the bundle; in development, show it in the Dock too.
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'))
  Menu.setApplicationMenu(buildMenu())
  createWindow()
  // Like other Mac browsers, Lit keeps running with no windows open;
  // clicking the Dock icon opens a fresh one. Registered after the first
  // window so a launch-time activate cannot open a second.
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
