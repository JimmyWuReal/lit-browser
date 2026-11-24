# Lit

A minimal web browser built on Chromium (via [Electron](https://www.electronjs.org/)).

It opens on a centered search box: type a search or an address and press Enter. After that the box becomes the address bar at the top of the window.

Each window has tabs; every new tab starts on the same search box. Links that open a new window (and `window.open`) open as a tab next to their page, keeping their link to it, so sign-in popups work. Closing a window's last tab closes the window, and Lit keeps running with no windows open, like other Mac browsers.

| Shortcut | Action |
| --- | --- |
| ⌘T / ⌘N | New tab / new window |
| ⇧⌘T | Reopen the last closed tab or window |
| ⌘Y | History |
| ⌥⌘L | Downloads |
| ⌘W / ⇧⌘W | Close tab / close window |
| ⌥⌘W | Close other tabs |
| ⌘L | Focus the address bar |
| ⌘, | Settings |
| ⌃Tab, ⇧⌘] / ⌃⇧Tab, ⇧⌘[ | Next / previous tab |
| ⌘1–⌘8, ⌘9 | That tab, last tab |
| ⌘R, ⌘[, ⌘] | Reload, back, forward |
| ⌘= or ⌘+, ⌘-, ⌘0 | Zoom in, zoom out, reset zoom |
| ⌘F | Find in page |
| ⌘G / ⇧⌘G | Next / previous match |

Zoom is per site, as in Chrome: zooming a page zooms every tab on that site, and Lit remembers it for next time (in `zoom.json` in the app's data folder). A page that is not at the default zoom, or whose site has a zoom of its own, shows its zoom at the right of the address bar; click it, or press ⌘0, to go back to the default zoom set in Settings.

⌘F opens a find field at the end of the address row. It highlights matches as you type and shows the count; Enter and ⇧Enter (or ⌘G and ⇧⌘G) move between them, and Escape closes it. Each tab keeps its own search, and reopening brings back the tab's last one.

Middle-click closes a tab. In the tab strip, arrow keys move between tabs and Delete closes one.

⇧⌘T brings back the last tab you closed (⌘W, its close button, middle-click) as it was then, with its back/forward history, in its old place. A closed window comes back with all its tabs, and tabs closed from it before go back into it. Lit remembers the last 25 closed tabs and windows, in memory only, for an hour by default (see Settings); a page closing itself (such as a sign-in popup) is not remembered.

## Site permissions

When a site asks to use your camera or microphone, move and zoom your camera, know your location, show notifications or read your clipboard, a row appears below the address bar: "example.com wants to use your camera". Allow or Block is remembered for that site (its scheme, host and port, as in Chrome), in `permissions.json` in the app's data folder, so it is not asked again; × answers no just this time. A request for both camera and microphone only asks about the one you have not answered yet. The question belongs to the tab that asked: switching tabs hides it until you come back, and leaving the page drops it. Only the page in the address bar can ask. A frame from the same site gets the site's camera and microphone choices but nothing else; frames from other sites, and local files, are refused. A change in Settings applies the next time a site asks, so reload a page to stop a camera or microphone it is already using. Other permissions, such as full screen, keep Electron's default and are allowed.

Electron has no "not asked yet" state, so before you answer, a site that only checks (rather than asks) sees the permission as blocked.

## History

⌘Y opens History as a popup over the window: every page visited, newest first and grouped by day, saved to `history.json` in the app's data folder (the newest 5,000 pages). Type to search titles and addresses. Click a page to open it in the current tab, or ⌘-click to open it in a background tab. Remove one page with its × (or Delete), or everything with Clear History, which also forgets closed tabs.

## Downloads

Once a file starts downloading, a button appears at the right of the tab strip, in every window. While downloads are on their way, a ring around its arrow fills with their combined progress (or spins while a size is unknown). Click it, or press ⌥⌘L, to see the list: each download with its progress, size and time left, a button to cancel it, and, once finished, Show in Finder. Clear removes the finished ones, and the button goes away when the list is empty. The list lasts until Lit quits.

## Right-click menus

Right-clicking a page shows what fits the spot: a link can be opened in a new tab, saved or copied; an image, video or audio can be saved or have its address copied, and opened in a new tab when it has a web address (an image can also be copied); selected text can be copied or searched with your search engine; a text field gets spelling suggestions and Undo, Cut, Copy, Paste and Select All. Anywhere else the menu has Back, Forward and Reload. Every page menu ends with Inspect Element.

New tabs from the menu follow the Tabs settings like ⌘-clicked links: they open next to their page, in the background unless Lit is set to switch to them. Save follows the Downloads setting. Only web (http and https) links can be opened or saved from the menu.

Right-clicking a tab offers Reload, Duplicate (which keeps the tab's back and forward history), Close Tab, Close Other Tabs and Close Tabs to the Right. Duplicate Tab, Close Other Tabs and Close Tabs to the Right are also in the File menu. The address bar, the text fields in Settings and the History search get the editing items.

## Settings

⌘, or the button at the right of the tab strip opens Settings as a popup over the window. Changes save right away, to `settings.json` in the app's data folder.

- **General:** search engine (Google, DuckDuckGo or Bing), and the page zoom for sites you have not zoomed.
- **Tabs:** what new tabs open (the search box, or an address or search), where they go, whether ⌘-clicked links come to the front, and whether closing the last tab closes the window.
- **Downloads:** ask where to save, or save straight to Downloads.
- **Privacy:** save history (pages visited and closed tabs; when off, nothing new is saved, closed tabs are forgotten and Reopen Closed Tab does nothing), how long closed tabs can be reopened (10 minutes, 1 hour or 1 day; they are never written to disk), send Do Not Track and Global Privacy Control, and the site permissions you have given: switch each between Allow and Block, or remove it so the site is asked again.
- **Keyboard Shortcuts:** every shortcut in the table above except ⌘1–9 and the ⇧⌘[ / ⇧⌘] and ⌘+ alternates, plus Duplicate Tab and Close Tabs to the Right, which have none until you set one. Click a shortcut and press the new keys; Escape cancels and Delete removes it. Lit refuses a shortcut another command already uses.

## Run

```sh
npm install
npm start
```

For development, `npm run dev` restarts the app whenever a file in `src/` changes (Node's built-in `--watch`, no extra tools). `npm test` runs the unit tests in `test/` with Node's built-in test runner.

## Build the Mac app

```sh
npm run app
```

This builds `Lit.app` with [electron-builder](https://www.electron.build/) and installs it into `/Applications`, quitting and replacing any older copy. Run it again whenever you want the installed app updated. `npm run build` only builds, into `out/`.

The app is ad-hoc signed, which is enough to run it on this Mac. Sharing it with others will need a Developer ID certificate and notarization.

## Icon

The icon is `build/icon.png` (1024×1024, a placeholder for now). Replace that file and run `npm run app`; electron-builder turns it into the `.icns` file. `npm start` shows the same icon in the Dock.

## How it works

- `src/main.js` opens windows and gives each tab its own Chromium `WebContentsView` under the toolbar; only the active tab's view is shown. It owns the tab list and sends it to the toolbar whenever it changes. The application menu holds every shortcut, so they work whether the toolbar or a page has focus.
- `src/index.html` is the toolbar: the tab strip (also the window's title bar), the address bar and the find field. When the active tab has not loaded anything, the address bar fills the window as the centered search box and the tab's page view stays hidden.
- `src/preload.js` is the bridge between Lit's own pages (the toolbar, and the Settings and History popups) and the main process.
- `src/settings.js` lists every setting, grouped in sections, with its type and default; it also loads, checks and saves them. `src/settings.html` is the Settings popup, drawn entirely from that list, so a new setting only needs an entry there (plus a control in `settings.html` if it brings a new type). Each window shows the popup in its own transparent view over the tabs. While a shortcut is recorded, main passes the key presses to it instead of the menu.
- `src/shortcuts.js` turns key presses into Electron accelerators, checks them, and labels them (⇧⌘W). `src/downloads.js` picks a free file name in Downloads and words each download's progress and size; main follows each download from `will-download` to `done`, keeping this session's list, and `src/downloads.html` is the Downloads popup, a panel hanging from the toolbar button in the same kind of transparent view as Settings. `src/find.js` holds each tab's find state; main runs the searches with Chromium's `findInPage` and sends the counts to the toolbar with the tabs. `src/zoom.js` holds the zoom steps and loads and saves each site's zoom. `src/permissions.js` decides which permission requests Lit asks about and keeps each site's answers; main answers Chromium's permission requests and checks from them, or queues a prompt on the tab that asked, moving its page down while the toolbar shows it.
- Closed tabs and windows go on a list in `src/main.js`, each with its `navigationHistory` entries, which Reopen Closed Tab restores. `src/history.js` keeps the pages visited (one entry per address) and `src/history.html` is the History popup, shown the same way as Settings.
- `src/menus.js` decides what each right-click menu holds, for a page (from Chromium's context-menu details) and for a tab; main turns those items into native menus and runs what is chosen.
- `src/url.js` turns typed text into a URL or a search with the chosen engine; `src/tabs.js` holds the tab and window rules (which tab to show after closing one, next/previous, ⌘1–9, how many closed tabs to remember, where one reopens, whether a window is still on screen). `url.js`, `tabs.js`, `menus.js`, `settings.js`, `history.js`, `shortcuts.js`, `downloads.js`, `find.js`, `zoom.js` and `permissions.js` are plain Node, tested in `test/`.
