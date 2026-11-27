// Passkey requests on their way to Apple's passkey sheet (native/passkeys.m)
// and the answers on their way back to the page (src/passkeysheet.js).
//
// A page sends its request as WebAuthn's JSON form (binary as base64url), and
// nothing in it is taken on trust: the frame's origin comes from Chromium,
// and here the relying party (rpId) is checked against it, as Chromium would,
// so a site can only ever ask for its own passkeys. What passes becomes the
// native module's request; its answer becomes WebAuthn's JSON form again.
// Plain Node, tested in test/webauthn.test.js.
const crypto = require('node:crypto')
const { parse } = require('tldts')

// What Chromium allows a request to wait, in ms: 5 minutes unless the site
// says otherwise, and from 10 seconds to 10 minutes if it does.
const TIMEOUT = { default: 5 * 60_000, min: 10_000, max: 10 * 60_000 }
// What a page may send, well above anything a site needs.
const MAX_BYTES = 1024
const MAX_TEXT = 1024
const MAX_LIST = 64
// COSE algorithms: ES256 is the one passkeys use. A site that names none gets
// ES256 and RS256, as the spec says.
const ES256 = -7
const DEFAULT_ALGORITHMS = [ES256, -257]
const KEY_TRANSPORTS = ['usb', 'nfc', 'ble']

// Chromium's words for a refused request, which tell a site nothing more.
const NOT_ALLOWED = 'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.'
const failure = (name, message = NOT_ALLOWED) => ({ error: { name, message } })
const refusal = () => failure('NotAllowedError')

// Binary from the page, or null if it isn't base64url or is too long.
function bytesOf(value, { min = 0, max = MAX_BYTES } = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length >= min && bytes.length <= max ? bytes : null
}
const textOf = (value) => (typeof value === 'string' && value.length <= MAX_TEXT ? value : null)
const listOf = (value) => (value === undefined ? [] : Array.isArray(value) && value.length <= MAX_LIST ? value : null)
const oneOf = (value, values, fallback) => (values.includes(value) ? value : fallback)

// Credentials a site names, to allow or exclude: [{ id, transports }].
function descriptorsOf(value) {
  const list = listOf(value)
  if (!list) return null
  const descriptors = []
  for (const each of list) {
    if (each?.type !== 'public-key') continue
    const id = bytesOf(each.id, { min: 1 })
    if (!id) return null
    const transports = listOf(each.transports)?.filter((transport) => typeof transport === 'string')
    descriptors.push({ id, ...(transports?.length && { transports }) })
  }
  return descriptors
}

// The page's origin, as Apple puts it in clientDataJSON, if passkeys may be
// used there at all: https, or http on localhost, and a name, not an address.
function originOf(origin) {
  let url
  try { url = new URL(origin) } catch { return null }
  if (url.origin !== origin) return null
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')))) return null
  if (parse(url.hostname).isIp || url.hostname.startsWith('[')) return null
  return url
}

// Whether a page on `host` may use passkeys for `rpId`: its own name, or a
// domain it is under that isn't a public suffix (com, co.uk, github.io).
function rpIdFits(rpId, host) {
  if (rpId === host) return true
  if (typeof rpId !== 'string' || !host.endsWith(`.${rpId}`)) return false
  const parsed = parse(rpId, { allowPrivateDomains: true })
  return Boolean(parsed.domain) && parsed.publicSuffix !== rpId
}

// A page's request (`kind` 'create' or 'get', `options` in WebAuthn's JSON
// form), from a frame on `origin`, which is `sameOriginWithAncestors` when
// every frame above it is on that origin too. Answers
// `{ request, timeout, credProps }`, the native module's request and what
// main needs after, or `{ error: { name, message } }` for the page.
function check(kind, options, { origin, sameOriginWithAncestors }) {
  if ((kind !== 'create' && kind !== 'get') || !options || typeof options !== 'object') return failure('TypeError', 'The request isn’t one Lit knows.')
  // A frame under one from another origin would need that frame's leave
  // (publickey-credentials-* in Permissions Policy), which main can't see.
  const url = originOf(origin)
  if (!url || sameOriginWithAncestors !== true) return refusal()

  const challenge = bytesOf(options.challenge, { min: 1 })
  if (!challenge) return failure('TypeError', 'The challenge is missing or too long.')
  const rpId = (kind === 'create' ? options.rp?.id : options.rpId) ?? url.hostname
  if (!rpIdFits(rpId, url.hostname)) return failure('SecurityError', 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.')
  const timeout = Number.isFinite(options.timeout) ? Math.min(TIMEOUT.max, Math.max(TIMEOUT.min, options.timeout)) : TIMEOUT.default
  const userVerification = oneOf(options.userVerification ?? options.authenticatorSelection?.userVerification, ['required', 'preferred', 'discouraged'], 'preferred')
  const request = { kind, rpId, origin, challenge, userVerification }

  if (kind === 'get') {
    const allow = descriptorsOf(options.allowCredentials)
    if (!allow) return failure('TypeError', 'The allowed credentials can’t be read.')
    // Credentials that say where they are go only there: this Mac or a phone,
    // or a security key. Any others may be on either.
    const on = (transports) => allow.length > 0 && allow.every((each) => each.transports?.every((transport) => transports.includes(transport)))
    const securityKey = !on(['internal', 'hybrid'])
    const platform = !on(KEY_TRANSPORTS)
    return { request: { ...request, allow, platform, securityKey, hybrid: platform }, timeout }
  }

  const userId = bytesOf(options.user?.id, { min: 1, max: 64 })
  const name = textOf(options.user?.name)
  const displayName = textOf(options.user?.displayName ?? '')
  if (!userId || name === null || displayName === null || textOf(options.rp?.name) === null) return failure('TypeError', 'The user or relying party can’t be read.')
  const params = listOf(options.pubKeyCredParams)
  if (!params) return failure('TypeError', 'The algorithms can’t be read.')
  const algorithms = params.length ? params.filter((each) => each?.type === 'public-key' && Number.isInteger(each.alg)).map((each) => each.alg) : DEFAULT_ALGORITHMS
  const exclude = descriptorsOf(options.excludeCredentials)
  if (!exclude) return failure('TypeError', 'The excluded credentials can’t be read.')
  const selection = options.authenticatorSelection ?? {}
  const attachment = selection.authenticatorAttachment
  // Passkeys Apple keeps, or made on a phone, are ES256; a security key may
  // take what the site lists. A site that wants a security key gets only that,
  // and one that wants this Mac gets no phone either.
  const platform = attachment !== 'cross-platform' && algorithms.includes(ES256)
  const securityKey = attachment !== 'platform' && algorithms.length > 0
  if (!platform && !securityKey) return failure('NotSupportedError', 'None of the algorithms asked for are supported.')
  const residentKey = oneOf(selection.residentKey, ['required', 'preferred', 'discouraged'], selection.requireResidentKey === true ? 'required' : 'discouraged')
  return {
    request: {
      ...request,
      user: { id: userId, name, displayName },
      algorithms,
      exclude,
      residentKey,
      attestation: oneOf(options.attestation, ['none', 'indirect', 'direct', 'enterprise'], 'none'),
      platform,
      securityKey,
      hybrid: platform && attachment !== 'platform',
    },
    timeout,
    credProps: options.extensions?.credProps === true,
  }
}

// --- What comes back -------------------------------------------------------

// The first CBOR item in `bytes` from `at`: { value, end }. Enough of CBOR for
// an attestation object and a COSE key: numbers, byte and text strings,
// arrays, maps (as Maps), and true, false and null.
function cbor(bytes, at = 0) {
  const head = bytes[at]
  if (head === undefined) throw new Error('CBOR ends early')
  const major = head >> 5
  const info = head & 31
  let length = info
  let end = at + 1
  if (info === 24) length = bytes[end++]
  else if (info === 25) { length = bytes.readUInt16BE(end); end += 2 }
  else if (info === 26) { length = bytes.readUInt32BE(end); end += 4 }
  else if (info === 27) { length = Number(bytes.readBigUInt64BE(end)); end += 8 }
  else if (info > 27) throw new Error('CBOR item not supported')
  if (end > bytes.length) throw new Error('CBOR ends early')
  if (major === 0) return { value: length, end }
  if (major === 1) return { value: -1 - length, end }
  if (major === 2 || major === 3) {
    if (end + length > bytes.length) throw new Error('CBOR ends early')
    const slice = bytes.subarray(end, end + length)
    return { value: major === 2 ? Buffer.from(slice) : slice.toString('utf8'), end: end + length }
  }
  if (major === 4) {
    const value = []
    for (let i = 0; i < length; i++) ({ value: value[i], end } = cbor(bytes, end))
    return { value, end }
  }
  if (major === 5) {
    const value = new Map()
    for (let i = 0; i < length; i++) {
      const key = cbor(bytes, end)
      const item = cbor(bytes, key.end)
      value.set(key.value, item.value)
      end = item.end
    }
    return { value, end }
  }
  if (major === 7 && (info === 20 || info === 21 || info === 22)) return { value: info === 22 ? null : info === 21, end }
  throw new Error('CBOR item not supported')
}

// A COSE key as SubjectPublicKeyInfo (DER), for getPublicKey(): ES256 (P-256),
// EdDSA (Ed25519) and RS256 keys, the ones Chromium gives too.
function spkiOf(key) {
  const b64 = (name) => key.get(name)?.toString('base64url')
  const kty = key.get(1)
  let jwk
  if (kty === 2 && key.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: b64(-2), y: b64(-3) }
  else if (kty === 1 && key.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: b64(-2) }
  else if (kty === 3) jwk = { kty: 'RSA', n: b64(-1), e: b64(-2) }
  if (!jwk) return null
  try {
    return crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' })
  } catch {
    return null
  }
}

// What an attestation object says of the new credential: its authenticator
// data, and its public key and algorithm, from the attested credential data
// (rpIdHash 32, flags 1, signCount 4, aaguid 16, id length 2, id, COSE key).
function attested(attestationObject) {
  const authData = cbor(attestationObject).value?.get?.('authData')
  if (!Buffer.isBuffer(authData) || authData.length < 55 || !(authData[32] & 0x40)) throw new Error('No credential in the attestation')
  const idLength = authData.readUInt16BE(53)
  const key = cbor(authData, 55 + idLength).value
  if (!(key instanceof Map)) throw new Error('No public key in the attestation')
  return { authenticatorData: authData, publicKey: spkiOf(key), publicKeyAlgorithm: key.get(3) }
}

// The native module's answer (passkeys.m's resultOf) as WebAuthn's JSON form
// (RegistrationResponseJSON or AuthenticationResponseJSON), for the page.
// `checked` is what `check` answered for the request.
function credentialOf(kind, answer, checked) {
  const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
  const id = b64(answer.id)
  const common = { id, rawId: id, type: 'public-key', authenticatorAttachment: answer.attachment === 'platform' ? 'platform' : 'cross-platform' }
  if (kind === 'create') {
    const { authenticatorData, publicKey, publicKeyAlgorithm } = attested(answer.attestationObject)
    return {
      ...common,
      response: {
        clientDataJSON: b64(answer.clientDataJSON),
        attestationObject: b64(answer.attestationObject),
        authenticatorData: b64(authenticatorData),
        transports: [...(answer.transports ?? [])].sort(),
        ...(publicKey && { publicKey: b64(publicKey) }),
        publicKeyAlgorithm,
      },
      // Passkeys are always discoverable; what a security key made, Apple
      // doesn't say.
      clientExtensionResults: checked.credProps && answer.attachment === 'platform' ? { credProps: { rk: true } } : {},
    }
  }
  return {
    ...common,
    response: {
      clientDataJSON: b64(answer.clientDataJSON),
      authenticatorData: b64(answer.authenticatorData),
      signature: b64(answer.signature),
      ...(answer.userHandle && { userHandle: b64(answer.userHandle) }),
    },
    clientExtensionResults: {},
  }
}

// What the page is told when the sheet gives no credential: an excluded
// passkey already there is InvalidStateError, as the spec says; anything else
// (cancelled, timed out, not allowed) looks the same to the site.
const MATCHED_EXCLUDED = 1006
const errorOf = (error) => (error?.code === MATCHED_EXCLUDED ? failure('InvalidStateError', 'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.') : refusal())

module.exports = { check, credentialOf, errorOf, refusal, cbor, rpIdFits, TIMEOUT }
