// Cookies, for the Cookies section of Settings: a profile's cookies grouped
// by the domain they belong to, and which ones a removal names. Main reads
// and removes them through the profile's session (see cookiesState in main).
// Plain Node, so it is tested in test/cookies.test.js.

// Longer values are cut, so a list of thousands stays small to send.
const VALUE_LIMIT = 200

// The domain a cookie belongs to, without the dot a domain cookie has.
const domainOf = (cookie) => String(cookie.domain || '').replace(/^\./, '').toLowerCase()
// Whether a cookie is only its host's, not also its subdomains'. Chromium
// keeps a domain cookie's domain with a dot.
const isHostOnly = (cookie) => !String(cookie.domain || '').startsWith('.')

// Sorts by labels from the right, so accounts.google.com follows google.com
// instead of landing among the a's.
const sortKey = (domain) => domain.split('.').reverse().join('.')

// [{ domain, cookies: [{ name, value, path, hostOnly, expires, secure, httpOnly }] }]:
// `expires` is in ms since 1970, or null for one kept only until Lit quits.
// A host's own cookies and its domain cookies share one domain, so one name
// and path can be there twice, told apart by `hostOnly`.
function list(cookies) {
  const domains = new Map()
  for (const cookie of cookies) {
    const domain = domainOf(cookie)
    if (!domain) continue
    if (!domains.has(domain)) domains.set(domain, [])
    const value = String(cookie.value ?? '')
    domains.get(domain).push({
      name: String(cookie.name ?? ''),
      value: value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT)}…` : value,
      path: cookie.path || '/',
      hostOnly: isHostOnly(cookie),
      expires: cookie.session || !Number.isFinite(cookie.expirationDate) ? null : Math.round(cookie.expirationDate * 1000),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    })
  }
  return [...domains]
    .sort(([a], [b]) => sortKey(a).localeCompare(sortKey(b)))
    .map(([domain, items]) => ({ domain, cookies: items.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path) || b.hostOnly - a.hostOnly) }))
}

// Whether `target` names something to remove: a domain's cookies
// ({ domain }), or one of them ({ domain, name, path, hostOnly }).
const isTarget = (target) => typeof target?.domain === 'string' && Boolean(target.domain) && (target.name === undefined
  ? target.path === undefined && target.hostOnly === undefined
  : typeof target.name === 'string' && typeof target.path === 'string' && typeof target.hostOnly === 'boolean')

// The cookies in `cookies` that `target` names, none if it names nothing.
function pick(cookies, target) {
  if (!isTarget(target)) return []
  return cookies.filter((cookie) => domainOf(cookie) === target.domain &&
    (target.name === undefined || (cookie.name === target.name && (cookie.path || '/') === target.path && isHostOnly(cookie) === target.hostOnly)))
}

// The address Electron's cookies.remove and cookies.set take for a cookie:
// one it is sent to. Always https, which every cookie is sent to, and from
// which Chromium lets a cookie be set even beside a secure one of its name.
const urlOf = (cookie) => `https://${domainOf(cookie)}${cookie.path || '/'}`

// Chromium's identity for a cookie: its domain as stored (a domain cookie
// keeps its dot), path and name.
const keyOf = (cookie) => `${cookie.domain}\n${cookie.path || '/'}\n${cookie.name}`

// Electron removes every cookie of that name sent to the address, so
// removing `sid` at /app also takes `sid` at /, and a host's takes its
// domain cookie of that name. These are the cookies in `before` with a
// name in `named` that went but were not named, to put back. Only those
// names, so a cookie a site or another removal took meanwhile stays gone.
function lost(before, named, after) {
  const names = new Set(named.map((cookie) => cookie.name))
  const keep = new Set([...named, ...after].map(keyOf))
  return before.filter((cookie) => names.has(cookie.name) && !keep.has(keyOf(cookie)))
}

// What cookies.set takes to put `cookie` back as it was.
function detailsOf(cookie) {
  return {
    url: urlOf(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    // Without a domain, a cookie is the host's own again.
    ...(!isHostOnly(cookie) && { domain: cookie.domain }),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    ...(cookie.sameSite && { sameSite: cookie.sameSite }),
    ...(!cookie.session && Number.isFinite(cookie.expirationDate) && { expirationDate: cookie.expirationDate }),
  }
}

module.exports = { VALUE_LIMIT, domainOf, isHostOnly, list, isTarget, pick, urlOf, lost, detailsOf }
