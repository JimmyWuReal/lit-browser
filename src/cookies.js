// Cookies, for the Cookies section of Settings: a profile's cookies grouped
// by the domain they belong to, and which ones a removal names. Main reads
// and removes them through the profile's session (see cookiesState in main).
// Plain Node, so it is tested in test/cookies.test.js.

// Longer values are cut, so a list of thousands stays small to send.
const VALUE_LIMIT = 200

// The domain a cookie belongs to, without the dot a domain cookie has.
const domainOf = (cookie) => String(cookie.domain || '').replace(/^\./, '').toLowerCase()

// Sorts by labels from the right, so accounts.google.com follows google.com
// instead of landing among the a's.
const sortKey = (domain) => domain.split('.').reverse().join('.')

// [{ domain, cookies: [{ name, value, path, expires, secure, httpOnly }] }]:
// `expires` is in ms since 1970, or null for one kept only until Lit quits.
// A host's own cookies and its domain cookies share one domain.
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
      expires: cookie.session || !Number.isFinite(cookie.expirationDate) ? null : Math.round(cookie.expirationDate * 1000),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    })
  }
  return [...domains]
    .sort(([a], [b]) => sortKey(a).localeCompare(sortKey(b)))
    .map(([domain, items]) => ({ domain, cookies: items.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)) }))
}

// Whether `target` names something to remove: a domain's cookies
// ({ domain }), or one of them ({ domain, name, path }).
const isTarget = (target) => typeof target?.domain === 'string' && Boolean(target.domain) &&
  (target.name === undefined ? target.path === undefined : typeof target.name === 'string' && typeof target.path === 'string')

// The cookies in `cookies` that `target` names, none if it names nothing.
function pick(cookies, target) {
  if (!isTarget(target)) return []
  return cookies.filter((cookie) => domainOf(cookie) === target.domain &&
    (target.name === undefined || (cookie.name === target.name && (cookie.path || '/') === target.path)))
}

// The address Electron's cookies.remove takes for a cookie: one it would be
// sent to, so https for a secure one.
const urlOf = (cookie) => `${cookie.secure ? 'https' : 'http'}://${domainOf(cookie)}${cookie.path || '/'}`

module.exports = { VALUE_LIMIT, domainOf, list, isTarget, pick, urlOf }
