// Render an SVG to a 1024×1024 transparent PNG with Electron's offscreen renderer.
// Usage: npx electron scripts/render-icon.js build/icon.svg build/icon.png
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const [input, output] = process.argv.slice(-2)

app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1024, transparent: true, frame: false,
    webPreferences: { offscreen: true },
  })
  win.webContents.setFrameRate(1)
  const svg = fs.readFileSync(input, 'utf8')
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  await new Promise(r => setTimeout(r, 500))
  const img = await win.webContents.capturePage()
  const png = img.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG()
  fs.writeFileSync(output, png)
  console.log('wrote', output, img.getSize())
  app.quit()
})
