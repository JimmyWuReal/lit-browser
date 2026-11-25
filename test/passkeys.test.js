const test = require('node:test')
const assert = require('node:assert/strict')
const { refusePasskeys } = require('../src/passkeys')

// The page's credentials once passkeys.js has run in it.
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
  refusePasskeys()
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

test('with Security Keys on, only requests no key could answer are refused', async (t) => {
  const credentials = start(t, { keysOn: true })
  const allow = (...lists) => ({ publicKey: { allowCredentials: lists.map((transports) => ({ transports })) } })
  for (const options of [{ publicKey: {} }, allow(), allow(['usb', 'nfc']), allow(['internal'], ['usb']), allow([]), allow(undefined), allow(['internal', 'usb'])]) {
    assert.equal((await credentials.get(options))[2], options)
  }
  for (const options of [allow(['internal']), allow(['internal', 'hybrid'], ['hybrid']), { publicKey: {}, mediation: 'conditional' }]) {
    await assert.rejects(credentials.get(options), { name: 'NotAllowedError' })
  }
  const attached = (authenticatorAttachment) => ({ publicKey: { authenticatorSelection: { authenticatorAttachment } } })
  assert.equal((await credentials.create(attached('cross-platform')))[1], 'created')
  await assert.rejects(credentials.create(attached('platform')), { name: 'NotAllowedError' })
})

test('an insecure page, with no credentials, is left alone', () => refusePasskeys())
