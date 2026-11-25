// PDFs show in Chromium's built-in PDF viewer, which Electron provides: the
// tab's page is a document holding the viewer, an extension frame of its own.
// Zooming that page does nothing to the PDF, so Lit's zoom commands go to the
// viewer instead. Its zoom is not public API: the scripts below reach into
// Chromium's pdf-viewer element, so an Electron update can break them. Then
// ⌘+, ⌘- and ⌘0 do nothing in a PDF, and the viewer's own buttons still work.
// Plain strings, so they are tested in test/pdf.test.js.

// The viewer's extension, the same in every Chromium.
const VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

// Whether a page is a PDF, run apart from the page's own scripts. A web page
// with a PDF inside it is not: zoom acts on the page, as in Chrome.
const IS_PDF = "document.contentType === 'application/pdf'"

// A PDF page's viewer frame, if it has loaded.
const viewerOf = (page) => page.mainFrame.frames.find((frame) => frame.origin === VIEWER)

// What the viewer runs to zoom in (1), out (-1), or back to fitting the
// window's width (0), as a PDF opens. In and out move through the viewer's
// own steps, which are Chrome's.
function zoomScript(direction) {
  const call = direction > 0 ? 'zoomIn()' : direction < 0 ? 'zoomOut()' : 'fitToWidth()'
  return `document.querySelector('pdf-viewer')?.viewport_?.${call}`
}

module.exports = { VIEWER, IS_PDF, viewerOf, zoomScript }
