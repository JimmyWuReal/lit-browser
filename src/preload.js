// The only bridge between Lit's own pages (the toolbar, the address bar's
// suggestions, and the Settings, History and Downloads popups) and the
// main process.
const { contextBridge, ipcRenderer } = require('electron')

const on = (channel, callback) => ipcRenderer.on(channel, (_event, value) => callback(value))

contextBridge.exposeInMainWorld('lit', {
  navigate: (input) => ipcRenderer.send('navigate', input),
  newTab: () => ipcRenderer.send('new-tab'),
  // `focus: false` keeps keyboard focus in the toolbar.
  closeTab: (id, focus = true) => ipcRenderer.send('close-tab', id, focus),
  activateTab: (id, focus = true) => ipcRenderer.send('activate-tab', id, focus),
  // { activeId, tabs: [{ id, title, url, favicon, loading, started, find, zoom, prompt }] },
  // `zoom` being '125%', or '' at the default zoom, and `prompt` the tab's
  // permission request, { id, site, kinds, does }, or undefined.
  onTabs: (callback) => on('tabs', callback),
  onFocusAddress: (callback) => ipcRenderer.on('focus-address', () => callback()),
  openSettings: () => ipcRenderer.send('open-settings'),
  openDownloads: () => ipcRenderer.send('open-downloads'),
  // The downloads indicator: { count, active, progress }, `progress` being
  // 0–1, or null while none is running or one has no known size.
  onDownloads: (callback) => on('downloads', callback),
  // Answers a permission prompt: 'allow', 'block', or null to dismiss it.
  // `kinds` is what the prompt showed, so a stale answer is ignored.
  answerPermission: (tabId, promptId, kinds, choice) => ipcRenderer.send('answer-permission', tabId, promptId, kinds, choice),
  // Puts the active page back at the default zoom.
  resetZoom: () => ipcRenderer.send('reset-zoom'),
  // Find in page, on the tab the toolbar shows (main ignores a tab that is
  // no longer active). Its state comes with onTabs as tab.find:
  // { text, active, matches } or null while closed.
  find: (tabId, text) => ipcRenderer.send('find', tabId, text),
  findAgain: (tabId, forward = true) => ipcRenderer.send('find-again', tabId, forward),
  closeFind: (tabId) => ipcRenderer.send('close-find', tabId),
  onFocusFind: (callback) => ipcRenderer.on('focus-find', () => callback()),
  // Address bar suggestions. `suggest` shows what fits `text` under the
  // field and answers with it: quick search sites for a half-typed
  // shortcut, [{ kind: 'site', id, name, alias, icon, shortcut }], else bookmarks and
  // pages from history, [{ url, title, bookmarked? }] ([] when none match or both are off); `rect` is { x, y, width },
  // where the list goes. `selectSuggestion` highlights one (-1 for none).
  suggest: (text, rect) => ipcRenderer.invoke('suggest', text, rect),
  selectSuggestion: (index) => ipcRenderer.send('suggestions-select', index),
  // `blur` when the field lost focus, maybe to a click on the list.
  closeSuggestions: (blur = false) => ipcRenderer.send('suggestions-close', blur),
  // Quick search: { prefix, sites: [{ id, name, aliases, icon }] }, or
  // null while it is off. onQuickSearchPick is a site clicked in the
  // suggestions, { id, alias }, to show as the field's chip.
  onQuickSearch: (callback) => on('quick-search', callback),
  onQuickSearchPick: (callback) => on('quick-search-pick', callback),
  // The right-click menu for a tab.
  showTabMenu: (id) => ipcRenderer.send('tab-menu', id),
  // { 'shortcuts.newTab': '⌘T', ... }, '' for a command without one.
  onShortcuts: (callback) => on('shortcuts', callback),
  // The bookmark bar: { visible, items } (see src/bookmarks.js).
  onBookmarks: (callback) => on('bookmarks', callback),
  // Bookmarks the active page, or edits its bookmark.
  bookmarkPage: () => ipcRenderer.send('bookmark-page'),
  // Opens a bookmark here, or (`newTab`) in a new tab.
  openBookmark: (id, newTab = false) => ipcRenderer.send('bookmark-open', id, newTab),
  // The right-click menu for a bookmark or folder, or (null) the bar. `at`
  // ({ x, y }, in the window) is where a form it opens goes.
  showBookmarkMenu: (id, at) => ipcRenderer.send('bookmark-menu', id, at),
  // Into a folder (null for the bar), before another item there or last.
  moveBookmark: (id, folderId, beforeId) => ipcRenderer.send('bookmark-move', id, folderId, beforeId),
  // Lists what is in a folder, or (an array of ids) the bookmarks that do
  // not fit the bar, at `at`.
  listBookmarks: (folderOrIds, at) => ipcRenderer.send('bookmark-list', folderOrIds, at),
  // For the Bookmarks popup only: a list of bookmarks, or the form that
  // edits one (see bookmarksState in main).
  bookmarks: {
    get: () => ipcRenderer.invoke('bookmarks-get'),
    // { title, url?, folderId? }; answers { error } when it can't be saved.
    save: (values) => ipcRenderer.invoke('bookmarks-save', values),
    remove: () => ipcRenderer.send('bookmarks-remove'),
    close: () => ipcRenderer.send('bookmarks-close'),
    onOpen: (callback) => on('bookmarks-open', callback),
    onChanged: (callback) => on('bookmarks-changed', callback),
  },
  // For the Settings popup only; main ignores these from anywhere else.
  // State is { sections, values, labels, sitePermissions, error? } (see
  // settingsState in main).
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: (key, value) => ipcRenderer.invoke('settings-set', key, value),
    // A site's choice for one kind: 'allow', 'block', or null to forget it.
    setPermission: (site, kind, choice) => ipcRenderer.invoke('permissions-set', site, kind, choice),
    close: () => ipcRenderer.send('settings-close'),
    // While on, key presses come back through onShortcutPressed as
    // { accelerator } ('' clears) or { cancel: true }, not to the menu.
    // `layout` is the keyboard's { code: character } map.
    record: (on, layout) => ipcRenderer.send('settings-record', on, layout),
    onShortcutPressed: (callback) => on('shortcut-pressed', callback),
    onOpen: (callback) => on('settings-open', callback),
    onChanged: (callback) => on('settings-changed', callback),
  },
  // For the History popup only. State is { entries: [{ url, title, time }],
  // enabled, closedTabs, error? } (see historyState in main), newest first.
  history: {
    get: () => ipcRenderer.invoke('history-get'),
    // `background` opens it in a new tab behind the current one.
    open: (url, background = false) => ipcRenderer.send('history-open-page', url, background),
    // Both answer with the new state, with `error` if nothing changed.
    remove: (url) => ipcRenderer.invoke('history-remove', url),
    clear: () => ipcRenderer.invoke('history-clear'),
    close: () => ipcRenderer.send('history-close'),
    onOpen: (callback) => on('history-open', callback),
    onChanged: (callback) => on('history-changed', callback),
  },
  // For the address bar's suggestions list only: it shows the items
  // (onShow, { items, generation }, as `suggest` answers them), highlights the one
  // the toolbar selects, and says which one was clicked, on which list.
  suggestions: {
    pick: (index, generation) => ipcRenderer.send('suggestions-pick', index, generation),
    onShow: (callback) => on('suggestions-show', callback),
    onSelect: (callback) => on('suggestions-select', callback),
    onHide: (callback) => ipcRenderer.on('suggestions-hide', () => callback()),
  },
  // For the Downloads popup only. State is { downloads: [{ id, name, state,
  // progress, status }] }, newest first (see row in src/downloads.js).
  downloads: {
    get: () => ipcRenderer.invoke('downloads-get'),
    cancel: (id) => ipcRenderer.send('downloads-cancel', id),
    showInFinder: (id) => ipcRenderer.send('downloads-show', id),
    // Removes every download that is no longer on its way.
    clear: () => ipcRenderer.send('downloads-clear'),
    close: () => ipcRenderer.send('downloads-close'),
    onOpen: (callback) => on('downloads-open', callback),
    onChanged: (callback) => on('downloads-changed', callback),
  },
})
