// Runs in every web page and the frames inside it, before their own scripts,
// for passkeys and security keys (WebAuthn). Lit can't use passkeys: macOS
// shows its passkey sheet only for browsers Apple has approved and signed so.
// Left alone, Chromium also has nothing to show, and a site's request waits
// forever. So unless the Security Keys setting is on, main hides and fails
// them (see turnAwayPasskeys), except in frames from another site than their
// page's; here they are refused in any. With the setting on, only requests no
// security key could answer are. Sandboxed, so it can require nothing but
// electron. Tested in test/passkeys.test.js.

// Runs among the page's own scripts, so it can use nothing outside itself.
function refuse() {
  // Insecure pages have none of it.
  if (typeof CredentialsContainer === 'undefined') return
  const keysOn = typeof PublicKeyCredential !== 'undefined'
  // On this device or a phone, and not on a key. Lists may be other iterables,
  // even ones that can be read only once; those are left for Chromium.
  const isPasskey = (credential) => Array.isArray(credential?.transports) && credential.transports.length > 0 &&
    credential.transports.every((transport) => transport === 'internal' || transport === 'hybrid')
  // Conditional requests list passkeys in a login field, which Lit can't.
  const takesKey = ({ mediation, publicKey: { authenticatorSelection, allowCredentials } }) =>
    mediation !== 'conditional' &&
    authenticatorSelection?.authenticatorAttachment !== 'platform' &&
    !(Array.isArray(allowCredentials) && allowCredentials.length > 0 && allowCredentials.every(isPasskey))
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

if (typeof window !== 'undefined') require('electron').contextBridge.executeInMainWorld({ func: refuse })
else module.exports = { refuse }
