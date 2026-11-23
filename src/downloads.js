// Where a download goes when Lit saves it without asking: the folder,
// with " (1)", " (2)"... added if the name is taken, as browsers do.
const path = require('node:path')
const fs = require('node:fs')

function uniquePath(folder, filename, exists = fs.existsSync) {
  const { name, ext } = path.parse(filename || 'download')
  let candidate = path.join(folder, `${name}${ext}`)
  for (let n = 1; exists(candidate); n++) candidate = path.join(folder, `${name} (${n})${ext}`)
  return candidate
}

module.exports = { uniquePath }
