// The only bridge between the toolbar UI and the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lit', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  newTab: () => ipcRenderer.send('new-tab'),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  // `focus: false` keeps keyboard focus in the toolbar.
  activateTab: (id, focus = true) => ipcRenderer.send('activate-tab', id, focus),
  // { activeId, tabs: [{ id, title, url, favicon, loading, started }] }
  onTabs: (callback) => ipcRenderer.on('tabs', (_event, state) => callback(state)),
  onFocusAddress: (callback) => ipcRenderer.on('focus-address', () => callback()),
})
