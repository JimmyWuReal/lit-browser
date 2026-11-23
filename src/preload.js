// The only bridge between Lit's own pages (the toolbar and the Settings
// popup) and the main process.
const { contextBridge, ipcRenderer } = require('electron')

const on = (channel, callback) => ipcRenderer.on(channel, (_event, value) => callback(value))

contextBridge.exposeInMainWorld('lit', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  newTab: () => ipcRenderer.send('new-tab'),
  // `focus: false` keeps keyboard focus in the toolbar.
  closeTab: (id, focus = true) => ipcRenderer.send('close-tab', id, focus),
  activateTab: (id, focus = true) => ipcRenderer.send('activate-tab', id, focus),
  // { activeId, tabs: [{ id, title, url, favicon, loading, started, zoom }] },
  // `zoom` being '125%', or '' at the default zoom.
  onTabs: (callback) => on('tabs', callback),
  onFocusAddress: (callback) => ipcRenderer.on('focus-address', () => callback()),
  openSettings: () => ipcRenderer.send('open-settings'),
  // Puts the active page back at the default zoom.
  resetZoom: () => ipcRenderer.send('reset-zoom'),
  // { 'shortcuts.newTab': '⌘T', ... }, '' for a command without one.
  onShortcuts: (callback) => on('shortcuts', callback),
  // For the Settings popup only; main ignores these from anywhere else.
  // State is { sections, values, labels, error? } (see settingsState in main).
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: (key, value) => ipcRenderer.invoke('settings-set', key, value),
    close: () => ipcRenderer.send('settings-close'),
    // While on, key presses come back through onShortcutPressed as
    // { accelerator } ('' clears) or { cancel: true }, not to the menu.
    // `layout` is the keyboard's { code: character } map.
    record: (on, layout) => ipcRenderer.send('settings-record', on, layout),
    onShortcutPressed: (callback) => on('shortcut-pressed', callback),
    onOpen: (callback) => on('settings-open', callback),
    onChanged: (callback) => on('settings-changed', callback),
  },
})
