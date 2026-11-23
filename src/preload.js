// The only bridge between Lit's own pages (the toolbar and the Settings
// window) and the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lit', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  newTab: () => ipcRenderer.send('new-tab'),
  // `focus: false` keeps keyboard focus in the toolbar.
  closeTab: (id, focus = true) => ipcRenderer.send('close-tab', id, focus),
  activateTab: (id, focus = true) => ipcRenderer.send('activate-tab', id, focus),
  // { activeId, tabs: [{ id, title, url, favicon, loading, started }] }
  onTabs: (callback) => ipcRenderer.on('tabs', (_event, state) => callback(state)),
  onFocusAddress: (callback) => ipcRenderer.on('focus-address', () => callback()),
  openSettings: () => ipcRenderer.send('open-settings'),
  // For the Settings window only; main ignores these from anywhere else.
  // get() -> { sections, values }; set() -> the saved values.
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: (key, value) => ipcRenderer.invoke('settings-set', key, value),
  },
})
