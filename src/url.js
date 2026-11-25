// Search engines the address bar can use. Settings offers these by name.
const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
}

// Turn whatever was typed into a URL: keep full URLs, add https:// to
// things that look like a domain, and send everything else to search.
function toUrl(input, engine = 'google') {
  const text = input.trim()
  if (/^(https?|file|about|data|chrome):/i.test(text)) return text
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return searchUrl(text, engine)
}

// The engine, falling back to Google for an unknown one.
const engineOf = (engine) => (Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google)

// A search for `text`, even when it looks like an address. A selection can
// end halfway through an emoji; toWellFormed keeps that from throwing.
function searchUrl(text, engine = 'google') {
  return `${engineOf(engine).url}${encodeURIComponent(text.trim().toWellFormed())}`
}

// How the address bar draws a page's address while it isn't being edited:
// { before, host, after }, the host standing out. Without `full`, what says
// little is left out: https://, www. and a lone slash; http:// stays, since
// it says the page isn't encrypted. Null for an address shown as it is: not
// a web one, or one with a user name, which could pass for the host.
function addressParts(url, full = false) {
  if (!URL.canParse(url)) return null
  const { protocol, username, password, host, pathname, search, hash } = new URL(url)
  if (!/^https?:$/.test(protocol) || username || password) return null
  const after = pathname + search + hash
  if (full) return { before: `${protocol}//`, host, after }
  return {
    before: protocol === 'https:' ? '' : 'http://',
    // Not from www.com itself.
    host: host.replace(/^www\.(?=[^.]+\.)/, ''),
    after: after === '/' ? '' : after,
  }
}

module.exports = { toUrl, searchUrl, engineOf, addressParts, SEARCH_ENGINES }
