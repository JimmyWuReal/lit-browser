const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdblock, MAX_AGE } = require('../src/adblock')

// A session that records what blocking put in it.
function fakeSession() {
  const live = new Map()
  const set = (name) => (filter, listener) => (listener ? live.set(name, listener) : live.delete(name))
  return {
    live,
    registerPreloadScript: () => { live.set('preload', true); return 'id' },
    unregisterPreloadScript: () => live.delete('preload'),
    webRequest: { onBeforeRequest: set('request'), onHeadersReceived: set('headers') },
  }
}

// A stand-in for ElectronBlocker, whose "lists" are just a name carried through serialize/deserialize.
function setup({ saved, savedAge = 0, fetchFails = false, writeFails = false, fetchGate } = {}) {
  const session = fakeSession()
  const handlers = {}
  const log = { fetched: 0, written: [], warned: [] }
  const engine = (name) => ({
    name,
    onInjectCosmeticFilters: () => `styles from ${name}`,
    onIsMutationObserverEnabled: () => true,
    onBeforeRequest: (_details, callback) => callback(name),
    serialize() { return new TextEncoder().encode(name) },
  })
  const Blocker = {
    deserialize(bytes) {
      const name = new TextDecoder().decode(bytes)
      if (name === 'old format') throw new Error('version')
      return engine(name)
    },
    async fromPrebuiltAdsAndTracking() {
      log.fetched++
      await fetchGate
      if (fetchFails) throw new Error('offline')
      return engine('fresh')
    },
  }
  const missing = () => Promise.reject(new Error('ENOENT'))
  const adblock = createAdblock('adblock.bin', {
    preload: () => 'preload.js',
    handle: (channel, handler) => { assert.equal(channel in handlers, false); handlers[channel] = handler },
    Blocker,
    now: () => 10 * MAX_AGE,
    read: saved ? async () => Buffer.from(saved) : missing,
    stat: saved ? async () => ({ mtimeMs: 10 * MAX_AGE - savedAge }) : missing,
    write: async (_file, bytes) => {
      if (writeFails) throw new Error('read-only')
      log.written.push(new TextDecoder().decode(bytes))
    },
    warn: (...args) => log.warned.push(args),
  })
  return { session, adblock, log, handlers }
}

test('nothing loads or downloads while off', async () => {
  const { session, adblock, log } = setup()
  await adblock.set(session, false)
  assert.equal(adblock.loaded(), null)
  assert.equal(log.fetched, 0)
})

test('with nothing saved, the lists download, block, and are saved', async () => {
  const { session, adblock, log } = setup()
  await adblock.set(session, true)
  await adblock.loaded()
  assert.equal(log.fetched, 1)
  assert.deepEqual(log.written, ['fresh'])
  assert.equal(adblock.current().name, 'fresh')
  assert.equal(adblock.blocks(session), true)
})

test('a fresh saved engine is used without downloading', async () => {
  const { session, adblock, log } = setup({ saved: 'cached', savedAge: MAX_AGE - 1 })
  await adblock.set(session, true)
  await adblock.loaded()
  assert.equal(log.fetched, 0)
  assert.equal(adblock.current().name, 'cached')
  assert.equal(adblock.blocks(session), true)
})

test('a stale saved engine blocks until fresh lists replace it', async () => {
  let release
  const fetchGate = new Promise((resolve) => { release = resolve })
  const { session, adblock, log } = setup({ saved: 'cached', savedAge: MAX_AGE + 1, fetchGate })
  await adblock.set(session, true)
  const loading = adblock.loaded()
  const cached = adblock.current()
  assert.equal(cached.name, 'cached')
  assert.equal(adblock.blocks(session), true)
  let answered
  const ask = () => { session.live.get('request')({}, (name) => { answered = name }); return answered }
  assert.equal(ask(), 'cached')
  release()
  await loading
  assert.equal(log.fetched, 1)
  assert.equal(ask(), 'fresh')
  assert.equal(adblock.current().name, 'fresh')
  assert.equal(adblock.blocks(session), true)
})

test('an engine saved by another version is rebuilt', async () => {
  const { session, adblock, log } = setup({ saved: 'old format' })
  await adblock.set(session, true)
  await adblock.loaded()
  assert.equal(log.fetched, 1)
  assert.equal(adblock.current().name, 'fresh')
})

test('turning off and on again switches the same engine', async () => {
  const { session, adblock, log } = setup()
  await adblock.set(session, true)
  await adblock.loaded()
  adblock.set(session, false)
  assert.equal(adblock.blocks(session), false)
  await adblock.set(session, true)
  await adblock.loaded()
  assert.equal(adblock.blocks(session), true)
  assert.equal(log.fetched, 1)
})

test('turned off while loading, the engine arrives without blocking', async () => {
  const { session, adblock } = setup()
  adblock.set(session, true)
  const loading = adblock.loaded()
  adblock.set(session, false)
  await loading
  assert.equal(adblock.blocks(session), false)
})

test('a failed download is tried again the next time it is turned on', async () => {
  const state = setup({ fetchFails: true })
  await state.adblock.set(state.session, true)
  await state.adblock.loaded()
  assert.equal(state.adblock.current(), null)
  assert.equal(state.log.warned.length, 1)
  state.adblock.set(state.session, false)
  await state.adblock.set(state.session, true)
  await state.adblock.loaded()
  assert.equal(state.log.fetched, 2)
})

test('blocking still works when the engine cannot be saved', async () => {
  const { session, adblock, log } = setup({ writeFails: true })
  await adblock.set(session, true)
  await adblock.loaded()
  assert.equal(adblock.blocks(session), true)
  assert.equal(log.warned.length, 1)
})

test('each session blocks by its own setting, sharing one engine', async () => {
  const { adblock, session, handlers, log } = setup({ saved: 'lists' })
  const other = fakeSession()
  await adblock.set(session, false)
  await adblock.set(other, true)
  assert.equal(adblock.blocks(session), false)
  assert.equal(session.live.size, 0)
  assert.equal(other.live.size, 3)
  // Pages of a session that blocks get styles, with the default one off.
  const inject = handlers['@ghostery/adblocker/inject-cosmetic-filters']
  assert.equal(inject({ sender: { session: other } }), 'styles from lists')
  assert.equal(inject({ sender: { session } }), undefined)
  await adblock.set(session, true)
  await adblock.set(other, false)
  assert.equal(session.live.size, 3)
  assert.equal(other.live.size, 0)
  assert.equal(log.fetched, 0)
})

test('a session is let go when removed', async () => {
  const { adblock, session } = setup({ saved: 'lists' })
  await adblock.set(session, true)
  assert.equal(session.live.size, 3)
  adblock.remove(session)
  assert.equal(session.live.size, 0)
  adblock.remove(session)
})
