// Lit's main process. Each window has a toolbar on top (src/index.html,
// the window's own page) and one Chromium WebContentsView per tab below it.
// Only the active tab's view is visible, or, in split view, it and the tab
// beside it (see `split` in createWindow). The Settings, History and
// Downloads popups and the command palette (src/commands.js) are each one
// more view, transparent and over everything, shown only while open. Find in page lives in the toolbar; each tab keeps its own
// search (src/find.js). A site asking for the camera, location and the like,
// or to open another app, gets a prompt in the toolbar, below the address
// row (src/permissions.js), and so does the offer to save a password just
// used (src/passwords.js; src/page.js watches pages for them). A server or
// proxy asking for a username and password gets one there too (src/signin.js).
// The toolbar also draws the page shown in place of one that failed to load
// or crashed (src/errors.js), while that tab's view is hidden.
// A private window (⇧⌘N) browses in an in-memory session of its own and
// keeps nothing once it closes (see privateSession), except the bookmarks
// someone adds in it. Every window belongs to one profile (see openProfile).
const { app, BrowserWindow, Menu, WebContentsView, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, safeStorage, screen, session, shell, systemPreferences } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const { quiet } = require('./quiet')
const { toUrl, webAddress, searchUrl, engineOf, addressParts } = require('./url')
const quickSearch = require('./quicksearch')
const { afterClose, step, byNumber, moved, nudged, remember, keepNewest, reopenIndex, onScreen, tabsPlace, sidebarToggle, SIDEBAR, sidebarWidth, sidebarNudged, sidebarShowing, splitPanes, splitRatio, splitWith, sleepy } = require('./tabs')
const settingsStore = require('./settings')
const historyStore = require('./history')
const bookmarkStore = require('./bookmarks')
const sessionStore = require('./session')
const shortcuts = require('./shortcuts')
const downloadsStore = require('./downloads')
const zoom = require('./zoom')
const pdf = require('./pdf')
const permissions = require('./permissions')
const passwords = require('./passwords')
const cookieStore = require('./cookies')
const shareStore = require('./share')
const signIn = require('./signin')
const errors = require('./errors')
const profileStore = require('./profiles')
const findState = require('./find')
const { pageMenu, tabMenu, navigationMenu, bookmarkMenu, adsMenu } = require('./menus')
const commandStore = require('./commands')
const { createAdblock } = require('./adblock')

// Keep in sync with .strip and .bar heights in index.html.
const STRIP_HEIGHT = 38
const BAR_HEIGHT = STRIP_HEIGHT + 44
// The permission prompt's row under the address row; keep in sync with
// .prompt in index.html. Pages move down by this while their tab asks.
const PROMPT_HEIGHT = 44
// The sign-in prompt's row, shown in its place; keep in sync with .sign-in in
// index.html. A note under what it asks makes it taller.
const SIGN_IN_HEIGHT = 88
const SIGN_IN_NOTE = 18
// The bookmark bar's row, above the prompt; keep in sync with .bookmarks in
// index.html.
const BOOKMARKS_HEIGHT = 34
// With Frame pages on, a page is a rounded card this far in from the
// window's sides and bottom; keep in sync with .framed .error in index.html.
const PAGE_INSET = 6
const PAGE_RADIUS = 10
// With vertical tabs, the sidebar down the window's left, which pages start
// right of while it shows, is as wide as the Tab sidebar width setting, its
// edge dragged to change it, within the limits of SIDEBAR in src/tabs.js.
// ← and → on its edge move it this far, with ⇧ further.
const SIDEBAR_STEP = 20
const SIDEBAR_BIG_STEP = 60
// Showing or hiding the sidebar slides it, and the pages with it, this long,
// easing out as --settle in index.html does (cubic-bezier(.22, 1, .36, 1)
// is the ease-out quint below). Keep the time in sync with .sliding there.
const SIDEBAR_SLIDE_MS = 260
const easeOut = (t) => 1 - (1 - t) ** 5
// Split view: the gap between its two pages, where the toolbar draws the
// divider to drag, and how narrow dragging it can make a page.
const SPLIT_GAP = 8
const SPLIT_MIN = 240
const PRELOAD = path.join(__dirname, 'preload.js')
// What runs in web pages.
const PAGE_PRELOAD = path.join(__dirname, 'page.js')
const PASSKEYS_PRELOAD = path.join(__dirname, 'passkeys.js')
// Runs preloads in the frames inside a page too, for passkeys.js. page.js and
// the ad blocker's keep to the top frame. Pages get no Node either way.
const PAGE_PREFERENCES = { nodeIntegrationInSubFrames: true }
// Keep in sync with .menu padding and .row height in suggestions.html.
const SUGGESTION_ROW = 38
const SUGGESTIONS_PAD = 5
// The list under a login field: the same rows, with a header; keep in sync
// with logins.html.
const LOGINS_HEADER = 26
const LOGINS_WIDTH = 240
// The most rows before it scrolls.
const LOGINS_ROWS = 5
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
// Names each page a tab loads, so the sharing picker can tell one from the next.
let nextPageId = 1
let nextShareId = 1
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
// - passwords: saved logins (src/passwords.js), which its private windows can
//   fill but never change.
// - bookmarks (src/bookmarks.js), which its private windows share.
// - closed: recently closed tabs and windows, newest last, for Reopen Closed
//   Tab (see rememberClosed).
// `deleted` is set once it is deleted, when nothing of it is saved any more.
// Its id never changes; its name and color follow the saved list.
function openProfile({ id, name, color }) {
  const folder = profileStore.folder(app.getPath('userData'), id)
  const partition = profileStore.partition(id)
  const files = Object.fromEntries(['settings', 'zoom', 'permissions', 'passwords', 'history', 'bookmarks'].map((file) => [file, path.join(folder, `${file}.json`)]))
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
    passwords: passwords.load(files.passwords),
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
    detail: 'Its history, bookmarks, saved passwords, settings, sign-ins and site data are deleted, its windows close, and downloads on their way are cancelled. This can’t be undone.',
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

// A page's redirect to another app, `redirectURL`. Electron would ask for the
// page the link was on, so a site allowed to open an app would vouch for every
// address it links to. Lit asks itself instead, for the site that redirects
// (`url`), which could as well load and open the app from its own page. Only
// the network request knows that site, so it asks from here, and the
// navigation is stopped (will-redirect). A service worker's redirect makes no
// request, so it is only stopped.
function onAppRedirect(store, { webContents: page, url, redirectURL }) {
  if (!page || !permissions.opensApp(redirectURL)) return
  // One a frame started is refused, as its other requests are.
  if ([...openWindows].some((controls) => controls.startedByFrame(page))) return
  answerRequest(store, page, permissions.originOf(url), permissions.kindsOf('openExternal', [], redirectURL), (allowed) => {
    if (allowed) shell.openExternal(permissions.escapeAppURL(redirectURL)).catch(() => {})
  })
}

// Requests for a kind Lit asks about are answered from the saved choices,
// or by a prompt on the tab that asked, for the kinds not yet decided.
// A frame from the page's own site is treated like the page for the camera
// and microphone, whose requests carry the frame's real origin
// (`securityOrigin`). Other requests carry only the frame's address, which a
// sandboxed frame keeps without the origin, so frames are refused those.
// The prompt names the site, not the frame, so its answer stays right even
// if the frame has gone. A link to another app is always a page's: Lit
// itself loads only Chromium's own schemes (toUrl, bookmarks), and a restored
// or duplicated tab, not yet on a page, has no site. Anything not from a tab (Lit's own pages, a
// service worker) is refused too. `store` is the session's choices.
function onPermissionRequest(store, contents, permission, callback, details) {
  if (permission === 'display-capture') return onShareRequest(contents, callback, details)
  const kinds = permissions.kindsOf(permission, details.mediaTypes, details.externalURL)
  if (!kinds) return callback(true)
  const site = siteFor(contents, details.securityOrigin ?? details.requestingUrl)
  if (!details.isMainFrame && !details.securityOrigin) return callback(false)
  const usesMedia = kinds.includes('camera') || kinds.includes('microphone')
  answerRequest(store, contents, site, kinds, !usesMedia ? callback : (allowed) => {
    if (allowed && contents) mediaPages.add(contents)
    callback(allowed)
  })
}

// Pages given a camera, a microphone or a screen since they loaded, which
// may be in a call, so their tabs never go to sleep. Electron can't say
// when a page stops using them; a new page in the tab starts again.
const mediaPages = new WeakSet()

// A site wants to share the screen (getDisplayMedia, as Meet and Zoom do).
// Asked each time, in the picker of the tab that asked; the page or a frame
// of its own site, as for the camera.
function onShareRequest(contents, callback, details) {
  const site = siteFor(contents, details.securityOrigin ?? details.requestingUrl)
  if (site) {
    for (const controls of openWindows) {
      if (controls.askShare(contents, site, details, callback)) return
    }
  }
  callback(false)
}

// The page's own frames: those on its origin, the only ones that can ask.
const ownFrames = (contents) => contents.mainFrame.framesInSubtree.filter((frame) => frame.origin === contents.mainFrame.origin)

// What grantShare is granting, for onDisplayMedia, which Electron calls from
// within `callback(true)`.
// getUserMedia with chromeMediaSource makes the very same request, but then
// captures whatever the page names, without onDisplayMedia. It can't be refused
// beforehand: Electron's handler gets identical details for both, and only
// picks the way after the answer (MediaAccessAllowed in its
// web_contents_permission_helper.cc, as of 45). So the page is held still
// (SIGSTOP) while it is granted, which is done within this call, and goes on
// only if the choice was taken; else it is killed, having run nothing since and
// so having seen nothing. Site isolation keeps a process to one site, so at
// most that same site's other tabs go with it.
// A page that can't be held is refused.
let granting = null
function grantShare(contents, site, callback, streams) {
  const held = []
  const release = (name) => {
    for (const pid of held) {
      try {
        process.kill(pid, name)
      } catch {
        // Already gone.
      }
    }
  }
  try {
    for (const pid of new Set(ownFrames(contents).map((frame) => frame.osProcessId))) {
      process.kill(pid, 'SIGSTOP')
      held.push(pid)
    }
  } catch {
    release('SIGCONT')
    return callback(false)
  }
  let taken = false
  granting = { contents, site, streams, take: () => { taken = true; mediaPages.add(contents) } }
  try {
    callback(true)
  } finally {
    granting = null
    release(taken ? 'SIGCONT' : 'SIGKILL')
  }
}

// Captures only what grantShare is granting, to the page and site it is for.
// A request from anywhere else leaves the grant alone, and is refused.
function onDisplayMedia({ frame, securityOrigin }, callback) {
  const grant = granting
  const top = grant && !grant.contents.isDestroyed() ? grant.contents.mainFrame : null
  if (!frame || !top || frame.top?.frameTreeNodeId !== top.frameTreeNodeId || permissions.originOf(securityOrigin) !== grant.site) return callback(null)
  granting = null
  grant.take()
  callback(grant.streams)
}

// Whether macOS lets Lit see windows and screens. Tabs need no permission.
const canCaptureScreen = () => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted'

// Opens where macOS grants that. Trying to list them first is what puts Lit
// on the list there.
function openScreenPermission() {
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {})
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {})
}

// Answers `site`'s request for `kinds` from its choices, or asks on the tab.
// Only a tab opens apps, whatever was saved.
function answerRequest(store, contents, site, kinds, callback) {
  if (!site || !kinds.length) return callback(false)
  if (permissions.isApp(kinds[0]) && ![...openWindows].some((controls) => controls.hasTab(contents))) return callback(false)
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

// A server or proxy wants a username and password, for a tab. Anything else
// (a service worker, a download, Lit's own pages and requests) is refused, as
// Electron does by default. The session that asked keeps the answer, in
// memory; Lit itself keeps none.
app.on('login', (event, contents, details, authInfo, callback) => {
  const controls = contents && [...openWindows].find((each) => each.hasTab(contents))
  const request = controls && signIn.describe(details, authInfo, contents.getURL())
  if (!request) return
  event.preventDefault()
  controls.askSignIn(contents, request, callback)
})

// What every session browsing pages needs: Lit's permission prompts, Do
// Not Track, downloads followed into the Downloads list, and what runs in
// its pages.
function setUpSession(ses, profile, store) {
  ses.setPermissionRequestHandler((...args) => onPermissionRequest(store, ...args))
  ses.setPermissionCheckHandler((...args) => onPermissionCheck(store, ...args))
  ses.setDisplayMediaRequestHandler(onDisplayMedia)
  ses.on('will-download', (_event, item) => trackDownload(item, ses, profile))
  ses.webRequest.onBeforeRedirect({ urls: ['<all_urls>'], types: ['mainFrame'] }, (details) => onAppRedirect(store, details))
  ses.registerPreloadScript({ type: 'frame', filePath: PAGE_PRELOAD })
  ses.registerPreloadScript({ type: 'frame', filePath: PASSKEYS_PRELOAD })
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
  ses.webRequest.onBeforeRedirect(null)
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
// How long (ms) a tab must be silent to stop showing as playing audio.
const SILENCE_AFTER = 1500
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

// The same for saved passwords.
function setPasswords(profile, next) {
  if (profile.deleted) return false
  try {
    passwords.save(profile.files.passwords, next)
  } catch {
    return false
  }
  profile.passwords = next
  for (const controls of windowsOf(profile)) controls.settingsChanged()
  return true
}

// The Keychain holds the key; null when it won't give it, or the password was
// encrypted with another one. Passwords are read only as they are needed.
function encrypt(password) {
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(password).toString('base64') : null
  } catch {
    return null
  }
}
function decrypt(secret) {
  try {
    return safeStorage.decryptString(Buffer.from(secret, 'base64'))
  } catch {
    return null
  }
}

// A saved password for Settings, after Touch ID on a Mac that has it:
// { password } or { error }, or {} when Touch ID was cancelled.
async function readPassword(profile, id) {
  const find = () => profile.passwords.logins.find((login) => login.id === id)
  const login = find()
  if (!login) return {}
  if (systemPreferences.canPromptTouchID?.()) {
    try {
      await systemPreferences.promptTouchID(`show the password for ${passwords.label(login.site)}`)
    } catch {
      return {}
    }
  }
  if (profile.deleted || !find()) return {}
  const password = decrypt(find().secret)
  return password === null ? { error: 'Couldn’t read this password from the Keychain.' } : { password }
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
  share: () => c.shareState(),
  palette: () => ({ commands: paletteSearch(c, '') }),
})[name]()

// The command palette's commands in window `c` (see src/commands.js):
// built afresh each time, so they follow the menu, tabs and settings.
const paletteCommands = (c) => commandStore.allCommands({
  menu: commandStore.menuCommands(Menu.getApplicationMenu()?.items ?? [], { skip: 'commandPalette' }),
  tabs: commandStore.tabCommands(c.otherTabs()),
  settings: commandStore.settingCommands(settingsStore.SECTIONS, c.profile.settings),
})
const paletteSearch = (c, text) => commandStore.match(paletteCommands(c), text).map(commandStore.shown)

// Runs the palette's command `id` once the palette has closed, so a
// command that opens a popup, or closes one, finds none open. A menu item
// runs as if picked from the menu with this window in front.
function runCommand(c, id) {
  const command = paletteCommands(c).find((each) => each.id === id)
  c.closePopup()
  if (!command) return
  if (command.item) return command.item.click(undefined, c.win, c.win.webContents)
  if (command.tabId) return c.activate(command.tabId)
  const error = changeSetting(c.profile, command.key, command.value)
  if (error) dialog.showMessageBox({ type: 'warning', message: error }).catch(() => {})
}

// What the Settings popup draws in a window of `profile`: the values, plus
// each shortcut as ⌘ symbols, and every profile.
function settingsState(profile, error) {
  const { settings, sitePermissions } = profile
  const labels = {}
  for (const setting of settingsStore.SETTINGS) {
    if (setting.type === 'shortcut') labels[setting.key] = settings[setting.key] ? shortcuts.label(settings[setting.key]) : ''
  }
  return { sections: settingsStore.SECTIONS, values: settings, labels, sitePermissions: permissions.list(sitePermissions), passwords: passwords.list(profile.passwords), quickSearchSites: quickSearch.list(), profileId: profile.id, profiles: profileList.profiles, profileColors: profileStore.COLORS, defaultBrowser: defaultBrowser(), ...(error && { error }) }
}

// Whether Lit is the Mac's default browser: 'yes', 'no', or 'unavailable' when
// run from source, where macOS would take Electron for the browser.
function defaultBrowser() {
  if (!app.isPackaged || process.platform !== 'darwin') return 'unavailable'
  return ['http', 'https'].every((scheme) => app.isDefaultProtocolClient(scheme)) ? 'yes' : 'no'
}

// The answer changes outside Lit, in macOS's question or System Settings, so
// it is read again when Lit comes to the front, and every second for a minute
// after asking.
let lastDefaultBrowser
let defaultBrowserTimer = null
function checkDefaultBrowser() {
  const now = defaultBrowser()
  if (now === lastDefaultBrowser) return
  lastDefaultBrowser = now
  for (const controls of openWindows) controls.settingsChanged()
}

// Asks macOS, which asks the person, for http and, once Lit has that, https:
// asked together, someone who says no would be asked twice. Returns why it
// couldn't, if so.
function makeDefaultBrowser() {
  if (defaultBrowser() !== 'no') return
  clearInterval(defaultBrowserTimer)
  const ask = (scheme) => app.setAsDefaultProtocolClient(scheme)
  let askedHttps = app.isDefaultProtocolClient('http')
  if (!ask(askedHttps ? 'https' : 'http')) return 'Couldn’t ask macOS. Choose Lit in System Settings › Desktop & Dock instead.'
  let left = 60
  defaultBrowserTimer = setInterval(() => {
    if (!askedHttps && app.isDefaultProtocolClient('http')) {
      askedHttps = true
      if (!app.isDefaultProtocolClient('https')) ask('https')
    }
    checkDefaultBrowser()
    if (!--left || lastDefaultBrowser === 'yes') clearInterval(defaultBrowserTimer)
  }, 1000)
}

// Links and files other apps open in Lit. Those that arrive before Lit is
// ready, as when one launches it, wait in `waitingLinks`; null once ready.
let waitingLinks = []
function openExternalLink(url) {
  if (waitingLinks) return waitingLinks.push(url)
  // In the profile used last, and never in a private window.
  const controls = windowsOf(currentProfile).filter((each) => !each.isPrivate).at(-1)
  if (!controls || shared().externalLinks === 'window') return createWindow({ url })
  if (controls.win.isMinimized()) controls.win.restore()
  controls.win.focus()
  controls.openLink(url)
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

// Unless Security Keys is on, Lit has no passkeys (src/passkeys.js). Called
// once, before any page: their processes take this as they start, and tabs and
// profiles share them.
function turnAwayPasskeys() {
  // Sites that look for PublicKeyCredential find none, in any frame, and offer
  // another way to sign in.
  app.commandLine.appendSwitch('disable-blink-features', 'WebAuth')
  // A request made anyway fails at once, as if cancelled, since macOS won't
  // let Lit use its passkey sheet.
  app.configureWebAuthn({ platformPasskeys: true })
}

// Ad and tracker blocking, in private sessions too (src/adblock.js), made at
// launch and switched with each profile's Block ads and trackers setting.
// It spares the pages of sites ads were stopped on (see adsOf in
// createWindow).
let adblock
const sparesAds = (contents, url) => [...openWindows].some((controls) => controls.sparesAds(contents, url))

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

// Show Tab Sidebar: hides the sidebar, or shows it, turning vertical tabs on
// first if need be (see sidebarToggle). The menu's checkbox follows as above.
function toggleTabSidebar(profile) {
  for (const [key, value] of sidebarToggle(profile.settings)) {
    if (!changeSetting(profile, key, value)) continue
    Menu.setApplicationMenu(buildMenu())
    dialog.showMessageBox({ type: 'warning', message: 'Couldn’t save settings' }).catch(() => {})
    return
  }
}

// `key`, `tabs`, `activeIndex`, `bounds`, `maximized`, `fullScreen` and
// `split` reopen a closed window (see `closed`), `split` being its split view
// by the tabs' places, { indexes, ratio }. Its old position is used only while it is
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
function createWindow({ key = nextWindowKey++, profile = currentProfile, isPrivate = false, url, tabs: restored = [], activeIndex = 0, bounds, maximized, fullScreen, split: restoredSplit } = {}) {
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
    // See src/quiet.js. Going full screen would show a hidden window.
    show: !quiet,
    fullscreenable: !quiet,
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
  // Split view: two tabs side by side, { ids: [left, right], ratio } (see
  // src/tabs.js), or null. It shows while either is the active tab, which
  // the toolbar is for; clicking the other page makes that one active.
  let split = null
  // The tabs on show: the active one, or both in split view.
  const shownTabs = () => paneTabs() ?? (active() ? [active()] : [])
  // The split's two tabs while it shows, left first, else null. Not while
  // the active page is full screen, which has the window to itself.
  const paneTabs = () => (split?.ids.includes(activeId) && active()?.fullScreen !== 'on' ? split.ids.map(find) : null)
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
  // Whether the pages start right of the tab sidebar: while it shows, and
  // not while the active page is full screen. `sidebarShown` is how much of
  // the sidebar's width they start right of, 0 to 1, between the two while
  // it slides (see slideSidebar), and where the tabs were, to tell a slide.
  let besideSidebar = false
  let sidebarShown = 0
  let slideTimer = null
  let lastTabsAt = tabsPlace(profile.settings)
  // The sidebar's width while its edge is being dragged, before it is saved
  // as the setting, and the width the toolbar was last sent to draw it at.
  let sidebarDragged = null
  let sentSidebar = null
  const chosenSidebar = () => sidebarDragged ?? profile.settings.sidebarWidth
  // Whether pages are framed as a card (the Frame pages setting, and always
  // in split view, so the gap and the active page's ring have room), which
  // a full screen page never is.
  let framed = profile.settings.framePages
  // The tabs split view last laid out side by side, as `ids,ratio`, or ''.
  let shownPanes = ''
  // While the click that made the other page of a split view the active one
  // is still down, { tab, top }: the pages stay at `top`, so the toolbar's
  // prompt row coming or going doesn't move them under the pointer.
  let heldTop = null
  // The click is done, or something else took its release.
  const releaseHeldTop = () => { if (heldTop) { heldTop = null; sync() } }
  // The tab whose page took the window full screen with it, if one did: the
  // window leaves with that page. One you made full screen yourself stays.
  let fullScreenFor = null
  // The window's full screen, from its own events, as macOS takes a moment to
  // change it: 'own' (you made it so), 'page' (one did), 'leaving' (one did
  // and has left, or is gone) or null.
  let windowFullScreen = null

  // The sign-in prompt on show, which goes before a permission prompt, and
  // the one for the tab's page itself, which is hidden meanwhile.
  const signInOf = (tab) => tab?.signIns[0]
  const signInPage = (tab) => tab?.signIns.find((prompt) => prompt.main)
  const promptHeight = (tab) => {
    const asked = signInOf(tab)
    if (asked) return SIGN_IN_HEIGHT + (asked.note ? SIGN_IN_NOTE : 0)
    return tab && promptOf(tab) ? PROMPT_HEIGHT : 0
  }

  // With no bookmarks the bar would be an empty row, so it stays hidden.
  const showsBookmarks = () => profile.settings.bookmarkBar && profile.bookmarks.length > 0

  // Everything the toolbar draws. Sent whenever any of it changes.
  function sync() {
    if (win.isDestroyed()) return
    const current = active()
    if (heldTop?.tab !== current) heldTop = null
    const top = current?.fullScreen === 'on' ? 0 : heldTop ? heldTop.top : BAR_HEIGHT + (showsBookmarks() ? BOOKMARKS_HEIGHT : 0) + promptHeight(current)
    const pair = paneTabs()
    const panes = pair ? `${split.ids},${split.ratio}` : ''
    const frame = current?.fullScreen !== 'on' && (profile.settings.framePages || Boolean(pair))
    const tabsAt = tabsPlace(profile.settings)
    const beside = current?.fullScreen !== 'on' && tabsAt === 'side'
    // Only showing or hiding the sidebar slides it; tabs moving to or from
    // the top, or a page going full screen, are at once, as the toolbar's are.
    const slides = tabsAt !== lastTabsAt && tabsAt !== 'top' && lastTabsAt !== 'top'
    lastTabsAt = tabsAt
    // The page moves sideways with the sidebar, or into a pane, and a list
    // of logins over it would be left where it was, as when the window is
    // resized.
    if (beside !== besideSidebar || panes !== shownPanes) hideLogins()
    const moved = beside !== besideSidebar
    if (moved) slideSidebar(beside, slides)
    if (top !== pageTop || frame !== framed || moved || panes !== shownPanes || chosenSidebar() !== sentSidebar) { pageTop = top; framed = frame; layout() }
    else reveal()
    const title = signInPage(current)?.url || current?.title || (current?.started ? current.url : '') || 'New Tab'
    const named = profiles.length > 1 ? `${title} — ${profile.name}` : title
    win.setTitle(isPrivate ? `${named} (Private)` : named)
    win.webContents.send('tabs', {
      activeId,
      navigationButtons: profile.settings.navigationButtons,
      framed,
      tabsAt,
      // Both tabs of the split view, shown or not, so the strip can mark them.
      split: split?.ids ?? null,
      tabs: tabs.map(({ id, title, url, favicon, loading, started, find, zoom: factor, pdf: isPdf, page, prompts, signIns, offer, error, audible, asleep }, index) => ({
        id, title, url, favicon, loading, started,
        asleep: Boolean(asleep),
        canGoBack: asleep ? asleep.history.index > 0 : !page.isDestroyed() && page.navigationHistory.canGoBack(),
        canGoForward: asleep ? asleep.history.index < asleep.history.entries.length - 1 : !page.isDestroyed() && page.navigationHistory.canGoForward(),
        audio: profile.settings.tabAudio ? audioOf({ page, audible, asleep }) : null,
        address: addressParts(signInPage({ signIns })?.url ?? url, profile.settings.fullAddress),
        // The address asking to sign in, not the page it would replace, so
        // another site's name is never over its prompt.
        ...(signInPage({ signIns }) && { title: '', url: signInPage({ signIns }).url, favicon: null }),
        // The tab's oldest unanswered sign-in; the rest wait.
        signIn: signIns[0] && { id: signIns[0].id, name: signIns[0].name, asks: signIn.asks(signIns[0]), note: signIns[0].note, main: signIns[0].main },
        // The tab's oldest unanswered permission request; the rest wait. Then
        // its offer to save a password.
        prompt: signIns[0] ? undefined : promptOf({ prompts, offer }),
        // The address bar shows the zoom, to reset it, when it is not the
        // default or the site has its own (which can match a later default).
        // A PDF's viewer shows its own zoom instead.
        zoom: started && !error && !isPdf && !signInPage({ signIns }) && (!zoom.same(factor, profile.settings.defaultZoom) || ownZoom(asleep ? url : page.isDestroyed() ? '' : page.getURL()))
          ? zoom.percent(factor)
          : '',
        find: find && { text: find.text, active: find.active, matches: find.matches },
        // The ad blocking button: what blocking does on the page, and its
        // site's name, or null to hide the button.
        ads: started && !error && !signInPage({ signIns }) && adsOf(tabs[index], url)
          ? { state: adsOf(tabs[index], url), site: permissions.label(permissions.originOf(url)) }
          : null,
        error: error && !signInPage({ signIns }) && {
          ...errors.describe(error, url),
          action: error.kind === 'crash' ? 'Reload' : 'Try again',
        },
      })),
    })
    for (const each of openWindows) each.shareTabsChanged()
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
  const sendBookmarks = () => { if (!win.isDestroyed()) win.webContents.send('bookmarks', { visible: showsBookmarks(), items: profile.bookmarks }) }
  // The toolbar's profile button, shown while there is more than one.
  const sendProfile = () => { if (!win.isDestroyed()) win.webContents.send('profile', { name: profile.name, color: profileStore.colorOf(profile.color).value, shown: profiles.length > 1 }) }
  // The toolbar's downloads indicator.
  const sendDownloads = () => { if (!win.isDestroyed()) win.webContents.send('downloads', downloadsSummary(ses)) }

  // Where the pages go: the room under the toolbar, or in split view its
  // two panes, which the toolbar learns to draw what goes around and between
  // them (`panes`: { ids, rects: [{ x, y, width, height }], gap }, or null).
  // `area` is the room, for the divider (resizeSplit).
  let area = { x: 0, width: 0 }
  function layout() {
    const { width, height } = win.getContentBounds()
    const inset = framed ? PAGE_INSET : 0
    // The toolbar draws the sidebar this wide too, narrower in a narrow window.
    if (chosenSidebar() !== sentSidebar) { sentSidebar = chosenSidebar(); win.webContents.send('sidebar-width', sentSidebar) }
    const pageLeft = Math.round(sidebarShown * sidebarShowing(sentSidebar, width))
    area = { x: pageLeft + inset, width: Math.max(width - pageLeft - 2 * inset, 0) }
    const y = pageTop
    const pageHeight = Math.max(height - pageTop - inset, 0)
    const pair = paneTabs()
    const rects = pair && splitPanes(area, split.ratio, SPLIT_GAP, SPLIT_MIN)
    shownPanes = pair ? `${split.ids},${split.ratio}` : ''
    for (const tab of tabs) {
      const { x, width: pageWidth } = rects?.[pair.indexOf(tab)] ?? area
      tab.view.setBounds({ x, y, width: pageWidth, height: pageHeight })
      tab.view.setBorderRadius(framed ? PAGE_RADIUS : 0)
    }
    for (const view of Object.values(popups)) view.setBounds({ x: 0, y: 0, width, height })
    reveal()
    win.webContents.send('panes', pair && { ids: split.ids, rects: rects.map((rect) => ({ ...rect, y, height: pageHeight })), gap: SPLIT_GAP })
  }

  // Starts the pages right of the sidebar (`beside`) or at the window's
  // left. With `slides` they get there over SIDEBAR_SLIDE_MS, laid out each
  // frame, from wherever they are, so showing it again mid-slide turns back;
  // otherwise, or when the system asks for reduced motion, at once (the
  // caller lays them out).
  function slideSidebar(beside, slides) {
    besideSidebar = beside
    clearInterval(slideTimer)
    slideTimer = null
    const from = sidebarShown
    const to = beside ? 1 : 0
    if (!slides || systemPreferences.getAnimationSettings?.().prefersReducedMotion) { sidebarShown = to; return }
    const start = Date.now()
    slideTimer = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(slideTimer); return }
      const t = Math.min((Date.now() - start) / SIDEBAR_SLIDE_MS, 1)
      sidebarShown = from + (to - from) * easeOut(t)
      if (t === 1) { clearInterval(slideTimer); slideTimer = null }
      layout()
    }, 1000 / 60)
  }

  // Shows the pages on show, and hides the rest: the active tab's, or both
  // in split view. A blank tab shows the toolbar's search box (or, in split
  // view, its pane's card), and one that failed the toolbar's error page.
  function reveal() {
    const pair = paneTabs()
    // A sleeping tab coming on show wakes first.
    for (const tab of shownTabs()) wake(tab)
    for (const tab of tabs) tab.view.setVisible((pair ? pair.includes(tab) : tab.id === activeId) && tab.started && !tab.error && !signInPage(tab))
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

  // The page the window is full screen for is done with it. Electron mostly
  // restores the window itself, but not after a page closed, or one that went
  // full screen while the window was leaving.
  function windowDone() {
    fullScreenFor = null
    if (windowFullScreen !== 'page') return
    windowFullScreen = 'leaving'
    win.setFullScreen(false)
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
    reveal()
    if (!focus || popupOpen) return
    if (signInPage(tab)) {
      win.webContents.focus()
      win.webContents.send('focus-sign-in', signInPage(tab).id)
    } else if (tab.error) {
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
    tab.submitted = null
    dropPrompts(tab)
    hideLoginsOf(tab)
    dropSignIns(tab)
    if (tab.id === activeId) show(tab, win.isFocused() && !win.webContents.isFocused())
    sync()
  }

  // Reload, for a page as it is or one that failed.
  function reload(tab, ignoreCache = false) {
    // A sleeping tab loads its page again by waking.
    if (tab?.asleep) return wake(tab)
    if (!tab?.started || tab.page.isDestroyed()) return
    if (tab.error) retry(tab, ignoreCache)
    else if (ignoreCache) tab.page.reloadIgnoringCache()
    else tab.page.reload()
  }

  // Stops loading. A tab stopped before its first page came has nothing to
  // show, so it goes back to the search box. A restored one keeps its address
  // and back/forward list, for Reload to load, as in other browsers.
  function stop(tab) {
    if (!tab?.started || tab.page.isDestroyed()) return
    // Before its first page, a restored tab stopped is not to try again (addTab).
    tab.stopped = true
    tab.page.stop()
    if (tab.url || tab.error || tab.page.getURL()) return
    tab.started = false
    tab.pendingUrl = undefined
    show(tab)
    sync()
  }

  // Back (`delta` -1) or forward (1) one page, or in a new tab next to this
  // one, with its back/forward list, as ⌘-clicked links open. Chromium may
  // skip a page that added itself to the list; the new tab can't, as Electron
  // doesn't say which those are.
  function stepPage(tab, delta, newTab) {
    if (!tab?.started || tab.page.isDestroyed()) return
    const list = tab.page.navigationHistory
    if (!newTab) return delta < 0 ? list.goBack() : list.goForward()
    const history = { entries: list.getAllEntries(), index: list.getActiveIndex() + delta }
    if (history.entries[history.index]) addTab({ history, index: tabs.indexOf(tab) + 1, background: !profile.settings.switchToNewTabs })
  }

  // The pages Back or Forward leads to, to pick one.
  function showStepMenu(tab, delta, { x, y }) {
    if (!tab?.started || tab.page.isDestroyed()) return
    const list = tab.page.navigationHistory
    const entries = list.getAllEntries()
    popup(navigationMenu({ entries, index: list.getActiveIndex() }, delta), (_command, index) => {
      // The list may have changed while the menu was open.
      if (tab.page.isDestroyed() || list.getEntryAtIndex(index)?.url !== entries[index].url) return
      list.goToIndex(index)
      if (tab.id === activeId) show(tab)
    }, { x, y })
  }

  // Loads the failed address again. Chromium reloads nothing when that would
  // send a form again, so its address is opened without the form instead (past
  // the cache, if asked, only for the page itself: Electron can't for the rest).
  function retry(tab, ignoreCache = false) {
    const url = tab.url || tab.page.getURL() || tab.pendingUrl
    if (tab.page.getURL() === url) {
      if (ignoreCache) tab.page.reloadIgnoringCache()
      else tab.page.reload()
    }
    if (!tab.page.isLoading()) tab.page.loadURL(url, ignoreCache ? { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache' } : {}).catch(() => {})
  }

  function activate(id, focus = true) {
    const tab = find(id)
    if (!tab) return
    if (id !== activeId) hideLogins()
    // Sharing is asked by the tab on show.
    if (share && share.tab !== tab) closePopup()
    // Those left were on show until now; the one shown wakes (reveal), and
    // may be put to sleep again.
    for (const shown of shownTabs()) shown.seen = Date.now()
    tab.seen = Date.now()
    tab.keepAwake = false
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
    // `seen` is when the tab was last on show, for sleepIdle; `asleep`
    // holds what a sleeping tab needs to wake (see sleep).
    const tab = { id: nextTabId++, view: null, page: null, title: '', url: '', favicon: null, loading: false, started: Boolean(url || webContents || history), history: null, find: null, zoom: profile.settings.defaultZoom, pdf: false, prompts: [], signIns: [], submitted: null, offer: null, fullScreen: null, error: null, audible: false, seen: Date.now(), asleep: null }
    tabs.splice(index, 0, tab)
    const page = attach(tab, webContents)
    if (history) restore(tab, history, url)
    else if (url) page.loadURL(url, referrer ? { httpReferrer: referrer } : {}).catch(() => {})
    // A popup can stay on the about:blank its opener writes into, without
    // ever firing did-navigate, so it gets its zoom here.
    if (webContents) setZoom(tab, zoomOf(page.getURL() || 'about:blank'))
    if (background) sync()
    else activate(tab.id)
    return tab
  }

  // Gives the tab a page of its own, in a view under the window's popups:
  // when it opens, and again each time it wakes. Its events act on the
  // tab while this page is the tab's.
  function attach(tab, webContents) {
    // A page a tab opened is already in its session.
    // Private pages get no DevTools, which saves its state (breakpoints and
    // the like) to the profile on disk, whatever the session. A page opened
    // by another needs PAGE_PREFERENCES both here and in its opener's
    // setWindowOpenHandler, or its frames miss them.
    const view = new WebContentsView(webContents ? { webContents, webPreferences: PAGE_PREFERENCES } : { webPreferences: { ...PAGE_PREFERENCES, session: ses, devTools: !isPrivate } })
    // `page` keeps the WebContents itself: once it is destroyed (a popup
    // calling window.close(), or the tab going to sleep), Electron clears
    // `view.webContents`.
    const page = view.webContents
    tab.view = view
    tab.page = page
    // A page opened by another ignores the devTools preference.
    if (isPrivate) page.on('devtools-opened', () => page.closeDevTools())
    // Lit sets each page's zoom itself (setZoom). Chromium's own sharing,
    // by URL, would also zoom Lit's toolbar when a tab shows its file.
    page.setZoomMode('isolated')
    view.setVisible(false)
    win.contentView.addChildView(view)
    // Re-adding a view moves it to the top, so popups stay over new tabs.
    for (const overlay of Object.values(popups)) win.contentView.addChildView(overlay)
    layout()

    page.on('did-start-loading', () => { tab.loading = true; tab.started = true; refresh(tab) })
    page.on('did-stop-loading', () => { tab.loading = false; tab.leaving = false; settle(tab); dropSignIns(tab, true); sync(); checkResponse(tab); checkLogin(tab) })
    // The address being opened, before it commits: a tab duplicated or
    // closed before its first page commits gets it.
    // Whether the page started it (a link, a script) or Lit did (the
    // address bar, Back, a reload), for `committed`.
    page.on('did-start-navigation', ({ url, isMainFrame, isSameDocument, initiator }) => {
      if (!isMainFrame) return
      tab.pendingUrl = url
      // Leaving the page, or a load that asks, drops their sign-ins, and the
      // page left asks no more (askSignIn); a load only stopped drops its own
      // (did-stop-loading).
      if (!isSameDocument) { tab.leaving = true; dropSignIns(tab) }
      // For onAppRedirect. Read now: a frame can be gone by the time its
      // navigation redirects. A new page cancels the one still on its way, so
      // this is the latest's; a move within the page (#section) leaves it
      // loading, so it changes nothing here.
      if (!isSameDocument) tab.startedByFrame = Boolean(initiator?.parent)
      tab.startedByPage = Boolean(initiator)
      // The address bar, Back or a reload is not the sign-in going on.
      if (!isSameDocument && !initiator) tab.submitted = tab.loginName = null
    })
    // Asked about in onAppRedirect, not here; a frame's is refused.
    page.on('will-redirect', (event) => { if (permissions.opensApp(event.url)) event.preventDefault() })
    // A click, key press, touch or scroll on the page since its last page
    // committed, for `committed`: a page moving on with none is redirecting.
    page.on('input-event', (_event, input) => {
      if (['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart', 'mouseWheel', 'gestureScrollBegin'].includes(input.type)) tab.touched = true
      // In split view, clicking the other page makes it the active one; the
      // click gives it focus itself. The pages move for its prompts once the
      // click is done (see heldTop).
      if (['mouseDown', 'touchStart'].includes(input.type) && tab.id !== activeId && paneTabs()?.includes(tab)) {
        heldTop = { tab, top: pageTop }
        activate(tab.id, false)
      }
      if (['mouseUp', 'touchEnd', 'touchCancel'].includes(input.type) && heldTop?.tab === tab) releaseHeldTop()
      // Back skips pages that added themselves with no click or key press on
      // them, so one can be what makes it possible, with no other event.
      // Chromium counts it a moment later.
      const canGoBack = () => !page.isDestroyed() && page.navigationHistory.canGoBack()
      if (['mouseDown', 'rawKeyDown', 'keyDown', 'touchEnd'].includes(input.type) && !canGoBack()) {
        setTimeout(() => { if (canGoBack()) sync() }, 200)
      }
    })
    // Each new page opens at its site's zoom. A new page has no title yet; a restored one keeps its entry's title,
    // as Chromium does not announce a title it already had.
    page.on('did-navigate', (_event, url, status) => {
      const history = page.navigationHistory
      tab.title = history.getEntryAtIndex(history.getActiveIndex())?.title || ''
      tab.favicon = null
      tab.pageId = nextPageId++
      mediaPages.delete(page)
      // A new page has nothing typed into it (page-edited).
      tab.edited = false
      tab.find = findState.reset(tab.find)
      // A new page has not asked for anything yet; the old page's requests go.
      dropPrompts(tab)
      moveLogin(tab, status)
      dropSignIns(tab)
      tab.leaving = false
      // Until checkPdf says otherwise.
      tab.pdf = false
      // Leaving the site ends its Stop on This Site Once.
      if (tab.adsOnce && permissions.originOf(url) !== tab.adsOnce) tab.adsOnce = null
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
      if (isMainFrame) committed(tab, url, true)
      // A frame's moves are in the back/forward list too.
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
    // A short silence (between songs) doesn't count as stopping, so the
    // tab's speaker doesn't come and go.
    page.on('audio-state-changed', ({ audible }) => {
      clearTimeout(tab.silence)
      if (audible) { tab.audible = true; sync() }
      else tab.silence = setTimeout(() => { tab.audible = false; sync() }, SILENCE_AFTER)
    })
    page.on('did-stop-loading', () => { if (tab.fullScreen === 'leaving') leaveFullScreen(tab) })
    // The page asked to be full screen (a video's button), or stopped;
    // tab.fullScreen is 'on', 'leaving' (asked to stop), or null.
    // Electron makes the window full screen with it; the toolbar hides.
    // One granted it only after its tab was left gives it back, as does one
    // with a question in the toolbar.
    page.on('enter-html-full-screen', () => {
      tab.fullScreen = 'on'
      if (windowFullScreen !== 'own') fullScreenFor = tab
      sync()
      if (tab.id !== activeId || tab.prompts.length || tab.signIns.length) leaveFullScreen(tab)
    })
    page.on('leave-html-full-screen', () => {
      tab.fullScreen = null
      if (fullScreenFor === tab) windowDone()
      sync()
    })
    // Keys for the list under a login field, while it shows; any other goes
    // to the page. Here, so the page never answers them itself.
    page.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && !input.isComposing && tab.id === activeId && loginsKey(input.key)) event.preventDefault()
    })
    // Escape in the page closes its find field too, as in Safari and
    // Firefox. The page still gets the key, and an input method's keeps it.
    page.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !input.isComposing && !loginsClosed && tab.find && tab.id === activeId) closeFind()
    })
    // A new page (or a reload) gets the open search run again once its
    // document is ready, without waiting for slow images; did-stop-loading
    // covers pages restored from the back-forward cache, which skip dom-ready.
    const rerunFind = () => { if (tab.find?.text && tab.find.requestId === null) search(tab) }
    page.on('dom-ready', rerunFind)
    page.on('did-stop-loading', rerunFind)
    // Whether the page is a PDF, which zooms in its viewer (src/pdf.js).
    // Asked apart from the page's own scripts, so no page passes for one.
    const checkPdf = async () => {
      const { pageId } = tab
      if (page.isDestroyed()) return
      const isPdf = (await page.executeJavaScriptInIsolatedWorld(CHECK_WORLD, [{ code: pdf.IS_PDF }]).catch(() => false)) === true
      if (tab.pageId !== pageId || tab.pdf === isPdf) return
      tab.pdf = isPdf
      sync()
    }
    page.on('dom-ready', checkPdf)
    page.on('did-stop-loading', checkPdf)
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
    // page closes itself (window.close() on a popup it opened). A page
    // closed to sleep leaves its tab asleep instead.
    page.on('destroyed', () => {
      if (tab.page !== page) return
      if (tab.sleeping && !tab.closedByUser) fellAsleep(tab)
      else removeTab(tab)
    })
    // Electron cancels an unload a page objects to without asking; ask the
    // way other browsers do, both for closing the tab and for leaving the page.
    // A page going to sleep is not asked: it stays awake, until it is next
    // on show, as it may hold something typed that would be lost.
    page.on('will-prevent-unload', (event) => {
      if (tab.sleeping && !tab.closedByUser) {
        tab.sleeping = null
        tab.keepAwake = true
        return
      }
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
    // A link to another app loads nothing in its tab, and its prompt is on
    // this one, so that tab stays behind and closes once the app was asked for.
    page.setWindowOpenHandler(({ url, disposition }) => ({
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: PAGE_PREFERENCES },
      createWindow: (options) => {
        const toApp = permissions.opensApp(url)
        const opened = addTab({
          webContents: options.webContents,
          background: toApp || (disposition === 'background-tab' && !profile.settings.switchToNewTabs),
          index: tabs.indexOf(tab) + 1,
        }).page
        if (toApp) opened.once('did-stop-loading', () => { if (!opened.getURL()) opened.close() })
        return opened
      },
    }))

    // A right-click's menu takes the release of the click (see heldTop).
    page.on('context-menu', (_event, params) => { releaseHeldTop(); showPageMenu(page, params) })
    return page
  }

  // Loads a back/forward list ({ entries, index }) into the tab's page: a
  // closed tab reopened, a tab restored or duplicated, or one waking.
  // `url` loads if that fails.
  function restore(tab, history, url) {
    const { page } = tab
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
      if (tab.error || tab.page !== page) return
      if (retry && !tab.stopped && !page.isDestroyed()) page.loadURL(retry).catch(restored)
      else restored()
    })
  }

  // Sleeping tabs. A tab out of sight for a while (the Sleep tabs setting)
  // closes its page, which frees its memory, and keeps what the tab strip
  // shows (title, icon, address) and its back/forward list, with each
  // page's scroll position and form values, to load again once shown. The
  // page is closed the way closing the tab does, so one that would ask
  // before leaving stays awake instead (will-prevent-unload).
  // tab.sleeping is set while its page closes, tab.asleep once it has.
  function sleep(tab) {
    const history = liveHistory(tab)
    if (!history) return
    tab.sleeping = { history, muted: tab.page.isAudioMuted() }
    tab.page.close({ waitForBeforeUnload: true })
  }

  // The page closed; the tab keeps no view until it wakes. Shown meanwhile
  // (or beside the active tab in split view), it wakes right away.
  function fellAsleep(tab) {
    if (win.isDestroyed() || !find(tab.id)) return
    win.contentView.removeChildView(tab.view)
    tab.asleep = tab.sleeping
    tab.sleeping = null
    tab.loading = false
    clearTimeout(tab.silence)
    tab.audible = false
    tab.leaving = false
    if (tab.id === activeId) show(tab)
    else if (shownTabs().includes(tab)) reveal()
    sync()
  }

  // A new page for the tab, on the page it was on, as when it is reopened:
  // not a new visit. Muting belongs to the tab, so it stays. One woken
  // out of sight (Reload in its menu) counts as just seen, so it isn't put
  // back to sleep as soon as it loads.
  function wake(tab) {
    if (!tab.asleep) return
    const { history, muted } = tab.asleep
    tab.asleep = null
    tab.stopped = false
    tab.seen = Date.now()
    attach(tab)
    tab.page.setAudioMuted(muted)
    restore(tab, history)
  }

  // Puts to sleep the tabs out of sight for `minutes` (see sleepy in
  // src/tabs.js), from a timer in main.
  function sleepIdle(now, minutes) {
    const shown = shownTabs()
    for (const tab of shown) tab.seen = now
    for (const tab of tabs) {
      if (tab.sleeping || tab.page.isDestroyed()) continue
      const site = permissions.originOf(tab.url)
      const inUse = tab.page.isBeingCaptured() || tab.page.isCurrentlyAudible() || tab.page.isDevToolsOpened() || mediaPages.has(tab.page) ||
        (Boolean(site) && permissions.status(permissionStore.sites, site, ['notifications']) === 'allow')
      const asking = tab.prompts.length > 0 || tab.signIns.length > 0 || Boolean(tab.offer) || share?.tab === tab
      // The page's own address: a popup can be on one that never committed.
      if (sleepy({ ...tab, shown: shown.includes(tab), url: tab.started && tab.url && urlOf(tab), asking, inUse }, now, minutes)) sleep(tab)
    }
  }

  // A new tab from ⌘T or the + button, placed and filled as Settings says.
  function newTab(url = profile.settings.newTabPage ? toUrl(profile.settings.newTabPage, profile.settings.searchEngine) : undefined) {
    const current = active()
    addTab({
      url,
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
  // page has committed; a sleeping tab's, as it was when it fell asleep.
  function liveHistory(tab) {
    if (tab.asleep) return tab.asleep.history
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
  // `histories` are all its tabs', in order, for its split view's places.
  function closedWindow(histories, activeIndex) {
    const indexes = split?.ids.map((id) => tabs.findIndex((tab) => tab.id === id))
    return {
      key, tabs: histories, activeIndex, bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: windowFullScreen === 'own', profile: profile.id,
      ...(indexes && histories.length === tabs.length && { split: { indexes, ratio: split.ratio } }),
    }
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
    if (tab.id === activeId && !tab.error && !signInPage(tab) && !tab.view.getVisible()) show(tab)
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

  // The same tabs, in the order of their ids.
  function arrange(order) {
    tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    sync()
  }

  function removeTab(tab) {
    if (!find(tab.id)) return
    dropPrompts(tab)
    dropSignIns(tab)
    // Its split view ends, and the tab beside it takes its place.
    const partner = split?.ids.includes(tab.id) ? split.ids.find((id) => id !== tab.id) : null
    if (partner !== null) split = null
    const nextId = partner !== null && activeId === tab.id ? partner : afterClose(ids(), activeId, tab.id)
    const focus = tab.closeFocus ?? true
    const index = tabs.indexOf(tab)
    const history = tab.started ? saveHistory(tab) || tab.closeSnapshot || null : null
    // A page closed before it finished loading was still seen.
    if (tab.closedByUser) settle(tab)
    tabs.splice(index, 1)
    if (win.isDestroyed()) return
    if (!tab.asleep) win.contentView.removeChildView(tab.view)
    // Closing the last tab closes the window, as in Chrome and Safari,
    // unless Settings says to keep it open with a new tab. Then the window
    // is what reopens.
    const closesWindow = nextId === null && profile.settings.closeWindowWithLastTab
    if (tab.closedByUser && !isPrivate) rememberClosed(profile, closesWindow ? closedWindow([history], 0) : { windowKey: key, index, history })
    // A page gone while full screen never leaves it, so its window does here.
    if (fullScreenFor === tab && !closesWindow) windowDone()
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
  // A sleeping tab's is the one it fell asleep on.
  const urlOf = (tab) => (tab.asleep ? tab.url : tab.page.isDestroyed() ? '' : tab.page.getURL())
  // A PDF zooms in its viewer, apart from its site's zoom (see src/pdf.js).
  const zoomPdf = (tab, direction) => { if (!tab.page.isDestroyed()) pdf.viewerOf(tab.page)?.executeJavaScript(pdf.zoomScript(direction)).catch(() => {}) }
  const zoomBy = (tab, direction) => { const url = urlOf(tab); if (tab.pdf) zoomPdf(tab, direction); else if (url) changeZoom(url, zoom.step(tab.zoom, direction)) }
  const resetZoom = (tab) => { const url = urlOf(tab); if (tab.pdf) zoomPdf(tab, 0); else if (url) changeZoom(url, profile.settings.defaultZoom) }

  // Permission prompts. A tab's requests wait in order, one prompt at a
  // time; the same request asked again joins the one waiting. Each prompt
  // is { id, site, kinds, callbacks }: `kinds` is the whole request, which
  // settles it, while the prompt asks only about the undecided ones.
  // A page can ask to open apps as often as it likes, each scheme a kind of
  // its own, so a tab asks about one at a time and refuses others meanwhile.
  // The same one asked again takes its place: Allow opens the last link, once.
  function askPermission(contents, site, kinds, callback) {
    const tab = tabs.find((each) => each.page === contents)
    if (!tab) return false
    const same = tab.prompts.find((prompt) => prompt.site === site && prompt.kinds.join() === kinds.join())
    const toApp = permissions.isApp(kinds[0])
    if (toApp && !same && tab.prompts.some((prompt) => permissions.isApp(prompt.kinds[0]))) {
      callback(false)
      return true
    }
    if (toApp && same) for (const replaced of same.callbacks.splice(0)) replaced(false)
    if (same) same.callbacks.push(callback)
    else tab.prompts.push({ id: nextPromptId++, site, kinds, callbacks: [callback] })
    // The question is in the toolbar.
    leaveFullScreen(tab)
    sync()
    return true
  }
  // What the toolbar shows for a tab: its oldest request, else its offer to
  // save a password, or undefined.
  function promptOf({ prompts: [prompt], offer }) {
    if (prompt) {
      const site = permissions.label(prompt.site)
      const kinds = asking(prompt)
      const does = permissions.describe(kinds)
      return {
        id: prompt.id, site, kinds, says: `wants to ${does}`,
        allow: { text: 'Allow', label: `Allow ${site} to ${does}` },
        block: { text: 'Block', label: `Block ${site} from being able to ${does}` },
      }
    }
    if (!offer) return undefined
    const site = passwords.label(offer.site)
    const update = offer.action === 'update'
    const text = update ? 'Update' : 'Save'
    const whose = offer.username ? ` for ${offer.username}` : ''
    return {
      id: offer.id, site, kinds: ['password'], says: `— ${text.toLowerCase()} password${whose}?`,
      allow: { text, label: `${text} password${whose} on ${site}` },
      // A site with a saved password was never refused one.
      block: update ? null : { text: 'Never', label: `Never save passwords for ${site}` },
    }
  }
  // What a prompt asks about now: its kinds without a choice yet.
  const asking = (prompt) => permissions.undecided(permissionStore.sites, prompt.site, prompt.kinds)

  // Refuses the tab's waiting requests, without saving anything.
  function dropPrompts(tab) {
    if (share?.tab === tab) closePopup(!tab.page.isDestroyed())
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
    if (tab?.offer && tabId === activeId && !tab.prompts.length && !tab.signIns.length && tab.offer.id === promptId) return answerOffer(tab, choice)
    // Only the prompt on show: the active tab's first.
    const prompt = tabId === activeId ? tab?.prompts[0] : null
    if (prompt?.id !== promptId || !Array.isArray(kinds) || kinds.join() !== asking(prompt).join()) return
    if (choice) {
      const kinds = asking(prompt)
      prompt.answered = true
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
  // are redrawn too, as what they ask about may have changed. Allow opens an
  // app only for the prompt it was clicked on: a request waiting elsewhere,
  // in a tab that may be hidden, has its own link, and is dropped.
  function settlePrompts() {
    for (const tab of tabs) {
      for (const prompt of [...tab.prompts]) {
        const answer = permissions.status(permissionStore.sites, prompt.site, prompt.kinds)
        if (answer === 'ask') continue
        tab.prompts.splice(tab.prompts.indexOf(prompt), 1)
        const allowed = answer === 'allow' && (prompt.answered || !permissions.isApp(prompt.kinds[0]))
        for (const callback of prompt.callbacks) callback(allowed)
      }
    }
    sync()
  }

  // Saving a password someone signed in with. src/page.js says what was
  // submitted, kept on the tab (tab.submitted) until the sign-in looks to have
  // worked: the next page, once loaded, has no password field, or the page
  // that stayed lost its own. Then tab.offer asks, until it is answered or a
  // later page comes. The password never leaves main.
  const LOGIN_TIME = 60000
  const savesPasswords = () => profile.settings.savePasswords && !isPrivate
  function loginSubmitted(tab, site, { username, password, old }) {
    const { loginName } = tab
    // A click and the submit it makes both say so, the name only once.
    const before = tab.submitted
    const known = before?.site === site && before.password === password && !before.moved ? before.username : loginName?.site === site && Date.now() - loginName.at < LOGIN_TIME * 5 ? loginName.username : ''
    tab.loginName = null
    tab.submitted = savesPasswords() ? { site, username: username || known, password, old, at: Date.now(), moved: false } : null
  }
  // A new page came, or an error page, after which nothing is saved.
  function moveLogin(tab, status) {
    hideLoginsOf(tab)
    if (tab.submitted) {
      if (status >= 400 || Date.now() - tab.submitted.at > LOGIN_TIME) tab.submitted = null
      else tab.submitted.moved = true
    }
    // The second step's page comes by itself; one the person went on to from
    // there is no part of it.
    if (tab.loginName?.moved && tab.touched) tab.loginName = null
    else if (tab.loginName) tab.loginName.moved = true
    // Signing in often passes through more pages by itself.
    if (tab.offer && Date.now() - tab.offer.at > LOGIN_TIME) tab.offer = null
  }
  async function checkLogin(tab) {
    const { submitted } = tab
    if (!submitted?.moved || tab.page.isDestroyed()) return
    const failed = await tab.page.executeJavaScriptInIsolatedWorld(CHECK_WORLD, [{
      // Pages often draw their form after they load, maybe in a shadow tree,
      // so it is looked for a while.
      code: `(async () => {
        const asks = (root) => [...root.querySelectorAll('*')].some((each) => (each.matches('input[type=password]') && each.checkVisibility()) || (each.shadowRoot && asks(each.shadowRoot)))
        for (let i = 0; i < 8; i++) {
          if (asks(document)) return true
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return asks(document)
      })()`,
    }]).catch(() => null)
    // The page left before it could tell; the next one is checked.
    if (failed === null) return
    // Another page or sign-in may have come meanwhile.
    if (tab.submitted !== submitted || tab.page.isDestroyed() || tab.page.isLoadingMainFrame()) return
    if (failed) tab.submitted = null
    else offerLogin(tab)
  }
  function offerLogin(tab) {
    const { submitted } = tab
    tab.submitted = null
    if (!submitted || !find(tab.id) || !savesPasswords()) return
    const offer = passwords.offerFor(profile.passwords, submitted, decrypt)
    if (!offer) return
    tab.offer = { id: nextPromptId++, site: submitted.site, action: offer.action, username: offer.username, login: offer.id, secret: offer.secret, submitted, at: Date.now() }
    sync()
  }
  // 'allow' saves it, 'block' never asks for the site again, null is not now.
  function answerOffer(tab, choice) {
    const { offer } = tab
    tab.offer = null
    sync()
    // Saved, changed or removed meanwhile (in another tab or Settings): what
    // was asked no longer holds, so ask again if there is still reason to.
    const now = passwords.offerFor(profile.passwords, offer.submitted, decrypt)
    if (choice && (now?.action !== offer.action || now.id !== offer.login || now.secret !== offer.secret)) {
      tab.submitted = offer.submitted
      return offerLogin(tab)
    }
    let saved = true
    if (choice === 'allow') {
      const secret = encrypt(offer.submitted.password)
      saved = secret !== null && setPasswords(profile, passwords.put(profile.passwords, { site: offer.site, username: offer.username, secret }))
    } else if (choice === 'block' && offer.action === 'save') saved = setPasswords(profile, passwords.neverFor(profile.passwords, offer.site))
    if (saved || win.isDestroyed()) return
    dialog.showMessageBox(win, {
      type: 'warning',
      message: choice === 'allow' ? 'Couldn’t save the password' : 'Couldn’t save that choice',
      detail: 'Nothing was changed.',
    }).catch(() => {})
  }

  // The site's saved logins, listed under the field someone is in (src/
  // logins.html), in a view of its own like the suggestions. The page keeps
  // focus, and main handles the keys. `logins` is the list on show, or null:
  // { tab, frame, site, request, items, selected }. A click on it takes focus
  // from the page, which closes it, so it lasts until it has faded.
  let loginsView = null
  let logins = null
  let loginsFading = null
  let loginsHide = null
  let loginsGeneration = 0
  // Whether the Escape being handled closed the list, so it only does that.
  let loginsClosed = false

  function showLogins(tab, frame, site, { request, x, top: fieldTop, y, width, needsPassword }) {
    const items = profile.settings.fillPasswords ? passwords.forSite(profile.passwords, site).map(({ id, username }) => ({ id, username })) : []
    if (!items.length || tab.id !== activeId || tab.error || popupOpen || !win.isFocused()) return hideLogins()
    if (!loginsView) {
      loginsView = new WebContentsView({ webPreferences: { preload: PRELOAD, session: ses } })
      loginsView.setBackgroundColor('#00000000')
      loginsView.setVisible(false)
      windowsByPopup.set(loginsView.webContents, { controls, name: 'logins' })
      // The first list is sent before the page can hear it; send it again.
      loginsView.webContents.on('did-finish-load', sendLogins)
      loginsView.webContents.loadFile(path.join(__dirname, 'logins.html'))
    }
    clearTimeout(loginsHide)
    loginsFading = null
    logins = { tab, frame, site, request, needsPassword, items, selected: -1 }
    loginsGeneration++
    const bounds = win.getContentBounds()
    const listWidth = Math.min(Math.max(Math.round(width * tab.zoom), LOGINS_WIDTH), bounds.width)
    const height = LOGINS_HEADER + Math.min(items.length, LOGINS_ROWS) * SUGGESTION_ROW + SUGGESTIONS_PAD * 2
    // Above the field when only there it fits; else below, moved up to fit.
    const below = pageTop + Math.round(y * tab.zoom) + 4
    const above = pageTop + Math.round(fieldTop * tab.zoom) - 4 - height
    const top = below + height > bounds.height && above >= pageTop ? above : Math.max(pageTop, Math.min(below, bounds.height - height))
    loginsView.setBounds({
      // The page's own left edge, which a framed page has in from the window's.
      x: Math.max(0, Math.min(tab.view.getBounds().x + Math.round(x * tab.zoom), bounds.width - listWidth)),
      y: top,
      width: listWidth,
      height: Math.max(1, Math.min(height, bounds.height - top)),
    })
    if (!loginsView.getVisible()) win.contentView.addChildView(loginsView)
    loginsView.setVisible(true)
    sendLogins()
  }
  function sendLogins() {
    if (logins) loginsView.webContents.send('logins-show', { logins: logins.items, site: passwords.label(logins.site), generation: loginsGeneration })
  }

  // `left` is the page's field losing focus, which a click on the list does
  // too, so that click still counts while the list fades.
  function hideLogins(left = false) {
    if (!left) loginsFading = null
    if (!logins) return
    loginsFading = left ? logins : null
    logins = null
    loginsView.webContents.send('logins-hide')
    clearTimeout(loginsHide)
    loginsHide = setTimeout(() => {
      loginsFading = null
      if (win.isDestroyed()) return
      const hadFocus = loginsView.webContents.isFocused()
      loginsView.setVisible(false)
      const tab = active()
      if (hadFocus && tab) show(tab)
    }, SUGGESTIONS_FADE)
  }

  function hideLoginsOf(tab) {
    if ((logins ?? loginsFading)?.tab === tab) hideLogins()
  }

  // Whether the list took the key.
  function loginsKey(key) {
    loginsClosed = false
    if (!logins) return false
    const count = logins.items.length
    if (key === 'Escape') {
      hideLogins()
      return (loginsClosed = true)
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      logins.selected = key === 'ArrowDown' ? (logins.selected + 1) % count : logins.selected < 1 ? count - 1 : logins.selected - 1
      loginsView.webContents.send('logins-select', logins.selected)
      return true
    }
    if (key !== 'Enter' || logins.selected < 0) return false
    pickLogin(logins.items[logins.selected].id, loginsGeneration)
    return true
  }

  // Fills the picked login, only into the very page that asked: the frame must
  // still be there and on that site, and it checks again itself.
  function pickLogin(id, generation) {
    const list = logins || loginsFading
    const login = list && generation === loginsGeneration && list.items.some((item) => item.id === id)
      ? passwords.forSite(profile.passwords, list.site).find((each) => each.id === id)
      : null
    if (!login) return
    hideLogins()
    const { tab, frame, site, request } = list
    if (tab.page.isDestroyed() || frame.isDestroyed() || frame !== tab.page.mainFrame || frame.origin !== site) return
    // A field for the name alone (the first step of two) gets just that.
    const password = list.needsPassword ? decrypt(login.secret) : null
    if (list.needsPassword && password === null) {
      dialog.showMessageBox(win, { type: 'warning', message: 'Couldn’t read this password', detail: 'The Keychain didn’t unlock it. You can remove it in Settings and save it again.' }).catch(() => {})
      return
    }
    tab.page.focus()
    frame.send('login-fill', { request, site, username: login.username, password })
  }

  // Screen sharing. The tab's request waiting in the picker (src/share.html):
  // { id, tab, site, audio, callback, frames, sources, shown }, `audio` being
  // whether it wants sound too, `frames` the frames that may have asked (none
  // if the page did itself), `shown`
  // the tabs last sent to the picker, as text, and `sources` the windows and screens, null until listed. One
  // at a time, for the tab on show; others are refused, as is one while another
  // popup is open. Closing the picker, however that comes about, refuses it.
  let share = null
  function askShare(contents, site, { mediaTypes = [], isMainFrame, requestingUrl }, callback) {
    const tab = tabs.find((each) => each.page === contents)
    if (!tab) return false
    if (!profile.settings.screenSharing || share || popupOpen || tab.id !== activeId) {
      callback(false)
      return true
    }
    const asked = share = {
      id: nextShareId++,
      tab, site, callback,
      audio: mediaTypes.includes('audio'),
      frames: isMainFrame ? [] : ownFrames(contents).filter((frame) => frame.url === requestingUrl).map((frame) => frame.frameToken),
      allowed: canCaptureScreen(),
      sources: null,
    }
    openPopup('share')
    const listed = asked.allowed
      ? desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 340, height: 212 }, fetchWindowIcons: true })
      : Promise.resolve([])
    listed.catch(() => []).then((sources) => {
      if (share !== asked) return
      asked.sources = shareStore.sourceRows(sources)
      popups.share.webContents.send('share-changed', shareState())
    })
    return true
  }
  const dropShare = () => {
    if (!share) return
    const { callback } = share
    share = null
    callback(false)
  }
  // The tabs a share can be of: those of the windows on the same session (so
  // never across profiles, or in and out of private windows), but for the one
  // asking, which would show itself.
  const shareTabs = () => [...openWindows].filter((c) => c.session === ses).flatMap((c) => c.shareableTabs()).filter((tab) => tab !== share?.tab)
  const shareRows = () => shareTabs().map(({ id, pageId, title, url, favicon }) => ({ id, page: `${pageId} ${url}`, name: title || url, icon: favicon }))
  // A tab changed somewhere, which the picker follows.
  function shareTabsChanged() {
    if (!share) return
    const shown = JSON.stringify(shareRows())
    if (shown === share.shown) return
    share.shown = shown
    popups.share?.webContents.send('share-changed', shareState())
  }
  const shareState = () => share && {
    id: share.id,
    site: permissions.label(share.site),
    audio: share.audio,
    allowed: share.allowed,
    tabs: shareRows(),
    windows: share.sources && share.sources.windows,
    screens: share.sources && share.sources.screens,
  }
  // Shares what was picked. A tab is picked as the page the picker showed
  // (`page`): one that moved on meanwhile isn't it. A window or screen is looked
  // for again, as they may have gone while the picker was open; by id, since a
  // window's title can change all the time. What has gone is taken off the
  // picker, to choose again. A later choice replaces one still being looked for.
  // A frame that asked and has gone can't be given anything; all Electron says
  // of it is its address, so any with that one that has gone refuses it.
  async function chooseShare(kind, id, audio, page) {
    if (!share) return
    const asked = share
    const { tab, site, callback, audio: wantsAudio, frames } = asked
    const choice = asked.choice = {}
    let streams = null
    if (kind === 'tabs') {
      const picked = shareTabs().find((each) => each.id === id)
      if (picked && !shareRows().some((row) => row.id === id && row.page === page)) return shareTabsChanged()
      const frame = picked?.page.mainFrame
      if (frame && !frame.isDestroyed()) streams = shareStore.tabStreams(frame, wantsAudio && audio === true)
    } else if (kind === 'windows' || kind === 'screens') {
      const now = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => [])
      if (share !== asked || asked.choice !== choice) return
      const source = asked.sources?.[kind].find((each) => each.id === id)
      if (source && !now.some((each) => each.id === id)) {
        asked.sources = shareStore.stillThere(asked.sources, now)
        return popups.share?.webContents.send('share-changed', shareState())
      }
      if (source) streams = shareStore.sourceStreams(source)
    }
    const own = new Set(ownFrames(tab.page).map((frame) => frame.frameToken))
    if (!streams || !frames.every((token) => own.has(token))) return closePopup()
    share = null
    closePopup()
    grantShare(tab.page, site, callback, streams)
  }

  // Sign-in prompts. A tab's wait in order, one at a time, each { id,
  // callbacks } and what signIn.describe says; a request the same answer fits
  // joins the one waiting. Electron's callbacks are each called exactly once:
  // with the username and password, or with none, which refuses it and leaves
  // the server's own response.
  // A page that asks is on its way to replace the one there, whose requests
  // are refused as soon as it starts to load, so its prompt is the tab's only one. It gets the keyboard,
  // but not from someone typing in the toolbar, nor in a window behind.
  function askSignIn(contents, request, callback) {
    const tab = tabs.find((each) => each.page === contents)
    if (!request.main && tab.leaving) return callback()
    const same = tab.signIns.find((prompt) => prompt.key === request.key)
    if (same) {
      same.callbacks.push(callback)
      same.retry ||= request.retry
    } else tab.signIns.push({ id: nextPromptId++, ...request, callbacks: [callback] })
    // The question is in the toolbar.
    leaveFullScreen(tab)
    hideLoginsOf(tab)
    if (request.main && tab.id === activeId) show(tab, win.isFocused() && !win.webContents.isFocused())
    sync()
  }

  // Refuses the tab's waiting sign-ins, or (`mainOnly`) only its page's. The
  // page there is shown again; the toolbar hands back the focus.
  function dropSignIns(tab, mainOnly = false) {
    const dropped = tab.signIns.filter((prompt) => prompt.main || !mainOnly)
    if (dropped.length) endSignIns(tab, dropped)
  }

  function endSignIns(tab, ended, ...credentials) {
    tab.signIns = tab.signIns.filter((prompt) => !ended.includes(prompt))
    for (const prompt of ended) for (const callback of prompt.callbacks) callback(...credentials)
    if (tab.id === activeId && !tab.page.isDestroyed()) show(tab, false)
    sync()
  }

  // Signs in, or (`credentials` null) cancels. Only the prompt on show: the
  // active tab's first.
  function answerSignIn(tabId, promptId, credentials) {
    const tab = find(tabId)
    const prompt = tabId === activeId ? signInOf(tab) : null
    if (prompt?.id !== promptId) return
    if (credentials) endSignIns(tab, [prompt], credentials.username, credentials.password)
    else endSignIns(tab, [prompt])
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

  // Pops up a right-click menu of items from src/menus.js, at `at` ({ x, y },
  // in the window) or the pointer; `run` gets each chosen item's command and
  // arg. Shortcuts are only shown, since the application menu already answers
  // them.
  function popup(items, run, at) {
    if (!items.length || win.isDestroyed()) return
    Menu.buildFromTemplate(items.map((item) => (item.type === 'separator' ? item : {
      label: item.label,
      enabled: item.enabled ?? true,
      accelerator: item.accelerator || undefined,
      registerAccelerator: false,
      click: () => item.command && run(item.command, item.arg),
    }))).popup({ window: win, ...(at && { x: Math.round(at.x), y: Math.round(at.y) }) })
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

  // What a tab's speaker shows: 'muted' (even while nothing plays),
  // 'playing', or null.
  const audioOf = ({ page, audible, asleep }) => ((asleep ? asleep.muted : !page.isDestroyed() && page.isAudioMuted()) ? 'muted' : audible ? 'playing' : null)

  // Split View: the active tab beside a new one, or, in split view, its two
  // tabs one at a time again.
  function toggleSplit() {
    if (split?.ids.includes(activeId)) closeSplit()
    else openSplit(null)
  }

  // Shows tab `id` beside the active one (see splitWith), or a new tab
  // (null) right after it, and makes it the active one. The new tab is blank
  // whatever new tabs open, so its pane lists the tabs to pick from.
  function openSplit(id) {
    const current = active()
    if (!current || id === activeId) return
    const other = id === null ? addTab({ index: tabs.indexOf(current) + 1, background: true }) : find(id)
    if (!other) return
    split = splitWith(split, activeId, other.id)
    activate(other.id)
  }

  // Its two tabs stay, the active one on show.
  function closeSplit() {
    if (!split) return
    split = null
    sync()
  }

  // A tab picked in the blank pane of a new split view goes there instead,
  // and the blank tab closes, never to be reopened.
  function pickForSplit(blankId, id) {
    const blank = find(blankId)
    if (!blank || blank.started || blankId !== activeId || !split?.ids.includes(blankId) || split.ids.includes(id) || !find(id)) return
    split = { ...split, ids: split.ids.map((each) => (each === blankId ? id : each)) }
    activate(id)
    if (blank.page.isDestroyed()) removeTab(blank)
    else blank.page.close()
  }

  // The divider dragged to `x` in the window, or back to the middle (null).
  function resizeSplit(x) {
    if (!paneTabs()) return
    split = { ...split, ratio: x === null ? 0.5 : splitRatio(area, x, SPLIT_GAP, SPLIT_MIN) }
    hideLogins()
    layout()
    if (!isPrivate) sessionChanged()
  }

  // The sidebar's edge dragged to `x` in the window: the sidebar follows it
  // in this window (see sidebarWidth), only as wide as it can show, and
  // with `done`, on release, that is saved as the setting, for every window.
  // `x` null resets it to the default.
  function resizeSidebar(x, done) {
    if (tabsPlace(profile.settings) !== 'side' || active()?.fullScreen === 'on') return
    const fits = sidebarShowing(SIDEBAR.most, win.getContentBounds().width)
    const width = x === null ? SIDEBAR.standard : sidebarWidth(Math.min(x, fits))
    hideLogins()
    if (!done) { sidebarDragged = width; layout(); return }
    sidebarDragged = null
    saveSidebar(width)
  }

  // ← or → on the sidebar's edge (`direction` -1 or 1), `big` with ⇧.
  function nudgeSidebar(direction, big) {
    if (tabsPlace(profile.settings) !== 'side' || active()?.fullScreen === 'on') return
    const fits = sidebarShowing(SIDEBAR.most, win.getContentBounds().width)
    const from = sidebarShowing(profile.settings.sidebarWidth, win.getContentBounds().width)
    hideLogins()
    saveSidebar(Math.min(sidebarNudged(from, direction, big ? SIDEBAR_BIG_STEP : SIDEBAR_STEP), fits))
  }

  // Saving lays out every window (see settingsChanged); a failed save puts
  // this one back.
  function saveSidebar(width) {
    if (width !== profile.settings.sidebarWidth && changeSetting(profile, 'sidebarWidth', width)) {
      dialog.showMessageBox({ type: 'warning', message: 'Couldn’t save settings' }).catch(() => {})
    }
    layout()
  }

  // Muting belongs to the tab: it lasts across pages, until it closes.
  function toggleMute(id) {
    const tab = find(id)
    if (tab?.asleep) {
      tab.asleep.muted = !tab.asleep.muted
      return sync()
    }
    if (!tab || tab.page.isDestroyed()) return
    tab.page.setAudioMuted(!tab.page.isAudioMuted())
    sync()
  }

  // A copy of the tab right after it, with its back/forward history. A
  // tab whose first page has not committed yet has no history, so its copy
  // loads the address being opened, as does a copy whose history fails to
  // restore. A tab on the search box copies as blank.
  function duplicateTab(id) {
    const tab = find(id)
    if (!tab) return
    const index = tabs.indexOf(tab) + 1
    if (tab.asleep) return addTab({ history: tab.asleep.history, url: tab.url, index })
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
    const keys = Object.fromEntries(['reload', 'duplicateTab', 'muteTab', 'splitView', 'closeTab', 'closeOtherTabs', 'closeTabsToRight']
      .map((command) => [command, profile.settings[`shortcuts.${command}`]]))
    const inSplit = Boolean(split?.ids.includes(id))
    popup(tabMenu({ index: tabs.indexOf(tab), count: tabs.length, started: tab.started, muted: audioOf(tab) === 'muted', split: inSplit, active: id === activeId, keys }), (command) => {
      if (!find(id)) return
      switch (command) {
        // Beside the active tab, or, for the active tab itself, a new one.
        case 'split': return openSplit(id === activeId ? null : id)
        case 'unsplit': return split?.ids.includes(id) && closeSplit()
        case 'reload': return reload(tab)
        case 'duplicate': return duplicateTab(id)
        case 'mute': return toggleMute(id)
        case 'close': return closeTab(id)
        case 'closeOthers': return closeOtherTabs(id)
        case 'closeToRight': return closeTabsToRight(id)
      }
    })
  }

  // What ad blocking does on the page at `url` in `tab`: null where it does
  // nothing (it is off, or the page is no web site's), else 'block', 'site'
  // (Stop on This Site: the site's ads kind saved as Allow, in the window's
  // permission store) or 'once' (Stop on This Site Once: this tab, until it
  // leaves the site). See adsMenu and src/adblock.js.
  function adsOf(tab, url) {
    const site = profile.settings.blockAds && /^https?:/i.test(url || '') ? permissions.originOf(url) : null
    if (!site) return null
    if (tab.adsOnce === site) return 'once'
    return permissions.status(permissionStore.sites, site, ['ads']) === 'allow' ? 'site' : 'block'
  }

  // The toolbar's ad blocking button, for the tab it showed. Each choice
  // reloads the page, for its ads to come or go; other tabs on the site
  // change at their next load.
  function showAdsMenu(id, at) {
    const tab = find(id)
    const ads = tab && !tab.error && adsOf(tab, tab.url)
    if (!ads) return
    const site = permissions.originOf(tab.url)
    popup(adsMenu({ ads, label: permissions.label(site) }), (command) => {
      // The tab may have closed or moved on while the menu was open.
      if (!find(id) || permissions.originOf(tab.url) !== site) return
      if (command === 'settings') return openPopup('settings', 'privacy')
      tab.adsOnce = command === 'stopOnce' ? site : null
      // Unsaved, a choice still holds until Lit quits.
      if (command === 'stopSite') permissionStore.choose(site, ['ads'], 'allow')
      if (command === 'resume' && adsOf(tab, tab.url) === 'site') permissionStore.choose(site, ['ads'], null)
      reload(tab)
      sync()
    }, at)
  }

  // The toolbar's profile button: every profile, and managing them.
  function showProfileMenu({ x, y }) {
    if (win.isDestroyed()) return
    Menu.buildFromTemplate(profileItems(profile)).popup({ window: win, x: Math.round(x), y: Math.round(y) })
  }

  // The Settings, History, Downloads, Bookmarks and screen sharing popups
  // and the command palette (src/settings.html, src/history.html,
  // src/downloads.html, src/bookmarks.html, src/share.html,
  // src/palette.html): each is made on first use, then hidden and shown; one is open at a time.
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
    hideLogins()
    const view = popupView(name)
    if (!popupOpen) toolbarHadFocus = win.webContents.isFocused()
    else if (popupOpen !== name) {
      popups[popupOpen].setVisible(false)
      recording = false
      dropShare()
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
  // `focus` is false when the active page has gone, and whatever comes next
  // takes it.
  function closePopup(focus = true) {
    if (!popupOpen) return
    popups[popupOpen].setVisible(false)
    popupOpen = null
    recording = false
    dropShare()
    if (!focus) return
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
  // What was typed for them, which the list marks in each.
  let suggestionsText = ''
  let suggestionsOpen = false
  let suggestionsHide = null
  // Counts each list shown; a click names the list it was on, so a click
  // on a list that has since changed opens nothing.
  let suggestionsGeneration = 0

  function showSuggestions(items, text, { x, y, width }) {
    if (!suggestionsView) {
      suggestionsView = new WebContentsView({ webPreferences: { preload: PRELOAD, session: ses } })
      suggestionsView.setBackgroundColor('#00000000')
      suggestionsView.setVisible(false)
      windowsByPopup.set(suggestionsView.webContents, { controls, name: 'suggestions' })
      // The first list is sent before the page can hear it; send it again.
      suggestionsView.webContents.on('did-finish-load', () => {
        if (suggestionsOpen) suggestionsView.webContents.send('suggestions-show', { items: suggestions, text: suggestionsText, generation: suggestionsGeneration })
      })
      suggestionsView.webContents.loadFile(path.join(__dirname, 'suggestions.html'))
    }
    clearTimeout(suggestionsHide)
    suggestions = items
    suggestionsText = text
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
    suggestionsView.webContents.send('suggestions-show', { items, text, generation: suggestionsGeneration })
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
    if (items.length) showSuggestions(items, text, rect)
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
    const url = tab?.started && !signInPage(tab) ? bookmarkStore.address(tab.url) : null
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
  const pages = () => [...tabs.map((tab) => tab.page), ...Object.values(popups).map((view) => view.webContents), suggestionsView?.webContents, loginsView?.webContents]

  const controls = {
    win,
    key,
    profile,
    isPrivate,
    session: ses,
    pages,
    newTab: () => newTab(),
    // A link from another app, in a new tab over any popup.
    openLink(url) {
      closePopup()
      newTab(url)
    },
    closeTab: (id = activeId, focus = true) => closeTab(id, focus),
    // Before another tab, or last (null).
    moveTab: (id, beforeId) => arrange(moved(ids(), id, beforeId)),
    // One place left (-1) or right (1).
    nudgeTab: (id, direction) => arrange(nudged(ids(), id, direction)),
    reopenTab(history, index) {
      closePopup()
      addTab({ history, index: reopenIndex(index, tabs.length) })
    },
    activate,
    // Every tab but the active one, for the command palette.
    otherTabs: () => tabs.filter((tab) => tab.id !== activeId).map((tab) => ({ id: tab.id, title: tab.title, url: urlOf(tab) })),
    navigate,
    focusAddress,
    step: (delta) => activate(step(ids(), activeId, delta)),
    byNumber: (number) => activate(byNumber(ids(), number)),
    // The active page, for back, forward and its developer tools.
    page: () => (active()?.started && !active().page.isDestroyed() ? active().page : null),
    // Whether it failed, so there is nothing of it to print.
    failed: () => Boolean(active()?.error),
    reload: (ignoreCache) => reload(active(), ignoreCache),
    stop: () => stop(active()),
    stepPage: (delta, newTab) => stepPage(active(), delta, newTab),
    showStepMenu: (delta, at) => showStepMenu(active(), delta, at),
    // The page came back while its error page or sign-in prompt had focus,
    // or asks to sign in again already.
    focusPage: () => { const tab = active(); if (tab?.started && !tab.error && !popupOpen && !tab.page.isDestroyed()) show(tab) },
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
    savesPasswords,
    askPermission,
    pickLogin,
    // A message from src/page.js in the tab whose top frame sent it, now on
    // `site`.
    pageMessage(contents, frame, site, message, value) {
      const tab = tabs.find((each) => each.page === contents)
      if (!tab) return
      // Kept for the second step of a sign-in (loginSubmitted).
      if (message === 'name') tab.loginName = !savesPasswords() ? null : { site, username: value.username, at: Date.now() }
      else if (message === 'abandoned') tab.submitted = tab.loginName = null
      else if (message === 'submitted') loginSubmitted(tab, site, value)
      else if (message === 'done') { if (tab.submitted?.site === site && !tab.submitted.moved) offerLogin(tab) }
      else if (message === 'field') showLogins(tab, frame, site, value)
      else if (logins?.tab === tab) hideLogins(true)
    },
    focusActive: () => { const tab = active(); if (tab) show(tab) },
    askPermission,
    askShare,
    shareState,
    shareTabsChanged,
    chooseShare,
    isSharing: (id) => Boolean(share) && share.id === id,
    // Not sleeping ones, whose page is closed: a tab is shared as it shows.
    shareableTabs: () => tabs.filter((tab) => tab.started && !tab.error && tab.url && !tab.page.isDestroyed()),
    // A page in the tab, or a frame in it, was edited by hand.
    pageEdited(contents) {
      const tab = tabs.find((each) => each.page === contents)
      if (tab) tab.edited = true
    },
    askSignIn,
    answerSignIn,
    hasTab: (contents) => tabs.some((tab) => tab.page === contents),
    // Whether a frame started the page's current navigation.
    startedByFrame: (contents) => Boolean(tabs.find((tab) => tab.page === contents)?.startedByFrame),
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
    showAdsMenu,
    // Whether ad blocking leaves the page in `contents` alone, if it is one
    // of this window's tabs: at `url`, the page it shows or is opening.
    sparesAds(contents, url) {
      const tab = tabs.find((each) => each.page === contents)
      const ads = tab && adsOf(tab, url)
      return ads === 'site' || ads === 'once'
    },
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
    // The bar can come or go with the change, moving the page. A list follows
    // the change, and closes once nothing is left to list; a form keeps what
    // is typed in it.
    bookmarksChanged() {
      sync()
      sendBookmarks()
      if (popupOpen !== 'bookmarks' || bookmarksView.kind !== 'list') return
      const gone = bookmarksView.folderId && !bookmarkStore.get(profile.bookmarks, bookmarksView.folderId)
      const state = bookmarksState()
      if (gone || (!bookmarksView.folderId && !state.items.length)) closePopup()
      else popups.bookmarks.webContents.send('bookmarks-changed', state)
    },
    duplicateTab: () => duplicateTab(activeId),
    toggleMute: (id = activeId) => toggleMute(id),
    closeOtherTabs: () => closeOtherTabs(activeId),
    closeTabsToRight: () => closeTabsToRight(activeId),
    toggleSplit,
    resizeSplit,
    resizeSidebar,
    nudgeSidebar,
    pickForSplit,
    setRecording: (on, keys) => {
      recording = on
      keyboardLayout = on && keys && typeof keys === 'object' ? keys : {}
    },
    settingsChanged() {
      if (!profile.settings.savePasswords) {
        for (const tab of tabs) { tab.submitted = tab.loginName = tab.offer = null }
      }
      if (!profile.settings.fillPasswords) hideLogins()
      sendShortcuts()
      sync()
      sendQuickSearch()
      sendBookmarks()
      // Sharing turned off refuses what is being asked.
      if (share && !profile.settings.screenSharing) closePopup()
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
    sleepIdle,
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

  win.on('resize', () => { hideLogins(); layout() })
  // Another app or window comes to the front.
  win.on('blur', () => { hideLogins(); releaseHeldTop() })
  // Where the window is, and which window was in front, come back next
  // launch; a private window changes none of that.
  const changed = () => { if (!isPrivate) sessionChanged() }
  for (const change of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(change, changed)
  win.on('enter-full-screen', () => { windowFullScreen = fullScreenFor ? 'page' : 'own' })
  win.on('leave-full-screen', () => {
    const before = windowFullScreen
    windowFullScreen = null
    // A page that went full screen while another's was ending wants the
    // window back in it. Otherwise it was left by the green button or the
    // menu, which takes the page out too.
    if (before === 'leaving' && fullScreenFor?.fullScreen === 'on') win.setFullScreen(true)
    else {
      fullScreenFor = null
      leaveFullScreen(active())
    }
    // Electron tells a page that left that it has only as its view changes
    // size, and not while the window is still changing; so change it now.
    const view = active()?.view
    if (!view) return
    const bounds = view.getBounds()
    view.setBounds({ ...bounds, height: Math.max(bounds.height - 1, 0) })
    setTimeout(() => { if (!win.isDestroyed()) layout() }, 50)
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
  // What was sent before the toolbar loaded never reached it.
  win.webContents.on('did-finish-load', () => { sentSidebar = null; layout(); sync(); sendShortcuts(); sendQuickSearch(); sendBookmarks(); sendDownloads(); sendProfile() })
  win.on('closed', () => {
    openWindows.delete(controls)
    dropShare()
    changed()
    if (closingWindow) rememberClosed(profile, closingWindow)
    // Its own pages too, read before they close.
    const open = pages()
    for (const tab of tabs.splice(0)) {
      for (const prompt of tab.prompts) for (const callback of prompt.callbacks) callback(false)
      for (const prompt of tab.signIns.splice(0)) for (const callback of prompt.callbacks) callback()
      settle(tab)
      if (!tab.page.isDestroyed()) tab.page.close()
    }
    for (const view of Object.values(popups)) view.webContents.close()
    clearTimeout(suggestionsHide)
    suggestionsView?.webContents.close()
    clearTimeout(loginsHide)
    loginsView?.webContents.close()
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
    const splitIds = restoredSplit?.indexes.map((index) => tabs[index]?.id)
    if (splitIds?.every(Boolean) && splitIds[0] !== splitIds[1]) split = { ids: splitIds, ratio: restoredSplit.ratio }
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

// Settings, History and the command palette open in the focused window, or
// a new one, and the same command closes them again.
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
        { label: 'Mute or Unmute Tab', accelerator: key('muteTab'), click: inFocused((c) => c.toggleMute()) },
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
        // Lists every other command here, so it is left out of its own list.
        { id: 'commandPalette', label: 'Command Palette…', accelerator: key('commandPalette'), click: togglePopup('palette') },
        { type: 'separator' },
        // Unchecked with tabs across the top too, where it turns on vertical tabs.
        { label: 'Show Tab Sidebar', type: 'checkbox', checked: tabsPlace(settings) === 'side', accelerator: key('tabSidebar'), click: (_item, win) => toggleTabSidebar(controlsOf(win)?.profile ?? currentProfile) },
        // The active tab beside a new one, or back to one tab at a time.
        { label: 'Split View', accelerator: key('splitView'), click: inFocused((c) => { c.closePopup(); c.toggleSplit() }) },
        { type: 'separator' },
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
ipcMain.on('move-tab', fromToolbar((c, id, beforeId) => c.moveTab(id, beforeId)))
ipcMain.on('nudge-tab', fromToolbar((c, id, direction) => (direction === -1 || direction === 1) && c.nudgeTab(id, direction)))
ipcMain.on('activate-tab', fromToolbar((c, id, focus) => c.activate(id, focus !== false)))
// Find messages name the tab the toolbar showed, so a tab switch the
// toolbar has not drawn yet never sends them to another tab.
ipcMain.on('find', fromToolbar((c, tabId, text) => c.isActive(tabId) && typeof text === 'string' && text.length <= findState.MAX_TEXT && c.findText(text)))
ipcMain.on('find-again', fromToolbar((c, tabId, forward) => c.isActive(tabId) && c.findAgain(forward !== false)))
ipcMain.on('close-find', fromToolbar((c, tabId) => c.isActive(tabId) && c.closeFind()))
ipcMain.on('open-settings', fromToolbar((c) => c.openPopup('settings')))
ipcMain.on('open-downloads', fromToolbar((c) => c.openPopup('downloads')))
ipcMain.on('mute-tab', fromToolbar((c, id) => Number.isInteger(id) && c.toggleMute(id)))
ipcMain.on('tab-menu', fromToolbar((c, id) => c.showTabMenu(id)))
ipcMain.on('profile-menu', fromToolbar((c, at) => isPoint(at) && c.showProfileMenu(at)))
ipcMain.on('ads-menu', fromToolbar((c, tabId, at) => c.isActive(tabId) && isPoint(at) && c.showAdsMenu(tabId, at)))
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
// The toolbar's Back, Forward, Reload and Stop buttons, for the tab they showed.
const isStep = (delta) => delta === -1 || delta === 1
ipcMain.on('step', fromToolbar((c, tabId, delta, newTab) => c.isActive(tabId) && isStep(delta) && c.stepPage(delta, newTab === true)))
ipcMain.on('step-menu', fromToolbar((c, tabId, delta, at) => c.isActive(tabId) && isStep(delta) && isPoint(at) && c.showStepMenu(delta, at)))
ipcMain.on('reload-tab', fromToolbar((c, tabId, ignoreCache) => c.isActive(tabId) && c.reload(ignoreCache === true)))
ipcMain.on('stop', fromToolbar((c, tabId) => c.isActive(tabId) && c.stop()))
ipcMain.on('focus-active', fromToolbar((c) => c.focusActive()))
ipcMain.on('focus-page', fromToolbar((c, tabId) => c.isActive(tabId) && c.focusPage()))
ipcMain.on('reset-zoom', fromToolbar((c) => c.resetZoom()))
// Split view's divider, dragged to x in the window or reset (null), and
// the tab picked for a new split view's blank pane.
ipcMain.on('split-resize', fromToolbar((c, x) => (x === null || Number.isFinite(x)) && c.resizeSplit(x)))
// The tab sidebar's edge, dragged to x in the window (`done` on release) or
// reset (null), or moved by ← or →.
ipcMain.on('sidebar-resize', fromToolbar((c, x, done) => (x === null || Number.isFinite(x)) && c.resizeSidebar(x, done === true)))
ipcMain.on('sidebar-nudge', fromToolbar((c, direction, big) => (direction === -1 || direction === 1) && c.nudgeSidebar(direction, big === true)))
ipcMain.on('split-pick', fromToolbar((c, blankId, id) => Number.isInteger(blankId) && Number.isInteger(id) && c.pickForSplit(blankId, id)))
// A prompt's answer: 'allow', 'block', or null to dismiss it, for the
// kinds the row showed.
ipcMain.on('answer-permission', fromToolbar((c, tabId, promptId, kinds, choice) => {
  if (choice === null || permissions.CHOICES.includes(choice)) c.answerPrompt(tabId, promptId, kinds, choice)
}))
// A sign-in prompt's answer: { username, password }, or null to cancel it.
ipcMain.on('answer-sign-in', fromToolbar((c, tabId, promptId, credentials) => {
  if (credentials === null || (typeof credentials?.username === 'string' && typeof credentials.password === 'string')) c.answerSignIn(tabId, promptId, credentials)
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
  const saved = typeof site === 'string' && permissions.isKind(kind) && c.profile.sitePermissions.get(site)?.[kind]
  if (saved && (choice === null || permissions.CHOICES.includes(choice)) && !choosePermission(c.profile, site, [kind], choice)) {
    return settingsState(c.profile, 'Couldn’t save site permissions, so this change lasts only until Lit quits.')
  }
  return settingsState(c.profile)
}))
// Saved passwords: removing one, asking about a site again, and showing or
// copying one.
ipcMain.handle('passwords-remove', fromSettings((c, id) => settingsState(c.profile, setPasswords(c.profile, passwords.remove(c.profile.passwords, id)) ? undefined : 'Couldn’t save passwords, so nothing was removed.')))
ipcMain.handle('passwords-ask-again', fromSettings((c, site) => settingsState(c.profile, setPasswords(c.profile, passwords.askAgain(c.profile.passwords, site)) ? undefined : 'Couldn’t save passwords, so nothing was changed.')))
ipcMain.handle('passwords-reveal', fromSettings((c, id) => readPassword(c.profile, id)))
ipcMain.handle('passwords-copy', fromSettings(async (c, id) => {
  const { password, error } = await readPassword(c.profile, id)
  if (password !== undefined) clipboard.writeText(password)
  return error ? { error } : { copied: password !== undefined }
}))

// Cookies: the profile's, by domain (src/cookies.js), and removing one
// cookie, a domain's, or (null, after asking) every one. Each answers with
// { domains, error? }; removing all answers null if not confirmed. Always
// the profile's own, even from a private window, whose cookies go with it.
async function cookiesState(profile, error) {
  try {
    return { domains: cookieStore.list(await profile.session.cookies.get({})), ...(error && { error }) }
  } catch {
    return { domains: [], error: 'Couldn’t read cookies.' }
  }
}
// Removals run one at a time, so one never puts back what another took.
let cookieWork = Promise.resolve()
const oneAtATime = (run) => {
  const done = cookieWork.then(run)
  cookieWork = done.catch(() => {})
  return done
}
async function removeCookies(win, profile, target) {
  const ses = profile.session
  if (target === null) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Remove All', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: profiles.length > 1 ? `Remove every cookie in “${profile.name}”?` : 'Remove every cookie?',
      detail: 'You’ll be signed out of most sites, and they forget your preferences. This can’t be undone.',
    })
    if (response !== 0) return null
  } else if (!cookieStore.isTarget(target)) {
    return cookiesState(profile)
  }
  return oneAtATime(async () => {
    try {
      if (target === null) {
        await ses.clearStorageData({ storages: ['cookies'] })
      } else {
        const before = await ses.cookies.get({})
        const named = cookieStore.pick(before, target)
        await Promise.allSettled(named.map((cookie) => ses.cookies.remove(cookieStore.urlOf(cookie), cookie.name)))
        // Removing takes others of the same name too; they go back as they were.
        const lost = cookieStore.lost(before, named, await ses.cookies.get({}))
        await Promise.allSettled(lost.map((cookie) => ses.cookies.set(cookieStore.detailsOf(cookie))))
      }
      // What is still there was not removed, such as a cookie set again.
      const left = await ses.cookies.get({})
      const missed = target === null ? left.length : cookieStore.pick(left, target).length
      return cookiesState(profile, missed ? 'Some cookies couldn’t be removed, or a site set them again.' : undefined)
    } catch {
      return cookiesState(profile, 'Couldn’t remove cookies.')
    }
  })
}
ipcMain.handle('cookies-get', fromSettings((c) => cookiesState(c.profile)))
ipcMain.handle('cookies-remove', fromSettings((c, target) => removeCookies(c.win, c.profile, target ?? null)))

// From src/page.js, in web pages. The site is the sending frame's, as
// Chromium knows it, never what the message says.
const fromPage = (message, read) => (event, value) => {
  const frame = event.senderFrame
  if (!frame || frame.isDestroyed() || frame !== event.sender.mainFrame) return
  const site = passwords.siteOf(frame.origin)
  const checked = site ? read(value) : null
  if (!checked) return
  for (const controls of openWindows) controls.pageMessage(event.sender, frame, site, message, checked)
}
// Whether what is typed into a login may be sent to be saved. Always answered,
// as the page waits for it.
ipcMain.on('login-saves', (event) => {
  event.returnValue = [...openWindows].some((controls) => controls.hasTab(event.sender) && controls.savesPasswords())
})
ipcMain.on('login-submitted', fromPage('submitted', (value) => (passwords.isText(value?.username) && passwords.isText(value?.password) && value.password ? { username: value.username, password: value.password, old: passwords.isText(value.old) ? value.old : '' } : null)))
ipcMain.on('login-name', fromPage('name', (value) => (passwords.isText(value?.username) ? { username: value.username } : null)))
ipcMain.on('login-abandoned', fromPage('abandoned', () => true))
ipcMain.on('login-done', fromPage('done', () => true))
ipcMain.on('login-field', fromPage('field', (value) => (value && ['request', 'x', 'top', 'y', 'width'].every((key) => Number.isFinite(value[key])) ? value : null)))
ipcMain.on('page-edited', (event) => { for (const controls of openWindows) controls.pageEdited(event.sender) })
ipcMain.on('login-field-left', fromPage('left', () => true))
ipcMain.on('logins-pick', fromPopup('logins', (c, id, generation) => c.pickLogin(id, generation)))
ipcMain.handle('default-browser-make', fromSettings((c) => settingsState(c.profile, makeDefaultBrowser())))
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

ipcMain.handle('share-get', fromPopup('share', (c) => c.shareState()))
// What the picker does counts only for the request it was shown for.
const fromShare = (handler) => fromPopup('share', (c, shareId, ...args) => { if (c.isSharing(shareId)) handler(c, ...args) })
ipcMain.on('share-choose', fromShare((c, kind, id, audio, page) => c.chooseShare(kind, id, audio, page)))
ipcMain.on('share-allow', fromShare(openScreenPermission))
ipcMain.on('share-close', fromShare((c) => c.closePopup()))

const fromPalette = (handler) => fromPopup('palette', handler)
ipcMain.handle('palette-get', fromPalette((c) => popupState('palette', c)))
ipcMain.handle('palette-search', fromPalette((c, text) => (typeof text === 'string' && text.length <= 200 ? paletteSearch(c, text) : [])))
// Only from the palette still open: an Enter waiting on a search can arrive
// after it closed, or another popup took its place.
ipcMain.on('palette-run', fromPalette((c, id) => c.popupOpen() === 'palette' && typeof id === 'string' && runCommand(c, id)))
ipcMain.on('palette-close', fromPalette((c) => c.popupOpen() === 'palette' && c.closePopup()))

// Other apps opening links, and HTML and PDF files. Registered before Lit is ready,
// as macOS sends the link that launched it early.
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (webAddress(url)) openExternalLink(url)
})
app.on('open-file', (event, file) => {
  event.preventDefault()
  openExternalLink(pathToFileURL(file).href)
})

// Every minute, tabs out of sight for longer than the Sleep tabs setting
// go to sleep (sleepIdle in createWindow).
function sleepIdleTabs() {
  const minutes = shared().sleepTabsAfter
  if (!minutes) return
  const now = Date.now()
  for (const controls of openWindows) controls.sleepIdle(now, minutes)
}

app.whenReady().then(async () => {
  setInterval(sleepIdleTabs, 60_000)
  const root = app.getPath('userData')
  profilesFile = path.join(root, 'profiles.json')
  profileList = profileStore.load(profilesFile)
  // Deleted profiles' files go before any session is opened.
  const swept = profileStore.sweep(root, profileList)
  if (swept !== profileList) setProfileList(swept)
  for (const profile of profileList.profiles) openProfile(profile)
  currentProfile = profiles.find((profile) => profile.id === profileList.last)
  if (!shared().securityKeys) turnAwayPasskeys()
  adblock = createAdblock(path.join(root, 'adblock.bin'), { spares: sparesAds })
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
  // A link that launched Lit opens in a window of its own, if none reopened.
  else if (!waitingLinks.length) createWindow()
  const links = waitingLinks
  waitingLinks = null
  links.forEach(openExternalLink)
  lastDefaultBrowser = defaultBrowser()
  app.on('did-become-active', checkDefaultBrowser)
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
