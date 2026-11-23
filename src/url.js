// Turn whatever was typed into a URL: keep full URLs, add https:// to
// things that look like a domain, and send everything else to search.
function toUrl(input) {
  const text = input.trim()
  if (/^(https?|file|about|data|chrome):/i.test(text)) return text
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

module.exports = { toUrl }
