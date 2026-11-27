const test = require('node:test')
const assert = require('node:assert/strict')
const { bridge, allows } = require('../src/passkeysheet')

const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
const bytesOf = (buffer) => [...new Uint8Array(buffer)]

// A page's credentials once the bridge has run in it, with Chromium's
// interfaces, sending to `answer` in place of main.
function start(t, answer = async () => ({ error: { name: 'NotAllowedError', message: 'no' } })) {
  const sent = []
  const cancels = []
  globalThis.CredentialsContainer = class {
    async get(options) { return [this, 'got', options] }
    async create(options) { return [this, 'created', options] }
  }
  globalThis.PublicKeyCredential = class { static async isUserVerifyingPlatformAuthenticatorAvailable() { return false } }
  globalThis.AuthenticatorAttestationResponse = class {}
  globalThis.AuthenticatorAssertionResponse = class {}
  t.after(() => {
    for (const name of ['CredentialsContainer', 'PublicKeyCredential', 'AuthenticatorAttestationResponse', 'AuthenticatorAssertionResponse']) delete globalThis[name]
  })
  const ask = (kind, options) => { sent.push([kind, options]); return answer(kind, options) }
  // As it runs in a page: the function's source, alone.
  ;(0, eval)(`(${bridge})`)(ask, () => cancels.push(true))
  return { credentials: new CredentialsContainer(), sent, cancels }
}

const used = {
  id: 'AQ', rawId: 'AQ', type: 'public-key', authenticatorAttachment: 'platform',
  response: { clientDataJSON: b64('{"a":1}'), authenticatorData: b64([0, 1]), signature: b64([5]), userHandle: b64([7]) },
  clientExtensionResults: {},
}
const made = {
  id: 'Ag', rawId: 'Ag', type: 'public-key', authenticatorAttachment: 'cross-platform',
  response: { clientDataJSON: b64('{}'), attestationObject: b64([1, 2]), authenticatorData: b64([3]), transports: ['usb'], publicKey: b64([4]), publicKeyAlgorithm: -7 },
  clientExtensionResults: { credProps: { rk: true } },
}

test('other credentials go on to Chromium', async (t) => {
  const { credentials, sent } = start(t)
  assert.deepEqual(await credentials.get({ password: true }), [credentials, 'got', { password: true }])
  assert.deepEqual(await credentials.create({ password: {} }), [credentials, 'created', { password: {} }])
  assert.deepEqual(await credentials.get(), [credentials, 'got', undefined])
  assert.equal(sent.length, 0)
  assert.equal(credentials.get.name, 'get')
})

test('a request goes to main in WebAuthn’s JSON form', async (t) => {
  const { credentials, sent } = start(t)
  const challenge = new Uint8Array([1, 2, 3, 250])
  await assert.rejects(credentials.get({ publicKey: {
    challenge: challenge.buffer, rpId: 'example.com', timeout: 1000, userVerification: 'required',
    allowCredentials: new Set([{ type: 'public-key', id: new DataView(new Uint8Array([9, 8]).buffer), transports: ['usb'] }]),
  } }), { name: 'NotAllowedError' })
  assert.deepEqual(sent[0], ['get', {
    challenge: b64(challenge), rpId: 'example.com', timeout: 1000, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: b64([9, 8]), transports: ['usb'] }],
  }])
  await assert.rejects(credentials.create({ publicKey: {
    challenge: new Uint8Array([1]).subarray(0, 1), rp: { name: 'Example' }, user: { id: new Uint8Array([4]), name: 'a', displayName: 'A' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required' },
    extensions: { credProps: true, other: 1 },
  } }), { name: 'NotAllowedError' })
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1])), ['create', {
    challenge: 'AQ', rp: { name: 'Example' }, user: { id: 'BA', name: 'a', displayName: 'A' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required' },
    extensions: { credProps: true },
  }])
  // What can't be read is left for main to refuse.
  await credentials.get({ publicKey: { challenge: 'text', allowCredentials: 5 } }).catch(() => {})
  assert.deepEqual(sent[2][1].challenge, undefined)
  assert.equal(sent[2][1].allowCredentials, null)
  await assert.rejects(credentials.get({ publicKey: { get challenge() { throw new Error('boom') } } }), TypeError)
  // A buffer from another frame (here, another realm) is read too.
  const other = require('node:vm').runInNewContext('new Uint8Array([6, 7]).buffer')
  assert.equal(other instanceof ArrayBuffer, false)
  await credentials.get({ publicKey: { challenge: other } }).catch(() => {})
  assert.equal(sent[3][1].challenge, b64([6, 7]))
})

test('a passkey used comes back as Chromium’s would', async (t) => {
  const { credentials } = start(t, async () => ({ credential: used }))
  const credential = await credentials.get({ publicKey: { challenge: new Uint8Array(1) } })
  assert.ok(credential instanceof PublicKeyCredential)
  assert.ok(credential.response instanceof AuthenticatorAssertionResponse)
  assert.deepEqual([credential.id, credential.type, credential.authenticatorAttachment], ['AQ', 'public-key', 'platform'])
  assert.deepEqual(bytesOf(credential.rawId), [1])
  assert.equal(Buffer.from(credential.response.clientDataJSON).toString(), '{"a":1}')
  assert.deepEqual(bytesOf(credential.response.authenticatorData), [0, 1])
  assert.deepEqual(bytesOf(credential.response.signature), [5])
  assert.deepEqual(bytesOf(credential.response.userHandle), [7])
  assert.deepEqual(credential.getClientExtensionResults(), {})
  assert.deepEqual(credential.toJSON(), used)
  assert.deepEqual(JSON.parse(JSON.stringify(credential)), used)
  const { userHandle, ...response } = used.response
  const { credentials: again } = start(t, async () => ({ credential: { ...used, response } }))
  assert.equal((await again.get({ publicKey: {} })).response.userHandle, null)
})

test('a new passkey comes back as Chromium’s would', async (t) => {
  const { credentials } = start(t, async () => ({ credential: made }))
  const credential = await credentials.create({ publicKey: { challenge: new Uint8Array(1) } })
  assert.ok(credential instanceof PublicKeyCredential)
  assert.ok(credential.response instanceof AuthenticatorAttestationResponse)
  assert.deepEqual(bytesOf(credential.response.attestationObject), [1, 2])
  assert.deepEqual(credential.response.getTransports(), ['usb'])
  assert.deepEqual(bytesOf(credential.response.getAuthenticatorData()), [3])
  assert.deepEqual(bytesOf(credential.response.getPublicKey()), [4])
  assert.equal(credential.response.getPublicKeyAlgorithm(), -7)
  assert.deepEqual(credential.getClientExtensionResults(), { credProps: { rk: true } })
  // What a site changes is its own copy.
  credential.getClientExtensionResults().credProps.rk = false
  credential.response.getTransports().push('x')
  assert.deepEqual([credential.getClientExtensionResults().credProps.rk, credential.response.getTransports()], [true, ['usb']])
  const { publicKey, ...response } = made.response
  const { credentials: again } = start(t, async () => ({ credential: { ...made, response } }))
  assert.equal((await again.create({ publicKey: {} })).response.getPublicKey(), null)
})

test('a refusal reaches the site as the error Chromium would give', async (t) => {
  let error = { name: 'InvalidStateError', message: 'there' }
  const { credentials } = start(t, async () => ({ error }))
  await assert.rejects(credentials.create({ publicKey: {} }), (thrown) => thrown instanceof DOMException && thrown.name === 'InvalidStateError')
  error = { name: 'TypeError', message: 'bad' }
  await assert.rejects(credentials.create({ publicKey: {} }), (thrown) => thrown instanceof TypeError && thrown.message === 'bad')
  error = undefined
  await assert.rejects(credentials.get({ publicKey: {} }), { name: 'NotAllowedError' })
  const { credentials: broken } = start(t, async () => { throw new Error('gone') })
  await assert.rejects(broken.get({ publicKey: {} }), { name: 'NotAllowedError' })
})

test('passkeys in login fields are refused without asking', async (t) => {
  const { credentials, sent } = start(t)
  await assert.rejects(credentials.get({ publicKey: {}, mediation: 'conditional' }), { name: 'NotAllowedError' })
  await assert.rejects(credentials.create({ publicKey: {}, mediation: 'conditional' }), { name: 'NotAllowedError' })
  assert.equal(sent.length, 0)
})

test('a site that gives up closes the sheet', async (t) => {
  let resolve
  const { credentials, sent, cancels } = start(t, () => new Promise((done) => { resolve = done }))
  const before = new AbortController()
  before.abort(new Error('early'))
  await assert.rejects(credentials.get({ publicKey: {}, signal: before.signal }), { message: 'early' })
  assert.equal(sent.length, 0)
  const during = new AbortController()
  const asked = credentials.get({ publicKey: {}, signal: during.signal })
  during.abort(new Error('late'))
  await assert.rejects(asked, { message: 'late' })
  assert.equal(cancels.length, 1)
  // The sheet's answer after that changes nothing.
  resolve({ credential: used })
})

test('sites learn the sheet is there, and login-field passkeys aren’t', async (t) => {
  start(t)
  assert.equal(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true)
  assert.equal(await PublicKeyCredential.isConditionalMediationAvailable(), false)
  const capabilities = await PublicKeyCredential.getClientCapabilities()
  assert.deepEqual([capabilities.conditionalGet, capabilities.hybridTransport, capabilities.passkeyPlatformAuthenticator], [false, true, true])
  assert.equal(PublicKeyCredential.getClientCapabilities.name, 'getClientCapabilities')
})

test('a document its Permissions Policy keeps from passkeys isn’t asked for', () => {
  const asked = []
  const policy = (allowed) => ({ allowsFeature: (feature) => { asked.push(feature); return allowed } })
  assert.equal(allows(policy(true), 'get'), true)
  assert.equal(allows(policy(false), 'create'), false)
  assert.deepEqual(asked, ['publickey-credentials-get', 'publickey-credentials-create'])
  assert.equal(allows(undefined, 'get'), true)
})

test('an insecure page, with no credentials, is left alone', () => bridge())
