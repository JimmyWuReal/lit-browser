// Ad and tracker blocking, the Block ads and trackers setting, with
// Ghostery's engine (@ghostery/adblocker-electron) and its prebuilt ads and
// tracking lists. The engine blocks requests and hides ad elements in every
// page of the sessions it is on in; each profile has the setting, and every
// session shares the one engine.
//
// Building the engine downloads the lists, so it is saved to a file and read
// back at the next launch. A saved engine older than MAX_AGE is still used
// at once, while fresh lists are fetched and swapped in. Nothing loads or
// downloads while blocking is off. Plain Node apart from the engine, which
// tests replace (test/adblock.test.js).
//
// A page can be spared: `spares(contents, url)`, from main, says whether the
// page in `contents` (a tab), or the one it is opening at `url`, is on a site
// ads were stopped for (the toolbar's ad blocking button). Its requests and
// styles then go untouched, its frames' too.
const fs = require('node:fs/promises')

const ALL = { urls: ['<all_urls>'] }
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

// The requests the engine's preload script makes from pages. The engine's own
// enableBlockingInSession can't be used for more than one session, as it
// registers these globally each time; here one set serves every session.
const INJECT = '@ghostery/adblocker/inject-cosmetic-filters'
const OBSERVE = '@ghostery/adblocker/is-mutation-observer-enabled'

// `deps` holds `spares`, and the rest are for tests: { Blocker, preload,
// handle, fetch, read, write, stat, now, warn }.
function createAdblock(file, deps = {}) {
  const {
    spares = () => false,
    Blocker = require('@ghostery/adblocker-electron').ElectronBlocker,
    preload = () => require.resolve('@ghostery/adblocker-electron-preload'),
    handle = (...args) => require('electron').ipcMain.handle(...args),
    fetch = globalThis.fetch,
    read = fs.readFile,
    write = fs.writeFile,
    stat = fs.stat,
    now = Date.now,
    warn = console.warn,
  } = deps
  let engine = null
  let loading = null

  // Each session (a profile's, or a private window's) -> whether it should
  // block, and the preload script it has while it does.
  const sessions = new Map()
  const blocks = (ses) => Boolean(engine && sessions.get(ses)?.on)
  // A request with no page (a service worker's) is never spared. A page's
  // own load is for the address it opens, not the one it leaves.
  const spared = (contents, url) => Boolean(contents) && !contents.isDestroyed() && spares(contents, url ?? contents.getURL())
  const pageOf = (details) => [details.webContents, details.resourceType === 'mainFrame' ? details.url : undefined]
  // The cosmetic filters' requests come from the page's frames, whose
  // sender is the page's tab.
  const styles = (event) => blocks(event.sender.session) && !spared(event.sender)
  handle(INJECT, (event, ...args) => (styles(event) ? engine.onInjectCosmeticFilters(event, ...args) : undefined))
  handle(OBSERVE, (event) => styles(event) && engine.onIsMutationObserverEnabled(event))

  // Matches one session to its setting, once there is an engine. `engine` is
  // read on each request, so fresh lists apply at once.
  function apply(ses) {
    const state = sessions.get(ses)
    if (blocks(ses) === (state.preload !== null)) return
    if (blocks(ses)) {
      state.preload = ses.registerPreloadScript({ type: 'frame', filePath: preload() })
      ses.webRequest.onBeforeRequest(ALL, (details, callback) => (spared(...pageOf(details)) ? callback({}) : engine.onBeforeRequest(details, callback)))
      ses.webRequest.onHeadersReceived(ALL, (details, callback) => (spared(...pageOf(details)) ? callback({}) : engine.onHeadersReceived(details, callback)))
    } else {
      ses.unregisterPreloadScript(state.preload)
      state.preload = null
      ses.webRequest.onBeforeRequest(null)
      ses.webRequest.onHeadersReceived(null)
    }
  }

  function use(next) {
    engine = next
    for (const ses of sessions.keys()) apply(ses)
  }

  async function saved() {
    try {
      const [buffer, info] = await Promise.all([read(file), stat(file)])
      return { engine: Blocker.deserialize(new Uint8Array(buffer)), fresh: now() - info.mtimeMs < MAX_AGE }
    } catch {
      // Missing, or saved by an engine version that can no longer read it.
      return null
    }
  }

  // Starts loading: `restored` settles once a saved engine is in use (or
  // there is none), and `loading` once fresh lists are in too.
  let restored = null
  function load() {
    restored = saved().then((cached) => {
      if (cached) use(cached.engine)
      return cached
    })
    loading = restored.then(async (cached) => {
      if (cached?.fresh) return
      const built = await Blocker.fromPrebuiltAdsAndTracking(fetch)
      use(built)
      try {
        await write(file, built.serialize())
      } catch (error) {
        warn('Couldn’t save the ad blocking lists:', error)
      }
    }).catch((error) => {
      warn('Couldn’t load the ad blocking lists:', error)
      loading = null
    })
  }

  return {
    // The engine in use, or null before one loads.
    current: () => engine,
    // The load in progress or done (null while never on), for tests.
    loaded: () => loading,
    // Whether a session blocks now, for tests.
    blocks,
    // Turns blocking on or off in one session. The first time on loads the
    // engine; a load that fails (offline with nothing saved) is tried again
    // next time on. Resolves once the saved engine, if any, is blocking, so
    // pages opened after it are covered; downloading fresh lists goes on in
    // the background.
    async set(ses, on) {
      sessions.set(ses, { preload: null, ...sessions.get(ses), on })
      apply(ses)
      if (on && !loading) load()
      if (on) await restored
    },
    // Forgets a session that is going away.
    remove(ses) {
      if (!sessions.has(ses)) return
      sessions.get(ses).on = false
      apply(ses)
      sessions.delete(ses)
    },
  }
}

module.exports = { createAdblock, MAX_AGE }
