// Lit's main process. Each window has a toolbar on top (src/index.html,
// the window's own page) and one Chromium WebContentsView per tab below it.
// Only the active tab's view is visible. The Settings, History and
// Downloads popups are each one more view, transparent and over
// everything, shown only while open. Find in page lives in the toolbar; each tab keeps its own
// search (src/find.js). A site asking for the camera, location and the like
// gets a prompt in the toolbar, below the address row (src/permissions.js).
const { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, ipcMain, screen, session, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { toUrl, searchUrl, engineOf } = require('./url')
const { afterClose, step, byNumber, remember, forgetOlder, reopenIndex, onScreen } = require('./tabs')
const settingsStore = require('./settings')
const historyStore = require('./history')
const shortcuts = require('./shortcuts')
const downloadsStore = require('./downloads')
const zoom = require('./zoom')
const permissions = require('./permissions')
const findState = require('./find')
const { pageMenu, tabMenu } = require('./menus')

// Keep in sync with .strip and .bar heights in index.html.
const STRIP_HEIGHT = 38
const BAR_HEIGHT = STRIP_HEIGHT + 44
// The permission prompt's row under the address row; keep in sync with
// .prompt in index.html. Pages move down by this while their tab asks.
const PROMPT_HEIGHT = 44
const PRELOAD = path.join(__dirname, 'preload.js')

// The toolbar's webContents -> its window's controls, so toolbar messages
// only ever act on their own window. Each popup's webContents ->
// { controls, name }, so a popup only gets its own messages answered.
const windowsByToolbar = new WeakMap()
const windowsByPopup = new WeakMap()
const openWindows = new Set()
let nextTabId = 1
let nextPromptId = 1
// Names a window for Reopen Closed Tab; a reopened window keeps its key,
// so tabs closed from it earlier still find their way back to it.
let nextWindowKey = 1

// Recently closed tabs and windows, newest last, for Reopen Closed Tab.
// Only closes people make count (⌘W, the close button, closing a window),
// not a page closing itself; a blank tab has a null history and comes
// back blank. Nothing is kept while Save history is off.
// A tab: { windowKey, index, history }, back in its window if that is open.
// A window: { key, tabs: [history], activeIndex, bounds, maximized,
// fullScreen }, so tab order, the active tab and its place come back as they were.
// A history is { entries, index } from navigationHistory, so back and
// forward come back too. Kept in memory only, and forgotten after the
// time the Forget closed tabs setting gives (and when Lit quits).
const closed = []

// Settings are read once at launch and saved on every change.
let settingsFile
let settings = settingsStore.clean()

// Each site's zoom, when it differs from the default (see src/zoom.js).
// Read at launch and saved whenever a site's zoom changes.
let zoomFile
let siteZooms = new Map()
const zoomFor = (url) => siteZooms.get(zoom.siteOf(url)) ?? settings.defaultZoom

// Zooms every tab on `url`'s site, in every window, and remembers it;
// zooming back to the default forgets the site. A step past the last zoom,
// or a reset at the default, changes nothing.
function zoomSite(url, factor) {
  const site = zoom.siteOf(url)
  if (!site) return
  const forget = zoom.same(factor, settings.defaultZoom)
  const saved = siteZooms.get(site)
  if (forget ? saved === undefined : saved !== undefined && zoom.same(saved, factor)) return
  const next = new Map(siteZooms)
  if (forget) next.delete(site)
  else next.set(site, factor)
  siteZooms = next
  try {
    zoom.save(zoomFile, siteZooms)
  } catch {
    // Unsaved, the zoom still holds until Lit quits.
  }
  for (const controls of openWindows) controls.applyZoom(site)
}

// Each site's Allow or Block, per kind (see src/permissions.js). Read at
// launch and saved whenever one changes.
let permissionsFile
let sitePermissions = new Map()

// Saves `choice` ('allow', 'block', or null to forget) for the kinds, then
// answers every prompt it settles, in every window. Unsaved, a choice still
// holds until Lit quits.
function choosePermission(site, kinds, choice) {
  sitePermissions = permissions.choose(sitePermissions, site, kinds, choice)
  try {
    permissions.save(permissionsFile, sitePermissions)
  } catch {
    // Kept in memory only.
  }
  for (const controls of openWindows) { controls.settlePrompts(); controls.settingsChanged() }
}

// The site a request or check is for: the origin that asked, but only when
// it is the page in the address bar, so a choice always belongs to the site
// people see. A frame from another site gets null, and is refused, as is a
// page with no origin. Without a page (a service worker), the origin that
// asked stands alone. A check can also name the origin embedding the
// frame (`embedding`), even without a page; it has to match too.
function siteFor(contents, asking, embedding) {
  const site = permissions.originOf(asking)
  const page = contents && !contents.isDestroyed() ? contents.getURL() : ''
  if (!site || (page && permissions.originOf(page) !== site)) return null
  return embedding && permissions.originOf(embedding) !== site ? null : site
}

// Requests for a kind Lit asks about are answered from the saved choices,
// or by a prompt on the tab that asked, for the kinds not yet decided.
// Anything not from a tab (Lit's own pages, a service worker) is refused.
function onPermissionRequest(contents, permission, callback, details) {
  const kinds = permissions.kindsOf(permission, details.mediaTypes)
  if (!kinds) return callback(true)
  const site = siteFor(contents, details.requestingUrl)
  if (!site) return callback(false)
  const answer = permissions.status(sitePermissions, site, kinds)
  if (answer !== 'ask') return callback(answer === 'allow')
  for (const controls of openWindows) {
    if (controls.askPermission(contents, site, kinds, callback)) return
  }
  callback(false)
}

// Checks (Notification.permission, navigator.permissions.query, device
// labels) say yes only once a site was allowed. Electron has no "not asked
// yet", so until then they read as denied; asking still prompts.
function onPermissionCheck(contents, permission, requestingOrigin, details) {
  let kinds = permissions.kindsOf(permission)
  if (permission === 'media') kinds = details.mediaType === 'video' ? ['camera'] : details.mediaType === 'audio' ? ['microphone'] : ['camera', 'microphone']
  if (!kinds) return true
  const site = siteFor(contents, requestingOrigin, details.embeddingOrigin)
  if (!site) return false
  return kinds.some((kind) => permissions.status(sitePermissions, site, [kind]) === 'allow')
}

// Pages visited (src/history.js), newest first. Loaded at launch, and saved
// a moment after a visit, so a burst of navigations writes once; removing
// pages saves right away, so they can't come back after a crash.
let historyFile
let visited = []
let historySave = null

// Whether the write worked.
function saveVisited() {
  clearTimeout(historySave)
  historySave = null
  try {
    historyStore.save(historyFile, visited)
    return true
  } catch {
    return false
  }
}

// `now` saves right away and keeps the old list if that fails, so a page
// someone removed never comes back after a restart. Returns whether the
// change was made.
function setVisited(next, { now = false } = {}) {
  if (next === visited) return true
  const before = visited
  visited = next
  if (now && !saveVisited()) {
    visited = before
    return false
  }
  if (!now) {
    clearTimeout(historySave)
    historySave = setTimeout(saveVisited, 1000)
  }
  for (const controls of openWindows) controls.historyChanged()
  return true
}

// Whether the visit was recorded, so a title arriving later goes only to
// a visit that was.
function recordVisit(url, title) {
  if (settings.saveHistory) setVisited(historyStore.visit(visited, { url, title, time: Date.now() }))
  return settings.saveHistory
}

// What the History popup draws.
// `closedTabs` counts tabs and windows Reopen Closed Tab still has, which
// Clear History also forgets.
// `error` says why the last removal didn't happen.
const historyState = (error) => ({ entries: visited, enabled: settings.saveHistory, closedTabs: closed.length, ...(error && { error }) })

function forgetClosed() {
  closed.length = 0
  pruneClosed()
}

// This session's downloads, newest first, in memory only: { id, item,
// path, state, received, total, speed } (see src/downloads.js). One joins
// the list once it has somewhere to go, so a save dialog someone cancels
// never shows. Every window's toolbar shows them, as they share a session.
const downloads = []
let nextDownloadId = 1
// Progress arrives many times a second; windows hear about it at most
// this often, while a download starting or ending is sent right away.
const DOWNLOADS_EVERY = 250
let downloadsTimer = null

function downloadsChanged(now = false) {
  if (downloadsTimer && !now) return
  clearTimeout(downloadsTimer)
  const send = () => {
    downloadsTimer = null
    for (const controls of openWindows) controls.downloadsChanged()
  }
  if (now) send()
  else downloadsTimer = setTimeout(send, DOWNLOADS_EVERY)
}

const downloadsSummary = () => downloadsStore.summary(downloads)

// What the Downloads popup draws. A finished file someone has since moved
// or deleted says so, and can no longer be shown in Finder.
function downloadsState() {
  return {
    downloads: downloads.map((download) => downloadsStore.row({
      ...download,
      missing: download.state === 'completed' && !fs.existsSync(download.path),
    })),
  }
}

// Follows one download from will-download to done. Saving straight to
// Downloads, when Settings says so; otherwise Electron asks where to save.
// Paths of unfinished downloads count as taken, so two same-name downloads
// never share one.
const downloading = new Set()
function trackDownload(item) {
  let file = null
  if (settings.downloadLocation === 'downloads') {
    file = downloadsStore.uniquePath(app.getPath('downloads'), item.getFilename(), (candidate) => downloading.has(candidate) || fs.existsSync(candidate))
    downloading.add(file)
    item.setSavePath(file)
  }
  const download = { id: nextDownloadId++, item, path: '', state: 'progressing', received: 0, total: 0, speed: 0 }
  const read = (state) => {
    download.state = state
    download.path = item.getSavePath()
    download.received = item.getReceivedBytes()
    download.total = item.getTotalBytes()
    download.speed = state === 'progressing' ? item.getCurrentBytesPerSecond() : 0
    // Listed once it has a place: right away, or after the save dialog.
    if (!download.path || downloads.includes(download)) return false
    downloads.unshift(download)
    return true
  }
  item.on('updated', (_event, state) => downloadsChanged(read(state)))
  item.once('done', (_event, state) => {
    if (file) downloading.delete(file)
    read(state === 'interrupted' ? 'failed' : state)
    // Done with Electron's item; the list keeps what it last said.
    download.item = null
    if (state === 'completed') app.dock?.downloadFinished(download.path)
    downloadsChanged(true)
  })
  if (read('progressing')) downloadsChanged(true)
}

// How long a closed tab can be reopened, per the Forget closed tabs setting.
const KEEP_CLOSED = { '10m': 10 * 60 * 1000, '1h': 60 * 60 * 1000, '1d': 24 * 60 * 60 * 1000 }
let closedTimer = null

// Forgets closes older than the setting allows, then waits for the next
// one to come due. Run after every change to the list or the setting.
function pruneClosed() {
  clearTimeout(closedTimer)
  const due = forgetOlder(closed, Date.now(), KEEP_CLOSED[settings.closedTabsFor])
  closedTimer = due === null ? null : setTimeout(pruneClosed, due - Date.now())
  refreshReopen()
}

// What a popup draws when it opens.
const popupState = (name) => ({ settings: settingsState, history: historyState, downloads: downloadsState })[name]()

// What the Settings popup draws: the values, plus each shortcut as ⌘ symbols.
function settingsState(error) {
  const labels = {}
  for (const setting of settingsStore.SETTINGS) {
    if (setting.type === 'shortcut') labels[setting.key] = settings[setting.key] ? shortcuts.label(settings[setting.key]) : ''
  }
  return { sections: settingsStore.SECTIONS, values: settings, labels, sitePermissions: permissions.list(sitePermissions), ...(error && { error }) }
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
  remember(closed, { ...entry, time: Date.now() })
  pruneClosed()
}

// The last closed tab goes back where it was: its own window if still open,
// else the focused one, else a new window. A closed window reopens whole.
function reopenClosed(focused) {
  pruneClosed()
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
  if (!settings.saveHistory) {
    forgetClosed()
    for (const controls of openWindows) controls.forgetTabHistories()
  } else pruneClosed()
  for (const controls of openWindows) { controls.applyZoom(); controls.settingsChanged() }
}

// `key`, `tabs`, `activeIndex`, `bounds`, `maximized` and `fullScreen` reopen
// a closed window (see `closed`). Its old position is used only while it is
// still on a connected display; otherwise only its size.
function createWindow({ key = nextWindowKey++, tabs: restored = [], activeIndex = 0, bounds, maximized, fullScreen } = {}) {
  const place = bounds && onScreen(bounds, screen.getAllDisplays().map((display) => display.workArea))
    ? bounds
    : { width: bounds?.width || 1200, height: bounds?.height || 800 }
  const win = new BrowserWindow({
    ...place,
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
  // How far down the pages start: lower while the active tab has a prompt.
  let pageTop = BAR_HEIGHT

  // Everything the toolbar draws. Sent whenever any of it changes.
  function sync() {
    if (win.isDestroyed()) return
    const current = active()
    const top = BAR_HEIGHT + (current?.prompts.length ? PROMPT_HEIGHT : 0)
    if (top !== pageTop) { pageTop = top; layout() }
    win.setTitle(current?.title || (current?.started ? current.url : '') || 'New Tab')
    win.webContents.send('tabs', {
      activeId,
      tabs: tabs.map(({ id, title, url, favicon, loading, started, find, zoom: factor, page, prompts }) => ({
        id, title, url, favicon, loading, started,
        // The tab's oldest unanswered permission request; the rest wait.
        prompt: prompts[0] && { id: prompts[0].id, site: permissions.label(prompts[0].site), kinds: asking(prompts[0]), does: permissions.describe(asking(prompts[0])) },
        // The address bar shows the zoom, to reset it, when it is not the
        // default or the site has its own (which can match a later default).
        zoom: started && (!zoom.same(factor, settings.defaultZoom) || siteZooms.has(zoom.siteOf(page.isDestroyed() ? '' : page.getURL())))
          ? zoom.percent(factor)
          : '',
        find: find && { text: find.text, active: find.active, matches: find.matches },
      })),
    })
  }

  // The toolbar's tooltips show the current shortcuts.
  const sendShortcuts = () => { if (!win.isDestroyed()) win.webContents.send('shortcuts', settingsState().labels) }
  // The toolbar's downloads indicator.
  const sendDownloads = () => { if (!win.isDestroyed()) win.webContents.send('downloads', downloadsSummary()) }

  function layout() {
    const { width, height } = win.getContentBounds()
    for (const tab of tabs) tab.view.setBounds({ x: 0, y: pageTop, width, height: Math.max(height - pageTop, 0) })
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
  // `history` ({ entries, index }) restores a back/forward list, of a closed
  // tab or of the tab being duplicated; `url` is then loaded only if that
  // fails. `referrer` ({ url, policy }) is sent with `url`, as a link opened
  // from a page sends it.
  function addTab({ url, webContents, history, referrer, background = false, index = tabs.length } = {}) {
    const view = new WebContentsView(webContents ? { webContents } : {})
    // `page` keeps the WebContents itself: once it is destroyed (a popup
    // calling window.close()), Electron clears `view.webContents`.
    const page = view.webContents
    // Lit sets each page's zoom itself (setZoom). Chromium's own sharing,
    // by URL, would also zoom Lit's toolbar when a tab shows its file.
    page.setZoomMode('isolated')
    const tab = { id: nextTabId++, view, page, title: '', url: '', favicon: null, loading: false, started: Boolean(url || webContents || history), history: null, find: null, zoom: settings.defaultZoom, prompts: [] }
    tabs.splice(index, 0, tab)
    view.setVisible(false)
    win.contentView.addChildView(view)
    // Re-adding a view moves it to the top, so popups stay over new tabs.
    for (const overlay of Object.values(popups)) win.contentView.addChildView(overlay)
    layout()

    page.on('did-start-loading', () => { tab.loading = true; tab.started = true; refresh(tab) })
    page.on('did-stop-loading', () => { tab.loading = false; sync() })
    // The address being opened, before it commits: a tab duplicated or
    // closed before its first page commits gets it.
    page.on('did-start-navigation', ({ url, isMainFrame }) => { if (isMainFrame) tab.pendingUrl = url })
    // Each new page opens at its site's zoom. A new page has no title yet; a restored one keeps its entry's title,
    // as Chromium does not announce a title it already had.
    page.on('did-navigate', (_event, url) => {
      const history = page.navigationHistory
      tab.url = url
      tab.title = history.getEntryAtIndex(history.getActiveIndex())?.title || ''
      tab.favicon = null
      tab.find = findState.reset(tab.find)
      // A new page has not asked for anything yet; the old page's requests go.
      dropPrompts(tab)
      setZoom(tab, zoomFor(url))
      tab.recorded = recordVisit(url, tab.title)
      sync()
    })
    page.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      tab.url = url
      tab.recorded = recordVisit(url, tab.title)
      sync()
    })
    page.on('page-title-updated', (_event, title) => {
      tab.title = title
      if (settings.saveHistory && tab.recorded) setVisited(historyStore.retitle(visited, tab.url, title))
      sync()
    })
    page.on('page-favicon-updated', (_event, favicons) => { tab.favicon = favicons[0] || null; sync() })
    // Escape in the page closes its find field too, as in Safari and
    // Firefox. The page still gets the key, and an input method's keeps it.
    page.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !input.isComposing && tab.find && tab.id === activeId) closeFind()
    })
    // A new page (or a reload) gets the open search run again once its
    // document is ready, without waiting for slow images; did-stop-loading
    // covers pages restored from the back-forward cache, which skip dom-ready.
    const rerunFind = () => { if (tab.find?.text && tab.find.requestId === null) search(tab) }
    page.on('dom-ready', rerunFind)
    page.on('did-stop-loading', rerunFind)
    page.on('found-in-page', (_event, result) => {
      const next = findState.result(tab.find, result)
      if (next === tab.find) return
      tab.find = next
      sync()
      // A step asked for while the search was starting goes now.
      if (next.matches !== null && next.queued !== null) {
        tab.find = { ...next, queued: null }
        if (tab.id === activeId) findAgain(next.queued)
      }
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
      // Staying cancels a close in progress, so a later close the page
      // makes itself is not taken for one made here.
      else {
        delete tab.closedByUser
        delete tab.closeFocus
        delete tab.closeSnapshot
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

    page.on('context-menu', (_event, params) => showPageMenu(page, params))

    if (history) {
      // Shows the page's address and title until it loads.
      const current = history.entries[history.index] || {}
      tab.url = current.url || ''
      tab.title = current.title || ''
      tab.history = history
      // If restoring fails, the page it was on still loads.
      const retry = url || current.url
      page.navigationHistory.restore(history).catch(() => { if (retry && !page.isDestroyed()) page.loadURL(retry).catch(() => {}) })
    } else if (url) page.loadURL(url, referrer ? { httpReferrer: referrer } : {}).catch(() => {})
    // A popup can stay on the about:blank its opener writes into, without
    // ever firing did-navigate, so it gets its zoom here.
    if (webContents) setZoom(tab, zoomFor(page.getURL() || 'about:blank'))
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
  // Closed Tab. Read when the tab or its window closes, so scroll positions
  // and form values are fresh; a reopened tab starts with the list it was
  // restored from. A page still loading is not part of it: a tab reopens
  // as it was when closed.
  // Until its first page commits (tab.url is set), Chromium's list holds
  // only its initial blank entry, so it is not read; the address being
  // loaded stands in, if any.
  function saveHistory(tab) {
    // While Save history is off, nothing is kept to reopen.
    if (!settings.saveHistory) return (tab.history = null)
    if (!tab.page.isDestroyed() && tab.url) {
      const entries = tab.page.navigationHistory.getAllEntries()
      if (entries.length) tab.history = { entries, index: tab.page.navigationHistory.getActiveIndex() }
    }
    if (!tab.history && !tab.url && tab.pendingUrl) return { entries: [{ url: tab.pendingUrl, title: '' }], index: 0 }
    return tab.history
  }

  // What Reopen Closed Tab needs to bring this window back.
  function closedWindow(histories, activeIndex) {
    return { key, tabs: histories, activeIndex, bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() }
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
    // Read now, while the page is still there to read.
    tab.closeSnapshot = saveHistory(tab)
    if (tab.page.isDestroyed()) removeTab(tab)
    else tab.page.close({ waitForBeforeUnload: true })
  }

  function removeTab(tab) {
    if (!find(tab.id)) return
    dropPrompts(tab)
    const nextId = afterClose(ids(), activeId, tab.id)
    const focus = tab.closeFocus ?? true
    const index = tabs.indexOf(tab)
    const history = tab.started ? saveHistory(tab) || tab.closeSnapshot || null : null
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

  // Zoom is per site, so changing it goes through zoomSite, which comes
  // back here (applyZoom) for every tab on that site.
  function setZoom(tab, factor) {
    tab.zoom = factor
    if (!tab.page.isDestroyed()) tab.page.setZoomFactor(factor)
  }
  // The page's own URL, not tab.url: a popup can stay on the about:blank its
  // opener writes into, which never fires did-navigate.
  const urlOf = (tab) => (tab.page.isDestroyed() ? '' : tab.page.getURL())
  const zoomBy = (tab, direction) => { const url = urlOf(tab); if (url) zoomSite(url, zoom.step(tab.zoom, direction)) }
  const resetZoom = (tab) => { const url = urlOf(tab); if (url) zoomSite(url, settings.defaultZoom) }

  // Permission prompts. A tab's requests wait in order, one prompt at a
  // time; the same request asked again joins the one waiting. Each prompt
  // is { id, site, kinds, callbacks }: `kinds` is the whole request, which
  // settles it, while the prompt asks only about the undecided ones.
  function askPermission(contents, site, kinds, callback) {
    const tab = tabs.find((each) => each.page === contents)
    if (!tab) return false
    const same = tab.prompts.find((prompt) => prompt.site === site && prompt.kinds.join() === kinds.join())
    if (same) same.callbacks.push(callback)
    else tab.prompts.push({ id: nextPromptId++, site, kinds, callbacks: [callback] })
    sync()
    return true
  }
  // What a prompt asks about now: its kinds without a choice yet.
  const asking = (prompt) => permissions.undecided(sitePermissions, prompt.site, prompt.kinds)

  // Refuses the tab's waiting requests, without saving anything.
  function dropPrompts(tab) {
    if (!tab.prompts.length) return
    for (const prompt of tab.prompts.splice(0)) for (const callback of prompt.callbacks) callback(false)
    sync()
  }

  // Allow or Block saves the choice for the site, which answers this
  // prompt and any other it settles; dismissing (null) refuses only this
  // request, so the site can ask again. `kinds` is what the row showed; an
  // answer to a row that has since changed is ignored.
  function answerPrompt(tabId, promptId, kinds, choice) {
    const tab = find(tabId)
    const prompt = tab?.prompts.find((each) => each.id === promptId)
    if (!prompt || !Array.isArray(kinds) || kinds.join() !== asking(prompt).join()) return
    if (choice) return choosePermission(prompt.site, asking(prompt), choice)
    tab.prompts.splice(tab.prompts.indexOf(prompt), 1)
    for (const callback of prompt.callbacks) callback(false)
    sync()
  }

  // Answers every waiting request the saved choices now decide. The rest
  // are redrawn too, as what they ask about may have changed.
  function settlePrompts() {
    for (const tab of tabs) {
      for (const prompt of [...tab.prompts]) {
        const answer = permissions.status(sitePermissions, prompt.site, prompt.kinds)
        if (answer === 'ask') continue
        tab.prompts.splice(tab.prompts.indexOf(prompt), 1)
        for (const callback of prompt.callbacks) callback(answer === 'allow')
      }
    }
    sync()
  }

  function navigate(input) {
    const tab = active()
    if (!tab || !input.trim()) return
    tab.started = true
    show(tab)
    tab.page.loadURL(toUrl(input, settings.searchEngine)).catch(() => {})
  }

  // Starts a new search for the tab's find text; results come back through
  // found-in-page. A new search starts from the page's selection, which
  // closing Find keeps, so reopening carries on from the last match.
  function search(tab, forward = true) {
    if (tab.page.isDestroyed()) return
    tab.find = { ...tab.find, requestId: tab.page.findInPage(tab.find.text, { forward, findNext: true }) }
  }

  // Find in page. ⌘F opens the active tab's find field in the toolbar (or
  // selects its text again); a tab on the search box has nothing to search.
  // Reopening brings back the tab's last search and runs it again, in
  // `forward`'s direction (⇧⌘G on a closed field searches backward).
  function openFind(forward = true) {
    const tab = active()
    if (!tab?.started || tab.page.isDestroyed()) return
    closePopup()
    if (!tab.find) {
      tab.find = findState.open(null, tab.lastFindText)
      if (tab.find.text) search(tab, forward)
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
    if (!tab?.find?.text) return openFind(forward)
    if (tab.page.isDestroyed()) return
    if (tab.find.requestId === null) return search(tab, forward)
    // Chromium drops a step sent before a new search's first answer, so
    // it waits for that answer (see found-in-page).
    if (tab.find.matches === null) { tab.find = { ...tab.find, queued: forward }; return }
    tab.find = { ...tab.find, requestId: tab.page.findInPage(tab.find.text, { forward, findNext: false }) }
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

  // Pops up a right-click menu of items from src/menus.js; `run` gets
  // each chosen item's command and arg. Shortcuts are only shown, since the
  // application menu already answers them.
  function popup(items, run) {
    if (!items.length || win.isDestroyed()) return
    Menu.buildFromTemplate(items.map((item) => (item.type === 'separator' ? item : {
      label: item.label,
      enabled: item.enabled ?? true,
      accelerator: item.accelerator || undefined,
      registerAccelerator: false,
      click: () => item.command && run(item.command, item.arg),
    }))).popup({ window: win })
  }

  // The right-click menu for a page, or (isPage false) for a text field in
  // the toolbar or Settings, which only gets the editing items.
  function showPageMenu(contents, params, isPage = true) {
    const items = pageMenu(params, {
      isPage,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      engineName: engineOf(settings.searchEngine).name,
      askWhereToSave: settings.downloadLocation !== 'downloads',
      keys: { reload: settings['shortcuts.reload'], back: settings['shortcuts.back'], forward: settings['shortcuts.forward'] },
      inSubframe: Boolean(params.frame && params.frame !== contents.mainFrame),
    })
    popup(items, (command, arg) => {
      if (contents.isDestroyed()) return
      // New tabs go right after the page's tab (or the active one).
      const from = tabs.find((tab) => tab.page === contents) || active()
      const index = from ? tabs.indexOf(from) + 1 : tabs.length
      switch (command) {
        // Like ⌘-click: in the background unless Settings says to switch.
        // The page the link is on is the referrer, under that frame's policy.
        case 'openInNewTab': return addTab({
          url: arg,
          referrer: { url: params.frameURL || params.pageURL, policy: params.referrerPolicy?.policy || 'default' },
          index,
          background: !settings.switchToNewTabs,
        })
        case 'search': return addTab({ url: searchUrl(arg, settings.searchEngine), index })
        // Through will-download, so the Downloads setting applies.
        case 'download': return contents.downloadURL(arg)
        case 'copyText': return clipboard.writeText(arg)
        case 'copyImage': return contents.copyImageAt(params.x, params.y)
        case 'replaceMisspelling': return contents.replaceMisspelling(arg)
        case 'addToDictionary': return contents.session.addWordToSpellCheckerDictionary(arg)
        case 'back': return contents.navigationHistory.goBack()
        case 'forward': return contents.navigationHistory.goForward()
        case 'reload': return contents.reload()
        case 'inspect': return contents.inspectElement(params.x, params.y)
        // undo, redo, cut, copy, paste, selectAll
        default: return contents[command]()
      }
    })
  }

  // A copy of the tab right after it, with its back/forward history. A
  // tab whose first page has not committed yet has no history, so its copy
  // loads the address being opened, as does a copy whose history fails to
  // restore. A tab on the search box copies as blank.
  function duplicateTab(id) {
    const tab = find(id)
    if (!tab) return
    const index = tabs.indexOf(tab) + 1
    const destroyed = tab.page.isDestroyed()
    const url = (!destroyed && tab.page.getURL()) || tab.url || tab.pendingUrl || undefined
    const history = destroyed ? null : tab.page.navigationHistory
    const entries = history ? history.getAllEntries() : []
    if (entries.length) return addTab({ history: { entries, index: history.getActiveIndex() }, url, index })
    addTab({ url, index })
  }

  // The kept tab comes to the front first, so closing the others never
  // shows one of them on the way.
  function closeOtherTabs(id) {
    const tab = find(id)
    if (!tab) return
    activate(id)
    for (const other of tabs.filter((each) => each !== tab)) closeTab(other.id)
  }

  function closeTabsToRight(id) {
    const index = tabs.indexOf(find(id))
    if (index === -1) return
    if (index < tabs.indexOf(active())) activate(id)
    for (const other of tabs.slice(index + 1)) closeTab(other.id)
  }

  // The right-click menu for a tab in the strip. Tabs are looked up again
  // on click, as they may have changed while the menu was open.
  function showTabMenu(id) {
    const tab = find(id)
    if (!tab) return
    const keys = Object.fromEntries(['reload', 'duplicateTab', 'closeTab', 'closeOtherTabs', 'closeTabsToRight']
      .map((command) => [command, settings[`shortcuts.${command}`]]))
    popup(tabMenu({ index: tabs.indexOf(tab), count: tabs.length, started: tab.started, keys }), (command) => {
      if (!find(id)) return
      switch (command) {
        case 'reload': return tab.page.isDestroyed() ? undefined : tab.page.reload()
        case 'duplicate': return duplicateTab(id)
        case 'close': return closeTab(id)
        case 'closeOthers': return closeOtherTabs(id)
        case 'closeToRight': return closeTabsToRight(id)
      }
    })
  }

  // The Settings, History and Downloads popups (src/settings.html,
  // src/history.html, src/downloads.html): each is made on first use, then hidden and shown; one is open at a time.
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
    // Their text fields get the editing right-click menu.
    view.webContents.on('context-menu', (_event, params) => showPageMenu(view.webContents, params, false))
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
    view.webContents.send(`${name}-open`, popupState(name))
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
    // Zoom acts on the active tab's page, once it has an address.
    zoomBy: (direction) => { const tab = active(); if (tab?.started) zoomBy(tab, direction) },
    resetZoom: () => { const tab = active(); if (tab?.started) resetZoom(tab) },
    // Every tab's zoom again, or only those on `site`.
    applyZoom(site) {
      for (const tab of tabs) {
        const url = urlOf(tab)
        if (url && (!site || zoom.siteOf(url) === site)) setZoom(tab, zoomFor(url))
      }
      sync()
    },
    isActive: (id) => id === activeId,
    askPermission,
    answerPrompt,
    settlePrompts,
    openFind,
    findText,
    findAgain,
    closeFind,
    openPopup,
    closePopup,
    popupOpen: () => popupOpen,
    openFromHistory,
    showTabMenu,
    duplicateTab: () => duplicateTab(activeId),
    closeOtherTabs: () => closeOtherTabs(activeId),
    closeTabsToRight: () => closeTabsToRight(activeId),
    setRecording: (on, keys) => {
      recording = on
      keyboardLayout = on && keys && typeof keys === 'object' ? keys : {}
    },
    settingsChanged() {
      sendShortcuts()
      popups.settings?.webContents.send('settings-changed', settingsState())
      controls.historyChanged()
    },
    // Save history was turned off: drop what each tab kept to reopen.
    forgetTabHistories() {
      for (const tab of tabs) {
        tab.history = null
        delete tab.closeSnapshot
      }
    },
    historyChanged() {
      if (popupOpen === 'history') popups.history.webContents.send('history-changed', historyState())
    },
    downloadsChanged() {
      sendDownloads()
      if (popupOpen === 'downloads') popups.downloads.webContents.send('downloads-changed', downloadsState())
    },
  }
  windowsByToolbar.set(win.webContents, controls)
  openWindows.add(controls)

  win.on('resize', layout)
  win.webContents.on('context-menu', (_event, params) => showPageMenu(win.webContents, params, false))
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
  win.webContents.on('did-finish-load', () => { sync(); sendShortcuts(); sendDownloads() })
  win.on('closed', () => {
    openWindows.delete(controls)
    if (closingWindow) rememberClosed(closingWindow)
    for (const tab of tabs.splice(0)) {
      for (const prompt of tab.prompts) for (const callback of prompt.callbacks) callback(false)
      if (!tab.page.isDestroyed()) tab.page.close()
    }
    for (const view of Object.values(popups)) view.webContents.close()
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  if (maximized) win.maximize()
  if (fullScreen) win.setFullScreen(true)
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
        { label: 'Duplicate Tab', accelerator: key('duplicateTab'), click: inFocused((c) => { c.closePopup(); c.duplicateTab() }) },
        { label: 'Open Location…', accelerator: key('openLocation'), click: inFocused((c) => { c.closePopup(); c.focusAddress() }) },
        { type: 'separator' },
        // With a popup open, Close Tab closes the popup instead.
        { label: 'Close Tab', accelerator: key('closeTab'), click: inFocused((c) => (c.popupOpen() ? c.closePopup() : c.closeTab())) },
        { label: 'Close Window', accelerator: key('closeWindow'), click: inFocused((c) => c.win.close()) },
        { label: 'Close Other Tabs', accelerator: key('closeOtherTabs'), click: inFocused((c) => { c.closePopup(); c.closeOtherTabs() }) },
        { label: 'Close Tabs to the Right', accelerator: key('closeTabsToRight'), click: inFocused((c) => { c.closePopup(); c.closeTabsToRight() }) },
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
            { label: 'Find…', accelerator: key('find'), click: inFocused((c) => c.openFind(true)) },
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
        // Back to the default zoom from Settings, which may not be 100%.
        { label: 'Reset Zoom', accelerator: key('resetZoom'), click: inFocused((c) => c.resetZoom()) },
        { label: 'Zoom In', accelerator: key('zoomIn'), click: inFocused((c) => c.zoomBy(1)) },
        { label: 'Zoom Out', accelerator: key('zoomOut'), click: inFocused((c) => c.zoomBy(-1)) },
        // ⌘+ (⇧⌘= on most layouts) as well as ⌘=, as in other browsers,
        // while Zoom In is on ⌘= and no command has ⇧⌘= itself.
        ...(key('zoomIn') === 'CmdOrCtrl+=' && !Object.values(settings).includes('Shift+CmdOrCtrl+=')
          ? [hidden('Zoom In', 'CmdOrCtrl+Plus', inFocused((c) => c.zoomBy(1)))]
          : []),
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
        { label: 'Downloads', accelerator: key('downloads'), click: togglePopup('downloads') },
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
// Find messages name the tab the toolbar showed, so a tab switch the
// toolbar has not drawn yet never sends them to another tab.
ipcMain.on('find', fromToolbar((c, tabId, text) => c.isActive(tabId) && typeof text === 'string' && text.length <= findState.MAX_TEXT && c.findText(text)))
ipcMain.on('find-again', fromToolbar((c, tabId, forward) => c.isActive(tabId) && c.findAgain(forward !== false)))
ipcMain.on('close-find', fromToolbar((c, tabId) => c.isActive(tabId) && c.closeFind()))
ipcMain.on('open-settings', fromToolbar((c) => c.openPopup('settings')))
ipcMain.on('open-downloads', fromToolbar((c) => c.openPopup('downloads')))
ipcMain.on('tab-menu', fromToolbar((c, id) => c.showTabMenu(id)))
ipcMain.on('reset-zoom', fromToolbar((c) => c.resetZoom()))
// A prompt's answer: 'allow', 'block', or null to dismiss it, for the
// kinds the row showed.
ipcMain.on('answer-permission', fromToolbar((c, tabId, promptId, kinds, choice) => {
  if (choice === null || permissions.CHOICES.includes(choice)) c.answerPrompt(tabId, promptId, kinds, choice)
}))

// Popup messages, answered only for the popup `name`.
const fromPopup = (name, handler) => (event, ...args) => {
  const popup = windowsByPopup.get(event.sender)
  if (popup?.name === name) return handler(popup.controls, ...args)
}
const fromSettings = (handler) => fromPopup('settings', handler)
const fromHistory = (handler) => fromPopup('history', handler)
const fromDownloads = (handler) => fromPopup('downloads', handler)
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
// Changes or forgets (null) one site's choice for one kind.
ipcMain.handle('permissions-set', fromSettings((_c, site, kind, choice) => {
  const saved = typeof site === 'string' && Object.hasOwn(permissions.KINDS, kind) && sitePermissions.get(site)?.[kind]
  if (saved && (choice === null || permissions.CHOICES.includes(choice))) choosePermission(site, [kind], choice)
  return settingsState()
}))
ipcMain.on('settings-record', fromSettings((c, on, keys) => c.setRecording(on === true, keys)))
ipcMain.on('settings-close', fromSettings((c) => c.closePopup()))

ipcMain.handle('history-get', fromHistory(() => historyState()))
// Only addresses already in history can be opened from it.
ipcMain.on('history-open-page', fromHistory((c, url, background) => {
  if (visited.some((entry) => entry.url === url)) c.openFromHistory(url, background === true)
}))
// Removing and clearing answer with the state, saying so if nothing changed.
ipcMain.handle('history-remove', fromHistory((_c, url) => (setVisited(historyStore.remove(visited, url), { now: true })
  ? historyState()
  : historyState('Couldn’t save history, so that page wasn’t removed.'))))
// Clearing history forgets closed tabs too.
ipcMain.handle('history-clear', fromHistory(() => {
  if (!setVisited([], { now: true })) return historyState('Couldn’t save history, so nothing was cleared.')
  forgetClosed()
  return historyState()
}))
ipcMain.on('history-close', fromHistory((c) => c.closePopup()))

const downloadById = (id) => downloads.find((download) => download.id === id)
ipcMain.handle('downloads-get', fromDownloads(() => downloadsState()))
// Only a download still on its way can be cancelled; done fires next.
ipcMain.on('downloads-cancel', fromDownloads((_c, id) => downloadById(id)?.item?.cancel()))
ipcMain.on('downloads-show', fromDownloads((_c, id) => {
  const download = downloadById(id)
  if (download?.state === 'completed') shell.showItemInFolder(download.path)
}))
// Clear keeps downloads still on their way. Clearing them all takes the
// toolbar button away, and the popup hanging from it closes too.
ipcMain.on('downloads-clear', fromDownloads((c) => {
  const active = downloads.filter(downloadsStore.isActive)
  if (active.length === downloads.length) return
  downloads.splice(0, downloads.length, ...active)
  downloadsChanged(true)
  if (!downloads.length) c.closePopup()
}))
ipcMain.on('downloads-close', fromDownloads((c) => c.closePopup()))

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json')
  settings = settingsStore.load(settingsFile)
  zoomFile = path.join(app.getPath('userData'), 'zoom.json')
  siteZooms = zoom.load(zoomFile)
  permissionsFile = path.join(app.getPath('userData'), 'permissions.json')
  sitePermissions = permissions.load(permissionsFile)
  session.defaultSession.setPermissionRequestHandler(onPermissionRequest)
  session.defaultSession.setPermissionCheckHandler(onPermissionCheck)
  historyFile = path.join(app.getPath('userData'), 'history.json')
  visited = historyStore.load(historyFile)
  applyDoNotTrack()
  session.defaultSession.on('will-download', (_event, item) => trackDownload(item))
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
