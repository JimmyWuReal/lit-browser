// The words on the page shown in place of one that failed to load or
// crashed, drawn by the toolbar (index.html). Plain Node, so it is tested in
// test/errors.test.js; main decides when a tab has an error.
//
// An error is one of:
//   { kind: 'load', name }          Chromium couldn't load it; `name` is like
//                                   'ERR_NAME_NOT_RESOLVED'
//   { kind: 'http', status }        the site answered with an HTTP error and
//                                   nothing to show
//   { kind: 'crash', reason, exitCode }  its process ended, from Electron's
//                                   render-process-gone

const UNREACHABLE = 'This site can’t be reached'
const NOT_PRIVATE = 'This connection isn’t private'
const NOT_WORKING = 'This page isn’t working'

// The failures with words of their own, the first matching pattern winning:
// [pattern, title, detail], `detail` getting the site's name.
const LOAD = [
  [/^ERR_INTERNET_DISCONNECTED$/, 'You’re offline', () => 'Check your network connection, then try again.'],
  [/^ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_.+)$/, UNREACHABLE, (site) => `The server for ${site} couldn’t be found. Check the address for typos.`],
  [/^ERR_CONNECTION_REFUSED$/, UNREACHABLE, (site) => `${site} refused to connect.`],
  [/^ERR_(CONNECTION_)?TIMED_OUT$/, UNREACHABLE, (site) => `${site} took too long to respond.`],
  [/^ERR_(CONNECTION_(RESET|CLOSED|ABORTED)|SOCKET_NOT_CONNECTED)$/, UNREACHABLE, (site) => `The connection to ${site} was interrupted.`],
  [/^ERR_(ADDRESS_UNREACHABLE|CONNECTION_FAILED)$/, UNREACHABLE, (site) => `${site} is unreachable from this network.`],
  [/^ERR_NETWORK_CHANGED$/, 'Your network changed', () => 'The connection was interrupted. Try again.'],
  [/^ERR_(PROXY_.+|TUNNEL_.+|.+_PROXY_.+)$/, 'Can’t connect to the proxy', () => 'Check your network’s proxy settings, then try again.'],
  [/^ERR_CERT_DATE_INVALID$/, NOT_PRIVATE, (site) => `The security certificate of ${site} has expired or isn’t valid yet. Your computer’s clock could also be wrong.`],
  [/^ERR_CERT_COMMON_NAME_INVALID$/, NOT_PRIVATE, (site) => `The security certificate sent for ${site} belongs to another site. Someone could be trying to read what you send.`],
  [/^ERR_(CERT_.+|CERTIFICATE_.+|SSL_PINNED_KEY_.+)$/, NOT_PRIVATE, (site) => `Lit doesn’t trust the security certificate of ${site}. Someone could be trying to read what you send.`],
  [/^ERR_((SSL|ECH)_.+|BAD_SSL_.+)$/, 'Can’t connect securely', (site) => `A secure connection to ${site} couldn’t be made.`],
  [/^ERR_TOO_MANY_REDIRECTS$/, NOT_WORKING, (site) => `${site} redirected too many times.`],
  [/^ERR_EMPTY_RESPONSE$/, NOT_WORKING, (site) => `${site} didn’t send any data.`],
  [/^ERR_(INVALID_(HTTP_)?RESPONSE|RESPONSE_HEADERS_.+|HTTP2_.+|QUIC_.+|CONTENT_DECODING_.+)$/, NOT_WORKING, (site) => `${site} sent a response Lit couldn’t read.`],
  [/^ERR_CACHE_MISS$/, 'This page needs a form sent again', () => 'It came from a form you sent, and isn’t kept. Trying again opens its address without sending the form.'],
  [/^ERR_FILE_NOT_FOUND$/, 'This file can’t be found', () => 'It may have been moved, renamed or deleted.'],
  [/^ERR_ACCESS_DENIED$/, 'This file can’t be opened', () => 'Lit isn’t allowed to read it.'],
  [/^ERR_(INVALID_URL|UNKNOWN_URL_SCHEME|DISALLOWED_URL_SCHEME)$/, 'This address can’t be opened', () => 'Check it for typos.'],
  [/^ERR_UNSAFE_PORT$/, 'This address can’t be opened', () => 'Its port is one browsers don’t use, for your safety.'],
  [/^ERR_BLOCKED_BY_.+$/, 'This page was blocked', (site) => `${site} can’t be shown here.`],
]

const HTTP = {
  403: ['You can’t open this page', (site) => `${site} refused to show it.`],
  404: ['This page can’t be found', (site) => `${site} has nothing at this address.`],
  429: ['Too many requests', (site) => `${site} asked you to wait before trying again.`],
}

// The page's site, as the text names it: its host and port.
function siteOf(url) {
  try {
    return new URL(url).host || 'this address'
  } catch {
    return 'this address'
  }
}

// { title, detail, code }, `code` being what a search or a bug report needs.
function describe(error, url) {
  const site = siteOf(url)
  if (error.kind === 'crash') {
    const code = `${error.reason} (${error.exitCode})`
    if (error.reason === 'oom' || error.reason === 'memory-eviction') return { title: 'This page ran out of memory', detail: 'Closing other tabs can help. Reload to open it again.', code }
    return { title: 'This page crashed', detail: 'Something went wrong while showing it. Reload to open it again.', code }
  }
  if (error.kind === 'http') {
    const [title, detail] = HTTP[error.status] || [NOT_WORKING, (name) => `${name} ${error.status >= 500 ? 'has a problem of its own' : 'couldn’t answer this request'}.`]
    return { title, detail: detail(site), code: `HTTP ${error.status}` }
  }
  const [, title, detail] = LOAD.find(([pattern]) => pattern.test(error.name)) || [null, 'This page can’t be opened', () => 'Something went wrong while loading it.']
  return { title, detail: detail(site), code: error.name }
}

module.exports = { describe }
