// What the right-click menus hold, kept apart from Electron so it can be
// tested. Each function returns a list of plain items that main turns into
// a native menu:
//   { label, command, arg?, enabled?, accelerator? }  runs `command` in main
//   { type: 'separator' }
// Separators only go between groups, never first, last or twice in a row.

// Long selections are cut short in the "Search for" label.
const SEARCH_LABEL_LENGTH = 30
// So are page titles in the Back and Forward menus, which list this many.
const PAGE_LABEL_LENGTH = 60
const MENU_PAGES = 15

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
// Media a page can save: web addresses, and its own data: and blob: ones.
// Never file: ones, which a web page must not reach.
const isSavable = (url) => isWeb(url) || /^(data|blob):/i.test(url || '')

function cut(text, length) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat
}
const quote = (text) => cut(text, SEARCH_LABEL_LENGTH)

// The menu for a right-click inside a page, from Electron's context-menu
// `params`. `context` says what else applies:
//   isPage         false for Lit's own toolbar and Settings, which only get
//                  the editing items
//   canGoBack, canGoForward
//   engineName     the search engine's name, for "Search Google for …"
//   askWhereToSave whether downloads ask where to save (the Downloads setting)
//   keys           { reload, back, forward, print }: the current accelerators, shown
//                  next to those items
//   inSubframe     whether the right-click was inside an iframe
//   isPrivate      a private window: no Add to Dictionary, whose words
//                  would outlast it, and no Inspect Element, as DevTools
//                  saves its state to disk
function pageMenu(params, context = {}) {
  const { isPage = true, canGoBack = false, canGoForward = false, engineName = 'Google', askWhereToSave = true, keys = {}, inSubframe = false, isPrivate = false } = context
  const flags = params.editFlags || {}
  const selection = (params.selectionText || '').trim()
  const groups = []

  // Spelling suggestions come first, as in other Mac apps.
  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).map((word) => ({ label: word, command: 'replaceMisspelling', arg: word }))
    groups.push([
      ...(suggestions.length ? suggestions : [{ label: 'No Guesses Found', enabled: false }]),
      ...(!isPrivate ? [{ label: 'Add to Dictionary', command: 'addToDictionary', arg: params.misspelledWord }] : []),
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

  // Images, videos and audio. Only a web address opens in a new tab (a
  // data: or blob: one belongs to its page). Images save from any of
  // isSavable's addresses, since the page itself downloads them; videos and
  // audio only when Chromium also says so (not streams). Copying an image needs its drawn pixels, and
  // Electron only copies from the top frame, so not inside an iframe.
  const media = { image: 'Image', video: 'Video', audio: 'Audio' }[params.mediaType]
  if (isPage && media) {
    const src = params.srcURL || ''
    const canSave = isSavable(src) && (media === 'Image' || Boolean(params.mediaFlags?.canSave))
    groups.push([
      ...(isWeb(src) ? [{ label: `Open ${media} in New Tab`, command: 'openInNewTab', arg: src }] : []),
      ...(canSave ? [{ label: askWhereToSave ? `Save ${media} As…` : `Download ${media}`, command: 'download', arg: src }] : []),
      ...(media === 'Image' && params.hasImageContents && !inSubframe ? [{ label: 'Copy Image', command: 'copyImage' }] : []),
      ...(src ? [{ label: `Copy ${media} Address`, command: 'copyText', arg: src }] : []),
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
    ], [
      { label: 'Print…', command: 'print', accelerator: keys.print },
    ])
  }

  if (isPage && !isPrivate) groups.push([{ label: 'Inspect Element', command: 'inspect' }])
  return joinGroups(groups)
}

// The menu for a right-click on a tab, the `index`th of `count`.
// `started` is false for a tab still showing the search box. `split` says
// whether the tab is in the window's split view, which it can then close,
// else open beside the active tab (`active`: beside a new tab). `keys`
// ({ reload, duplicateTab, muteTab, splitView, closeTab, closeOtherTabs,
// closeTabsToRight }) are the current accelerators, shown next to their
// items; Split View's only on the active tab, the one its shortcut acts on.
function tabMenu({ index, count, started, muted = false, split = false, active = false, keys = {} }) {
  return joinGroups([
    [
      { label: 'Reload', command: 'reload', enabled: Boolean(started), accelerator: keys.reload },
      { label: 'Duplicate', command: 'duplicate', accelerator: keys.duplicateTab },
      { label: muted ? 'Unmute Tab' : 'Mute Tab', command: 'mute', accelerator: keys.muteTab },
    ],
    [split
      ? { label: 'Close Split View', command: 'unsplit', accelerator: active ? keys.splitView : undefined }
      : { label: 'Open in Split View', command: 'split', accelerator: active ? keys.splitView : undefined }],
    [
      { label: 'Close Tab', command: 'close', accelerator: keys.closeTab },
      { label: 'Close Other Tabs', command: 'closeOthers', enabled: count > 1, accelerator: keys.closeOtherTabs },
      { label: 'Close Tabs to the Right', command: 'closeToRight', enabled: index < count - 1, accelerator: keys.closeTabsToRight },
    ],
  ])
}

// The menu of the toolbar's Back (`direction` -1) or Forward (1) button: the
// pages that way in a back/forward list, { entries, index }, the nearest
// first. Each item's arg is the entry's index.
function navigationMenu({ entries, index }, direction) {
  const pages = entries.map(({ title, url }, at) => ({ label: cut(title || url, PAGE_LABEL_LENGTH), command: 'go', arg: at }))
  const ahead = direction < 0 ? pages.slice(0, index).reverse() : pages.slice(index + 1)
  return ahead.slice(0, MENU_PAGES)
}

// The menu for a right-click on the bookmark bar or in one of its lists:
// on a page, on a folder (`count` pages in it), or, with no `kind`, on the
// bar itself. `key` is Show Bookmark Bar's accelerator.
function bookmarkMenu({ kind, count = 0, key } = {}) {
  const create = [
    { label: 'Add Page…', command: 'addPage' },
    { label: 'Add Folder…', command: 'addFolder' },
  ]
  const bar = [{ label: 'Hide Bookmark Bar', command: 'hideBar', accelerator: key }]
  if (kind === 'page') {
    return joinGroups([
      [
        { label: 'Open in New Tab', command: 'openInNewTab' },
        { label: 'Open in New Window', command: 'openInNewWindow' },
        { label: 'Open in Private Window', command: 'openInPrivateWindow' },
      ],
      [{ label: 'Copy Address', command: 'copyAddress' }],
      [{ label: 'Edit…', command: 'edit' }, { label: 'Delete', command: 'delete' }],
      create,
      bar,
    ])
  }
  if (kind === 'folder') {
    return joinGroups([
      [{ label: `Open All in New Tabs (${count})`, command: 'openAll', enabled: count > 0 }],
      [{ label: 'Rename…', command: 'edit' }, { label: 'Delete', command: 'delete' }],
      create,
      bar,
    ])
  }
  return joinGroups([create, bar])
}

module.exports = { pageMenu, tabMenu, navigationMenu, bookmarkMenu }
