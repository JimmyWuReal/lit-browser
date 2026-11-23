// What the right-click menus hold, kept apart from Electron so it can be
// tested. Each function returns a list of plain items that main turns into
// a native menu:
//   { label, command, arg?, enabled?, accelerator? }  runs `command` in main
//   { type: 'separator' }
// Separators only go between groups, never first, last or twice in a row.

// Long selections are cut short in the "Search for" label.
const SEARCH_LABEL_LENGTH = 30

// Drops leading, trailing and repeated separators left by empty groups.
function joinGroups(groups) {
  const items = []
  for (const group of groups) {
    if (!group.length) continue
    if (items.length) items.push({ type: 'separator' })
    items.push(...group)
  }
  return items
}

const isWeb = (url) => /^https?:\/\//i.test(url || '')

function quote(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SEARCH_LABEL_LENGTH ? `${flat.slice(0, SEARCH_LABEL_LENGTH - 1).trimEnd()}…` : flat
}

// The menu for a right-click inside a page, from Electron's context-menu
// `params`. `context` says what else applies:
//   isPage         false for Lit's own toolbar and Settings, which only get
//                  the editing items
//   canGoBack, canGoForward
//   engineName     the search engine's name, for "Search Google for …"
//   askWhereToSave whether downloads ask where to save (the Downloads setting)
//   keys           { reload, back, forward }: the current accelerators, shown
//                  next to those items
function pageMenu(params, context = {}) {
  const { isPage = true, canGoBack = false, canGoForward = false, engineName = 'Google', askWhereToSave = true, keys = {} } = context
  const flags = params.editFlags || {}
  const selection = (params.selectionText || '').trim()
  const groups = []

  // Spelling suggestions come first, as in other Mac apps.
  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).map((word) => ({ label: word, command: 'replaceMisspelling', arg: word }))
    groups.push([
      ...(suggestions.length ? suggestions : [{ label: 'No Guesses Found', enabled: false }]),
      { label: 'Add to Dictionary', command: 'addToDictionary', arg: params.misspelledWord },
    ])
  }

  // Only web addresses open or download: not javascript: or mailto: links,
  // nor file: ones, which a web page must not be able to open.
  if (isPage && params.linkURL) {
    groups.push([
      ...(isWeb(params.linkURL) ? [
        { label: 'Open Link in New Tab', command: 'openInNewTab', arg: params.linkURL },
        { label: askWhereToSave ? 'Save Link As…' : 'Download Linked File', command: 'download', arg: params.linkURL },
      ] : []),
      { label: 'Copy Link Address', command: 'copyText', arg: params.linkURL },
    ])
  }

  // Images, videos and audio: opening, saving and copying the address need
  // a web address (not a data: or blob: one, which another tab cannot
  // open); copying an image needs only its drawn pixels.
  const media = { image: 'Image', video: 'Video', audio: 'Audio' }[params.mediaType]
  if (isPage && media) {
    const web = isWeb(params.srcURL)
    groups.push([
      ...(web ? [
        { label: `Open ${media} in New Tab`, command: 'openInNewTab', arg: params.srcURL },
        { label: askWhereToSave ? `Save ${media} As…` : `Download ${media}`, command: 'download', arg: params.srcURL },
      ] : []),
      ...(media === 'Image' && params.hasImageContents ? [{ label: 'Copy Image', command: 'copyImage' }] : []),
      ...(web ? [{ label: `Copy ${media} Address`, command: 'copyText', arg: params.srcURL }] : []),
    ])
  }

  if (params.isEditable) {
    groups.push(
      [
        { label: 'Undo', command: 'undo', enabled: Boolean(flags.canUndo), accelerator: 'CmdOrCtrl+Z' },
        { label: 'Redo', command: 'redo', enabled: Boolean(flags.canRedo), accelerator: 'Shift+CmdOrCtrl+Z' },
      ],
      [
        { label: 'Cut', command: 'cut', enabled: Boolean(flags.canCut), accelerator: 'CmdOrCtrl+X' },
        { label: 'Copy', command: 'copy', enabled: Boolean(flags.canCopy), accelerator: 'CmdOrCtrl+C' },
        { label: 'Paste', command: 'paste', enabled: Boolean(flags.canPaste), accelerator: 'CmdOrCtrl+V' },
        { label: 'Select All', command: 'selectAll', enabled: Boolean(flags.canSelectAll), accelerator: 'CmdOrCtrl+A' },
      ],
    )
  } else if (selection) {
    groups.push([{ label: 'Copy', command: 'copy', accelerator: 'CmdOrCtrl+C' }])
  }

  if (isPage && selection) {
    groups.push([{ label: `Search ${engineName} for “${quote(selection)}”`, command: 'search', arg: selection }])
  }

  // A right-click on nothing in particular acts on the page itself.
  if (isPage && !groups.some((group) => group.length)) {
    groups.push([
      { label: 'Back', command: 'back', enabled: canGoBack, accelerator: keys.back },
      { label: 'Forward', command: 'forward', enabled: canGoForward, accelerator: keys.forward },
      { label: 'Reload', command: 'reload', accelerator: keys.reload },
    ])
  }

  if (isPage) groups.push([{ label: 'Inspect Element', command: 'inspect' }])
  return joinGroups(groups)
}

// The menu for a right-click on a tab, the `index`th of `count`.
// `started` is false for a tab still showing the search box. `keys`
// ({ reload, closeTab }) are the current accelerators, shown as in Chrome.
function tabMenu({ index, count, started, keys = {} }) {
  return joinGroups([
    [
      { label: 'Reload', command: 'reload', enabled: Boolean(started), accelerator: keys.reload },
      { label: 'Duplicate', command: 'duplicate' },
    ],
    [
      { label: 'Close Tab', command: 'close', accelerator: keys.closeTab },
      { label: 'Close Other Tabs', command: 'closeOthers', enabled: count > 1 },
      { label: 'Close Tabs to the Right', command: 'closeToRight', enabled: index < count - 1 },
    ],
  ])
}

module.exports = { pageMenu, tabMenu }
