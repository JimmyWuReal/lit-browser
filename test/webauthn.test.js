const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { check, credentialOf, errorOf, refusal, cbor, rpIdFits, TIMEOUT } = require('../src/webauthn')

const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
const challenge = b64(crypto.randomBytes(32))
const at = (origin, sameOriginWithAncestors = true) => ({ origin, sameOriginWithAncestors })
const page = at('https://login.example.com')
const getOptions = (more) => ({ challenge, ...more })
const createOptions = (more) => ({
  challenge,
  rp: { id: 'example.com', name: 'Example' },
  user: { id: b64([1, 2, 3]), name: 'jimmy@example.com', displayName: 'Jimmy' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
  ...more,
})

test('only https pages, or localhost, and the frame of the page itself, may ask', () => {
  for (const origin of ['http://example.com', 'https://192.168.1.1', 'https://[::1]', 'null', 'file://', 'https://example.com/path', 'not a url']) {
    assert.deepEqual(check('get', getOptions(), at(origin)), refusal(), origin)
  }
  assert.deepEqual(check('get', getOptions(), at('https://ads.example.net', false)), refusal())
  assert.deepEqual(check('get', getOptions(), { origin: 'https://example.com' }), refusal())
  assert.equal(check('get', getOptions(), at('http://localhost:3000')).request.rpId, 'localhost')
  assert.equal(check('get', getOptions(), at('https://example.com')).request.origin, 'https://example.com')
  assert.equal(check('sign', getOptions(), page).error.name, 'TypeError')
  assert.equal(check('get', null, page).error.name, 'TypeError')
})

test('a site may only ask for its own passkeys', () => {
  assert.equal(rpIdFits('example.com', 'login.example.com'), true)
  assert.equal(rpIdFits('login.example.com', 'login.example.com'), true)
  assert.equal(rpIdFits('example.co.uk', 'www.example.co.uk'), true)
  assert.equal(rpIdFits('github.io', 'github.io'), true)
  for (const [rpId, host] of [['com', 'example.com'], ['co.uk', 'example.co.uk'], ['github.io', 'jimmy.github.io'], ['evil.com', 'example.com'],
    ['ample.com', 'example.com'], ['www.example.com', 'example.com'], ['', 'example.com'], [42, 'example.com']]) {
    assert.equal(rpIdFits(rpId, host), false, `${rpId} on ${host}`)
  }
  assert.equal(check('get', getOptions({ rpId: 'example.com' }), page).request.rpId, 'example.com')
  assert.equal(check('get', getOptions({ rpId: 'google.com' }), page).error.name, 'SecurityError')
  assert.equal(check('create', createOptions({ rp: { id: 'com', name: 'x' } }), page).error.name, 'SecurityError')
  // With none given, the page's own name.
  assert.equal(check('create', createOptions({ rp: { name: 'Example' } }), page).request.rpId, 'login.example.com')
})

test('what a page sends is checked before it goes anywhere', () => {
  for (const bad of [undefined, '', 'not base64!', b64(Buffer.alloc(2000))]) {
    assert.equal(check('get', { challenge: bad }, page).error.name, 'TypeError')
  }
  assert.equal(check('get', getOptions({ allowCredentials: 'x' }), page).error.name, 'TypeError')
  assert.equal(check('get', getOptions({ allowCredentials: [{ type: 'public-key', id: '' }] }), page).error.name, 'TypeError')
  assert.equal(check('get', getOptions({ allowCredentials: Array(65).fill({ type: 'public-key', id: 'AQ' }) }), page).error.name, 'TypeError')
  assert.equal(check('create', createOptions({ user: { id: b64(Buffer.alloc(65)), name: 'a' } }), page).error.name, 'TypeError')
  assert.equal(check('create', createOptions({ user: { id: '', name: 'a' } }), page).error.name, 'TypeError')
  assert.equal(check('create', createOptions({ user: { id: 'AQ', name: 7 } }), page).error.name, 'TypeError')
  assert.equal(check('create', createOptions({ user: { id: 'AQ', name: 'a'.repeat(5000) } }), page).error.name, 'TypeError')
  assert.equal(check('create', createOptions({ pubKeyCredParams: 'x' }), page).error.name, 'TypeError')
  assert.equal(check('create', createOptions({ excludeCredentials: [{ type: 'public-key', id: '!' }] }), page).error.name, 'TypeError')
})

test('a request to get a passkey', () => {
  const { request, timeout } = check('get', getOptions({ rpId: 'example.com', userVerification: 'required', timeout: 60_000 }), page)
  assert.deepEqual(request, {
    kind: 'get', rpId: 'example.com', origin: 'https://login.example.com', challenge: Buffer.from(challenge, 'base64url'),
    userVerification: 'required', allow: [], platform: true, securityKey: true, hybrid: true,
  })
  assert.equal(timeout, 60_000)
  assert.equal(check('get', getOptions({ timeout: 1 }), page).timeout, TIMEOUT.min)
  assert.equal(check('get', getOptions({ timeout: 1e9 }), page).timeout, TIMEOUT.max)
  assert.equal(check('get', getOptions(), page).timeout, TIMEOUT.default)
  assert.equal(check('get', getOptions({ userVerification: 'maybe' }), page).request.userVerification, 'preferred')

  // Transports are hints, so every way stays open, and ids are what is sent.
  const allowed = check('get', getOptions({ allowCredentials: [{ type: 'public-key', id: 'AQ', transports: ['usb'] }, { type: 'public-key', id: 'Ag', transports: ['internal'] }] }), page).request
  assert.deepEqual([allowed.platform, allowed.securityKey, allowed.hybrid], [true, true, true])
  assert.deepEqual(allowed.allow, [{ id: Buffer.from([1]) }, { id: Buffer.from([2]) }])
  // Others than public-key are skipped, as in Chromium.
  assert.deepEqual(check('get', getOptions({ allowCredentials: [{ type: 'password', id: 'AQ' }] }), page).request.allow, [])
})

test('a request to make a passkey', () => {
  const { request, credProps } = check('create', createOptions({ extensions: { credProps: true }, attestation: 'direct' }), page)
  assert.deepEqual(request, {
    kind: 'create', rpId: 'example.com', origin: 'https://login.example.com', challenge: Buffer.from(challenge, 'base64url'),
    userVerification: 'preferred', user: { id: Buffer.from([1, 2, 3]), name: 'jimmy@example.com', displayName: 'Jimmy' },
    algorithms: [-7, -257], exclude: [], residentKey: 'discouraged', attestation: 'direct', platform: true, securityKey: true, hybrid: true,
  })
  assert.equal(credProps, true)
  const made = (more) => check('create', createOptions(more), page)
  const selection = (authenticatorSelection) => made({ authenticatorSelection })
  assert.deepEqual(['platform', 'securityKey', 'hybrid'].map((key) => selection({ authenticatorAttachment: 'platform' }).request[key]), [true, false, false])
  assert.deepEqual(['platform', 'securityKey'].map((key) => selection({ authenticatorAttachment: 'cross-platform' }).request[key]), [false, true])
  assert.equal(selection({ residentKey: 'required' }).request.residentKey, 'required')
  assert.equal(selection({ requireResidentKey: true }).request.residentKey, 'required')
  assert.equal(selection({ userVerification: 'required' }).request.userVerification, 'required')
  // Passkeys are ES256; a site that won't take it can only use a security key.
  assert.deepEqual(['platform', 'securityKey'].map((key) => made({ pubKeyCredParams: [{ type: 'public-key', alg: -8 }] }).request[key]), [false, true])
  assert.equal(made({ pubKeyCredParams: [{ type: 'public-key', alg: -8 }], authenticatorSelection: { authenticatorAttachment: 'platform' } }).error.name, 'NotSupportedError')
  assert.equal(made({ pubKeyCredParams: [{ type: 'other', alg: -7 }] }).error.name, 'NotSupportedError')
  assert.deepEqual(made({ pubKeyCredParams: [] }).request.algorithms, [-7, -257])
  assert.equal(made({ attestation: 'weird' }).request.attestation, 'none')
  assert.equal(made({ attestation: 'enterprise' }).request.attestation, 'none')
  assert.equal(made().credProps, false)
  assert.equal(check('create', createOptions({ user: { id: 'AQ', name: 'a' } }), page).request.user.displayName, '')
})

// A tiny CBOR encoder, for attestation objects as an authenticator makes them.
function encode(value) {
  const head = (major, length) => {
    if (length < 24) return Buffer.from([(major << 5) | length])
    if (length < 256) return Buffer.from([(major << 5) | 24, length])
    const bytes = Buffer.alloc(3)
    bytes[0] = (major << 5) | 25
    bytes.writeUInt16BE(length, 1)
    return bytes
  }
  if (value === false || value === true || value === null) return Buffer.from([value === null ? 0xf6 : value ? 0xf5 : 0xf4])
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encode)])
  const entries = value instanceof Map ? [...value] : Object.entries(value)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [encode(key), encode(item)])])
}

function attestationFor(cose, id = Buffer.from([9, 9, 9])) {
  const length = Buffer.alloc(2)
  length.writeUInt16BE(id.length)
  const authData = Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, encode(cose)])
  return { authData, attestationObject: encode({ fmt: 'none', attStmt: {}, authData }) }
}

test('cbor reads what authenticators write', () => {
  const value = new Map([[1, -7], ['a', Buffer.from([1, 2])], [-2, [true, false, null, 'x', 300]]])
  assert.deepEqual(cbor(encode(value)).value, value)
  assert.throws(() => cbor(Buffer.from([0x5f])))
  assert.throws(() => cbor(Buffer.from([0x42, 1])))
  assert.throws(() => cbor(Buffer.alloc(0)))
})

test('a new passkey reaches the page in WebAuthn’s JSON form, with its public key', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
  const { authData, attestationObject } = attestationFor(cose)
  const answer = { id: Buffer.from([9, 9, 9]), clientDataJSON: Buffer.from('{"type":"webauthn.create"}'), attestationObject, attachment: 'platform', transports: ['internal', 'hybrid'] }
  const credential = credentialOf('create', answer, { credProps: true })
  assert.deepEqual(credential, {
    id: 'CQkJ', rawId: 'CQkJ', type: 'public-key', authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64(answer.clientDataJSON),
      attestationObject: b64(attestationObject),
      authenticatorData: b64(authData),
      transports: ['hybrid', 'internal'],
      publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
      publicKeyAlgorithm: -7,
    },
    clientExtensionResults: { credProps: { rk: true } },
  })
  // A security key's: Ed25519, and no word on credProps.
  const ed = crypto.generateKeyPairSync('ed25519').publicKey
  const edCose = new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(ed.export({ format: 'jwk' }).x, 'base64url')]])
  const key = credentialOf('create', { ...answer, attestationObject: attestationFor(edCose).attestationObject, attachment: 'cross-platform', transports: undefined }, { credProps: true })
  assert.equal(key.response.publicKey, b64(ed.export({ type: 'spki', format: 'der' })))
  assert.deepEqual([key.authenticatorAttachment, key.response.transports, key.response.publicKeyAlgorithm, key.clientExtensionResults], ['cross-platform', [], -8, {}])
  // A key Lit can't put as SPKI still comes through, without it.
  const unknown = credentialOf('create', { ...answer, attestationObject: attestationFor(new Map([[1, 9], [3, -999]])).attestationObject }, {})
  assert.equal('publicKey' in unknown.response, false)
  assert.equal(unknown.response.publicKeyAlgorithm, -999)
  // An attestation with no credential in it is no answer.
  assert.throws(() => credentialOf('create', { ...answer, attestationObject: encode({ fmt: 'none', authData: Buffer.alloc(37) }) }, {}))
  assert.throws(() => credentialOf('create', { ...answer, attestationObject: Buffer.from([1]) }, {}))
})

test('a passkey used reaches the page in WebAuthn’s JSON form', () => {
  const answer = { id: Buffer.from([1]), clientDataJSON: Buffer.from('{}'), authenticatorData: Buffer.alloc(37), signature: Buffer.from([5]), userHandle: Buffer.from([7]), attachment: 'platform' }
  assert.deepEqual(credentialOf('get', answer, {}), {
    id: 'AQ', rawId: 'AQ', type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: b64('{}'), authenticatorData: b64(Buffer.alloc(37)), signature: 'BQ', userHandle: 'Bw' },
    clientExtensionResults: {},
  })
  const { userHandle, ...noUser } = answer
  assert.equal('userHandle' in credentialOf('get', { ...noUser, attachment: 'cross-platform' }, {}).response, false)
})

test('a site learns only that it got no passkey, unless one it excluded is there', () => {
  assert.deepEqual(errorOf({ code: 1001 }), refusal())
  assert.deepEqual(errorOf({ code: 1004 }), refusal())
  assert.deepEqual(errorOf(undefined), refusal())
  assert.equal(errorOf({ code: 1006 }).error.name, 'InvalidStateError')
  assert.equal(refusal().error.name, 'NotAllowedError')
})
