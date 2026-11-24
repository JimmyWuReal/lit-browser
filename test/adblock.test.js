const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdblock, MAX_AGE } = require('../src/adblock')

// A stand-in for ElectronBlocker: engines record which sessions they block,
// and the "lists" are just a name carried through serialize/deserialize.
function setup({ saved, savedAge = 0, fetchFails = false, writeFails = false, fetchGate } = {}) {
  const session = {}
  const log = { fetched: 0, written: [], warned: [] }
  const engine = (name) => ({
    name,
    sessions: new Set(),
    isBlockingEnabled(s) { return this.sessions.has(s) },
    enableBlockingInSession(s) { this.sessions.add(s) },
    disableBlockingInSession(s) { this.sessions.delete(s) },
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
  const adblock = createAdblock(session, 'adblock.bin', {
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
  return { session, adblock, log }
}

test('nothing loads or downloads while off', async () => {
  const { adblock, log } = setup()
  await adblock.set(false)
  assert.equal(adblock.loaded(), null)
  assert.equal(log.fetched, 0)
})

test('with nothing saved, the lists download, block, and are saved', async () => {
  const { session, adblock, log } = setup()
  await adblock.set(true)
  await adblock.loaded()
  assert.equal(log.fetched, 1)
  assert.deepEqual(log.written, ['fresh'])
  assert.equal(adblock.current().name, 'fresh')
  assert.equal(adblock.current().isBlockingEnabled(session), true)
})

test('a fresh saved engine is used without downloading', async () => {
  const { session, adblock, log } = setup({ saved: 'cached', savedAge: MAX_AGE - 1 })
  await adblock.set(true)
  await adblock.loaded()
  assert.equal(log.fetched, 0)
  assert.equal(adblock.current().name, 'cached')
  assert.equal(adblock.current().isBlockingEnabled(session), true)
})

test('a stale saved engine blocks until fresh lists replace it', async () => {
  let release
  const fetchGate = new Promise((resolve) => { release = resolve })
  const { session, adblock, log } = setup({ saved: 'cached', savedAge: MAX_AGE + 1, fetchGate })
  await adblock.set(true)
  const loading = adblock.loaded()
  const cached = adblock.current()
  assert.equal(cached.name, 'cached')
  assert.equal(cached.isBlockingEnabled(session), true)
  release()
  await loading
  assert.equal(log.fetched, 1)
  assert.equal(cached.isBlockingEnabled(session), false)
  assert.equal(adblock.current().name, 'fresh')
  assert.equal(adblock.current().isBlockingEnabled(session), true)
})

test('an engine saved by another version is rebuilt', async () => {
  const { adblock, log } = setup({ saved: 'old format' })
  await adblock.set(true)
  await adblock.loaded()
  assert.equal(log.fetched, 1)
  assert.equal(adblock.current().name, 'fresh')
})

test('turning off and on again switches the same engine', async () => {
  const { session, adblock, log } = setup()
  await adblock.set(true)
  await adblock.loaded()
  const engine = adblock.current()
  adblock.set(false)
  assert.equal(engine.isBlockingEnabled(session), false)
  await adblock.set(true)
  await adblock.loaded()
  assert.equal(engine.isBlockingEnabled(session), true)
  assert.equal(log.fetched, 1)
})

test('turned off while loading, the engine arrives without blocking', async () => {
  const { session, adblock } = setup()
  adblock.set(true)
  const loading = adblock.loaded()
  adblock.set(false)
  await loading
  assert.equal(adblock.current().isBlockingEnabled(session), false)
})

test('a failed download is tried again the next time it is turned on', async () => {
  const state = setup({ fetchFails: true })
  await state.adblock.set(true)
  await state.adblock.loaded()
  assert.equal(state.adblock.current(), null)
  assert.equal(state.log.warned.length, 1)
  state.adblock.set(false)
  await state.adblock.set(true)
  await state.adblock.loaded()
  assert.equal(state.log.fetched, 2)
})

test('blocking still works when the engine cannot be saved', async () => {
  const { session, adblock, log } = setup({ writeFails: true })
  await adblock.set(true)
  await adblock.loaded()
  assert.equal(adblock.current().isBlockingEnabled(session), true)
  assert.equal(log.warned.length, 1)
})
