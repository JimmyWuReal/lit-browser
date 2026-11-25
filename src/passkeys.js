// Runs in every web page's top frame, for passkeys and security keys. Lit
// can't show macOS's passkey sheet (Apple gives that to approved, signed
// browsers only) and has no prompt of its own, so a site's request would wait
// forever with nothing on screen. Unless the Security Keys setting is on, main
// starts Chromium without PublicKeyCredential, in every frame, and sites that
// look for it offer another way to sign in. Chromium's get and create still
// take such a request, so here they refuse it, as when someone cancels.
// Sandboxed, so it can require nothing but electron. Tested in
// test/passkeys.test.js.

// Runs among the page's own scripts, so it can use nothing outside itself.
function refusePasskeys() {
  for (const name of ['get', 'create']) {
    const real = CredentialsContainer.prototype[name]
    const { [name]: value } = {
      [name](...args) {
        if (!args[0]?.publicKey) return real.apply(this, args)
        return Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'))
      },
    }
    Object.defineProperty(CredentialsContainer.prototype, name, { value })
  }
}

if (typeof window !== 'undefined') {
  // Insecure pages have neither.
  if (window.CredentialsContainer && !window.PublicKeyCredential) require('electron').contextBridge.executeInMainWorld({ func: refusePasskeys })
} else module.exports = { refusePasskeys }
