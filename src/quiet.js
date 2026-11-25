// Keeps a copy of Lit run from source out of sight, so agents can test it while
// someone works on the same Mac: it has no Dock icon, its windows are never
// shown, and nothing in Lit or a script driving it brings it forward. Hidden
// windows still draw, take input events and can be captured. `npm start` and
// `npm run dev` set LIT_FOREGROUND to run it normally; the built app always
// does. Main requires this before it makes a window.
const { app, BrowserWindow } = require('electron')

const quiet = process.platform === 'darwin' && !app.isPackaged && !process.env.LIT_FOREGROUND

if (quiet) {
  app.setActivationPolicy('accessory')
  // Without this, hidden windows don't draw.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.focus = app.show = () => {}
  for (const name of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[name] = () => {}
}

module.exports = { quiet }
