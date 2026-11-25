// Screen sharing: what the picker (src/share.html) lists, and what a choice
// grants. Plain Node, so it is tested in test/share.test.js; main opens the
// picker and answers the site (see askShare).

// The picker's windows and screens, from desktopCapturer's sources. A window
// without a title is none anyone would know, so it is left out.
function sourceRows(sources) {
  const rows = { windows: [], screens: [] }
  for (const { id, name, thumbnail, appIcon } of sources) {
    const screen = id.startsWith('screen:')
    if (!screen && !name.trim()) continue
    rows[screen ? 'screens' : 'windows'].push({
      id,
      name,
      thumbnail: thumbnail && !thumbnail.isEmpty() ? thumbnail.toDataURL() : null,
      icon: appIcon && !appIcon.isEmpty() ? appIcon.toDataURL() : null,
    })
  }
  return rows
}

// What Electron is told to capture. Only a tab has sound (Electron can't
// capture the system's on macOS), which keeps playing here too.
const tabStreams = (frame, audio) => (audio ? { video: frame, audio: frame, enableLocalEcho: true } : { video: frame })
const sourceStreams = ({ id, name }) => ({ video: { id, name } })

module.exports = { sourceRows, tabStreams, sourceStreams }
