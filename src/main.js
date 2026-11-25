// Lit's main process. Each window has a toolbar on top (src/index.html,
// the window's own page) and one Chromium WebContentsView per tab below it.
// Only the active tab's view is visible. The Settings, History and
// Downloads popups are each one more view, transparent and over
// everything, shown only while open. Find in page lives in the toolbar; each tab keeps its own
// search (src/find.js). A site asking for the camera, location and the like
// gets a prompt in the toolbar, below the address row (src/permissions.js).
// The toolbar also draws the page shown in place of one that failed to load
// or crashed (src/errors.js), while that tab's view is hidden.
// A private window (⇧⌘N) browses in an in-memory session of its own and
// keeps nothing once it closes (see privateSession), except the bookmarks
// someone adds in it. Every window belongs to one profile (see openProfile).
const { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, ipcMain, nativeImage, screen, session, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { toUrl, searchUrl, engineOf } = require('./url')
const quickSearch = require('./quicksearch')
const { afterClose, step, byNumber, remember, keepNewest, reopenIndex, onScreen } = require('./tabs')
const settingsStore = require('./settings')
const historyStore = require('./history')
const bookmarkStore = require('./bookmarks')
const sessionStore = require('./session')
const shortcuts = require('./shortcuts')
const downloadsStore = require('./downloads')
const zoom = require('./zoom')
const permissions = require('./permissions')
const errors = require('./errors')
const profileStore = require('./profiles')
const findState = require('./find')
const { pageMenu, tabMenu, bookmarkMenu } = require('./menus')
const { createAdblock } = require('./adblock')

// Keep in sync with .strip and .bar heights in index.html.
const STRIP_HEIGHT = 38
const BAR_HEIGHT = STRIP_HEIGHT + 44
// The permission prompt's row under the address row; keep in sync with
// .prompt in index.html. Pages move down by this while their tab asks.
const PROMPT_HEIGHT = 44
// The bookmark bar's row, above the prompt; keep in sync with .bookmarks in
// index.html.
const BOOKMARKS_HEIGHT = 34
const PRELOAD = path.join(__dirname, 'preload.js')
// Keep in sync with .menu padding and .row height in suggestions.html.
const SUGGESTION_ROW = 38
const SUGGESTIONS_PAD = 5
// How long the suggestions list takes to fade out (its opacity transition).
const SUGGESTIONS_FADE = 160

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

// Every profile, the default one first, each an object openProfile makes; and
// their saved list (src/profiles.js). `currentProfile` is the one of the
// window focused last, where a new window opens when none is.
let profiles = []
let profileList
let profilesFile
let currentProfile

// Opens a profile's session and reads its files. Everything that differs
// between profiles is on the object:
// - settings: its own values and the shared ones together (src/settings.js),
//   saved on every change.
// - siteZooms: each site's zoom, when it differs from the default (see
//   src/zoom.js), saved whenever one changes.
// - sitePermissions: each site's Allow or Block, per kind (see
//   src/permissions.js), saved whenever one changes.
// - permissionStore: where its session's permission choices live: `sites` to
//   read them, and `choose` to change one, which returns whether it was
//   saved. A private window has a store of its own (see createWindow).
// - visited: pages visited (src/history.js), newest first; historySave is
//   the timer of a save still waiting.
// - bookmarks (src/bookmarks.js), which its private windows share.
// - closed: recently closed tabs and windows, newest last, for Reopen Closed
//   Tab (see rememberClosed).
// `deleted` is set once it is deleted, when nothing of it is saved any more.
// Its id never changes; its name and color follow the saved list.
function openProfile({ id, name, color }) {
  const folder = profileStore.folder(app.getPath('userData'), id)
  const partition = profileStore.partition(id)
  const files = Object.fromEntries(['settings', 'zoom', 'permissions', 'history', 'bookmarks'].map((file) => [file, path.join(folder, `${file}.json`)]))
  const own = settingsStore.load(files.settings)
  const profile = {
    id, name, color, files,
    session: partition ? session.fromPartition(partition) : session.defaultSession,
    // The default profile's file holds the shared settings too.
    settings: profiles.length ? settingsStore.combine(own, profiles[0].settings) : own,
    siteZooms: zoom.load(files.zoom),
    sitePermissions: permissions.load(files.permissions),
    visited: historyStore.load(files.history),
    historySave: null,
    bookmarks: bookmarkStore.load(files.bookmarks),
    closed: [],
    deleted: false,
  }
  profile.permissionStore = {
    get sites() { return profile.sitePermissions },
    choose: (site, kinds, choice) => choosePermission(profile, site, kinds, choice),
  }
  setUpSession(profile.session, profile, profile.permissionStore)
  profiles.push(profile)
  return profile
}

const windowsOf = (profile) => [...openWindows].filter((controls) => controls.profile === profile)
// Settings every profile shares.
const shared = () => profiles[0].settings

// Saves a changed list of profiles; returns whether it was saved. Names and
// colors reach every window.
function setProfileList(next) {
  try {
    profileStore.save(profilesFile, next)
  } catch {
    return false
  }
  profileList = next
  for (const profile of profiles) Object.assign(profile, next.profiles.find(({ id }) => id === profile.id))
  return true
}

function profilesChanged() {
  Menu.setApplicationMenu(buildMenu())
  for (const controls of openWindows) { controls.profileChanged(); controls.settingsChanged() }
}

// A window of `profile` came to the front. The menu shows what is its own;
// the next launch starts with it, unless the window is private.
function profileUsed(profile, isPrivate) {
  if (quitting || profile.deleted) return
  if (currentProfile !== profile) {
    currentProfile = profile
    Menu.setApplicationMenu(buildMenu())
  }
  // Unsaved, the next launch starts with the one before.
  if (!isPrivate && profileList.last !== profile.id) setProfileList({ ...profileList, last: profile.id })
}

// Brings back the profile's window used last, or opens one.
function switchProfile(profile) {
  if (profile.deleted) return
  const controls = windowsOf(profile).filter((each) => !each.isPrivate).at(-1)
  if (!controls) return createWindow({ profile })
  if (controls.win.isMinimized()) controls.win.restore()
  controls.win.focus()
  return controls
}

// Returns why it couldn't, if so. A saved ad blocking engine is in use before
// the profile can be opened, as at launch.
async function addProfile() {
  const { state, profile } = profileStore.add(profileList)
  if (!setProfileList(state)) return 'Couldn’t save profiles.'
  const opened = openProfile(profile)
  await adblock.set(opened.session, opened.settings.blockAds)
  profilesChanged()
}

function updateProfile(id, changes) {
  const { state, error } = profileStore.update(profileList, id, changes)
  if (error) return error
  if (!setProfileList(state)) return 'Couldn’t save profiles.'
  profilesChanged()
}

// Deletes a profile and all it holds, after asking. Its windows close without
// asking their pages, its session is cleared, and what Chromium still holds
// on disk goes at the next launch (sweep in src/profiles.js). Being off the
// saved list first, it never comes back half deleted.
async function deleteProfile(win, id) {
  const profile = profiles.find((each) => each.id === id)
  if (!profile || id === profileStore.DEFAULT) return
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete “${profile.name}”?`,
    detail: 'Its history, bookmarks, settings, sign-ins and site data are deleted, its windows close, and downloads on their way are cancelled. This can’t be undone.',
  })
  if (response !== 0 || profile.deleted) return
  if (!setProfileList(profileStore.remove(profileList, id))) return 'Couldn’t save profiles, so nothing was deleted.'
  profile.deleted = true
  clearTimeout(profile.historySave)
  profile.historySave = null
  profiles = profiles.filter((each) => each !== profile)
  if (currentProfile === profile) currentProfile = profiles[0]
  const windows = windowsOf(profile)
  // Lit stays in view, in another profile.
  if (windows.length === openWindows.size) switchProfile(profiles[0])
  const pages = windows.flatMap((controls) => controls.pages())
  for (const controls of windows) controls.win.destroy()
  dropDownloads(profile.session)
  profilesChanged()
  saveSession()
  try {
    fs.rmSync(profileStore.folder(app.getPath('userData'), id), { recursive: true, force: true })
  } catch {
    // The next launch tries again.
  }
  forgetSession(profile.session, pages)
}

// Remembers a closed tab or window, for Reopen Closed Tab.
// Only closes people make count (⌘W, the close button, closing a window),
// not a page closing itself; a blank tab has a null history and comes
// back blank. Nothing is kept while Save history is off.
// A tab: { windowKey, index, history }, back in its window if that is open.
// A window: { key, tabs: [history], activeIndex, bounds, maximized,
// fullScreen }, so tab order, the active tab and its place come back as they were.
// A history is { entries, index } from navigationHistory, so back and
// forward come back too. Kept in memory only, so Lit forgets them when it
// quits; the Closed tabs to remember setting caps how many.
function rememberClosed(profile, entry) {
  if (!profile.settings.saveHistory) return
  remember(profile.closed, entry, profile.settings.closedTabsLimit)
  refreshReopen()
}

const zoomFor = (profile, url) => profile.siteZooms.get(zoom.siteOf(url)) ?? profile.settings.defaultZoom

// Zooms every tab on `url`'s site, in the profile's windows, and remembers it;
// zooming back to the default forgets the site. A step past the last zoom,
// or a reset at the default, changes nothing.
function zoomSite(profile, url, factor) {
  const site = zoom.siteOf(url)
  if (!site) return
  const forget = zoom.same(factor, profile.settings.defaultZoom)
  const saved = profile.siteZooms.get(site)
  if (forget ? saved === undefined : saved !== undefined && zoom.same(saved, factor)) return
  const next = new Map(profile.siteZooms)
  if (forget) next.delete(site)
  else next.set(site, factor)
  profile.siteZooms = next
  try {
    zoom.save(profile.files.zoom, profile.siteZooms)
  } catch {
    // Unsaved, the zoom still holds until Lit quits.
  }
  for (const controls of windowsOf(profile)) controls.applyZoom(site)
}

// Saves `choice` ('allow', 'block', or null to forget) for the kinds, then
// answers every prompt it settles, in the profile's windows. Unsaved, a choice still
// holds until Lit quits; returns whether it was saved.
function choosePermission(profile, site, kinds, choice) {
  profile.sitePermissions = permissions.choose(profile.sitePermissions, site, kinds, choice)
  let saved = true
  try {
    permissions.save(profile.files.permissions, profile.sitePermissions)
  } catch {
    saved = false
  }
  for (const controls of windowsOf(profile)) { controls.settlePrompts(); controls.settingsChanged() }
  return saved
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
// A frame from the page's own site is treated like the page for the camera
// and microphone, whose requests carry the frame's real origin
// (`securityOrigin`). Other requests carry only the frame's address, which a
// sandboxed frame keeps without the origin, so frames are refused those.
// The prompt names the site, not the frame, so its answer stays right even
// if the frame has gone. Anything not from a tab (Lit's own pages, a
// service worker) is refused too. `store` is the session's choices.
function onPermissionRequest(store, contents, permission, callback, details) {
  const kinds = permissions.kindsOf(permission, details.mediaTypes)
  if (!kinds) return callback(true)
  const site = siteFor(contents, details.securityOrigin ?? details.requestingUrl)
  if (!site || !kinds.length) return callback(false)
  if (!details.isMainFrame && !details.securityOrigin) return callback(false)
  const answer = permissions.status(store.sites, site, kinds)
  if (answer !== 'ask') return callback(answer === 'allow')
  for (const controls of openWindows) {
    if (controls.askPermission(contents, site, kinds, callback)) return
  }
  callback(false)
}

// Checks (Notification.permission, navigator.permissions.query, device
// labels) say yes only once a site was allowed. Electron has no "not asked
// yet", so until then they read as denied; asking still prompts. A frame
// reads as its requests are answered: its site's camera and microphone
// choices, and no for the rest. A check names the frame's real origin
// (`requestingOrigin`). A service worker (no page) reads its site's choice.
function onPermissionCheck(store, contents, permission, requestingOrigin, details) {
  const kinds = permissions.checkKindsOf(permission, details.mediaType)
  if (!kinds) return true
  if (contents && !details.isMainFrame && permission !== 'media') return false
  const site = siteFor(contents, requestingOrigin, details.embeddingOrigin)
  return Boolean(site) && kinds.length > 0 && permissions.status(store.sites, site, kinds) === 'allow'
}

// What every session browsing pages needs: Lit's permission prompts, Do
// Not Track, and downloads followed into the Downloads list.
function setUpSession(ses, profile, store) {
  ses.setPermissionRequestHandler((...args) => onPermissionRequest(store, ...args))
  ses.setPermissionCheckHandler((...args) => onPermissionCheck(store, ...args))
  ses.on('will-download', (_event, item) => trackDownload(item, ses, profile))
  applyDoNotTrack(ses, profile)
}

// Private windows' sessions, while their windows are open -> their profile.
const privateSessions = new Map()

// Each private window browses in a session of its own, in memory only (a
// partition without "persist:"), so its cookies, cache and site storage
// never reach disk, and no other window, private or not, sees them. It has
// no HTTP cache at all, so pages it loads aren't kept even in memory.
// Closing the window clears it (see forgetSession), as Electron keeps a
// session object around until Lit quits.
function privateSession(key, profile, store) {
  const ses = session.fromPartition(`private-${key}`, { cache: false })
  setUpSession(ses, profile, store)
  adblock.set(ses, profile.settings.blockAds)
  privateSessions.set(ses, profile)
  return ses
}

// Forgets a closed private window's session, or a deleted profile's.
// Refuses everything a closing window's pages still ask for, waits until
// they (`pages`, its WebContents) are gone, so none can write after the
// clearing, then clears all the session holds, one step at a time. The
// handlers stay, as Electron allows every permission without them; these
// hold nothing of the window. A failure is logged without saying what the
// window visited.
async function forgetSession(ses, pages) {
  privateSessions.delete(ses)
  adblock.remove(ses)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.removeAllListeners('will-download')
  ses.on('will-download', (event) => event.preventDefault())
  ses.webRequest.onBeforeSendHeaders(null)
  ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
  await Promise.all(pages.map((page) => !page || page.isDestroyed() || new Promise((resolve) => page.once('destroyed', resolve))))
  for (const [step, run] of [
    ['close connections', () => ses.closeAllConnections()],
    ['clear data', () => ses.clearData()],
    ['clear sign-ins', () => ses.clearAuthCache()],
    ['clear host lookups', () => ses.clearHostResolverCache()],
  ]) {
    try {
      await run()
    } catch {
      console.error(`Couldn’t ${step} of a closed private window or deleted profile.`)
    }
  }
}

// History is saved a moment after a visit, so a burst of navigations writes
// once; removing pages saves right away, so they can't come back after a
// crash. Returns whether the write worked.
function saveVisited(profile) {
  clearTimeout(profile.historySave)
  profile.historySave = null
  try {
    historyStore.save(profile.files.history, profile.visited)
    return true
  } catch {
    return false
  }
}

// `now` saves right away and keeps the old list if that fails, so a page
// someone removed never comes back after a restart. Returns whether the
// change was made.
function setVisited(profile, next, { now = false } = {}) {
  if (next === profile.visited) return true
  if (profile.deleted) return false
  const before = profile.visited
  profile.visited = next
  if (now && !saveVisited(profile)) {
    profile.visited = before
    return false
  }
  if (!now) {
    clearTimeout(profile.historySave)
    profile.historySave = setTimeout(() => saveVisited(profile), 1000)
  }
  for (const controls of windowsOf(profile)) controls.historyChanged()
  return true
}

// Records a visit and returns what unvisit needs to take it back, or
// null when nothing was recorded (Save history is off, or not a real page).
// Which navigations count as visits is up to the tab (see `committed`).
// Each visit gets its own time, so unvisit never mistakes one for another.
let lastVisitTime = 0
function recordVisit(profile, url, title) {
  if (!profile.settings.saveHistory || !historyStore.recordable(url)) return null
  const previous = profile.visited.find((entry) => entry.url === url) || null
  const time = lastVisitTime = Math.max(Date.now(), lastVisitTime + 1)
  setVisited(profile, historyStore.visit(profile.visited, { url, title, time }))
  return { url, time, previous }
}

// Visits taken back after the same page was visited again (by another
// tab), by time: one taken back later must not bring them back as its
// `previous`, so it goes past them to theirs.
const takenBack = new Map()
function takeBack(profile, visit) {
  let previous = visit.previous
  while (previous && takenBack.has(previous.time)) previous = takenBack.get(previous.time).previous
  const next = historyStore.unvisit(profile.visited, { ...visit, previous })
  if (next === profile.visited) takenBack.set(visit.time, { ...visit, previous })
  else setVisited(profile, next)
}

// How soon after loading a page that loads another by itself, untouched,
// counts as redirecting rather than as a page someone read.
const REDIRECT_AFTER = 5000
// Run on a page to end its full screen. A page can have one element full
// screen over another, so it leaves each (up to a point, as a page can break
// exitFullscreen). One told it may enter has not done so yet, and can't leave
// before it has; waiting for that ends soon, so as not to undo a later one.
const EXIT_FULL_SCREEN = `{
  const exit = async () => {
    try {
      for (let tries = 20; document.fullscreenElement && tries; tries--) await document.exitFullscreen()
    } catch {}
  }
  if (document.fullscreenElement) exit()
  else document.addEventListener('fullscreenchange', exit, { once: true, signal: AbortSignal.timeout(1000) })
}`

// Chromium's code for a load that was stopped, not one that failed.
const ERR_ABORTED = -3
// The isolated world Lit asks a page in, apart from the page's own scripts.
const CHECK_WORLD = 1001

// A page's address without its #fragment, to tell a jump within a page
// from a new page.
const withoutHash = (url) => url.split('#')[0]

// Saved first, so a failed write keeps the old list. Returns whether the
// change was made.
function setBookmarks(profile, next) {
  if (next === profile.bookmarks) return true
  if (profile.deleted) return false
  try {
    bookmarkStore.save(profile.files.bookmarks, next)
  } catch {
    return false
  }
  profile.bookmarks = next
  for (const controls of windowsOf(profile)) controls.bookmarksChanged()
  return true
}

// The same, for changes with nowhere of their own to show a failure.
function changeBookmarks(profile, win, next) {
  if (setBookmarks(profile, next)) return true
  if (!win.isDestroyed()) dialog.showMessageBox(win, { type: 'warning', message: 'Couldn’t save bookmarks', detail: 'Nothing was changed.' }).catch(() => {})
  return false
}

// A site's icon as a data: URL, from its address: pictures Electron can
// read are scaled to 32px, others (SVG, ICO) kept if small. '' if it can't
// be had. A bigger file is dropped as it arrives, so a page can't fill
// memory with its icon.
const ICON_DOWNLOAD_LIMIT = 1024 * 1024
const ICON_LIMIT = 64 * 1024
async function fetchIcon(url, ses) {
  try {
    if (!/^(https?|data):/i.test(url)) return ''
    const response = await ses.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) })
    const type = (response.headers.get('content-type') || '').split(';')[0].trim()
    if (!response.ok || !/^image\/[\w.+-]+$/.test(type)) return ''
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > ICON_DOWNLOAD_LIMIT) return ''
      chunks.push(chunk)
    }
    const data = Buffer.concat(chunks)
    const image = nativeImage.createFromBuffer(data)
    if (!image.isEmpty()) return image.resize({ width: 32, height: 32 }).toDataURL()
    return data.length <= ICON_LIMIT ? `data:${type};base64,${data.toString('base64')}` : ''
  } catch {
    return ''
  }
}

// Gives `url`'s bookmarks without an icon theirs, from a page showing it.
async function addIcon(profile, url, favicon, ses) {
  const missing = () => bookmarkStore.pages(profile.bookmarks).filter((item) => item.url === url && !item.icon)
  if (!favicon || !missing().length) return
  const icon = await fetchIcon(favicon, ses)
  if (icon) setBookmarks(profile, missing().reduce((list, item) => bookmarkStore.update(list, item.id, { icon }), profile.bookmarks))
}

// The windows and tabs to reopen at the next launch (src/session.js),
// saved a moment after anything in them changes, so a crash loses little,
// and once more as Lit quits. Windows closing one by one during a quit
// change nothing: the session is what was open when the quit began.
let sessionFile
let sessionSave = null
let quitting = false

function saveSession() {
  clearTimeout(sessionSave)
  sessionSave = null
  if (!sessionFile) return
  try {
    if (!shared().restoreSession) return sessionStore.forget(sessionFile)
    sessionStore.save(sessionFile, [...openWindows].map((controls) => controls.snapshot()).filter(Boolean))
  } catch {
    // Unsaved, the session saved last reopens instead.
  }
}

function sessionChanged() {
  if (quitting || sessionSave) return
  sessionSave = setTimeout(saveSession, 1000)
}

// What the History popup draws.
// `closedTabs` counts tabs and windows Reopen Closed Tab still has, which
// Clear History also forgets.
// `error` says why the last removal didn't happen.
const historyState = (profile, error) => ({ entries: profile.visited, enabled: profile.settings.saveHistory, closedTabs: profile.closed.length, ...(error && { error }) })

function forgetClosed(profile) {
  profile.closed.length = 0
  refreshReopen()
}

// This run's downloads, newest first, in memory only: { id, item, session,
// path, state, received, total, speed } (see src/downloads.js). One joins
// the list once it has somewhere to go, so a save dialog someone cancels
// never shows. A window shows the downloads of its browsing session: every
// normal window of a profile the same ones, a private window only its own, which go
// (cancelled if still on their way) when it closes.
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

const downloadsOf = (ses) => downloads.filter((download) => download.session === ses)
const downloadsSummary = (ses) => downloadsStore.summary(downloadsOf(ses))

// What the Downloads popup draws. A finished file someone has since moved
// or deleted says so, and can no longer be shown in Finder.
function downloadsState(ses) {
  return {
    downloads: downloadsOf(ses).map((download) => downloadsStore.row({
      ...download,
      missing: download.state === 'completed' && !fs.existsSync(download.path),
    })),
  }
}

// Follows one download from will-download to done. Saving straight to
// Downloads, when Settings says so; otherwise Electron asks where to save.
// A private window always asks, so no site there writes a file unasked.
// Paths of unfinished downloads count as taken, so two same-name downloads
// never share one.
const downloading = new Set()
// Every download not done yet, listed or still in its save dialog, so
// closing a private window can cancel all of its own.
const unfinished = new Set()
const askWhereToSave = (ses, profile) => profile.settings.downloadLocation !== 'downloads' || privateSessions.has(ses)
function trackDownload(item, ses, profile) {
  let file = null
  if (!askWhereToSave(ses, profile)) {
    file = downloadsStore.uniquePath(app.getPath('downloads'), item.getFilename(), (candidate) => downloading.has(candidate) || fs.existsSync(candidate))
    downloading.add(file)
    item.setSavePath(file)
  }
  const download = { id: nextDownloadId++, item, session: ses, path: '', state: 'progressing', received: 0, total: 0, speed: 0 }
  const read = (state) => {
    download.state = state
    download.path = item.getSavePath()
    download.received = item.getReceivedBytes()
    download.total = item.getTotalBytes()
    download.speed = state === 'progressing' ? item.getCurrentBytesPerSecond() : 0
    // Listed once it has a place: right away, or after the save dialog;
    // never again once its private window has dropped it.
    if (!download.path || download.dropped || downloads.includes(download)) return false
    downloads.unshift(download)
    return true
  }
  item.on('updated', (_event, state) => downloadsChanged(read(state)))
  item.once('done', (_event, state) => {
    unfinished.delete(download)
    if (file) downloading.delete(file)
    read(state === 'interrupted' ? 'failed' : state)
    // Done with Electron's item; the list keeps what it last said.
    download.item = null
    // The Dock's Downloads stack is shared, so a private one doesn't bounce it.
    if (state === 'completed' && !privateSessions.has(ses) && !download.dropped) app.dock?.downloadFinished(download.path)
    downloadsChanged(true)
  })
  unfinished.add(download)
  if (read('progressing')) downloadsChanged(true)
}

// A session going away takes its downloads with it, those on their way (or in
// their save dialog) cancelled; files already saved stay where they were
// saved. A dropped download never joins the list again.
function dropDownloads(ses) {
  for (const download of unfinished) {
    if (download.session !== ses) continue
    download.dropped = true
    download.item?.cancel()
  }
  downloads.splice(0, downloads.length, ...downloads.filter((download) => download.session !== ses))
  downloadsChanged(true)
}

// What a popup draws when it opens in the window `c`.
const popupState = (name, c) => ({
  settings: () => ({ ...settingsState(c.profile), section: c.settingsSection() }),
  history: () => historyState(c.profile),
  downloads: () => downloadsState(c.session),
})[name]()

// What the Settings popup draws in a window of `profile`: the values, plus
// each shortcut as ⌘ symbols, and every profile.
function settingsState(profile, error) {
  const { settings, sitePermissions } = profile
  const labels = {}
  for (const setting of settingsStore.SETTINGS) {
    if (setting.type === 'shortcut') labels[setting.key] = settings[setting.key] ? shortcuts.label(settings[setting.key]) : ''
  }
  return { sections: settingsStore.SECTIONS, values: settings, labels, sitePermissions: permissions.list(sitePermissions), quickSearchSites: quickSearch.list(), profileId: profile.id, profiles: profileList.profiles, profileColors: profileStore.COLORS, ...(error && { error }) }
}

// Where typed text goes: a quick search shortcut's site (`!yt lofi`), else
// an address or a search with the chosen engine.
const destination = (input, settings) =>
  (settings.quickSearch && quickSearch.resolve(input, settings.quickSearchPrefix)) || toUrl(input, settings.searchEngine)

// Do Not Track and Global Privacy Control headers, only while turned on.
function applyDoNotTrack(ses, profile) {
  ses.webRequest.onBeforeSendHeaders(profile.settings.doNotTrack
    ? (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } })
    : null)
}

// A profile's session, and those of its private windows.
const sessionsOf = (profile) => [profile.session, ...[...privateSessions].filter(([, owner]) => owner === profile).map(([ses]) => ses)]

// Ad and tracker blocking, in private sessions too (src/adblock.js), made at
// launch and switched with each profile's Block ads and trackers setting.
let adblock

// After a closed list changes: the menu item is grayed out while there
// is nothing to reopen, and an open History learns what Clear would forget.
function refreshReopen() {
  const item = Menu.getApplicationMenu()?.getMenuItemById('reopenTab')
  if (item) item.enabled = currentProfile.closed.length > 0
  for (const controls of openWindows) controls.historyChanged()
}

// The last closed tab goes back where it was: its own window if still open,
// else the focused one, else a new window. A closed window reopens whole.
// Private windows remember nothing, and never take a tab from a normal
// one: from a private window, its profile's normal window in front last gets
// it. Profiles each have their own list.
function reopenClosed(focused) {
  const profile = focused?.profile ?? currentProfile
  const entry = profile.closed.pop()
  if (!entry) return
  refreshReopen()
  if (entry.tabs) return createWindow({ ...entry, profile })
  const normal = focused?.isPrivate ? windowsOf(profile).filter((c) => !c.isPrivate).at(-1) : focused
  const target = [...openWindows].find((c) => c.key === entry.windowKey) || normal
  if (!target) return createWindow({ profile, tabs: [entry.history] })
  if (target !== focused) {
    if (target.win.isMinimized()) target.win.restore()
    target.win.focus()
  }
  target.reopenTab(entry.history, entry.index)
}

// After a change: rebuild the menu for new shortcuts, and tell every window.
function applySettings() {
  Menu.setApplicationMenu(buildMenu())
  for (const profile of profiles) {
    for (const ses of sessionsOf(profile)) {
      applyDoNotTrack(ses, profile)
      adblock.set(ses, profile.settings.blockAds)
    }
    if (!profile.settings.saveHistory) {
      forgetClosed(profile)
      for (const controls of windowsOf(profile)) controls.forgetTabHistories()
    } else {
      keepNewest(profile.closed, profile.settings.closedTabsLimit)
      refreshReopen()
    }
  }
  for (const controls of openWindows) { controls.applyZoom(); controls.settingsChanged() }
  // Turning Reopen windows off forgets the saved session now; Save history
  // changes how much of each tab it keeps.
  saveSession()
}

// Changes one setting, for `profile` or, when it is a shared one, for all;
// returns why it couldn't, if so.
function changeSetting(profile, key, value) {
  const { values, error } = settingsStore.update(profile.settings, key, value)
  if (error) return error
  if (profile.deleted) return 'This profile was deleted.'
  const target = settingsStore.isProfile(key) ? profile : profiles[0]
  const next = { ...target.settings, [key]: values[key] }
  // Saved first, so a failed write leaves the old settings in use.
  try {
    settingsStore.save(target.files.settings, target === profiles[0] ? next : settingsStore.ownOf(next))
  } catch {
    return 'Couldn’t save settings.'
  }
  target.settings = next
  for (const each of profiles) each.settings = settingsStore.combine(each.settings, profiles[0].settings)
  applySettings()
}

// Applying the settings rebuilds the menu, so its checkbox follows; after
// a failure the rebuild puts it back.
function toggleBookmarkBar(profile) {
  if (!changeSetting(profile, 'bookmarkBar', !profile.settings.bookmarkBar)) return
  Menu.setApplicationMenu(buildMenu())
  dialog.showMessageBox({ type: 'warning', message: 'Couldn’t save settings' }).catch(() => {})
}

// `key`, `tabs`, `activeIndex`, `bounds`, `maximized` and `fullScreen` reopen
// a closed window (see `closed`). Its old position is used only while it is
// still on a connected display; otherwise only its size.
// `url` opens in the new window's first tab.
// `profile` is the one it browses as, for good; everything in it, from its
// session to its settings, is that profile's.
// `isPrivate` opens a private window: its own in-memory session, no history,
// nothing to reopen, and no part in the session saved for the next launch.
// It has its profile's settings and bookmarks, but
// suggests only bookmarks, nothing from history, and starts every site at the default
// zoom; only the sites' saved Blocks reach it. What changes in it goes when
// it closes.
function createWindow({ key = nextWindowKey++, profile = currentProfile, isPrivate = false, url, tabs: restored = [], activeIndex = 0, bounds, maximized, fullScreen } = {}) {
  // A private window's own permission choices, kept in memory, under the
  // saved Blocks, which always win (choosePermission settles its prompts too).
  const permissionStore = isPrivate
    ? (() => {
        let own = new Map()
        return {
          get sites() { return permissions.privateView(profile.sitePermissions, own) },
          choose(site, kinds, choice) { own = permissions.choose(own, site, kinds, choice); settlePrompts(); return true },
        }
      })()
    : profile.permissionStore
  const ses = isPrivate ? privateSession(key, profile, permissionStore) : profile.session
  // A private window's own site zooms, apart from the saved ones.
  const privateZooms = new Map()
  const zoomOf = (url) => (isPrivate ? privateZooms.get(zoom.siteOf(url)) ?? profile.settings.defaultZoom : zoomFor(profile, url))
  // Whether the site has a zoom of its own, which the address bar shows.
  const ownZoom = (url) => (isPrivate ? privateZooms : profile.siteZooms).has(zoom.siteOf(url))
  function changeZoom(url, factor) {
    if (!isPrivate) return zoomSite(profile, url, factor)
    const site = zoom.siteOf(url)
    if (!site) return
    if (zoom.same(factor, profile.settings.defaultZoom)) privateZooms.delete(site)
    else privateZooms.set(site, factor)
    controls.applyZoom(site)
  }
  const place = bounds && onScreen(bounds, screen.getAllDisplays().map((display) => display.workArea))
    ? bounds
    : { width: bounds?.width || 1200, height: bounds?.height || 800 }
  const win = new BrowserWindow({
    ...place,
    minWidth: 480,
    minHeight: 320,
    // Matches body's background in index.html.
    backgroundColor: isPrivate ? '#0c0a12' : '#090909',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    // A private window's own pages (toolbar, popups, suggestions) use its
    // session too, so nothing of it lands in the profile on disk.
    webPreferences: { preload: PRELOAD, session: ses },
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
  let settingsSection
  // Whether the toolbar had focus when a popup opened, to give it back.
  let toolbarHadFocus = false
  // The keyboard layout's code -> character map, sent by the popup.
  let keyboardLayout = {}
  // How far down the pages start: lower with the bookmark bar, and while the
  // active tab has a prompt; at the very top, over the toolbar, while the
  // active page is full screen.
  let pageTop = BAR_HEIGHT
  // The tab whose page took the window full screen with it, if one did: the
  // window leaves with that page. One you made full screen yourself stays.
  let fullScreenFor = null
  // Whether the window is full screen, from its own events: by the time a
  // page's is announced, Electron has already asked the window to change.
  let windowFullScreen = false

  // Everything the toolbar draws. Sent whenever any of it changes.
  function sync() {
    if (win.isDestroyed()) return
    const current = active()
    const top = current?.fullScreen === 'on' ? 0 : BAR_HEIGHT + (profile.settings.bookmarkBar ? BOOKMARKS_HEIGHT : 0) + (current?.prompts.length ? PROMPT_HEIGHT : 0)
    if (top !== pageTop) { pageTop = top; layout() }
    const title = current?.title || (current?.started ? current.url : '') || 'New Tab'
    const named = profiles.length > 1 ? `${title} — ${profile.name}` : title
    win.setTitle(isPrivate ? `${named} (Private)` : named)
    win.webContents.send('tabs', {
      activeId,
      tabs: tabs.map(({ id, title, url, favicon, loading, started, find, zoom: factor, page, prompts, error }) => ({
        id, title, url, favicon, loading, started,
        // The tab's oldest unanswered permission request; the rest wait.
        prompt: prompts[0] && { id: prompts[0].id, site: permissions.label(prompts[0].site), kinds: asking(prompts[0]), does: permissions.describe(asking(prompts[0])) },
        // The address bar shows the zoom, to reset it, when it is not the
        // default or the site has its own (which can match a later default).
        zoom: started && !error && (!zoom.same(factor, profile.settings.defaultZoom) || ownZoom(page.isDestroyed() ? '' : page.getURL()))
          ? zoom.percent(factor)
          : '',
        find: find && { text: find.text, active: find.active, matches: find.matches },
        error: error && {
          ...errors.describe(error, url),
          action: error.kind === 'crash' ? 'Reload' : 'Try again',
          canGoBack: !page.isDestroyed() && page.navigationHistory.canGoBack(),
        },
      })),
    })
    // A private window is no part of the saved session.
    if (!isPrivate) sessionChanged()
  }

  // The toolbar's tooltips show the current shortcuts.
  const sendShortcuts = () => { if (!win.isDestroyed()) win.webContents.send('shortcuts', settingsState(profile).labels) }
  // What the toolbar needs to turn a typed shortcut into a site chip, or
  // null while quick search is off.
  const sendQuickSearch = () => {
    if (!win.isDestroyed()) win.webContents.send('quick-search', profile.settings.quickSearch ? { prefix: profile.settings.quickSearchPrefix, sites: quickSearch.list() } : null)
  }
  const sendBookmarks = () => { if (!win.isDestroyed()) win.webContents.send('bookmarks', { visible: profile.settings.bookmarkBar, items: profile.bookmarks }) }
  // The toolbar's profile button, shown while there is more than one.
  const sendProfile = () => { if (!win.isDestroyed()) win.webContents.send('profile', { name: profile.name, color: profileStore.colorOf(profile.color).value, shown: profiles.length > 1 }) }
  // The toolbar's downloads indicator.
  const sendDownloads = () => { if (!win.isDestroyed()) win.webContents.send('downloads', downloadsSummary(ses)) }

  function layout() {
    const { width, height } = win.getContentBounds()
    for (const tab of tabs) tab.view.setBounds({ x: 0, y: pageTop, width, height: Math.max(height - pageTop, 0) })
    for (const view of Object.values(popups)) view.setBounds({ x: 0, y: 0, width, height })
  }

  // Takes a full screen page out of it, bringing the toolbar back right
  // away, as the page may be slow to answer. Electron then restores the
  // window if the page had changed it; it needs the page to leave first.
  // Until the page has left, asking again tries again.
  function leaveFullScreen(tab) {
    if (!tab?.fullScreen) return
    tab.fullScreen = 'leaving'
    sync()
    if (tab.page.isDestroyed()) return
    // In a world of Lit's own, as a page can replace the method in its own.
    // That would wait for a page still loading, so its own world is tried
    // meanwhile, and did-stop-loading asks again if that didn't do.
    const left = tab.page.isLoadingMainFrame()
      ? tab.page.mainFrame.executeJavaScript(EXIT_FULL_SCREEN)
      : tab.page.executeJavaScriptInIsolatedWorld(CHECK_WORLD, [{ code: EXIT_FULL_SCREEN }])
    left.catch(() => {})
  }

  function focusAddress() {
    leaveFullScreen(active())
    win.webContents.focus()
    win.webContents.send('focus-address')
  }

  // A blank tab shows the toolbar's centered search box; a tab that has
  // loaded something shows its page, or the toolbar's error page if it failed.
  // `focus` is false when the toolbar keeps focus, as when arrow keys
  // move along the tabs.
  function show(tab, focus = true) {
    for (const other of tabs) other.view.setVisible(other === tab && tab.started && !tab.error)
    if (!focus || popupOpen) return
    if (tab.error) {
      win.webContents.focus()
      win.webContents.send('focus-error')
    } else if (tab.started) tab.page.focus()
    else focusAddress()
  }

  // A page failed: the toolbar shows why in its place (`error` as in
  // src/errors.js), until another page commits. Its find and requests go,
  // and it has no visit to take back or title.
  // Focus follows the page, but is never taken from the toolbar, where
  // someone may be typing, nor does it bring a window behind to the front.
  function fail(tab, error) {
    if (win.isDestroyed() || !find(tab.id)) return
    settle(tab)
    tab.visit = null
    tab.error = error
    tab.find = null
    tab.restoring = false
    tab.startedByPage = false
    dropPrompts(tab)
    if (tab.id === activeId) show(tab, win.isFocused() && !win.webContents.isFocused())
    sync()
  }

  // Reload, for a page as it is or one that failed.
  function reload(tab) {
    if (!tab?.started || tab.page.isDestroyed()) return
    if (tab.error) retry(tab)
    else tab.page.reload()
  }

  // Loads the failed address again. Chromium reloads nothing when that would
  // send a form again, so its address is opened without the form instead.
  function retry(tab) {
    const url = tab.url || tab.page.getURL() || tab.pendingUrl
    if (tab.page.getURL() === url) tab.page.reload()
    if (!tab.page.isLoading()) tab.page.loadURL(url).catch(() => {})
  }

  function activate(id, focus = true) {
    const tab = find(id)
    if (!tab) return
    activeId = id
    // A page stays full screen only while it is the one on show.
    for (const other of tabs) if (other !== tab) leaveFullScreen(other)
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
    // A page a tab opened is already in its session.
    // Private pages get no DevTools, which saves its state (breakpoints and
    // the like) to the profile on disk, whatever the session.
    const view = new WebContentsView(webContents ? { webContents } : { webPreferences: { session: ses, devTools: !isPrivate } })
    // `page` keeps the WebContents itself: once it is destroyed (a popup
    // calling window.close()), Electron clears `view.webContents`.
    const page = view.webContents
    // A page opened by another ignores the devTools preference.
    if (isPrivate) page.on('devtools-opened', () => page.closeDevTools())
    // Lit sets each page's zoom itself (setZoom). Chromium's own sharing,
    // by URL, would also zoom Lit's toolbar when a tab shows its file.
    page.setZoomMode('isolated')
    const tab = { id: nextTabId++, view, page, title: '', url: '', favicon: null, loading: false, started: Boolean(url || webContents || history), history: null, find: null, zoom: profile.settings.defaultZoom, prompts: [], fullScreen: null, error: null }
    tabs.splice(index, 0, tab)
    view.setVisible(false)
    win.contentView.addChildView(view)
    // Re-adding a view moves it to the top, so popups stay over new tabs.
    for (const overlay of Object.values(popups)) win.contentView.addChildView(overlay)
    layout()

    page.on('did-start-loading', () => { tab.loading = true; tab.started = true; refresh(tab) })
    page.on('did-stop-loading', () => { tab.loading = false; settle(tab); sync(); checkResponse(tab) })
    // The address being opened, before it commits: a tab duplicated or
    // closed before its first page commits gets it.
    // Whether the page started it (a link, a script) or Lit did (the
    // address bar, Back, a reload), for `committed`.
    page.on('did-start-navigation', ({ url, isMainFrame, initiator }) => {
      if (!isMainFrame) return
      tab.pendingUrl = url
      tab.startedByPage = Boolean(initiator)
    })
    // A click, key press, touch or scroll on the page since its last page
    // committed, for `committed`: a page moving on with none is redirecting.
    page.on('input-event', (_event, input) => {
      if (['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart', 'mouseWheel', 'gestureScrollBegin'].includes(input.type)) tab.touched = true
    })
    // Each new page opens at its site's zoom. A new page has no title yet; a restored one keeps its entry's title,
    // as Chromium does not announce a title it already had.
    page.on('did-navigate', (_event, url, status) => {
      const history = page.navigationHistory
      tab.title = history.getEntryAtIndex(history.getActiveIndex())?.title || ''
      tab.favicon = null
      tab.find = findState.reset(tab.find)
      // A new page has not asked for anything yet; the old page's requests go.
      dropPrompts(tab)
      setZoom(tab, zoomOf(url))
      // For checkResponse; a new object for each page.
      tab.response = { status }
      committed(tab, url, false)
      if (tab.error) {
        tab.error = null
        if (tab.id === activeId) show(tab, false)
      }
      sync()
    })
    // A page that couldn't load, whose address and place in the back/forward
    // list are now the tab's. This event is only for those: a page that
    // breaks off halfway, or a load stopped or turned into a download, keeps
    // what the tab shows.
    page.on('did-fail-provisional-load', (_event, code, name, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return
      tab.url = url
      tab.title = ''
      tab.favicon = null
      tab.response = null
      fail(tab, { kind: 'load', name })
    })
    // Within a page that failed (#section), it is still the failed one. Back
    // from a page that couldn't load or crashed is never one of these, even
    // to the same page: Chromium loads that again.
    page.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      committed(tab, url, true)
      sync()
    })
    // A title goes to the tab's visit once it is recorded; until then the
    // visit takes the tab's latest title when it is.
    page.on('page-title-updated', (_event, title) => {
      tab.title = title
      if (tab.toRecord) tab.toRecord.title = title
      else if (tab.visit && profile.settings.saveHistory) setVisited(profile, historyStore.retitle(profile.visited, tab.visit.url, title))
      sync()
    })
    // A bookmark added by hand gets its icon the first time its page shows.
    // Not in a private window, so browsing there changes nothing saved.
    page.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] || null
      if (!isPrivate) addIcon(profile, tab.url, tab.favicon, ses)
      sync()
    })
    page.on('did-stop-loading', () => { if (tab.fullScreen === 'leaving') leaveFullScreen(tab) })
    // The page asked to be full screen (a video's button), or stopped;
    // tab.fullScreen is 'on', 'leaving' (asked to stop), or null.
    // Electron makes the window full screen with it; the toolbar hides.
    // One granted it only after its tab was left gives it back, as does one
    // with a question in the toolbar.
    page.on('enter-html-full-screen', () => {
      tab.fullScreen = 'on'
      if (!windowFullScreen) fullScreenFor = tab
      sync()
      if (tab.id !== activeId || tab.prompts.length) leaveFullScreen(tab)
    })
    page.on('leave-html-full-screen', () => {
      tab.fullScreen = null
      if (fullScreenFor === tab) fullScreenFor = null
      sync()
    })
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
    // A page's process can also end in good order, which is no crash, nor is
    // the end of one that only holds a failed page's empty document.
    page.on('render-process-gone', (_event, { reason, exitCode }) => {
      if (reason !== 'clean-exit' && !tab.error) fail(tab, { kind: 'crash', reason, exitCode })
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
        // A quit waits for every page, so staying cancels it too.
        quitting = false
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
        background: disposition === 'background-tab' && !profile.settings.switchToNewTabs,
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
      // Reopening a page is not a new visit to it, as in other browsers.
      tab.restoring = true
      // If restoring fails, the page it was on still loads.
      const retry = url || current.url
      // When neither commits, the next page is a visit again.
      const restored = () => { tab.restoring = false }
      page.navigationHistory.restore(history).catch(() => {
        // Restored, though its page couldn't load; the error page says so.
        if (tab.error) return
        if (retry && !page.isDestroyed()) page.loadURL(retry).catch(restored)
        else restored()
      })
    } else if (url) page.loadURL(url, referrer ? { httpReferrer: referrer } : {}).catch(() => {})
    // A popup can stay on the about:blank its opener writes into, without
    // ever firing did-navigate, so it gets its zoom here.
    if (webContents) setZoom(tab, zoomOf(page.getURL() || 'about:blank'))
    if (background) sync()
    else activate(tab.id)
    return tab
  }

  // A new tab from ⌘T or the + button, placed and filled as Settings says.
  function newTab() {
    const current = active()
    addTab({
      url: profile.settings.newTabPage ? toUrl(profile.settings.newTabPage, profile.settings.searchEngine) : undefined,
      index: profile.settings.newTabPosition === 'next' && current ? tabs.indexOf(current) + 1 : tabs.length,
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
    // While Save history is off, or in a private window, nothing is kept to reopen.
    if (!profile.settings.saveHistory || isPrivate) return (tab.history = null)
    tab.history = liveHistory(tab) || tab.history
    return tab.history || pendingHistory(tab)
  }

  // The page's back/forward list as Chromium has it now, once its first
  // page has committed.
  function liveHistory(tab) {
    if (tab.page.isDestroyed() || !tab.url) return null
    const entries = tab.page.navigationHistory.getAllEntries()
    return entries.length ? { entries, index: tab.page.navigationHistory.getActiveIndex() } : null
  }

  // Before its first page commits, the address being opened stands in.
  const pendingHistory = (tab) => (!tab.url && tab.pendingUrl ? { entries: [{ url: tab.pendingUrl, title: '' }], index: 0 } : null)

  // A tab's back/forward list for the next launch. Unlike saveHistory it is
  // kept while Save history is off, but then only as the page the tab is on.
  function sessionHistory(tab) {
    if (!tab.started) return null
    const history = liveHistory(tab) || tab.history || pendingHistory(tab)
    if (!history || profile.settings.saveHistory) return history
    // Without its page state, which holds form values and scroll position.
    const current = history.entries[history.index]
    return current ? { entries: [{ url: current.url, title: current.title }], index: 0 } : null
  }

  // History follows the back/forward list, as in other browsers, and
  // records a page only once it has settled:
  // - A page is recorded when its tab stops loading, so the addresses it
  //   passes through while loading (redirects in the page, an address it
  //   swaps for another) never show. An address a page moves to after it
  //   has loaded (a web app's pushState) is recorded right away.
  // - A page that moves on by itself (loading another page, or replacing
  //   its own address) within REDIRECT_AFTER of loading, with no click,
  //   key press or scroll on it, is redirecting: that takes back the visit
  //   it recorded. Moves you prompt, or that come later, keep it, and so
  //   does a pushState, which keeps both addresses in the back list.
  // - A page left before it finished loading is recorded when you left it
  //   (a link clicked, an address typed, Back, closing it), as you saw it.
  // - A jump within the page (#section) is not a new visit.
  // - A restored page (a reopened or restored tab, a duplicate) is not
  //   one either.
  // tab.visit is the visit this tab's page recorded; tab.toRecord is the
  // page ({ url, title }) still waiting to be.
  function committed(tab, url, sameDocument) {
    const list = tab.page.navigationHistory
    const position = { length: list.length(), index: list.getActiveIndex(), next: list.getEntryAtIndex(list.getActiveIndex() + 1)?.url }
    const before = tab.position
    const left = tab.url
    // A same-document move that adds or replaces an entry is always the
    // page's own (Electron names no initiator for pushState).
    const unprompted = (tab.startedByPage || sameDocument) && !tab.touched
    tab.position = position
    tab.url = url
    tab.startedByPage = false
    if (tab.restoring) {
      tab.restoring = false
      tab.touched = false
      tab.toRecord = null
      tab.visit = null
      return
    }
    if (sameDocument && withoutHash(url) === withoutHash(left)) return
    tab.touched = false
    const replaced = before?.length === position.length && before.index === position.index
    // A new entry after the current one, dropping any after it; going
    // Forward to the entry that was there looks the same in numbers.
    const added = before && position.index === before.index + 1 && position.length === position.index + 1 &&
      !(position.length === before.length && url === before.next)
    const redirected = (replaced || (added && !sameDocument)) && unprompted
    if (redirected && url !== left && Date.now() - (tab.visit?.time ?? 0) < REDIRECT_AFTER && tab.visit && withoutHash(tab.visit.url) === withoutHash(left)) {
      takeBack(profile, tab.visit)
      tab.visit = null
    }
    // A page left while loading, other than by its own doing, still counts.
    if (!redirected) settle(tab)
    tab.toRecord = { url, title: tab.title }
    if (!tab.page.isLoading()) settle(tab)
  }

  // A private window records nothing.
  function settle(tab) {
    if (!tab.toRecord) return
    tab.visit = isPrivate ? null : recordVisit(profile, tab.toRecord.url, tab.toRecord.title)
    tab.toRecord = null
  }

  // What Reopen Closed Tab needs to bring this window back. Full screen only
  // if it was without a page's help, as the page won't be when it reopens.
  function closedWindow(histories, activeIndex) {
    return { key, tabs: histories, activeIndex, bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() && !fullScreenFor, profile: profile.id }
  }

  // A site can answer with an HTTP error and an empty page, which would show
  // as a blank one. The page is asked once it has loaded: what Chromium makes
  // of no bytes (HTML, plain text, JSON and the like) has nothing in it to
  // see, and anything else from the site is left alone. The site answered,
  // so History has it like its other error pages.
  async function checkResponse(tab) {
    const { response } = tab
    if (!(response?.status >= 400) || tab.error || tab.page.isDestroyed()) return
    const empty = await tab.page.executeJavaScriptInIsolatedWorld(CHECK_WORLD, [{
      code: `document.documentElement?.outerHTML === '<html><head></head><body></body></html>'`,
    }]).catch(() => false)
    // Another page may have come meanwhile.
    if (empty === true && tab.response === response && !tab.error) fail(tab, { kind: 'http', status: response.status })
  }

  // A tab's first load turns it from the search box into its page.
  function refresh(tab) {
    if (tab.id === activeId && !tab.error && !tab.view.getVisible()) show(tab)
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
    // A page closed before it finished loading was still seen.
    if (tab.closedByUser) settle(tab)
    tabs.splice(index, 1)
    if (win.isDestroyed()) return
    win.contentView.removeChildView(tab.view)
    // Closing the last tab closes the window, as in Chrome and Safari,
    // unless Settings says to keep it open with a new tab. Then the window
    // is what reopens.
    const closesWindow = nextId === null && profile.settings.closeWindowWithLastTab
    if (tab.closedByUser && !isPrivate) rememberClosed(profile, closesWindow ? closedWindow([history], 0) : { windowKey: key, index, history })
    // A page gone while full screen never leaves it, so its window does here.
    if (fullScreenFor === tab && !closesWindow) {
      fullScreenFor = null
      win.setFullScreen(false)
    }
    if (nextId === null) return closesWindow ? win.close() : newTab()
    if (nextId !== activeId) activate(nextId, focus)
    else sync()
  }

  // Zoom is per site, so changing it goes through changeZoom, which comes
  // back here (applyZoom) for every tab on that site.
  function setZoom(tab, factor) {
    tab.zoom = factor
    if (!tab.page.isDestroyed()) tab.page.setZoomFactor(factor)
  }
  // The page's own URL, not tab.url: a popup can stay on the about:blank its
  // opener writes into, which never fires did-navigate.
  const urlOf = (tab) => (tab.page.isDestroyed() ? '' : tab.page.getURL())
  const zoomBy = (tab, direction) => { const url = urlOf(tab); if (url) changeZoom(url, zoom.step(tab.zoom, direction)) }
  const resetZoom = (tab) => { const url = urlOf(tab); if (url) changeZoom(url, profile.settings.defaultZoom) }

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
    // The question is in the toolbar.
    leaveFullScreen(tab)
    sync()
    return true
  }
  // What a prompt asks about now: its kinds without a choice yet.
  const asking = (prompt) => permissions.undecided(permissionStore.sites, prompt.site, prompt.kinds)

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
    // Only the prompt on show: the active tab's first.
    const prompt = tabId === activeId ? tab?.prompts[0] : null
    if (prompt?.id !== promptId || !Array.isArray(kinds) || kinds.join() !== asking(prompt).join()) return
    if (choice) {
      const kinds = asking(prompt)
      if (permissionStore.choose(prompt.site, kinds, choice) || win.isDestroyed()) return
      // The choice still holds; say it won't outlast this run.
      dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Couldn’t save site permissions',
        detail: `${permissions.label(prompt.site)} ${choice === 'allow' ? 'can' : 'can’t'} ${permissions.describe(kinds)} until Lit quits, but it will be asked again after that.`,
      }).catch(() => {})
      return
    }
    tab.prompts.splice(tab.prompts.indexOf(prompt), 1)
    for (const callback of prompt.callbacks) callback(false)
    sync()
  }

  // Answers every waiting request the saved choices now decide. The rest
  // are redrawn too, as what they ask about may have changed.
  function settlePrompts() {
    for (const tab of tabs) {
      for (const prompt of [...tab.prompts]) {
        const answer = permissions.status(permissionStore.sites, prompt.site, prompt.kinds)
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
    hideSuggestions()
    tab.started = true
    show(tab)
    tab.page.loadURL(destination(input, profile.settings)).catch(() => {})
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
    if (!tab?.started || tab.error || tab.page.isDestroyed()) return
    closePopup()
    leaveFullScreen(tab)
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
      engineName: engineOf(profile.settings.searchEngine).name,
      askWhereToSave: askWhereToSave(ses, profile),
      keys: { reload: profile.settings['shortcuts.reload'], back: profile.settings['shortcuts.back'], forward: profile.settings['shortcuts.forward'], print: profile.settings['shortcuts.print'] },
      inSubframe: Boolean(params.frame && params.frame !== contents.mainFrame),
      isPrivate,
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
          background: !profile.settings.switchToNewTabs,
        })
        case 'search': return addTab({ url: searchUrl(arg, profile.settings.searchEngine), index })
        // Through will-download, so the Downloads setting applies.
        case 'download': return contents.downloadURL(arg)
        case 'copyText': return clipboard.writeText(arg)
        case 'copyImage': return contents.copyImageAt(params.x, params.y)
        case 'replaceMisspelling': return contents.replaceMisspelling(arg)
        case 'addToDictionary': return contents.session.addWordToSpellCheckerDictionary(arg)
        case 'back': return contents.navigationHistory.goBack()
        case 'forward': return contents.navigationHistory.goForward()
        case 'reload': return contents.reload()
        case 'print': return print(contents)
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
      .map((command) => [command, profile.settings[`shortcuts.${command}`]]))
    popup(tabMenu({ index: tabs.indexOf(tab), count: tabs.length, started: tab.started, keys }), (command) => {
      if (!find(id)) return
      switch (command) {
        case 'reload': return reload(tab)
        case 'duplicate': return duplicateTab(id)
        case 'close': return closeTab(id)
        case 'closeOthers': return closeOtherTabs(id)
        case 'closeToRight': return closeTabsToRight(id)
      }
    })
  }

  // The toolbar's profile button: every profile, and managing them.
  function showProfileMenu({ x, y }) {
    if (win.isDestroyed()) return
    Menu.buildFromTemplate(profileItems(profile)).popup({ window: win, x: Math.round(x), y: Math.round(y) })
  }

  // The Settings, History, Downloads and Bookmarks popups (src/settings.html,
  // src/history.html, src/downloads.html, src/bookmarks.html): each is made on first use, then hidden and shown; one is open at a time.
  // While a shortcut is being recorded in Settings, key presses go to it
  // instead of the menu, so ⌘T records ⌘T rather than opening a tab.
  function popupView(name) {
    if (popups[name]) return popups[name]
    const view = new WebContentsView({ webPreferences: { preload: PRELOAD, session: ses } })
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
  // `section` is the Settings section to show, if not the one shown last.
  function openPopup(name, section) {
    hideSuggestions()
    const view = popupView(name)
    if (!popupOpen) toolbarHadFocus = win.webContents.isFocused()
    else if (popupOpen !== name) {
      popups[popupOpen].setVisible(false)
      recording = false
    }
    popupOpen = name
    settingsSection = section
    win.contentView.addChildView(view)
    layout()
    view.setVisible(true)
    view.webContents.focus()
    view.webContents.send(`${name}-open`, name === 'bookmarks' ? bookmarksState() : popupState(name, controls))
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

  // Address bar suggestions (src/suggestions.html), in a view of their own
  // sized to the list and laid over the page just under the address field,
  // since the toolbar's page ends above the tabs. The toolbar keeps focus
  // and handles the keys; the view only draws the list and reports a click.
  // A click arrives while the list fades out (the toolbar closes it on
  // losing focus to the click), so the list is kept until it is hidden.
  let suggestionsView = null
  let suggestions = []
  let suggestionsOpen = false
  let suggestionsHide = null
  // Counts each list shown; a click names the list it was on, so a click
  // on a list that has since changed opens nothing.
  let suggestionsGeneration = 0

  function showSuggestions(items, { x, y, width }) {
    if (!suggestionsView) {
      suggestionsView = new WebContentsView({ webPreferences: { preload: PRELOAD, session: ses } })
      suggestionsView.setBackgroundColor('#00000000')
      suggestionsView.setVisible(false)
      windowsByPopup.set(suggestionsView.webContents, { controls, name: 'suggestions' })
      // The first list is sent before the page can hear it; send it again.
      suggestionsView.webContents.on('did-finish-load', () => {
        if (suggestionsOpen) suggestionsView.webContents.send('suggestions-show', { items: suggestions, generation: suggestionsGeneration })
      })
      suggestionsView.webContents.loadFile(path.join(__dirname, 'suggestions.html'))
    }
    clearTimeout(suggestionsHide)
    suggestions = items
    const { width: windowWidth, height: windowHeight } = win.getContentBounds()
    const left = Math.max(0, Math.min(Math.round(x), windowWidth - 1))
    const top = Math.max(0, Math.round(y))
    suggestionsView.setBounds({
      x: left,
      y: top,
      width: Math.max(1, Math.min(Math.round(width), windowWidth - left)),
      height: Math.max(1, Math.min(items.length * SUGGESTION_ROW + SUGGESTIONS_PAD * 2, windowHeight - top)),
    })
    // Re-adding moves it over the tabs.
    if (!suggestionsView.getVisible()) win.contentView.addChildView(suggestionsView)
    suggestionsView.setVisible(true)
    suggestionsOpen = true
    suggestionsGeneration++
    suggestionsView.webContents.send('suggestions-show', { items, generation: suggestionsGeneration })
  }

  // `blur` is the toolbar closing the list as the address field loses
  // focus, which a click on the list does too, so that click still counts
  // while the list fades. Any other close (Escape, a tab switch, opening a
  // page) ends clicks on it at once.
  function hideSuggestions(blur = false) {
    if (!blur) suggestionsGeneration++
    if (!suggestionsOpen) return
    suggestionsOpen = false
    suggestionsView.webContents.send('suggestions-hide')
    clearTimeout(suggestionsHide)
    suggestionsHide = setTimeout(() => {
      suggestions = []
      if (win.isDestroyed()) return
      // A click on the list's edge leaves focus on it; give it back.
      const hadFocus = suggestionsView.webContents.isFocused()
      suggestionsView.setVisible(false)
      const tab = active()
      if (hadFocus && tab) show(tab)
    }, SUGGESTIONS_FADE)
  }

  // What to list under the field at `rect` ({ x, y, width }, in the
  // window) for what is typed: the quick search sites a half-typed
  // shortcut could be ({ kind: 'site', id, name, alias, icon, shortcut },
  // `shortcut` being `!yt`), else
  // bookmarks and pages from history ({ url, title, bookmarked }; only
  // bookmarks in a private window). Answers with the items shown.
  function suggest(text, rect) {
    const fits = rect && ['x', 'y', 'width'].every((key) => Number.isFinite(rect[key]))
    const ok = fits && !popupOpen && typeof text === 'string' && text.length <= 2048
    const sites = ok && profile.settings.quickSearch
      ? quickSearch.complete(text, profile.settings.quickSearchPrefix).map((site) => ({ kind: 'site', ...site, shortcut: profile.settings.quickSearchPrefix + site.alias }))
      : []
    const items = sites.length ? sites : ok && profile.settings.addressSuggestions ? historyStore.suggestWithBookmarks(bookmarkStore.pages(profile.bookmarks), isPrivate ? [] : profile.visited, text) : []
    if (items.length) showSuggestions(items, rect)
    else hideSuggestions()
    return items
  }

  function pickSuggestion(index, generation) {
    const item = generation === suggestionsGeneration && suggestions[index]
    if (!item) return
    hideSuggestions()
    // A site goes back to the address field as its chip, to type a search.
    if (item.kind === 'site') {
      win.webContents.focus()
      win.webContents.send('quick-search-pick', { id: item.id, alias: item.alias })
    } else navigate(item.url)
  }

  // Bookmarks. The popup shows one of two things at `at` ({ x, y } in the
  // window): { kind: 'list', folderId | ids }, what is in a folder or the
  // bookmarks that don't fit the bar; or { kind: 'form', id, folder, values
  // }, to edit one (`id` null to add it) or to say it was just added.
  let bookmarksView = null

  function bookmarksState() {
    const view = bookmarksView
    if (!view) return null
    if (view.kind === 'list') {
      const folder = view.folderId && bookmarkStore.get(profile.bookmarks, view.folderId)
      const items = folder ? folder.items : profile.bookmarks.filter((item) => view.ids?.includes(item.id))
      return { kind: 'list', at: view.at, folderId: folder ? folder.id : null, title: folder ? folder.title : 'More bookmarks', items }
    }
    const { kind, at, id, folder, heading, values } = view
    return { kind, at, id, folder, heading, values, folders: bookmarkStore.folders(profile.bookmarks).map(({ id, title }) => ({ id, title })) }
  }

  function openBookmarks(view) {
    bookmarksView = view
    openPopup('bookmarks')
  }

  // Where the form goes when the pointer didn't say: under the star.
  const underStar = () => ({ x: win.getContentBounds().width, y: BAR_HEIGHT })

  function editBookmark(id, at = underStar(), heading) {
    const item = bookmarkStore.get(profile.bookmarks, id)
    if (!item) return
    const folder = bookmarkStore.isFolder(item)
    openBookmarks({
      kind: 'form', at, id, folder, heading: heading || (folder ? 'Rename folder' : 'Edit bookmark'),
      values: { title: item.title, url: item.url, folderId: bookmarkStore.folderOf(profile.bookmarks, id) },
    })
  }

  // The star or ⌘D: bookmarks the page at the end of the bar and offers to
  // change its name or folder; a page already bookmarked just opens that.
  function bookmarkPage() {
    const tab = active()
    const url = tab?.started ? bookmarkStore.address(tab.url) : null
    if (!url) return
    const existing = bookmarkStore.pages(profile.bookmarks).find((item) => item.url === url)
    if (existing) return editBookmark(existing.id)
    const item = bookmarkStore.page({ title: tab.title || url, url })
    if (!changeBookmarks(profile, win, bookmarkStore.add(profile.bookmarks, item))) return
    addIcon(profile, url, tab.favicon, ses)
    editBookmark(item.id, undefined, 'Bookmark added')
  }

  function newBookmark(folder, at) {
    const tab = active()
    const url = !folder && tab?.started ? bookmarkStore.address(tab.url) : null
    openBookmarks({
      kind: 'form', at, id: null, folder, heading: folder ? 'Add folder' : 'Add page',
      values: { title: url ? tab.title : '', url: url || '', folderId: null },
    })
  }

  // Done in the form. Answers { error }, or closes it.
  function saveBookmark(values) {
    const view = bookmarksView
    if (popupOpen !== 'bookmarks' || view?.kind !== 'form') return {}
    const title = String(values?.title ?? '').trim().slice(0, 1024)
    const folderId = values?.folderId || null
    let next
    let url
    // Removed in another window while it was edited here.
    if (view.id && !bookmarkStore.get(profile.bookmarks, view.id)) return { error: `This ${view.folder ? 'folder' : 'bookmark'} was removed.` }
    if (view.folder) {
      if (!title) return { error: 'Give the folder a name.' }
      next = view.id ? bookmarkStore.update(profile.bookmarks, view.id, { title }) : bookmarkStore.add(profile.bookmarks, bookmarkStore.folder(title))
    } else {
      url = bookmarkStore.address(values?.url)
      if (!url) return { error: 'Enter a web address.' }
      const old = view.id && bookmarkStore.get(profile.bookmarks, view.id)
      const target = bookmarkStore.folders(profile.bookmarks).some((each) => each.id === folderId) ? folderId : null
      if (!old) next = bookmarkStore.add(profile.bookmarks, bookmarkStore.page({ title, url }), target)
      else {
        // Another address is another site's icon.
        next = bookmarkStore.update(profile.bookmarks, old.id, { title, url, icon: url === old.url ? old.icon : '' })
        if (target !== bookmarkStore.folderOf(profile.bookmarks, old.id)) next = bookmarkStore.move(next, old.id, target)
      }
    }
    if (!setBookmarks(profile, next)) return { error: 'Couldn’t save bookmarks.' }
    if (url) for (const tab of tabs) if (tab.url === url) addIcon(profile, url, tab.favicon, ses)
    closePopup()
    return {}
  }

  // A folder with pages in it asks first, as it takes them with it.
  function deleteBookmark(id) {
    const item = bookmarkStore.get(profile.bookmarks, id)
    if (!item) return
    if (bookmarkStore.isFolder(item) && item.items.length) {
      const count = item.items.length
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Delete', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Delete “${item.title}”?`,
        detail: count === 1 ? 'The bookmark in it is deleted too.' : `The ${count} bookmarks in it are deleted too.`,
      })
      if (choice !== 0) return
    }
    changeBookmarks(profile, win, bookmarkStore.remove(profile.bookmarks, id))
  }

  function openBookmark(id, newTab) {
    const item = bookmarkStore.get(profile.bookmarks, id)
    if (!item || bookmarkStore.isFolder(item)) return
    closePopup()
    if (newTab) openInTabs([item.url])
    else navigate(item.url)
  }

  // New tabs next to the current one, in order, like ⌘-clicked links.
  function openInTabs(urls) {
    const index = active() ? tabs.indexOf(active()) + 1 : tabs.length
    urls.forEach((url, i) => addTab({ url, index: index + i, background: i > 0 || !profile.settings.switchToNewTabs }))
  }

  function showBookmarkMenu(id, at) {
    const item = id === null ? null : bookmarkStore.get(profile.bookmarks, id)
    if (id !== null && !item) return
    const folder = Boolean(item && bookmarkStore.isFolder(item))
    popup(bookmarkMenu({ kind: item && (folder ? 'folder' : 'page'), count: folder ? item.items.length : 0, key: profile.settings['shortcuts.bookmarkBar'] }), (command) => {
      switch (command) {
        case 'openInNewTab': return openBookmark(id, true)
        case 'openInNewWindow': return createWindow({ profile, url: item.url })
        case 'openInPrivateWindow': return createWindow({ profile, url: item.url, isPrivate: true })
        case 'openAll': closePopup(); return openInTabs(item.items.map((each) => each.url))
        case 'copyAddress': return clipboard.writeText(item.url)
        case 'edit': return editBookmark(id, at)
        case 'delete': return deleteBookmark(id)
        case 'addPage': return newBookmark(false, at)
        case 'addFolder': return newBookmark(true, at)
        case 'hideBar': closePopup(); return toggleBookmarkBar(profile)
      }
    })
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

  // Every page the window has besides its toolbar, to wait for as they close.
  const pages = () => [...tabs.map((tab) => tab.page), ...Object.values(popups).map((view) => view.webContents), suggestionsView?.webContents]

  const controls = {
    win,
    key,
    profile,
    isPrivate,
    session: ses,
    pages,
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
    // The active page, for back, forward and its developer tools.
    page: () => (active()?.started && !active().page.isDestroyed() ? active().page : null),
    // Whether it failed, so there is nothing of it to print.
    failed: () => Boolean(active()?.error),
    reload: () => reload(active()),
    // The page came back while its error page had focus.
    focusPage: () => { const tab = active(); if (tab?.started && !tab.error && !popupOpen && !tab.page.isDestroyed()) tab.page.focus() },
    // Zoom acts on the active tab's page, once it has an address.
    // No zoom while an error shows in its place.
    zoomBy: (direction) => { const tab = active(); if (tab?.started && !tab.error) zoomBy(tab, direction) },
    resetZoom: () => { const tab = active(); if (tab?.started && !tab.error) resetZoom(tab) },
    // Every tab's zoom again, or only those on `site`.
    applyZoom(site) {
      for (const tab of tabs) {
        const url = urlOf(tab)
        if (url && (!site || zoom.siteOf(url) === site)) setZoom(tab, zoomOf(url))
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
    settingsSection: () => settingsSection,
    profileChanged() { sendProfile(); sync() },
    showProfileMenu,
    openFromHistory,
    suggest,
    selectSuggestion: (index) => { if (suggestionsOpen) suggestionsView.webContents.send('suggestions-select', index) },
    hideSuggestions: (blur) => hideSuggestions(blur),
    pickSuggestion,
    showTabMenu,
    bookmarkPage,
    openBookmark,
    showBookmarkMenu,
    saveBookmark,
    bookmarksState,
    listBookmarks: (view) => openBookmarks({ kind: 'list', ...view }),
    moveBookmark: (id, folderId, beforeId) => changeBookmarks(profile, win, bookmarkStore.move(profile.bookmarks, id, folderId, beforeId)),
    // The form's Delete.
    removeBookmark() {
      const id = bookmarksView?.id
      closePopup()
      if (id) deleteBookmark(id)
    },
    // A list follows the change, and closes once nothing is left to list;
    // a form keeps what is typed in it.
    bookmarksChanged() {
      sendBookmarks()
      if (popupOpen !== 'bookmarks' || bookmarksView.kind !== 'list') return
      const gone = bookmarksView.folderId && !bookmarkStore.get(profile.bookmarks, bookmarksView.folderId)
      const state = bookmarksState()
      if (gone || (!bookmarksView.folderId && !state.items.length)) closePopup()
      else popups.bookmarks.webContents.send('bookmarks-changed', state)
    },
    duplicateTab: () => duplicateTab(activeId),
    closeOtherTabs: () => closeOtherTabs(activeId),
    closeTabsToRight: () => closeTabsToRight(activeId),
    setRecording: (on, keys) => {
      recording = on
      keyboardLayout = on && keys && typeof keys === 'object' ? keys : {}
    },
    settingsChanged() {
      sendShortcuts()
      sendQuickSearch()
      sendBookmarks()
      popups.settings?.webContents.send('settings-changed', settingsState(profile))
      controls.historyChanged()
    },
    // History removed `url` (or everything, without one): tabs drop their
    // visits to it, and their pages still loading are not recorded.
    forgetVisits(url) {
      for (const tab of tabs) {
        if (!url || tab.visit?.url === url) tab.visit = null
        if (!url || tab.toRecord?.url === url) tab.toRecord = null
      }
    },
    // Save history was turned off: drop what each tab kept to reopen.
    forgetTabHistories() {
      for (const tab of tabs) {
        tab.history = null
        tab.visit = null
        tab.toRecord = null
        delete tab.closeSnapshot
      }
    },
    // Records the pages still loading, as Lit quits.
    settleAll: () => { for (const tab of tabs) settle(tab) },
    // What reopening this window at the next launch needs (see src/session.js).
    snapshot: () => (tabs.length && !isPrivate ? closedWindow(tabs.map(sessionHistory), Math.max(tabs.indexOf(active()), 0)) : null),
    historyChanged() {
      if (popupOpen === 'history') popups.history.webContents.send('history-changed', historyState(profile))
    },
    downloadsChanged() {
      sendDownloads()
      if (popupOpen === 'downloads') popups.downloads.webContents.send('downloads-changed', downloadsState(ses))
    },
  }
  windowsByToolbar.set(win.webContents, controls)
  openWindows.add(controls)

  win.on('resize', layout)
  // Where the window is, and which window was in front, come back next
  // launch; a private window changes none of that.
  const changed = () => { if (!isPrivate) sessionChanged() }
  for (const change of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(change, changed)
  win.on('enter-full-screen', () => { windowFullScreen = true })
  // Leaving by the green button or the menu takes the page out too.
  win.on('leave-full-screen', () => {
    windowFullScreen = false
    fullScreenFor = null
    leaveFullScreen(active())
  })
  win.on('focus', () => {
    openWindows.delete(controls)
    openWindows.add(controls)
    profileUsed(profile, isPrivate)
    changed()
  })
  win.webContents.on('context-menu', (_event, params) => showPageMenu(win.webContents, params, false))
  // A window closed with tabs still in it (⇧⌘W, the close button) can be
  // reopened whole. A window closed by its last tab was remembered in
  // removeTab. Its tabs are read while it is still there, and remembered
  // only once it is really gone, in case the close is cancelled.
  let closingWindow = null
  win.on('close', () => {
    if (isPrivate) return
    const histories = tabs.map((tab) => (tab.started ? saveHistory(tab) : null))
    closingWindow = histories.length ? closedWindow(histories, Math.max(tabs.indexOf(active()), 0)) : null
  })
  // The toolbar asks for the tabs once it has loaded (and again if reloaded).
  win.webContents.on('did-finish-load', () => { sync(); sendShortcuts(); sendQuickSearch(); sendBookmarks(); sendDownloads(); sendProfile() })
  win.on('closed', () => {
    openWindows.delete(controls)
    changed()
    if (closingWindow) rememberClosed(profile, closingWindow)
    // Its own pages too, read before they close.
    const open = pages()
    for (const tab of tabs.splice(0)) {
      for (const prompt of tab.prompts) for (const callback of prompt.callbacks) callback(false)
      settle(tab)
      if (!tab.page.isDestroyed()) tab.page.close()
    }
    for (const view of Object.values(popups)) view.webContents.close()
    clearTimeout(suggestionsHide)
    suggestionsView?.webContents.close()
    if (isPrivate) {
      dropDownloads(ses)
      forgetSession(ses, open)
    }
  })

  // The toolbar draws a private window a little differently.
  win.loadFile(path.join(__dirname, 'index.html'), isPrivate ? { query: { private: '1' } } : {})
  if (maximized) win.maximize()
  if (fullScreen) win.setFullScreen(true)
  if (restored.length) {
    for (const history of restored) addTab(history ? { history, background: true } : { background: true })
    activate(tabs[Math.min(activeIndex, tabs.length - 1)].id)
  } else if (url) addTab({ url })
  else newTab()
  return controls
}

// Menu actions go to the focused window, which Electron passes to `click`.
const controlsOf = (win) => (win && !win.isDestroyed() ? windowsByToolbar.get(win.webContents) : undefined)
// Opens the system print dialog for a page. Cancelling it is not a failure
// worth reporting; anything else is logged.
function print(page) {
  page.print({}, (printed, reason) => {
    if (!printed && reason && !/cancel/i.test(reason)) console.error(`Print failed: ${reason}`)
  })
}

const inFocused = (action) => (_item, win) => {
  const controls = controlsOf(win)
  if (controls) action(controls)
}

// Settings and History open in the focused window, or a new one, and the
// same command closes them again.
const togglePopup = (name) => (_item, win) => {
  let c = controlsOf(win) || createWindow()
  // A private window has no history: its profile's normal window used last
  // shows it.
  if (name === 'history' && c.isPrivate) return switchProfile(c.profile).openPopup(name)
  if (c.popupOpen() === name) c.closePopup()
  else c.openPopup(name)
}

// Settings at its Profiles section, in the focused window or a new one; New
// Profile adds one there first, to name it.
const manageProfiles = (_item, win) => (controlsOf(win) || createWindow()).openPopup('settings', 'profiles')
async function newProfile(item, win) {
  const error = await addProfile()
  if (!error) return manageProfiles(item, win)
  dialog.showMessageBox({ type: 'warning', message: error }).catch(() => {})
}

// The profiles menu, in the menu bar and the toolbar: each profile, to switch
// to, `current` checked.
function profileItems(current) {
  const key = (command) => ({ accelerator: current.settings[`shortcuts.${command}`] || undefined })
  return [
    ...profiles.map((profile) => ({ label: profile.name, type: 'radio', checked: profile === current, click: () => switchProfile(profile) })),
    { type: 'separator' },
    { label: 'New Profile…', ...key('newProfile'), click: newProfile },
    { label: 'Manage Profiles…', ...key('profiles'), click: manageProfiles },
  ]
}

// The menu holds every shortcut, so they work whether the toolbar or a page
// has focus. Most come from Settings; hidden items still answer their
// shortcuts on macOS. Keep the fixed ones in RESERVED in src/shortcuts.js.
function buildMenu() {
  const { settings, closed } = currentProfile
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
        { label: 'New Window', accelerator: key('newWindow'), click: (_item, win) => createWindow({ profile: controlsOf(win)?.profile }) },
        { label: 'New Private Window', accelerator: key('newPrivateWindow'), click: (_item, win) => createWindow({ profile: controlsOf(win)?.profile, isPrivate: true }) },
        { type: 'separator' },
        { label: 'Duplicate Tab', accelerator: key('duplicateTab'), click: inFocused((c) => { c.closePopup(); c.duplicateTab() }) },
        { label: 'Open Location…', accelerator: key('openLocation'), click: inFocused((c) => { c.closePopup(); c.focusAddress() }) },
        { type: 'separator' },
        // With a popup open, Close Tab closes the popup instead.
        { label: 'Close Tab', accelerator: key('closeTab'), click: inFocused((c) => (c.popupOpen() ? c.closePopup() : c.closeTab())) },
        { label: 'Close Window', accelerator: key('closeWindow'), click: inFocused((c) => c.win.close()) },
        { label: 'Close Other Tabs', accelerator: key('closeOtherTabs'), click: inFocused((c) => { c.closePopup(); c.closeOtherTabs() }) },
        { label: 'Close Tabs to the Right', accelerator: key('closeTabsToRight'), click: inFocused((c) => { c.closePopup(); c.closeTabsToRight() }) },
        { type: 'separator' },
        { label: 'Print…', accelerator: key('print'), click: inFocused((c) => { const page = c.page(); if (page && !c.failed()) { c.closePopup(); print(page) } }) },
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
        { label: 'Reload', accelerator: key('reload'), click: inFocused((c) => c.reload()) },
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
        // Private windows have none (see addTab).
        { label: 'Developer Tools', accelerator: key('devTools'), click: inFocused((c) => { const page = c.page(); if (page && !c.isPrivate) page.toggleDevTools() }) },
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
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page…', accelerator: key('bookmarkPage'), click: inFocused((c) => c.bookmarkPage()) },
        { type: 'separator' },
        { label: 'Show Bookmark Bar', type: 'checkbox', checked: settings.bookmarkBar, accelerator: key('bookmarkBar'), click: (_item, win) => toggleBookmarkBar(controlsOf(win)?.profile ?? currentProfile) },
      ],
    },
    { label: 'Profiles', submenu: profileItems(currentProfile) },
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
ipcMain.on('profile-menu', fromToolbar((c, at) => isPoint(at) && c.showProfileMenu(at)))
// Bookmarks, from the bar or the popup's lists, which share these.
const fromBookmarks = (handler) => (event, ...args) => {
  const popup = windowsByPopup.get(event.sender)
  const controls = windowsByToolbar.get(event.sender) || (popup?.name === 'bookmarks' ? popup.controls : null)
  if (controls) handler(controls, ...args)
}
const isPoint = (at) => Number.isFinite(at?.x) && Number.isFinite(at?.y)
const isId = (id) => typeof id === 'string'
ipcMain.on('bookmark-page', fromToolbar((c) => c.bookmarkPage()))
ipcMain.on('bookmark-move', fromBookmarks((c, id, folderId, beforeId) => isId(id) && c.moveBookmark(id, isId(folderId) ? folderId : null, isId(beforeId) ? beforeId : null)))
ipcMain.on('bookmark-open', fromBookmarks((c, id, newTab) => isId(id) && c.openBookmark(id, newTab === true)))
ipcMain.on('bookmark-menu', fromBookmarks((c, id, at) => (id === null || isId(id)) && isPoint(at) && c.showBookmarkMenu(id, { x: at.x, y: at.y })))
ipcMain.on('bookmark-list', fromBookmarks((c, what, at) => {
  if (isPoint(at)) c.listBookmarks({ at: { x: at.x, y: at.y }, ...(Array.isArray(what) ? { ids: what } : { folderId: what }) })
}))
// The error page's, for the tab it was on.
ipcMain.on('reload', fromToolbar((c, tabId) => c.isActive(tabId) && c.failed() && c.reload()))
ipcMain.on('go-back', fromToolbar((c, tabId) => c.isActive(tabId) && c.failed() && c.page()?.navigationHistory.goBack()))
ipcMain.on('focus-page', fromToolbar((c, tabId) => c.isActive(tabId) && c.focusPage()))
ipcMain.on('reset-zoom', fromToolbar((c) => c.resetZoom()))
// A prompt's answer: 'allow', 'block', or null to dismiss it, for the
// kinds the row showed.
ipcMain.on('answer-permission', fromToolbar((c, tabId, promptId, kinds, choice) => {
  if (choice === null || permissions.CHOICES.includes(choice)) c.answerPrompt(tabId, promptId, kinds, choice)
}))
ipcMain.handle('suggest', (event, text, rect) => windowsByToolbar.get(event.sender)?.suggest(text, rect) ?? [])
ipcMain.on('suggestions-select', fromToolbar((c, index) => Number.isInteger(index) && c.selectSuggestion(index)))
ipcMain.on('suggestions-close', fromToolbar((c, blur) => c.hideSuggestions(blur === true)))

// Popup messages, answered only for the popup `name`.
const fromPopup = (name, handler) => (event, ...args) => {
  const popup = windowsByPopup.get(event.sender)
  if (popup?.name === name) return handler(popup.controls, ...args)
}
const fromSettings = (handler) => fromPopup('settings', handler)
const fromHistory = (handler) => fromPopup('history', handler)
const fromDownloads = (handler) => fromPopup('downloads', handler)
ipcMain.handle('bookmarks-get', fromPopup('bookmarks', (c) => c.bookmarksState()))
ipcMain.handle('bookmarks-save', fromPopup('bookmarks', (c, values) => c.saveBookmark(values)))
ipcMain.on('bookmarks-remove', fromPopup('bookmarks', (c) => c.removeBookmark()))
ipcMain.on('bookmarks-close', fromPopup('bookmarks', (c) => c.closePopup()))
ipcMain.on('suggestions-pick', fromPopup('suggestions', (c, index, generation) => Number.isInteger(index) && c.pickSuggestion(index, generation)))
ipcMain.handle('settings-get', fromSettings((c) => popupState('settings', c)))
ipcMain.handle('settings-set', fromSettings((c, key, value) => settingsState(c.profile, changeSetting(c.profile, key, value))))
// Profiles: adding, changing and deleting answer with the state.
ipcMain.handle('profiles-add', fromSettings(async (c) => settingsState(c.profile, await addProfile())))
ipcMain.handle('profiles-update', fromSettings((c, id, changes) => settingsState(c.profile, updateProfile(id, { name: changes?.name, color: changes?.color }))))
ipcMain.handle('profiles-delete', fromSettings(async (c, id) => settingsState(c.profile, await deleteProfile(c.win, id))))
ipcMain.on('profiles-open', fromSettings((c, id) => {
  const profile = profiles.find((each) => each.id === id)
  if (!profile) return
  c.closePopup()
  switchProfile(profile)
}))
// Changes or forgets (null) one site's choice for one kind.
ipcMain.handle('permissions-set', fromSettings((c, site, kind, choice) => {
  const saved = typeof site === 'string' && Object.hasOwn(permissions.KINDS, kind) && c.profile.sitePermissions.get(site)?.[kind]
  if (saved && (choice === null || permissions.CHOICES.includes(choice)) && !choosePermission(c.profile, site, [kind], choice)) {
    return settingsState(c.profile, 'Couldn’t save site permissions, so this change lasts only until Lit quits.')
  }
  return settingsState(c.profile)
}))
ipcMain.on('settings-record', fromSettings((c, on, keys) => c.setRecording(on === true, keys)))
ipcMain.on('settings-close', fromSettings((c) => c.closePopup()))

ipcMain.handle('history-get', fromHistory((c) => historyState(c.profile)))
// Only addresses already in history can be opened from it.
ipcMain.on('history-open-page', fromHistory((c, url, background) => {
  if (c.profile.visited.some((entry) => entry.url === url)) c.openFromHistory(url, background === true)
}))
// Removing and clearing answer with the state, saying so if nothing changed.
// Tabs forget their visits to what was removed, so neither taking a visit
// back nor a page finishing loading brings it back.
ipcMain.handle('history-remove', fromHistory((c, url) => {
  if (!setVisited(c.profile, historyStore.remove(c.profile.visited, url), { now: true })) return historyState(c.profile, 'Couldn’t save history, so that page wasn’t removed.')
  for (const controls of windowsOf(c.profile)) controls.forgetVisits(url)
  return historyState(c.profile)
}))
// Clearing history forgets closed tabs too.
ipcMain.handle('history-clear', fromHistory((c) => {
  if (!setVisited(c.profile, [], { now: true })) return historyState(c.profile, 'Couldn’t save history, so nothing was cleared.')
  for (const controls of windowsOf(c.profile)) controls.forgetVisits()
  forgetClosed(c.profile)
  return historyState(c.profile)
}))
ipcMain.on('history-close', fromHistory((c) => c.closePopup()))

// A window only reaches the downloads it shows.
const downloadById = (c, id) => downloadsOf(c.session).find((download) => download.id === id)
ipcMain.handle('downloads-get', fromDownloads((c) => downloadsState(c.session)))
// Only a download still on its way can be cancelled; done fires next.
ipcMain.on('downloads-cancel', fromDownloads((c, id) => downloadById(c, id)?.item?.cancel()))
ipcMain.on('downloads-show', fromDownloads((c, id) => {
  const download = downloadById(c, id)
  if (download?.state === 'completed') shell.showItemInFolder(download.path)
}))
// Clear keeps downloads still on their way. Clearing them all takes the
// toolbar button away, and the popup hanging from it closes too.
ipcMain.on('downloads-clear', fromDownloads((c) => {
  const cleared = downloadsOf(c.session).filter((download) => !downloadsStore.isActive(download))
  if (!cleared.length) return
  downloads.splice(0, downloads.length, ...downloads.filter((download) => !cleared.includes(download)))
  downloadsChanged(true)
  if (!downloadsOf(c.session).length) c.closePopup()
}))
ipcMain.on('downloads-close', fromDownloads((c) => c.closePopup()))

app.whenReady().then(async () => {
  const root = app.getPath('userData')
  profilesFile = path.join(root, 'profiles.json')
  profileList = profileStore.load(profilesFile)
  // Deleted profiles' files go before any session is opened.
  const swept = profileStore.sweep(root, profileList)
  if (swept !== profileList) setProfileList(swept)
  for (const profile of profileList.profiles) openProfile(profile)
  currentProfile = profiles.find((profile) => profile.id === profileList.last)
  adblock = createAdblock(path.join(root, 'adblock.bin'))
  // A saved engine is in use before any tab loads; first-time lists
  // download in the background.
  await Promise.all(profiles.map((profile) => adblock.set(profile.session, profile.settings.blockAds)))
  // The packaged app gets its icon from the bundle; in development, show it in the Dock too.
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'))
  Menu.setApplicationMenu(buildMenu())
  sessionFile = path.join(app.getPath('userData'), 'session.json')
  // The windows open when Lit last quit, the one in front opened last.
  // Windows of a profile since deleted don't.
  const restored = (shared().restoreSession ? sessionStore.load(sessionFile) : [])
    .map((saved) => ({ ...saved, profile: profiles.find(({ id }) => id === (saved.profile ?? profileStore.DEFAULT)) }))
    .filter(({ profile }) => profile)
  if (restored.length) for (const saved of restored) createWindow(saved)
  else createWindow()
  // Like other Mac browsers, Lit keeps running with no windows open;
  // clicking the Dock icon opens a fresh one. Registered after the first
  // window so a launch-time activate cannot open a second.
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})

// The session is saved as the quit begins, before windows start closing.
app.on('before-quit', () => {
  saveSession()
  quitting = true
  for (const controls of openWindows) controls.settleAll()
})
// A save still waiting when Lit quits is written now.
app.on('will-quit', () => { for (const profile of profiles) if (profile.historySave) saveVisited(profile) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
