# Lit

A minimal web browser built on Chromium (via [Electron](https://www.electronjs.org/)).

Right now it is one window with one bar: type a search or an address and press Enter.

## Run

```sh
npm install
npm start
```

For development, `npm run dev` restarts the app whenever a file in `src/` changes (Node's built-in `--watch`, no extra tools).

## How it works

- `src/main.js` opens the window and renders pages in a Chromium `WebContentsView` under the toolbar. It decides whether input is a URL or a Google search.
- `src/index.html` is the toolbar (the search / address bar).
- `src/preload.js` is the bridge between the toolbar and the main process.
