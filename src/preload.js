// The only bridge between the toolbar UI and the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lit', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  onUrl: (callback) => ipcRenderer.on('url', (_event, url) => callback(url)),
})
