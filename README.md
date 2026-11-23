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

Middle-click closes a tab. In the tab strip, arrow keys move between tabs and Delete closes one.

Settings (⌘, or the button at the right of the tab strip) holds the search engine (Google, DuckDuckGo or Bing) used for anything typed that is not an address. Settings save as they change, to `settings.json` in the app's data folder.

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
- `src/index.html` is the toolbar: the tab strip (also the window's title bar) and the address bar. When the active tab has not loaded anything, the address bar fills the window as the centered search box and the tab's page view stays hidden.
- `src/preload.js` is the bridge between Lit's own pages (the toolbar and the Settings window) and the main process.
- `src/settings.js` lists every setting, grouped in sections, with its type and default; it also loads, checks and saves them. `src/settings.html` is the Settings window, drawn entirely from that list, so a new setting only needs an entry there (plus a control in `settings.html` if it brings a new type).
- `src/url.js` turns typed text into a URL or a search with the chosen engine; `src/tabs.js` holds the tab-order rules (which tab to show after closing one, next/previous, ⌘1–9). These two and `src/settings.js` are plain Node, tested in `test/`.
