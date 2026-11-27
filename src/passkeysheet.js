// Runs in every web page and the frames inside it, before their own scripts,
// when Lit can use Apple's passkey sheet (in place of src/passkeys.js; see
// passkeySheet in main). Passkey and security key requests (WebAuthn) go to
// main, which checks them (src/webauthn.js) and shows the sheet; what the
// sheet gives back reaches the site as Chromium's own would. Sandboxed, so it
// can require nothing but electron. Tested in test/passkeysheet.test.js.

// Runs among the page's own scripts, so it can use nothing outside itself.
// `ask(kind, options)` sends a request in WebAuthn's JSON form and answers
// `{ credential }` in that form, or `{ error: { name, message } }`;
// `cancel()` closes the sheet for this frame's request.
function bridge(ask, cancel) {
  // Insecure pages have none of it.
  if (typeof CredentialsContainer === 'undefined' || typeof PublicKeyCredential === 'undefined') return

  const toBase64url = (source) => {
    const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : source instanceof ArrayBuffer ? new Uint8Array(source) : null
    if (!bytes) return undefined
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const toBuffer = (text) => {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }
  // Lists may be any iterable; strings and numbers stay as they are, and
  // main checks everything again.
  const list = (value, map) => (value == null ? undefined : typeof value[Symbol.iterator] === 'function' && typeof value !== 'string' ? Array.from(value, map) : null)
  const descriptor = (each) => ({ type: each?.type, id: toBase64url(each?.id), transports: list(each?.transports, String) })

  // The request in WebAuthn's JSON form, as main reads it.
  const json = {
    get: (options) => ({
      challenge: toBase64url(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentials: list(options.allowCredentials, descriptor),
    }),
    create: (options) => ({
      challenge: toBase64url(options.challenge),
      rp: options.rp && { id: options.rp.id, name: options.rp.name },
      user: options.user && { id: toBase64url(options.user.id), name: options.user.name, displayName: options.user.displayName },
      pubKeyCredParams: list(options.pubKeyCredParams, (each) => ({ type: each?.type, alg: each?.alg })),
      timeout: options.timeout,
      excludeCredentials: list(options.excludeCredentials, descriptor),
      authenticatorSelection: options.authenticatorSelection && {
        authenticatorAttachment: options.authenticatorSelection.authenticatorAttachment,
        residentKey: options.authenticatorSelection.residentKey,
        requireResidentKey: options.authenticatorSelection.requireResidentKey,
        userVerification: options.authenticatorSelection.userVerification,
      },
      attestation: options.attestation,
      extensions: { credProps: options.extensions?.credProps === true },
    }),
  }

  // Chromium's interfaces, so `instanceof PublicKeyCredential` and the like
  // hold; what it would keep inside, these keep as their own.
  const make = (prototype, fields) => Object.create(prototype, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, configurable: true }])))
  // A function named `name`, as Chromium's methods are.
  const method = (name, body) => ({ [name](...args) { return body(...args) } })[name]
  function credentialOf(answer) {
    const { response } = answer
    const fields = { clientDataJSON: toBuffer(response.clientDataJSON) }
    if (response.attestationObject) {
      const authenticatorData = toBuffer(response.authenticatorData)
      const publicKey = response.publicKey ? toBuffer(response.publicKey) : null
      Object.assign(fields, {
        attestationObject: toBuffer(response.attestationObject),
        getTransports: method('getTransports', () => [...response.transports]),
        getAuthenticatorData: method('getAuthenticatorData', () => authenticatorData.slice(0)),
        getPublicKey: method('getPublicKey', () => (publicKey ? publicKey.slice(0) : null)),
        getPublicKeyAlgorithm: method('getPublicKeyAlgorithm', () => response.publicKeyAlgorithm),
      })
    } else {
      Object.assign(fields, {
        authenticatorData: toBuffer(response.authenticatorData),
        signature: toBuffer(response.signature),
        userHandle: response.userHandle ? toBuffer(response.userHandle) : null,
      })
    }
    const Response = response.attestationObject ? AuthenticatorAttestationResponse : AuthenticatorAssertionResponse
    return make(PublicKeyCredential.prototype, {
      id: answer.id,
      rawId: toBuffer(answer.rawId),
      type: 'public-key',
      authenticatorAttachment: answer.authenticatorAttachment,
      response: make(Response.prototype, fields),
      getClientExtensionResults: method('getClientExtensionResults', () => JSON.parse(JSON.stringify(answer.clientExtensionResults))),
      toJSON: method('toJSON', () => JSON.parse(JSON.stringify(answer))),
    })
  }

  for (const name of ['get', 'create']) {
    const real = CredentialsContainer.prototype[name]
    const { [name]: value } = {
      async [name](...args) {
        const options = args[0]
        if (!options?.publicKey) return real.apply(this, args)
        const { signal } = options
        if (signal?.aborted) throw signal.reason
        // Passkeys listed in a login field are left for another time.
        if (options.mediation === 'conditional') throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
        let sent
        try { sent = json[name](options.publicKey) } catch { throw new TypeError(`Failed to execute '${name}' on 'CredentialsContainer'.`) }
        const answer = new Promise((resolve, reject) => {
          const aborted = () => { cancel(); reject(signal.reason) }
          signal?.addEventListener('abort', aborted, { once: true })
          ask(name, sent).then((result) => {
            signal?.removeEventListener('abort', aborted)
            if (result?.credential) resolve(credentialOf(result.credential))
            else if (result?.error?.name === 'TypeError') reject(new TypeError(result.error.message))
            else reject(new DOMException(result?.error?.message ?? '', result?.error?.name ?? 'NotAllowedError'))
          }, () => reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')))
        })
        return answer
      },
    }
    Object.defineProperty(CredentialsContainer.prototype, name, { value })
  }

  // What sites ask before offering passkeys: the sheet is always there (this
  // Mac, a phone or a security key), and passkeys in login fields aren't.
  const answers = {
    isUserVerifyingPlatformAuthenticatorAvailable: () => true,
    isConditionalMediationAvailable: () => false,
    getClientCapabilities: () => ({
      conditionalCreate: false,
      conditionalGet: false,
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
      relatedOrigins: false,
      signalAllAcceptedCredentials: false,
      signalCurrentUserDetails: false,
      signalUnknownCredential: false,
      'extension:credProps': true,
    }),
  }
  for (const [name, answer] of Object.entries(answers)) {
    Object.defineProperty(PublicKeyCredential, name, { value: method(name, async () => answer()), configurable: true, writable: true })
  }
}

// Whether the document may make this kind of request, by its Permissions
// Policy (publickey-credentials-get or -create), which only the page knows.
// Asked here, out of the page's reach.
function allows(policy, kind) {
  return !policy || policy.allowsFeature(kind === 'create' ? 'publickey-credentials-create' : 'publickey-credentials-get')
}

if (typeof window !== 'undefined') {
  const { contextBridge, ipcRenderer } = require('electron')
  const refused = { error: { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' } }
  contextBridge.executeInMainWorld({
    func: bridge,
    args: [
      async (kind, options) => (allows(document.featurePolicy, kind) ? ipcRenderer.invoke('passkey', kind, options) : refused),
      () => ipcRenderer.send('passkey-cancel'),
    ],
  })
} else module.exports = { bridge, allows }
