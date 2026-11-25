// HTTP sign-in: a server (401) or proxy (407) asking for a username and
// password. Says which requests Lit asks about and what the prompt says.
// Plain Node, so it is tested in test/signin.test.js; main keeps the prompts
// and answers Electron.
const permissions = require('./permissions')

// What to ask for an Electron `login` event, or null to refuse it. `page` is
// the address of the page the tab is on.
// Only the host Chromium says is asking is named. The realm is the server's
// own words, so it is never shown, only told apart.
// A page being opened always asks. Anything else a page loads (frames,
// images, scripts) asks only for the site in the address bar, so no other
// site can ask for a password from inside it. A proxy is one set on this
// computer, whatever the request.
// - key: the same for requests that the same username and password answer.
// - main: whether it is the tab's page itself, at `url`.
// - retry: whether an earlier answer was wrong.
function describe({ url, isMainFrame, isRequestForNavigation, firstAuthAttempt }, { isProxy, scheme, host, port, realm }, page) {
  const main = Boolean(isMainFrame && isRequestForNavigation)
  // A WebSocket is asked as its site.
  const protocol = new URL(url).protocol.replace(/^ws/, 'http')
  const site = permissions.originOf(`${isProxy ? 'http:' : protocol}//${host}:${port}`)
  if (!site) return null
  if (!main && !isProxy && permissions.originOf(page) !== site) return null
  return {
    key: JSON.stringify([isProxy, site, scheme, realm]),
    main,
    retry: firstAuthAttempt === false,
    url: withoutCredentials(url),
    // A proxy is named with its port, as network settings do.
    name: isProxy ? `${host}:${port}` : permissions.label(site),
    proxy: isProxy,
    // Electron doesn't say how a proxy is reached, so that could be either.
    note: isProxy ? 'May not be encrypted: others on the network could read your password.'
      : protocol === 'https:' ? '' : 'Not encrypted: others on the network could read your password.',
  }
}

// Finishes "example.com …".
const asks = ({ proxy, retry }) => `${proxy ? '(your proxy) ' : ''}${retry ? 'didn’t accept that, try again' : 'wants you to sign in'}`

function withoutCredentials(url) {
  const plain = new URL(url)
  plain.username = ''
  plain.password = ''
  return plain.href
}

module.exports = { describe, asks }
