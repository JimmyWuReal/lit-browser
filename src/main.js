// Lit's main process: one window with a toolbar on top (src/index.html)
// and the web page rendered below it in a Chromium WebContentsView.
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const path = require('node:path')

// Keep in sync with the toolbar height in index.html.
const BAR_HEIGHT = 52

// Turn whatever was typed into a URL: keep full URLs, add https:// to
// things that look like a domain, and send everything else to search.
function toUrl(input) {
  const text = input.trim()
  if (/^(https?|file|about|data|chrome):/i.test(text)) return text
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#090909',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })

  const page = new WebContentsView()
  win.contentView.addChildView(page)

  const layout = () => {
    const { width, height } = win.getContentBounds()
    page.setBounds({ x: 0, y: BAR_HEIGHT, width, height: height - BAR_HEIGHT })
  }
  layout()
  win.on('resize', layout)

  // Keep the address bar showing where the page actually is.
  const sendUrl = () => win.webContents.send('url', page.webContents.getURL())
  page.webContents.on('did-navigate', sendUrl)
  page.webContents.on('did-navigate-in-page', sendUrl)
  page.webContents.on('page-title-updated', (_event, title) => win.setTitle(title))

  // Links that open a new window load in the same view for now.
  page.webContents.setWindowOpenHandler(({ url }) => {
    page.webContents.loadURL(url)
    return { action: 'deny' }
  })

  ipcMain.on('navigate', (event, input) => {
    if (event.sender !== win.webContents || !input.trim()) return
    page.webContents.loadURL(toUrl(input)).catch(() => {})
    page.webContents.focus()
  })

  win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
