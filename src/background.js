// The new tab background: an image you choose, copied into the profile's
// folder as background-<random>.<ext>, so it stays when the original moves.
// The New tab background setting holds that file's name, or '' for none.
// Plain Node, so it is tested in test/background.test.js; main picks the
// file, sends it to the toolbar and makes the Settings preview.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// The formats Chromium draws, by extension.
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }
const EXTENSIONS = Object.keys(TYPES)
// The toolbar gets the image whole, so a huge one would slow every window.
const MAX_BYTES = 20 * 1024 * 1024

const NAME = new RegExp(`^background-[0-9a-f]{12}\\.(${EXTENSIONS.join('|')})$`)
// Whether `name` is one `adopt` could have made.
const isName = (name) => typeof name === 'string' && NAME.test(name)

const extensionOf = (file) => path.extname(file).slice(1).toLowerCase()

// Copies the image at `source` into `folder`; { name } of the copy, or
// { error }.
function adopt(folder, source) {
  const extension = extensionOf(source)
  if (!TYPES[extension]) return { error: 'Choose a PNG, JPEG, GIF, WebP or AVIF image.' }
  let size
  try {
    size = fs.statSync(source).size
  } catch {
    return { error: 'Couldn’t read that image.' }
  }
  if (size > MAX_BYTES) return { error: 'That image is over 20 MB. Choose a smaller one.' }
  const name = `background-${crypto.randomBytes(6).toString('hex')}.${extension}`
  try {
    fs.mkdirSync(folder, { recursive: true })
    fs.copyFileSync(source, path.join(folder, name))
  } catch {
    return { error: 'Couldn’t copy that image.' }
  }
  return { name }
}

// The image as { type, bytes }, or null when there is none or it is gone.
// Bytes, not a data: URL: the toolbar makes a blob: URL of them, as Chromium
// drops a CSS variable over 2 MB, which a big image's data: URL is.
function read(folder, name) {
  if (!isName(name)) return null
  try {
    return { type: TYPES[extensionOf(name)], bytes: fs.readFileSync(path.join(folder, name)) }
  } catch {
    return null
  }
}

// Deletes every background in `folder` but `keep`: the one replaced or
// removed, and any a crash left behind.
function sweep(folder, keep) {
  let names
  try {
    names = fs.readdirSync(folder)
  } catch {
    return
  }
  for (const name of names) {
    if (isName(name) && name !== keep) fs.rmSync(path.join(folder, name), { force: true })
  }
}

module.exports = { EXTENSIONS, MAX_BYTES, isName, adopt, read, sweep }
