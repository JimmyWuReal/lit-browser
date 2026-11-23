// Lit's main process. Each window has a toolbar on top (src/index.html,
// the window's own page) and one Chromium WebContentsView per tab below it.
// Only the active tab's view is visible. The Settings and History popups
// are each one more view, transparent and over everything, shown only
// while open.
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { toUrl } = require('./url')
const { afterClose, step, byNumber, remember, reopenIndex } = require('./tabs')
const settingsStore = require('./settings')
const historyStore = require('./history')
const shortcuts = require('./shortcuts')
const { uniquePath } = require('./downloads')

// Keep in sync with .strip and .bar heights in index.html.
const STRIP_HEIGHT = 38
const BAR_HEIGHT = STRIP_HEIGHT + 44
const PRELOAD = path.join(__dirname, 'preload.js')

// The toolbar's webContents -> its window's controls, so toolbar messages
// only ever act on their own window. Each popup's webContents ->
// { controls, name }, so a popup only gets its own messages answered.
const windowsByToolbar = new WeakMap()
const windowsByPopup = new WeakMap()
const openWindows = new Set()
let nextTabId = 1
// Names a window for Reopen Closed Tab; a reopened window keeps its key,
// so tabs closed from it earlier still find their way back to it.
let nextWindowKey = 1

// Recently closed tabs and windows, newest last, for Reopen Closed Tab.
// Only closes people make count (⌘W, the close button, closing a window),
// not a page closing itself; a blank tab has a null history and comes
// back blank. Nothing is kept while Save history is off.
// A tab: { windowKey, index, history }, back in its window if that is open.
// A window: { key, tabs: [history], activeIndex, size }, so tab order and
// the active tab come back as they were.
// A history is { entries, index } from navigationHistory, so back and
// forward come back too. Kept only while Lit runs.
const closed = []

// Settings are read once at launch and saved on every change.
let settingsFile
let settings = settingsStore.clean()

// Pages visited (src/history.js), newest first. Loaded at launch, and saved
// a moment after a visit, so a burst of navigations writes once; removing
// pages saves right away, so they can't come back after a crash.
let historyFile
let visited = []
let historySave = null

function saveVisited() {
  clearTimeout(historySave)
  historySave = null
  try {
    historyStore.save(historyFile, visited)
  } catch {}
}

function setVisited(next, { now = false } = {}) {
  if (next === visited) return
  visited = next
  if (now) saveVisited()
  else {
    clearTimeout(historySave)
    historySave = setTimeout(saveVisited, 1000)
  }
  for (const controls of openWindows) controls.historyChanged()
}

function recordVisit(url, title) {
  if (settings.saveHistory) setVisited(historyStore.visit(visited, { url, title, time: Date.now() }))
}

// What the History popup draws.
// `closedTabs` counts tabs and windows Reopen Closed Tab still has, which
// Clear History also forgets.
const historyState = () => ({ entries: visited, enabled: settings.saveHistory, closedTabs: closed.length })

function forgetClosed() {
  closed.length = 0
  refreshReopen()
}

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

// After the closed list changes: the menu item is grayed out while there
// is nothing to reopen, and an open History learns what Clear would forget.
function refreshReopen() {
  const item = Menu.getApplicationMenu()?.getMenuItemById('reopenTab')
  if (item) item.enabled = closed.length > 0
  for (const controls of openWindows) controls.historyChanged()
}

function rememberClosed(entry) {
  if (!settings.saveHistory) return
  remember(closed, entry)
  refreshReopen()
}

// The last closed tab goes back where it was: its own window if still open,
// else the focused one, else a new window. A closed window reopens whole.
function reopenClosed(focused) {
  const entry = closed.pop()
  if (!entry) return
  refreshReopen()
  if (entry.tabs) return createWindow(entry)
  const target = [...openWindows].find((c) => c.key === entry.windowKey) || focused
  if (!target) return createWindow({ tabs: [entry.history] })
  if (target !== focused) {
    if (target.win.isMinimized()) target.win.restore()
    target.win.focus()
  }
  target.reopenTab(entry.history, entry.index)
}

// After a change: rebuild the menu for new shortcuts, and tell every window.
function applySettings() {
  Menu.setApplicationMenu(buildMenu())
  applyDoNotTrack()
  if (!settings.saveHistory) forgetClosed()
  for (const controls of openWindows) controls.settingsChanged()
}

// `key`, `tabs`, `activeIndex` and `size` reopen a closed window (see `closed`).
function createWindow({ key = nextWindowKey++, tabs: restored = [], activeIndex = 0, size } = {}) {
  const win = new BrowserWindow({
    width: size?.width || 1200,
    height: size?.height || 800,
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
  // Popup views by name, each made on first open (see openPopup), and the
  // name of the one open, if any.
  const popups = {}
  let popupOpen = null
  let recording = false
  // Whether the toolbar had focus when a popup opened, to give it back.
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
      tabs: tabs.map(({ id, title, url, favicon, loading, started }) => ({ id, title, url, favicon, loading, started })),
    })
  }

  // The toolbar's tooltips show the current shortcuts.
  const sendShortcuts = () => { if (!win.isDestroyed()) win.webContents.send('shortcuts', settingsState().labels) }

  function layout() {
    const { width, height } = win.getContentBounds()
    for (const tab of tabs) tab.view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: height - BAR_HEIGHT })
    for (const view of Object.values(popups)) view.setBounds({ x: 0, y: 0, width, height })
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
    if (!focus || popupOpen) return
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
  // `history` reopens a closed tab with its back/forward list.
  function addTab({ url, webContents, history, background = false, index = tabs.length } = {}) {
    const view = new WebContentsView(webContents ? { webContents } : {})
    // `page` keeps the WebContents itself: once it is destroyed (a popup
    // calling window.close()), Electron clears `view.webContents`.
    const page = view.webContents
    const tab = { id: nextTabId++, view, page, title: '', url: '', favicon: null, loading: false, started: Boolean(url || webContents || history), history: null, firstUrl: '' }
    tabs.splice(index, 0, tab)
    view.setVisible(false)
    win.contentView.addChildView(view)
    // Re-adding a view moves it to the top, so popups stay over new tabs.
    for (const popup of Object.values(popups)) win.contentView.addChildView(popup)
    layout()

    page.on('did-start-loading', () => { tab.loading = true; tab.started = true; refresh(tab) })
    page.on('did-stop-loading', () => { tab.loading = false; tab.firstUrl = ''; sync() })
    // The address a tab's first page is loading, until it commits, fails or
    // is stopped; a tab closed meanwhile reopens on it. Later navigations
    // don't count: by then the tab reopens on the page it was showing.
    page.on('did-start-navigation', ({ url, isMainFrame, isSameDocument }) => {
      if (isMainFrame && !isSameDocument && !tab.url) tab.firstUrl = url
    })
    // A new page has no title yet; a reopened one keeps its entry's title,
    // as Chromium does not announce a title it already had.
    page.on('did-navigate', (_event, url) => {
      const history = page.navigationHistory
      tab.url = url
      tab.title = history.getEntryAtIndex(history.getActiveIndex())?.title || ''
      tab.favicon = null
      saveHistory(tab)
      recordVisit(url, tab.title)
      sync()
    })
    page.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      tab.url = url
      saveHistory(tab)
      recordVisit(url, tab.title)
      sync()
    })
    page.on('page-title-updated', (_event, title) => {
      tab.title = title
      if (settings.saveHistory) setVisited(historyStore.retitle(visited, tab.url, title))
      sync()
    })
    page.on('page-favicon-updated', (_event, favicons) => { tab.favicon = favicons[0] || null; sync() })
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
      // Staying cancels a close in progress, so a later close the page
      // makes itself is not taken for one made here.
      else {
        delete tab.closedByUser
        delete tab.closeFocus
      }
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

    if (history) {
      // Shows the page's address and title until it loads.
      const current = history.entries[history.index] || {}
      tab.url = current.url || ''
      tab.title = current.title || ''
      tab.history = history
      page.navigationHistory.restore(history).catch(() => {})
    } else if (url) page.loadURL(url).catch(() => {})
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

  // Copies the tab's back/forward list onto it, as it is now, for Reopen
  // Closed Tab. Kept on each navigation, and read once more at close for
  // the freshest scroll positions and form values. A page still loading
  // is not part of it: a tab reopens as it was when closed.
  // Until its first page commits (tab.url is set), Chromium's list holds
  // only its initial blank entry, so it is not read; the address being
  // loaded stands in, if any.
  function saveHistory(tab) {
    if (!tab.page.isDestroyed() && tab.url) {
      const entries = tab.page.navigationHistory.getAllEntries()
      if (entries.length) tab.history = { entries, index: tab.page.navigationHistory.getActiveIndex() }
    }
    if (!tab.history && tab.firstUrl) return { entries: [{ url: tab.firstUrl, title: '' }], index: 0 }
    return tab.history
  }

  // What Reopen Closed Tab needs to bring this window back.
  function closedWindow(histories, activeIndex) {
    const { width, height } = win.getNormalBounds()
    return { key, tabs: histories, activeIndex, size: { width, height } }
  }

  // A tab's first load turns it from the search box into its page.
  function refresh(tab) {
    if (tab.id === activeId && !tab.view.getVisible()) show(tab)
    sync()
  }

  // Asks the page to close, so its beforeunload can still keep it open;
  // removeTab runs once it is gone. Only tabs closed through here can be
  // reopened.
  function closeTab(id, focus = true) {
    const tab = find(id)
    if (!tab) return
    tab.closeFocus = focus
    tab.closedByUser = true
    saveHistory(tab)
    if (tab.page.isDestroyed()) removeTab(tab)
    else tab.page.close({ waitForBeforeUnload: true })
  }

  function removeTab(tab) {
    if (!find(tab.id)) return
    const nextId = afterClose(ids(), activeId, tab.id)
    const focus = tab.closeFocus ?? true
    const index = tabs.indexOf(tab)
    const history = tab.started ? saveHistory(tab) : null
    tabs.splice(index, 1)
    if (win.isDestroyed()) return
    win.contentView.removeChildView(tab.view)
    // Closing the last tab closes the window, as in Chrome and Safari,
    // unless Settings says to keep it open with a new tab. Then the window
    // is what reopens.
    const closesWindow = nextId === null && settings.closeWindowWithLastTab
    if (tab.closedByUser) rememberClosed(closesWindow ? closedWindow([history], 0) : { windowKey: key, index, history })
    if (nextId === null) return closesWindow ? win.close() : newTab()
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

  // The Settings and History popups (src/settings.html, src/history.html):
  // each is made on first use, then hidden and shown; one is open at a time.
  // While a shortcut is being recorded in Settings, key presses go to it
  // instead of the menu, so ⌘T records ⌘T rather than opening a tab.
  function popupView(name) {
    if (popups[name]) return popups[name]
    const view = new WebContentsView({ webPreferences: { preload: PRELOAD } })
    view.setBackgroundColor('#00000000')
    windowsByPopup.set(view.webContents, { controls, name })
    if (name === 'settings') {
      view.webContents.on('before-input-event', (event, input) => {
        if (!recording || input.type !== 'keyDown') return
        event.preventDefault()
        const plain = !input.control && !input.alt && !input.shift && !input.meta
        if (input.key === 'Escape') view.webContents.send('shortcut-pressed', { cancel: true })
        else if (plain && (input.code === 'Backspace' || input.code === 'Delete')) view.webContents.send('shortcut-pressed', { accelerator: '' })
        else {
          const accelerator = shortcuts.fromInput(input, keyboardLayout)
          if (accelerator) view.webContents.send('shortcut-pressed', { accelerator })
        }
      })
    }
    view.webContents.loadFile(path.join(__dirname, `${name}.html`))
    popups[name] = view
    return view
  }

  // Opening one popup over another swaps them; focus still goes back to
  // where it was before the first.
  function openPopup(name) {
    const view = popupView(name)
    if (!popupOpen) toolbarHadFocus = win.webContents.isFocused()
    else if (popupOpen !== name) {
      popups[popupOpen].setVisible(false)
      recording = false
    }
    popupOpen = name
    win.contentView.addChildView(view)
    layout()
    view.setVisible(true)
    view.webContents.focus()
    view.webContents.send(`${name}-open`, name === 'settings' ? settingsState() : historyState())
  }

  // Popups have no exit animation, so they just hide. Focus goes back
  // where it was: the toolbar (its settings button, or the address bar)
  // keeps its own focused element, otherwise the page gets it.
  function closePopup() {
    if (!popupOpen) return
    popups[popupOpen].setVisible(false)
    popupOpen = null
    recording = false
    if (toolbarHadFocus) return win.webContents.focus()
    const tab = active()
    if (tab) show(tab)
  }

  // A page picked in History opens in the current tab, or with ⌘ in a
  // background tab next to it, leaving History open.
  function openFromHistory(url, background) {
    if (background) {
      const current = active()
      return addTab({ url, background: true, index: current ? tabs.indexOf(current) + 1 : tabs.length })
    }
    closePopup()
    navigate(url)
  }

  const controls = {
    win,
    key,
    newTab,
    closeTab: (id = activeId, focus = true) => closeTab(id, focus),
    reopenTab(history, index) {
      closePopup()
      addTab({ history, index: reopenIndex(index, tabs.length) })
    },
    activate,
    navigate,
    focusAddress,
    step: (delta) => activate(step(ids(), activeId, delta)),
    byNumber: (number) => activate(byNumber(ids(), number)),
    // The active page, for reload, back, forward and its developer tools.
    page: () => (active()?.started && !active().page.isDestroyed() ? active().page : null),
    openPopup,
    closePopup,
    popupOpen: () => popupOpen,
    openFromHistory,
    setRecording: (on, keys) => {
      recording = on
      keyboardLayout = on && keys && typeof keys === 'object' ? keys : {}
    },
    settingsChanged() {
      sendShortcuts()
      popups.settings?.webContents.send('settings-changed', settingsState())
      controls.historyChanged()
    },
    historyChanged() {
      if (popupOpen === 'history') popups.history.webContents.send('history-changed', historyState())
    },
  }
  windowsByToolbar.set(win.webContents, controls)
  openWindows.add(controls)

  win.on('resize', layout)
  // A window closed with tabs still in it (⇧⌘W, the close button) can be
  // reopened whole. A window closed by its last tab was remembered in
  // removeTab. Its tabs are read while it is still there, and remembered
  // only once it is really gone, in case the close is cancelled.
  let closingWindow = null
  win.on('close', () => {
    const histories = tabs.map((tab) => (tab.started ? saveHistory(tab) : null))
    closingWindow = histories.length ? closedWindow(histories, Math.max(tabs.indexOf(active()), 0)) : null
  })
  // The toolbar asks for the tabs once it has loaded (and again if reloaded).
  win.webContents.on('did-finish-load', () => { sync(); sendShortcuts() })
  win.on('closed', () => {
    openWindows.delete(controls)
    if (closingWindow) rememberClosed(closingWindow)
    for (const tab of tabs.splice(0)) {
      if (!tab.page.isDestroyed()) tab.page.close()
    }
    for (const view of Object.values(popups)) view.webContents.close()
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  if (restored.length) {
    for (const history of restored) addTab(history ? { history, background: true } : { background: true })
    activate(tabs[Math.min(activeIndex, tabs.length - 1)].id)
  } else newTab()
  return controls
}

// Menu actions go to the focused window, which Electron passes to `click`.
const controlsOf = (win) => (win && !win.isDestroyed() ? windowsByToolbar.get(win.webContents) : undefined)
const inFocused = (action) => (_item, win) => {
  const controls = controlsOf(win)
  if (controls) action(controls)
}

// Settings and History open in the focused window, or a new one, and the
// same command closes them again.
const togglePopup = (name) => (_item, win) => {
  const c = controlsOf(win) || createWindow()
  if (c.popupOpen() === name) c.closePopup()
  else c.openPopup(name)
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
          click: togglePopup('settings'),
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
        { label: 'Open Location…', accelerator: key('openLocation'), click: inFocused((c) => { c.closePopup(); c.focusAddress() }) },
        { type: 'separator' },
        // With a popup open, Close Tab closes the popup instead.
        { label: 'Close Tab', accelerator: key('closeTab'), click: inFocused((c) => (c.popupOpen() ? c.closePopup() : c.closeTab())) },
        { label: 'Close Window', accelerator: key('closeWindow'), click: inFocused((c) => c.win.close()) },
      ],
    },
    { role: 'editMenu' },
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
      label: 'History',
      submenu: [
        { label: 'Show All History', accelerator: key('history'), click: togglePopup('history') },
        { type: 'separator' },
        { id: 'reopenTab', label: 'Reopen Closed Tab', accelerator: key('reopenTab'), enabled: closed.length > 0, click: (_item, win) => reopenClosed(controlsOf(win)) },
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
ipcMain.on('open-settings', fromToolbar((c) => c.openPopup('settings')))

// Popup messages, answered only for the popup `name`.
const fromPopup = (name, handler) => (event, ...args) => {
  const popup = windowsByPopup.get(event.sender)
  if (popup?.name === name) return handler(popup.controls, ...args)
}
const fromSettings = (handler) => fromPopup('settings', handler)
const fromHistory = (handler) => fromPopup('history', handler)
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
ipcMain.on('settings-close', fromSettings((c) => c.closePopup()))

ipcMain.handle('history-get', fromHistory(() => historyState()))
// Only addresses already in history can be opened from it.
ipcMain.on('history-open-page', fromHistory((c, url, background) => {
  if (visited.some((entry) => entry.url === url)) c.openFromHistory(url, background === true)
}))
ipcMain.on('history-remove', fromHistory((_c, url) => setVisited(historyStore.remove(visited, url), { now: true })))
// Clearing history forgets closed tabs too.
ipcMain.on('history-clear', fromHistory(() => { setVisited([], { now: true }); forgetClosed() }))
ipcMain.on('history-close', fromHistory((c) => c.closePopup()))

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = settingsStore.load(settingsFile)
  historyFile = path.join(app.getPath('userData'), 'history.json')
  visited = historyStore.load(historyFile)
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

// A save still waiting when Lit quits is written now.
app.on('will-quit', () => { if (historySave) saveVisited() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
