// Quick search: type a shortcut such as `!yt` with your search to search
// that site instead of the search engine (`!yt lofi`, or `lofi !yt`). A
// shortcut alone opens the site. Plain Node, tested in
// test/quicksearch.test.js. Each site's icon is an SVG in src/sites/.
const fs = require('node:fs')
const path = require('node:path')

// The prefixes Settings offers; a shortcut is the prefix and an alias.
const PREFIXES = ['!', '@', '#', ':', '/']

// In the order they are suggested. `search` has {query} where the encoded
// search goes; `home` opens when there is nothing to search.
const SITES = [
  { id: 'youtube', name: 'YouTube', aliases: ['yt', 'youtube'], home: 'https://www.youtube.com/', search: 'https://www.youtube.com/results?search_query={query}' },
  { id: 'wikipedia', name: 'Wikipedia', aliases: ['wiki', 'w'], home: 'https://wikipedia.org/', search: 'https://en.wikipedia.org/w/index.php?search={query}' },
  { id: 'google', name: 'Google', aliases: ['g', 'google'], home: 'https://www.google.com/', search: 'https://www.google.com/search?q={query}' },
  { id: 'duckduckgo', name: 'DuckDuckGo', aliases: ['ddg', 'duck'], home: 'https://duckduckgo.com/', search: 'https://duckduckgo.com/?q={query}' },
  { id: 'github', name: 'GitHub', aliases: ['gh', 'github'], home: 'https://github.com/', search: 'https://github.com/search?q={query}' },
  { id: 'maps', name: 'Google Maps', aliases: ['maps', 'map'], home: 'https://maps.google.com/', search: 'https://www.google.com/maps/search/{query}/', icon: 'google-maps' },
  { id: 'reddit', name: 'Reddit', aliases: ['r', 'reddit'], home: 'https://www.reddit.com/', search: 'https://www.reddit.com/search/?q={query}' },
  { id: 'x', name: 'X', aliases: ['x', 'twitter'], home: 'https://x.com/', search: 'https://x.com/search?q={query}' },
  { id: 'chatgpt', name: 'ChatGPT', aliases: ['gpt', 'chatgpt'], home: 'https://chatgpt.com/', search: 'https://chatgpt.com/?q={query}' },
  { id: 'claude', name: 'Claude', aliases: ['claude'], home: 'https://claude.ai/new', search: 'https://claude.ai/new?q={query}' },
  { id: 'perplexity', name: 'Perplexity', aliases: ['pplx', 'perplexity'], home: 'https://www.perplexity.ai/', search: 'https://www.perplexity.ai/search/new?q={query}' },
  { id: 'gemini', name: 'Gemini', aliases: ['gemini'], home: 'https://gemini.google.com/app', search: 'https://www.google.com/search?udm=50&aep=11&q={query}' },
  { id: 'grok', name: 'Grok', aliases: ['grok'], home: 'https://x.com/i/grok', search: 'https://x.com/i/grok?text={query}' },
  { id: 'stackoverflow', name: 'Stack Overflow', aliases: ['so', 'stack'], home: 'https://stackoverflow.com/', search: 'https://stackoverflow.com/search?q={query}', icon: 'stack-overflow' },
  { id: 'npm', name: 'npm', aliases: ['npm'], home: 'https://www.npmjs.com/', search: 'https://www.npmjs.com/search?q={query}' },
  { id: 'linkedin', name: 'LinkedIn', aliases: ['li', 'linkedin'], home: 'https://www.linkedin.com/', search: 'https://www.linkedin.com/search/results/all/?keywords={query}' },
  { id: 'amazon', name: 'Amazon', aliases: ['amz', 'amazon'], home: 'https://www.amazon.com/', search: 'https://www.amazon.com/s?k={query}' },
  { id: 'imdb', name: 'IMDb', aliases: ['imdb', 'movie'], home: 'https://www.imdb.com/', search: 'https://www.imdb.com/find/?q={query}' },
  { id: 'news', name: 'Google News', aliases: ['news'], home: 'https://news.google.com/', search: 'https://news.google.com/search?q={query}', icon: 'google-news' },
  { id: 'yahoo', name: 'Yahoo', aliases: ['y', 'yahoo'], home: 'https://www.yahoo.com/', search: 'https://search.yahoo.com/search?p={query}' },
]

// Each site's icon as a data: URL, so Lit's pages can show it under their
// content security policies. Read once, on first use.
let icons = null
function iconOf(site) {
  if (!icons) {
    icons = new Map(SITES.map((item) => {
      const svg = fs.readFileSync(path.join(__dirname, 'sites', `${item.icon || item.id}.svg`))
      return [item.id, `data:image/svg+xml;base64,${svg.toString('base64')}`]
    }))
  }
  return icons.get(site.id)
}

const siteFor = (alias) => SITES.find((site) => site.aliases.includes(alias.toLowerCase()))

// The site's search for `query`, or its home page when there is none.
// toWellFormed keeps half an emoji from throwing, as in src/url.js.
function urlFor(site, query = '') {
  const text = query.trim()
  return text ? site.search.replace('{query}', encodeURIComponent(text.toWellFormed())) : site.home
}

// { site, alias, query } when `input` starts or ends with a shortcut
// (`!yt lofi`, `lofi !yt`, or `!yt` alone), else null.
function parse(input, prefix = '!') {
  if (typeof input !== 'string' || !PREFIXES.includes(prefix)) return null
  const words = input.trim().split(/\s+/)
  const shortcut = (word) => word.length > prefix.length && word.startsWith(prefix) && siteFor(word.slice(prefix.length))
  for (const [at, rest] of [[0, words.slice(1)], [words.length - 1, words.slice(0, -1)]]) {
    const site = shortcut(words[at])
    if (site) return { site, alias: words[at].slice(prefix.length).toLowerCase(), query: rest.join(' ') }
  }
  return null
}

// Where `input` goes, or null when it has no shortcut.
function resolve(input, prefix = '!') {
  const found = parse(input, prefix)
  return found && urlFor(found.site, found.query)
}

// While a shortcut is half typed (`!`, `!y`, no space yet), the sites it
// could be, for the address bar to suggest: { id, name, alias, icon }, an
// exact alias first, then in SITES order, each named by its first alias
// that fits.
function complete(input, prefix = '!', limit = 6) {
  if (typeof input !== 'string' || !PREFIXES.includes(prefix) || !input.startsWith(prefix)) return []
  const typed = input.slice(prefix.length).toLowerCase()
  if (/\s/.test(typed)) return []
  const found = []
  for (const site of SITES) {
    const alias = site.aliases.find((item) => item === typed) || site.aliases.find((item) => item.startsWith(typed))
    if (alias) found.push({ site, alias, exact: alias === typed })
  }
  return found
    .sort((a, b) => b.exact - a.exact)
    .slice(0, limit)
    .map(({ site, alias }) => ({ id: site.id, name: site.name, alias, icon: iconOf(site) }))
}

// What the toolbar needs to turn a shortcut into a chip: every site, with
// its aliases and icon.
const list = () => SITES.map((site) => ({ id: site.id, name: site.name, aliases: site.aliases, icon: iconOf(site) }))

module.exports = { PREFIXES, SITES, parse, resolve, urlFor, complete, list }
