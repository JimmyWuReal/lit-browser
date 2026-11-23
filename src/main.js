// Lit's main process. Each window has a toolbar on top (src/index.html,
// the window's own page) and one Chromium WebContentsView per tab below it.
// Only the active tab's view is visible.
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain } = require('electron')
const path = require('node:path')
const { toUrl } = require('./url')
const { afterClose, step, byNumber } = require('./tabs')

// Keep in sync with .strip and .bar heights in index.html.
const STRIP_HEIGHT = 38
const BAR_HEIGHT = STRIP_HEIGHT + 44

// The toolbar's webContents -> its window's controls, so toolbar messages
// only ever act on their own window.
const windowsByToolbar = new WeakMap()
let nextTabId = 1

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#090909',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })

  const tabs = []
  let activeId = null
  const find = (id) => tabs.find((tab) => tab.id === id)
  const active = () => find(activeId)
  const ids = () => tabs.map((tab) => tab.id)

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

  function layout() {
    const { width, height } = win.getContentBounds()
    for (const tab of tabs) tab.view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: height - BAR_HEIGHT })
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
    if (!focus) return
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
    const tab = { id: nextTabId++, view, page, title: '', url: '', favicon: null, loading: false, started: Boolean(url || webContents) }
    tabs.splice(index, 0, tab)
    view.setVisible(false)
    win.contentView.addChildView(view)
    layout()

    page.on('did-start-loading', () => { tab.loading = true; tab.started = true; refresh(tab) })
    page.on('did-stop-loading', () => { tab.loading = false; sync() })
    page.on('did-navigate', (_event, url) => { tab.url = url; tab.title = ''; tab.favicon = null; sync() })
    page.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) { tab.url = url; sync() } })
    page.on('page-title-updated', (_event, title) => { tab.title = title; sync() })
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
    })

    // Links and window.open become tabs right after the opener: Cmd-click
    // opens in the background, everything else comes to the front.
    // The new tab outlives its opener, so closing the page a link came from
    // keeps the link's tab.
    page.setWindowOpenHandler(({ disposition }) => ({
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => addTab({
        webContents: options.webContents,
        background: disposition === 'background-tab',
        index: tabs.indexOf(tab) + 1,
      }).page,
    }))

    if (url) page.loadURL(url).catch(() => {})
    if (background) sync()
    else activate(tab.id)
    return tab
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
    // Closing the last tab closes the window, as in Chrome and Safari.
    if (nextId === null) return win.close()
    if (nextId !== activeId) activate(nextId, focus)
    else sync()
  }

  function navigate(input) {
    const tab = active()
    if (!tab || !input.trim()) return
    tab.started = true
    show(tab)
    tab.page.loadURL(toUrl(input)).catch(() => {})
  }

  const controls = {
    win,
    newTab: () => addTab(),
    closeTab: (id = activeId, focus = true) => closeTab(id, focus),
    activate,
    navigate,
    focusAddress,
    step: (delta) => activate(step(ids(), activeId, delta)),
    byNumber: (number) => activate(byNumber(ids(), number)),
    // The active page, for reload, back, forward and its developer tools.
    page: () => (active()?.started && !active().page.isDestroyed() ? active().page : null),
  }
  windowsByToolbar.set(win.webContents, controls)

  win.on('resize', layout)
  // The toolbar asks for the tabs once it has loaded (and again if reloaded).
  win.webContents.on('did-finish-load', sync)
  win.on('closed', () => {
    for (const tab of tabs.splice(0)) {
      if (!tab.page.isDestroyed()) tab.page.close()
    }
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  addTab()
  return controls
}

// Menu actions go to the focused window, which Electron passes to `click`.
const controlsOf = (win) => (win && !win.isDestroyed() ? windowsByToolbar.get(win.webContents) : undefined)
const inFocused = (action) => (_item, win) => {
  const controls = controlsOf(win)
  if (controls) action(controls)
}

// The menu holds every shortcut, so they work whether the toolbar or a page
// has focus. Hidden items still answer their shortcuts on macOS.
function buildMenu() {
  const hidden = (label, accelerator, click) => ({ label, accelerator, click, visible: false })
  const numbers = Array.from({ length: 9 }, (_, i) =>
    hidden(`Select Tab ${i + 1}`, `CmdOrCtrl+${i + 1}`, inFocused((c) => c.byNumber(i + 1))))
  const pageAction = (action) => inFocused((c) => { const page = c.page(); if (page) action(page) })

  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: (_item, win) => { const c = controlsOf(win); if (c) c.newTab(); else createWindow() } },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: inFocused((c) => c.focusAddress()) },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: inFocused((c) => c.closeTab()) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: inFocused((c) => c.win.close()) },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: pageAction((page) => page.reload()) },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: pageAction((page) => page.navigationHistory.goBack()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: pageAction((page) => page.navigationHistory.goForward()) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: pageAction((page) => page.toggleDevTools()) },
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
        { label: 'Show Next Tab', accelerator: 'Ctrl+Tab', click: inFocused((c) => c.step(1)) },
        { label: 'Show Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: inFocused((c) => c.step(-1)) },
        hidden('Show Next Tab', 'CmdOrCtrl+Shift+]', inFocused((c) => c.step(1))),
        hidden('Show Previous Tab', 'CmdOrCtrl+Shift+[', inFocused((c) => c.step(-1))),
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

app.whenReady().then(() => {
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
