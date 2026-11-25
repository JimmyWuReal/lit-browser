const test = require('node:test')
const assert = require('node:assert/strict')
const { refusePasskeys } = require('../src/passkeys')

test('passkey requests are refused, and other credentials still work', async (t) => {
  globalThis.CredentialsContainer = class {
    async get(options) { return [this, 'got', options] }
    async create(options) { return [this, 'created', options] }
    async store() { return 'stored' }
  }
  t.after(() => { delete globalThis.CredentialsContainer })
  refusePasskeys()
  const credentials = new CredentialsContainer()
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
