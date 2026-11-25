const test = require('node:test')
const assert = require('node:assert/strict')
const { refuse } = require('../src/passkeys')

// The frame's credentials once refuse has run in it.
function start(t, { keysOn = false } = {}) {
  globalThis.CredentialsContainer = class {
    async get(options) { return [this, 'got', options] }
    async create(options) { return [this, 'created', options] }
    async store() { return 'stored' }
  }
  if (keysOn) globalThis.PublicKeyCredential = class {}
  t.after(() => {
    delete globalThis.CredentialsContainer
    delete globalThis.PublicKeyCredential
  })
  // As main sends it: the function's source, alone.
  ;(0, eval)(`(${refuse})()`)
  return new CredentialsContainer()
}

test('passkey requests are refused, and other credentials still work', async (t) => {
  const credentials = start(t)
  for (const name of ['get', 'create']) {
    assert.equal(credentials[name].name, name)
    await assert.rejects(credentials[name]({ publicKey: {} }), { name: 'NotAllowedError' })
    await assert.rejects(credentials[name]({ publicKey: {}, mediation: 'conditional' }), { name: 'NotAllowedError' })
  }
  assert.deepEqual(await credentials.get({ password: true }), [credentials, 'got', { password: true }])
  assert.deepEqual(await credentials.create({ password: {} }), [credentials, 'created', { password: {} }])
  assert.deepEqual(await credentials.get(), [credentials, 'got', undefined])
  assert.equal(await credentials.store(), 'stored')
})

test('nothing is refused with Security Keys on, nor on an insecure page', async (t) => {
  refuse()
  const credentials = start(t, { keysOn: true })
  assert.equal((await credentials.get({ publicKey: {} }))[1], 'got')
})
