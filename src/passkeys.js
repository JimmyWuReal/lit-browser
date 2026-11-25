// Passkeys and security keys (WebAuthn). Lit can't use passkeys: macOS shows
// its passkey sheet only for browsers Apple has approved and signed so. Left
// alone, Chromium also has nothing to show, and a site's request waits
// forever. So unless the Security Keys setting is on, main turns them away
// here, before any page opens. Tested in test/passkeys.test.js.

// `app` is Electron's.
function turnAway(app) {
  // Sites that look for PublicKeyCredential find none, in any frame, and offer
  // another way to sign in.
  app.commandLine.appendSwitch('disable-blink-features', 'WebAuth')
  // Chromium's get and create still take a request. macOS refuses Lit's use of
  // its passkey sheet at once, and with it the request, as if cancelled. It
  // isn't asked for a frame from another site than its page's, so main runs
  // refuse in those.
  app.configureWebAuthn({ platformPasskeys: true })
}

// Runs among a page's own scripts, so it can use nothing outside itself.
function refuse() {
  // Insecure pages have none of it.
  if (typeof CredentialsContainer === 'undefined' || typeof PublicKeyCredential !== 'undefined') return
  for (const name of ['get', 'create']) {
    const real = CredentialsContainer.prototype[name]
    const { [name]: value } = {
      async [name](...args) {
        if (!args[0]?.publicKey) return real.apply(this, args)
        throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
      },
    }
    Object.defineProperty(CredentialsContainer.prototype, name, { value })
  }
}

module.exports = { turnAway, refuse }
