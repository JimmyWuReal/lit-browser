// Search engines the address bar can use. Settings offers these by name.
const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
}

// Turn whatever was typed into a URL: keep full URLs, add https:// to
// things that look like a domain, and send everything else to search, such
// as what only looks like an address (http://, example.com:99999).
function toUrl(input, engine = 'google') {
  const url = addressOf(input.trim())
  return url && URL.canParse(url) ? url : searchUrl(input, engine)
}

function addressOf(text) {
  if (/^(https?|file|about|data|chrome):/i.test(text)) return text
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return null
}

// The engine, falling back to Google for an unknown one.
const engineOf = (engine) => (Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google)

// A search for `text`, even when it looks like an address. A selection can
// end halfway through an emoji; toWellFormed keeps that from throwing.
function searchUrl(text, engine = 'google') {
  return `${engineOf(engine).url}${encodeURIComponent(text.trim().toWellFormed())}`
}

// An address another app asks Lit to open, as it is, or null for one that is
// not a web address: nothing else (javascript:, chrome:) is let in from outside.
const webAddress = (url) => (/^https?:/i.test(url) && URL.canParse(url) ? url : null)

module.exports = { toUrl, webAddress, searchUrl, engineOf, SEARCH_ENGINES }
