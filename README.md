# Lit

A minimal web browser built on Chromium (via [Electron](https://www.electronjs.org/)).

It opens on a centered search box: type a search or an address and press Enter. After that the box becomes the address bar at the top of the window.

Each window has tabs; every new tab starts on the same search box. Links that open a new window (and `window.open`) open as a tab next to their page, keeping their link to it, so sign-in popups work. Closing a window's last tab closes the window, and Lit keeps running with no windows open, like other Mac browsers.

| Shortcut | Action |
| --- | --- |
| ⌘T / ⌘N | New tab / new window |
| ⌘W / ⇧⌘W | Close tab / close window |
| ⌘L | Focus the address bar |
| ⌘, | Settings |
| ⌃Tab, ⇧⌘] / ⌃⇧Tab, ⇧⌘[ | Next / previous tab |
| ⌘1–⌘8, ⌘9 | That tab, last tab |
| ⌘R, ⌘[, ⌘] | Reload, back, forward |
| ⌘F | Find in page |
| ⌘G / ⇧⌘G | Next / previous match |

⌘F opens a find field at the end of the address row. It highlights matches as you type and shows the count; Enter and ⇧Enter (or ⌘G and ⇧⌘G) move between them, and Escape closes it. Each tab keeps its own search, and reopening brings back the tab's last one.

Middle-click closes a tab. In the tab strip, arrow keys move between tabs and Delete closes one.

## Settings

⌘, or the button at the right of the tab strip opens Settings as a popup over the window. Changes save right away, to `settings.json` in the app's data folder.

- **General:** search engine (Google, DuckDuckGo or Bing).
- **Tabs:** what new tabs open (the search box, or an address or search), where they go, whether ⌘-clicked links come to the front, and whether closing the last tab closes the window.
- **Downloads:** ask where to save, or save straight to Downloads.
- **Privacy:** send Do Not Track and Global Privacy Control.
- **Keyboard Shortcuts:** every shortcut in the table above except ⌘1–9 and the ⇧⌘[ / ⇧⌘] alternates. Click a shortcut and press the new keys; Escape cancels and Delete removes it. Lit refuses a shortcut another command already uses.

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
- `src/preload.js` is the bridge between Lit's own pages (the toolbar and the Settings popup) and the main process.
- `src/settings.js` lists every setting, grouped in sections, with its type and default; it also loads, checks and saves them. `src/settings.html` is the Settings popup, drawn entirely from that list, so a new setting only needs an entry there (plus a control in `settings.html` if it brings a new type). Each window shows the popup in its own transparent view over the tabs. While a shortcut is recorded, main passes the key presses to it instead of the menu.
- `src/shortcuts.js` turns key presses into Electron accelerators, checks them, and labels them (⇧⌘W). `src/downloads.js` picks a free file name in Downloads. `src/find.js` holds each tab's find state; main runs the searches with Chromium's `findInPage` and sends the counts to the toolbar with the tabs.
- `src/url.js` turns typed text into a URL or a search with the chosen engine; `src/tabs.js` holds the tab-order rules (which tab to show after closing one, next/previous, ⌘1–9). `url.js`, `tabs.js`, `settings.js`, `shortcuts.js`, `downloads.js` and `find.js` are plain Node, tested in `test/`.
