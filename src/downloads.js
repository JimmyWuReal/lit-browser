// Downloads: where one goes when Lit saves it without asking, and the words
// and numbers the toolbar indicator and the Downloads list show. Plain
// Node, so it is tested in test/downloads.test.js; main keeps the list of
// this session's downloads and turns each Electron DownloadItem into
// { id, path, state, received, total, speed, missing } for these.
//   state    'progressing', 'interrupted' (Chromium may still resume it),
//            'completed', 'cancelled' or 'failed'
//   total    0 when the server does not say
//   speed    bytes per second right now
//   missing  a completed file that is no longer where it was saved
const path = require('node:path')
const fs = require('node:fs')

// The folder, with " (1)", " (2)"... added if the name is taken, as browsers do.
function uniquePath(folder, filename, exists = fs.existsSync) {
  const { name, ext } = path.parse(filename || 'download')
  let candidate = path.join(folder, `${name}${ext}`)
  for (let n = 1; exists(candidate); n++) candidate = path.join(folder, `${name} (${n})${ext}`)
  return candidate
}

// Still on its way: running, or interrupted and waiting to resume.
const isActive = (download) => download.state === 'progressing' || download.state === 'interrupted'

// Decimal units, as Finder counts them: "840 KB", "1.6 MB", "12 MB".
function sizeLabel(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes || 0)
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++ }
  if (unit === 0) return value === 1 ? '1 byte' : `${Math.round(value)} bytes`
  // One decimal while it says something ("1.5 MB"), none once it doesn't ("240 MB").
  const digits = value < 10 ? 1 : 0
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unit]}`
}

// "5 sec left", "3 min left", "2 hr left"; rounded up, so it never says 0.
function timeLeft(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec left`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`
  return `${Math.ceil(seconds / 3600)} hr left`
}

// One row of the Downloads list: { id, name, state, progress, status }.
// `state` is 'active', 'done' or 'stopped' (cancelled, failed or moved);
// `progress` is 0–1, or null while the size is unknown or it isn't running.
function row(download) {
  const { id, received = 0, total = 0, speed = 0 } = download
  const name = path.basename(download.path) || 'download'
  const known = total > 0
  const progress = isActive(download) && known ? Math.min(1, received / total) : null
  switch (download.state) {
    case 'progressing': {
      const size = known ? `${sizeLabel(received)} of ${sizeLabel(total)}` : sizeLabel(received)
      const left = known && speed > 0 && received < total ? ` · ${timeLeft((total - received) / speed)}` : ''
      return { id, name, state: 'active', progress, status: size + left }
    }
    case 'interrupted': return { id, name, state: 'active', progress, status: 'Interrupted, waiting to resume' }
    case 'completed': return download.missing
      ? { id, name, state: 'stopped', progress: null, status: 'Moved or deleted' }
      : { id, name, state: 'done', progress: null, status: sizeLabel(total || received) }
    case 'cancelled': return { id, name, state: 'stopped', progress: null, status: 'Cancelled' }
    default: return { id, name, state: 'stopped', progress: null, status: 'Failed' }
  }
}

// What the toolbar indicator draws: { count, active, progress }.
// `count` is every download listed, `active` those still on their way, and
// `progress` their bytes so far out of their total, 0–1; null when none is
// running or one of them has no known size, so the indicator spins.
function summary(downloads) {
  const active = downloads.filter(isActive)
  let received = 0
  let total = 0
  for (const download of active) {
    if (!(download.total > 0)) return { count: downloads.length, active: active.length, progress: null }
    received += Math.min(download.received || 0, download.total)
    total += download.total
  }
  return { count: downloads.length, active: active.length, progress: total ? received / total : null }
}

module.exports = { uniquePath, isActive, sizeLabel, timeLeft, row, summary }
