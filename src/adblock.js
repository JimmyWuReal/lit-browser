// Ad and tracker blocking, the Block ads and trackers setting, with
// Ghostery's engine (@ghostery/adblocker-electron) and its prebuilt ads and
// tracking lists. The engine blocks requests and hides ad elements in every
// page of the session it is enabled in.
//
// Building the engine downloads the lists, so it is saved to a file and read
// back at the next launch. A saved engine older than MAX_AGE is still used
// at once, while fresh lists are fetched and swapped in. Nothing loads or
// downloads while blocking is off. Plain Node apart from the engine, which
// tests replace (test/adblock.test.js).
const fs = require('node:fs/promises')

const ALL = { urls: ['<all_urls>'] }
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

// `deps` are for tests: { Blocker, preload, fetch, read, write, stat, now, warn }.
function createAdblock(session, file, deps = {}) {
  const {
    Blocker = require('@ghostery/adblocker-electron').ElectronBlocker,
    preload = () => require.resolve('@ghostery/adblocker-electron-preload'),
    fetch = globalThis.fetch,
    read = fs.readFile,
    write = fs.writeFile,
    stat = fs.stat,
    now = Date.now,
    warn = console.warn,
  } = deps
  let on = false
  let engine = null
  let loading = null

  // Private windows' sessions -> their preload script's id, or null while
  // not blocked. The engine can't enable more than one session itself: its
  // ipcMain handlers are global. So these share the main session's handlers
  // and get only the per-session parts.
  const extra = new Map()
  function applyExtra(ses) {
    const blocking = on && Boolean(engine)
    if (blocking === (extra.get(ses) !== null)) return
    if (blocking) {
      extra.set(ses, ses.registerPreloadScript({ type: 'frame', filePath: preload() }))
      // `engine` is read on each request, so fresh lists apply at once.
      ses.webRequest.onBeforeRequest(ALL, (details, callback) => engine.onBeforeRequest(details, callback))
      ses.webRequest.onHeadersReceived(ALL, (details, callback) => engine.onHeadersReceived(details, callback))
    } else {
      ses.unregisterPreloadScript(extra.get(ses))
      extra.set(ses, null)
      ses.webRequest.onBeforeRequest(null)
      ses.webRequest.onHeadersReceived(null)
    }
  }

  // Matches every session to `on`, once there is an engine.
  function apply() {
    for (const ses of extra.keys()) applyExtra(ses)
    if (!engine || engine.isBlockingEnabled(session) === on) return
    if (on) engine.enableBlockingInSession(session)
    else engine.disableBlockingInSession(session)
  }

  // Electron keeps one listener per webRequest event, so the old engine
  // lets go of the session before the new one takes it.
  function use(next) {
    if (engine?.isBlockingEnabled(session)) engine.disableBlockingInSession(session)
    engine = next
    apply()
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
    // Blocks in one more session, like the main one, until removed.
    add(ses) { extra.set(ses, null); applyExtra(ses) },
    remove(ses) {
      if (extra.get(ses)) ses.unregisterPreloadScript(extra.get(ses))
      extra.delete(ses)
      ses.webRequest.onBeforeRequest(null)
      ses.webRequest.onHeadersReceived(null)
    },
    // Turns blocking on or off. The first time on loads the engine; a load
    // that fails (offline with nothing saved) is tried again next time on.
    // Resolves once the saved engine, if any, is blocking, so pages opened
    // after it are covered; downloading fresh lists goes on in the background.
    async set(value) {
      on = value
      apply()
      if (on && !loading) load()
      if (on) await restored
    },
  }
}

module.exports = { createAdblock, MAX_AGE }
