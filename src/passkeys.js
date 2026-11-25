// Runs in every web page, for passkeys and security keys: in its top frame as
// a preload, and in the frames inside it from main (which preloads don't
// reach) as soon as each opens its page. Lit can't show macOS's passkey sheet
// (Apple gives that to approved, signed browsers only) and has no prompt of
// its own, so a site's request would wait forever with nothing on screen.
// Unless the Security Keys setting is on, main starts Chromium without
// PublicKeyCredential, and sites that look for it offer another way to sign
// in. Chromium's get and create still take such a request, so here they refuse
// it, as when someone cancels. With the setting on, only a request no security
// key could answer is refused. Sandboxed, so it can require nothing but
// electron. Tested in test/passkeys.test.js.

// Runs among the page's own scripts, so it can use nothing outside itself.
function refusePasskeys() {
  // Insecure pages have none of it.
  if (typeof CredentialsContainer === 'undefined') return
  const keysOn = typeof PublicKeyCredential !== 'undefined'
  // On this device or a phone, and not on a key.
  const isPasskey = ({ transports }) => transports?.length > 0 && transports.every((transport) => transport === 'internal' || transport === 'hybrid')
  // Conditional requests list passkeys in a login field, which Lit has not.
  const takesKey = ({ mediation, publicKey: { authenticatorSelection, allowCredentials } }) =>
    mediation !== 'conditional' &&
    authenticatorSelection?.authenticatorAttachment !== 'platform' &&
    !(allowCredentials?.length && allowCredentials.every(isPasskey))
  for (const name of ['get', 'create']) {
    const real = CredentialsContainer.prototype[name]
    const { [name]: value } = {
      async [name](...args) {
        if (!args[0]?.publicKey || (keysOn && takesKey(args[0]))) return real.apply(this, args)
        throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
      },
    }
    Object.defineProperty(CredentialsContainer.prototype, name, { value })
  }
}

if (typeof window !== 'undefined') require('electron').contextBridge.executeInMainWorld({ func: refusePasskeys })
else module.exports = { refusePasskeys }
