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

const MAX_AGE = 7 * 24 * 60 * 60 * 1000

// `deps` are for tests: { Blocker, fetch, read, write, stat, now, warn }.
function createAdblock(session, file, deps = {}) {
  const {
    Blocker = require('@ghostery/adblocker-electron').ElectronBlocker,
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

  // Matches the session to `on`, once there is an engine.
  function apply() {
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

  async function load() {
    const cached = await saved()
    if (cached) use(cached.engine)
    if (cached?.fresh) return
    const built = await Blocker.fromPrebuiltAdsAndTracking(fetch)
    use(built)
    try {
      await write(file, built.serialize())
    } catch (error) {
      warn('Couldn’t save the ad blocking lists:', error)
    }
  }

  return {
    // The engine in use, or null before one loads.
    current: () => engine,
    // Turns blocking on or off. The first time on loads the engine; a load
    // that fails (offline with nothing saved) is tried again next time on.
    set(value) {
      on = value
      apply()
      if (on && !loading) {
        loading = load().catch((error) => {
          warn('Couldn’t load the ad blocking lists:', error)
          loading = null
        })
      }
      // The load in progress or done, for tests; null while never on.
      return loading
    },
  }
}

module.exports = { createAdblock, MAX_AGE }
