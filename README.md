# Lit

A minimal web browser built on Chromium (via [Electron](https://www.electronjs.org/)).

It opens on a centered search box: type a search or an address and press Enter. After that the box becomes the address bar at the top of the window. It makes the page's site stand out, and leaves out `https://` until you click it to edit the address.

Each window has tabs; every new tab starts on the same search box. Links that open a new window (and `window.open`) open as a tab next to their page, keeping their link to it, so sign-in popups work. Closing a window's last tab closes the window, and Lit keeps running with no windows open, like other Mac browsers.

| Shortcut | Action |
| --- | --- |
| ⌘T / ⌘N | New tab / new window |
| ⇧⌘N | New private window |
| ⇧⌘T | Reopen the last closed tab or window |
| ⌘Y | History |
| ⌥⌘L | Downloads |
| ⌘W / ⇧⌘W | Close tab / close window |
| ⌥⌘W | Close other tabs |
| ⌘L | Focus the address bar |
| ⌘, | Settings |
| ⇧⌘P | Command palette |
| ⇧⌘M | Manage profiles |
| ⌃Tab, ⇧⌘] / ⌃⇧Tab, ⇧⌘[ | Next / previous tab |
| ⌘1–⌘8, ⌘9 | That tab, last tab |
| ⇧⌘L | Show or hide the tab sidebar |
| ⌘R, ⌘[, ⌘] | Reload, back, forward |
| ⌘= or ⌘+, ⌘-, ⌘0 | Zoom in, zoom out, reset zoom |
| ⌘D | Bookmark the page, or edit its bookmark |
| ⇧⌘B | Show or hide the bookmark bar |
| ⌘F | Find in page |
| ⌘G / ⇧⌘G | Next / previous match |
| ⌘P | Print the page |

Back, forward and reload buttons sit before the address bar once a tab has a page. ⌘-click or middle-click Back or Forward to go there in a new tab, with the tab's back/forward history; right-click or hold it to list the pages that way. A plain click passes over pages a site added to the list without you doing anything there, as in Chrome; a new tab and the list don't, as Electron doesn't say which those are. Reload becomes Stop while the page loads, and ⇧-click reloads without the cache. Stopping a tab before its first page brings back its search box.

Zoom is per site, as in Chrome: zooming a page zooms every tab on that site, and Lit remembers it for next time (in `zoom.json` in the app's data folder). A page that is not at the default zoom, or whose site has a zoom of its own, shows its zoom at the right of the address bar; click it, or press ⌘0, to go back to the default zoom set in Settings.

PDFs open in Chromium's PDF viewer, with its own toolbar to go through the pages, zoom, rotate, draw on, download and print them. ⌘F finds in them and ⌘P prints them, as on other pages. In a PDF, ⌘+ and ⌘- zoom the PDF itself, through the viewer's steps, and ⌘0 fits it to the window's width again; its site's zoom is left alone, and the viewer's toolbar shows the zoom instead of the address bar. A PDF the site sends as an attachment downloads instead. Lit is in Finder's Open With for PDFs (see [Default browser](#default-browser)).

⌘F opens a find field at the end of the address row. It highlights matches as you type and shows the count; Enter and ⇧Enter (or ⌘G and ⇧⌘G) move between them, and Escape closes it. Each tab keeps its own search, and reopening brings back the tab's last one.

When a page goes full screen, as a video does, it fills the whole screen and the toolbar hides until it is done. Switching tabs, ⌘L, ⌘F, a site asking for permission or a sign-in, or taking the window out of full screen ends it. A window that was already full screen stays so; a page's full screen is not brought back when its window reopens.

A tab playing sound shows a speaker. Click it to mute the tab, and again to unmute it; so do Mute Tab in the tab's right-click menu and Mute or Unmute Tab in the File menu. A muted tab shows a crossed-out speaker, even while nothing plays, and stays muted as it moves to other pages, until it closes: a reopened, restored or duplicated tab is not muted. When tabs are too narrow for both, the speaker takes the place of the tab's icon, and only the active tab's can be clicked.

Drag a tab to move it along the strip. Middle-click closes a tab. In the tab strip, arrow keys move between tabs, ⇧← and ⇧→ move the tab itself, and Delete closes one.

Turn on Vertical tabs in Settings › Tabs to list the tabs down a sidebar on the window's left instead, each with its full title; the address bar and the page sit to its right. In a window under 700 points wide, the sidebar narrows to the tabs' icons. There ↑ and ↓ move between tabs, ⇧↑ and ⇧↓ move one, and dragging works up and down. ⇧⌘L (View › Show Tab Sidebar) hides the sidebar, giving pages the whole width, and shows it again; the tab shortcuts still work while it is hidden. With tabs across the top, ⇧⌘L turns vertical tabs on.

Tabs you haven't looked at for 30 minutes go to sleep: their page closes, freeing its memory, and their icon fades. A sleeping tab keeps its title, icon and back/forward history, with each page's scroll position and what was typed into it, and loads again when you click it (or Reload it from its right-click menu). A tab stays awake while it plays sound, is full screen, asks you something, uses your camera, microphone or screen, is being shared, has its Developer Tools open, or is on a site allowed to show notifications, so mail and chat keep notifying you. A page you typed into, or drew on, stays awake until it moves to another page, as a half-written draft couldn't be brought back, and so does one that would ask before you leave it, until you next look at it. Sharing a sleeping tab wakes it. Set how long tabs wait, or Never, in Settings › Tabs. Sleeping breaks a popup's link back to the page that opened it, which matters only for a sign-in popup left open that long.

⇧⌘T brings back the last tab you closed (⌘W, its close button, middle-click) as it was then, with its back/forward history, in its old place. A closed window comes back with all its tabs, and tabs closed from it before go back into it. Lit remembers up to 50 closed tabs by default (see Settings), counting each tab of a closed window. They are kept in memory only, so Lit forgets them when it quits; a page closing itself (such as a sign-in popup) is not remembered.

When Lit opens again, it reopens the windows and tabs that were open when it quit, each window where it was and each tab with its back/forward history, the window that was in front last. Windows closed before quitting stay closed. The session is saved to `session.json` in the app's data folder as it changes, so a crash loses little. Turn this off in Settings to start with a new window instead.

## Command palette

⇧⌘P (View › Command Palette) opens a search field over the window that runs any command by name. It lists every command in the menu bar, with its shortcut (New Tab, Show Previous Tab, Reopen Closed Tab, Bookmark This Page, Settings, a profile to switch to…), the window's other tabs, to switch to, and the settings one press can change: each on/off setting, to flip (its state shows next to it), and each option of the others, such as Search engine: Bing. Type any words of a command, its menu, or its setting's section or description; "suggestions" or "toggle suggestions" finds Suggest pages as you type. ↑ and ↓ pick one, Enter or a click runs it, and Escape or ⇧⌘P again closes the palette.

## Profiles

A profile is a separate place to browse: each has its own sign-ins, cookies and site data, so you can be signed in to different accounts of the same site, and its own history, closed tabs, bookmarks, downloads list, site zooms, site permissions, and General, Downloads and Privacy settings. The other settings, such as keyboard shortcuts, are shared.

Every window belongs to one profile. Once there is more than one, a button with the profile's color and first letter sits at the right of the tab strip, and window titles end with the profile's name. The button, or the Profiles menu, switches to another profile: its window used last comes to the front, or a new one opens. New windows, private ones too, take the profile of the window they are opened from (with none open, the one used last).

⇧⌘M (Profiles › Manage Profiles) opens the Profiles section of Settings, to add, rename, recolor, open or delete profiles. Deleting one asks first, then closes its windows and deletes all it holds; files it downloaded stay. The first profile, which has everything from before there were profiles, can be renamed but not deleted.

The profiles are listed in `profiles.json` in the app's data folder (one Lit can't read is kept as `profiles.json.bad`). The first profile's files are in the data folder itself, where this README says, and the others' in `Profiles/<id>/`, with their site data in `Partitions/profile-<id>/`. What Chromium still holds of a deleted profile is removed at the next launch.

## Bookmarks

The star at the end of the address bar, or ⌘D, adds the page to the bookmark bar, the row below the address bar (at the top of a new tab), which is hidden while there are no bookmarks. A form then offers to change its name, address or folder, or delete it; the star stays filled on a bookmarked page, and pressing it again reopens the form. Click a bookmark to open it here, or ⌘-click or middle-click for a new tab. Drag bookmarks to reorder them, on the bar or in its lists, or onto a folder to put them in it. Those that don't fit are listed by the » button at the bar's end.

Right-click a bookmark to open it in a new tab, window or private window, copy its address, edit it or delete it. Right-click the bar to add a page or a folder, or hide the bar. A folder's menu opens all its pages, renames or deletes it; folders hold pages, not other folders. Typing in the address bar lists matching bookmarks first, marked with a star.

Bookmarks are saved to `bookmarks.json` in the app's data folder, each with a copy of its site's icon, so drawing the bar never contacts a site. A file Lit can't read is kept as `bookmarks.json.bad`. A profile's private windows show the same bar, and a page bookmarked in one is kept after it closes.

## Quick search

Type a site's shortcut with your search to search that site instead of your search engine: `!yt lofi beats` searches YouTube, `!wiki Taiwan` Wikipedia, and `react hooks !gh` GitHub (the shortcut can come first or last). A shortcut alone, such as `!yt`, opens the site.

Typing `!` lists the sites under the address bar, narrowing as you type (`!y` lists Yahoo, whose shortcut is exactly `y`, then YouTube). ↓ and ↑ move through them; Tab, Enter or a click picks one. Picking a site, or typing its whole shortcut and a space (or Tab), turns the shortcut into a chip with the site's icon and name at the start of the field, which then holds just your search; Enter sends it. Backspace at the start of the search puts the shortcut back as text, and Escape or leaving the field drops it.

| Site | Shortcuts |
| --- | --- |
| YouTube | `yt`, `youtube` |
| Wikipedia | `wiki`, `w` |
| Google | `g`, `google` |
| DuckDuckGo | `ddg`, `duck` |
| GitHub | `gh`, `github` |
| Google Maps | `maps`, `map` |
| Reddit | `r`, `reddit` |
| X | `x`, `twitter` |
| ChatGPT | `gpt`, `chatgpt` |
| Claude | `claude` |
| Perplexity | `pplx`, `perplexity` |
| Gemini | `gemini` |
| Grok | `grok` |
| Stack Overflow | `so`, `stack` |
| npm | `npm` |
| LinkedIn | `li`, `linkedin` |
| Amazon | `amz`, `amazon` |
| IMDb | `imdb`, `movie` |
| Google News | `news` |
| Yahoo | `y`, `yahoo` |

The search goes straight to the site; your search engine never sees it. To add a site, add it to `SITES` in `src/quicksearch.js` with its icon in `src/sites/`. The icons come from [SVGL](https://svgl.app/), [Simple Icons](https://simpleicons.org/) and the sites' brand pages, as in the [QuickSearch](https://github.com/JimmyWuReal/quick-search) extension this comes from.

## Private windows

⇧⌘N (File › New Private Window) opens a private window. It looks a little different: a violet tint, a Private badge in the tab strip, and a note under the search box.

Each private window, its toolbar and popups included, browses in a session of its own, apart from its profile's, kept in memory and never written to disk, so its cookies and site storage are seen by no other window, private or not. It keeps no HTTP cache, not even in memory. Lit keeps nothing from it but the bookmarks you add there:

- No history: its pages are not recorded, and its closed tabs, and the window itself, can't be reopened. Reopen Closed Tab from a private window brings a normal tab of its profile back into a normal window.
- Show All History opens in a normal window of its profile.
- It is left out of the windows reopened at the next launch.
- It never offers to save a password, but can fill the ones its profile has saved.
- Sites start at the default zoom, not the one saved for them, and zooming one there lasts only until the window closes.
- Site permissions: a site you blocked stays blocked (even if you block it while the window is open), and one you allowed asks again. Answers there last only until the window closes.
- Downloads always ask where to save, whatever the Downloads setting, so no site there writes a file you didn't choose. They show only in the window's own Downloads list. Closing the window cancels those still on their way (or waiting in their save dialog) and drops the list; files already saved stay where they were saved.
- It has no Developer Tools (the menu item does nothing there, and the right-click menu has no Inspect Element), since DevTools saves its state to disk; nor Add to Dictionary.

The address bar suggests only bookmarks there, nothing from history. Once the window's pages have closed, its session is cleared from memory: cookies, site storage, sign-ins and connections. Ads are blocked as in normal windows, and changes made in Settings are saved.

## Passwords

After you sign in to a site, or change its password there, a row below the address bar offers to save the password (or update the saved one). Never stops Lit asking for that site; × answers no just this time. The offer comes once the sign-in seems to have worked: the next page shows no password field within about two seconds, or the page that stayed lost its own. A change of password on a form without a username updates a saved one only when the old password typed there is that of just one login. It goes when answered, when its tab closes, or with a page opened more than a minute later.

Click a login field, Tab into it or press ↓ in it, and Lit lists the site's saved logins under it. Pick one (or use ↓, ↑ and Enter; Escape closes the list) to fill the username and password. Nothing is filled until you pick, so a page can never read a password you didn't choose. A password is only offered on the exact site it was saved on (its scheme, host and port), in the page itself, not in frames inside it. A sign-in split in two steps gets its username in the first (a field the site marks as a username, or the form's only email field) and its password in the second.

Passwords are saved to `passwords.json` in the app's data folder, each encrypted with a key kept in the macOS Keychain; sites and usernames are not encrypted. A file Lit can't read is kept as `passwords.json.bad`. As Lit is ad-hoc signed, macOS may ask to allow Keychain access again after you rebuild it. Settings shows or copies a password after Touch ID, on a Mac that has it set up.

## Passkeys

Lit can't use passkeys yet. macOS shows its passkey sheet (iCloud Keychain, or a phone) only for browsers Apple has given the `com.apple.developer.web-browser.public-key-credential` entitlement, which takes a paid developer account, and Lit is ad-hoc signed. So Lit tells sites it has no passkey support, and refuses a request made anyway, so a site goes on to a password or another way to sign in rather than wait for a sheet that never shows.

USB security keys use the same requests. To use one, turn on Security Keys in Settings and reopen Lit; Lit shows nothing while a site waits for the key. A request only a passkey on this Mac or a phone could answer is still refused; one either could waits for the key, until the site gives up.

## Site permissions

When a site asks to use your camera or microphone, move and zoom your camera, know your location, show notifications, read your clipboard or open another app (a `mailto:` or `zoommtg:` link, say), a row appears below the address bar: "example.com wants to use your camera". Allow or Block is remembered for that site (its scheme, host and port, as in Chrome), in `permissions.json` in the app's data folder, so it is not asked again; × answers no just this time. Opening apps is remembered per kind of link, so a site allowed to open `mailto:` links still asks before `zoommtg:` ones. A request for both camera and microphone only asks about the one you have not answered yet. The question belongs to the tab that asked: switching tabs hides it until you come back, and leaving the page drops it. Only the page in the address bar can ask, and a frame from the same site for its camera and microphone (asked as the site); frames from other sites, and local files, are refused. A redirect to another app is asked as the site that redirected, not the page whose link led there, and refused from a frame or a service worker. A tab asks about one kind of app link at a time, and refuses others until you answer; Allow opens only the link you answered. A change in Settings applies the next time a site asks, so reload a page to stop a camera or microphone it is already using. Other permissions, such as full screen, keep Electron's default and are allowed.

Electron has no "not asked yet" state, so before you answer, a site that only checks (rather than asks) sees the permission as blocked.

## Screen sharing

When a site such as Meet or Zoom wants to share your screen, a picker asks what it gets: one of your other tabs (with its sound, if the site wants it and you leave that on), a window or a whole screen. It is asked every time, and nothing is shared until you pick; Cancel, Escape, switching tabs or leaving the page refuses. Only the tab on show can ask, for its page or a frame from the same site. Tabs listed are those of the same profile, or of the same private window. Stop sharing from the site, or by closing its tab.

Windows and screens need macOS's permission: turn Lit on under System Settings › Privacy & Security › Screen & System Audio Recording (the picker has a button that opens it), then reopen Lit. Tabs don't need it. A newly installed build of Lit may have to be given it again, as the app is ad-hoc signed. The sound of a window or screen can't be shared.

A page that gets around the picker's choice, through Chromium's old `chromeMediaSource` constraint, is stopped, and shows as crashed.

## Signing in

When a server, or a proxy set on this computer, asks for a username and password itself (HTTP authentication) rather than on its page, a row appears below the address bar with fields for them. It names the host that asks, as Chromium reports it, never the words the server sends with the request, and warns when the connection isn't encrypted (for a proxy, that it may not be). Cancel, or Escape, shows the server's own response; a wrong username or password asks again.

A page that asks while it opens is shown only once you answer: until then its address is in the address bar, and the page it would replace is hidden. What a page loads (its frames, images and requests) can ask only for the page's own site (its scheme, host and port); other sites are refused, and so get no say in what you are asked while you are on the page. A proxy may always ask. Requests that the same answer fits are asked once. Requests outside a tab, such as a download or a service worker's, are refused.

The question belongs to the tab that asked: switching tabs hides it and clears what was typed, and leaving or closing the page drops it. Chromium keeps the answer in memory until Lit quits (a private window's, until it closes), apart from every other profile and private window. Lit itself neither saves nor logs it.

## History

⌘Y opens History as a popup over the window: every page visited, newest first and grouped by day, saved to `history.json` in the app's data folder (the newest 5,000 pages).

Like other browsers, History holds the pages you landed on, not every address a page passed through. A page is recorded once its tab stops loading, so redirects and addresses a page swaps while it loads never show, and a page you leave or close before it finishes loading is recorded then. A page that moves on by itself within 5 seconds of loading (loading another page, or replacing its own address), without you clicking, typing or scrolling on it, is redirecting, and takes its visit with it; a web app adding an address (`history.pushState`) keeps both. Moving within a page (`#section`) is not a new visit, and neither is a tab reopened, restored or duplicated.

Typing in the address bar lists up to six pages whose title or address contains every word typed: bookmarks first, then visited pages, addresses that start with what was typed first within each. ↓ and ↑ move through them, putting the page's address in the field, so Enter opens it; click one to open it, and Escape closes the list.

## Downloads

Once a file starts downloading, a button appears at the right of the tab strip, in every window. While downloads are on their way, a ring around its arrow fills with their combined progress (or spins while a size is unknown). Click it, or press ⌥⌘L, to see the list: each download with its progress, size and time left, a button to cancel it, and, once finished, Show in Finder. Clear removes the finished ones, and the button goes away when the list is empty. The list lasts until Lit quits.

## Pages that fail or crash

A page that can't load, or crashes, shows what went wrong in its place, with the error's code and buttons to try again (or reload) and go back. The address bar keeps the address that failed, and Reload tries it again. A page that couldn't load is not added to History. Trying again never sends a form a second time: a page that came from one opens its address without it.

That covers an address that can't be found or reached, being offline, a site that redirects forever or sends nothing, a certificate Lit doesn't trust (there is no way past that one), a missing file, and a site answering with an HTTP error and an empty page. A page that breaks off halfway keeps what it has shown, and a site's own error page shows as it is. Text that only looks like an address, such as `example.com:99999`, is searched instead.

## Default browser

Settings › Default Browser makes Lit the Mac's default browser (macOS asks you to confirm), so links clicked in other apps open in Lit. HTML and PDF files keep the app they open with; Lit is in Finder’s Open With for them. It needs the installed app (`npm run app`); run from source, it is unavailable. Web links, HTML and PDF files from other apps open in a new tab of the window used last, or in a new window, as Settings says; in the profile used last, and never in a private window.

## Right-click menus

Right-clicking a page shows what fits the spot: a link can be opened in a new tab, saved or copied; an image, video or audio can be saved or have its address copied, and opened in a new tab when it has a web address (an image can also be copied); selected text can be copied or searched with your search engine; a text field gets spelling suggestions and Undo, Cut, Copy, Paste and Select All. Anywhere else the menu has Back, Forward, Reload and Print. Every page menu ends with Inspect Element, except in a private window.

New tabs from the menu follow the Tabs settings like ⌘-clicked links: they open next to their page, in the background unless Lit is set to switch to them. Save follows the Downloads setting. Only web (http and https) links can be opened or saved from the menu.

Right-clicking a tab offers Reload, Duplicate (which keeps the tab's back and forward history), Mute Tab or Unmute Tab, Close Tab, Close Other Tabs and Close Tabs to the Right. Duplicate Tab, Mute or Unmute Tab, Close Other Tabs and Close Tabs to the Right are also in the File menu. The address bar, the text fields in Settings and the History search get the editing items.

## Settings

⌘, or the button at the right of the tab strip opens Settings as a popup over the window. Changes save right away, to `settings.json` in the app's data folder. Type in the search field to find settings in any section by their name, description, options or shortcut, and change them right there; click a section's title to open it. Escape clears the search.

General, Downloads, Passwords, Privacy and Cookies are the profile's own; the rest are shared by every profile. With more than one profile, the sidebar groups them by whose they are.

- **General:** search engine (Google, DuckDuckGo or Bing), what new tabs open (the search box, or an address or search), the page zoom for sites you have not zoomed, whether the address bar suggests bookmarks and pages from history, whether the back, forward and reload buttons show, whether the address bar shows full addresses, whether the bookmark bar shows, and whether pages are framed (on by default: each page, and the new tab's search box, sits in a card with rounded corners a little in from the window's edges; off, pages reach the edges).
- **Downloads:** ask where to save, or save straight to Downloads.
- **Passwords:** whether Lit offers to save passwords, and whether it suggests saved ones in login fields. Also lists the saved ones, to show, copy or remove, and the sites never asked about, to ask again.
- **Privacy:** save history (pages visited and closed tabs; when off, nothing new is saved, closed tabs are forgotten, Reopen Closed Tab does nothing, and windows reopened at launch keep only each tab's page, not its back and forward history or what was typed into it), block ads and trackers (on by default, with Ghostery's prebuilt lists, downloaded the first time it is on, saved to `adblock.bin` in the app's data folder and refreshed when a week old; a saved copy is blocking before any tab loads, and a change shows or hides ads on open pages once they are reloaded), let sites ask to share your screen (on by default; when off they are refused), send Do Not Track and Global Privacy Control, and the site permissions you have given: switch each between Allow and Block, or remove it so the site is asked again.
- **Cookies:** every cookie sites saved in the profile, by domain (accounts.google.com next to google.com). Filter the domains by name, open one to see each cookie's name, value (the first 200 characters), path and when it expires, and remove one cookie, a domain's, or, after asking, every one. A cookie an embedded frame keeps apart for each site it is on shows once, with how many copies, and removing it removes them all. Removing a site's cookies signs you out of it. Settings reads them again each time it opens; a private window's own cookies are not listed, and go when it closes.
- **Default Browser:** whether links from other apps open in a new tab or a new window, and a button to make Lit the default browser.
- **Quick Search:** turn quick search shortcuts on or off, and the character that starts them (`!`, `@`, `#`, `:` or `/`). Also lists every site and its shortcuts.
- **Security Keys:** let sites ask for a USB security key (off by default, from the next time Lit opens; see [Passkeys](#passkeys)).
- **Tabs:** where new tabs go, whether ⌘-clicked links come to the front, whether tabs show a speaker while they play sound or are muted, vertical tabs (off by default: tabs in a sidebar down the window's left instead of across the top) and whether that sidebar shows (on by default; ⇧⌘L), when tabs out of sight go to sleep (after 15 or 30 minutes, the default, 1 or 2 hours, or never), whether closing the last tab closes the window, whether Lit reopens the windows and tabs from last time, and how many closed tabs Reopen Closed Tab remembers (10, 25, 50 or 100; a closed window counts each of its tabs, and one bigger than the limit keeps the tabs around its active one).
- **Profiles:** add, rename, recolor, open and delete profiles.
- **Keyboard Shortcuts:** every shortcut in the table above except ⌘1–9 and the ⇧⌘[ / ⇧⌘] and ⌘+ alternates, plus Duplicate Tab, Mute or Unmute Tab, Close Tabs to the Right and New Profile, which have none until you set one. Click a shortcut and press the new keys; Escape cancels and Delete removes it. Lit refuses a shortcut another command already uses.

## Run

```sh
npm install
npm start
```

For development, `npm run dev` restarts the app whenever a file in `src/` changes (Node's built-in `--watch`, no extra tools). `npm test` runs the unit tests in `test/` with Node's built-in test runner.

Run any other way from source (`npx electron .`, or a script that loads `src/main.js`), Lit stays hidden (`src/quiet.js`) so agents can test it without interrupting you: no Dock icon, no windows on screen, and it never takes focus. Pages still draw, take `sendInputEvent` and can be captured with `capturePage`. Set `LIT_FOREGROUND=1` for what needs a real window: focus (`isFocused`), full screen, or `screencapture`.

## Build the Mac app

```sh
npm run app
```

This builds `Lit.app` with [electron-builder](https://www.electron.build/) and installs it into `/Applications`, quitting and replacing any older copy. Run it again whenever you want the installed app updated. `npm run build` only builds, into `out/`.

The app is ad-hoc signed, which is enough to run it on this Mac. Sharing it with others will need a Developer ID certificate and notarization.

## Icon

The icon is `build/icon.png` (1024×1024, a placeholder for now). Replace that file and run `npm run app`; electron-builder turns it into the `.icns` file. `npm start` shows the same icon in the Dock.

## How it works

- `src/main.js` opens windows and gives each tab its own Chromium `WebContentsView` under the toolbar in its profile's session (in a private window, in that window's in-memory session, from `session.fromPartition`); only the active tab's view is shown. It owns the tab list and sends it to the toolbar whenever it changes. The application menu holds every shortcut, so they work whether the toolbar or a page has focus.
- `src/index.html` is the toolbar: the tab strip (also the window's title bar), the back, forward and reload buttons, the address bar and the find field. With vertical tabs the same tab list is laid out down a sidebar, and main starts the pages right of it. When the active tab has not loaded anything, the address bar fills the window as the centered search box and the tab's page view stays hidden.
- `src/preload.js` is the bridge between Lit's own pages (the toolbar, the address bar's suggestions, the command palette, and the Settings, History, Downloads, Bookmarks and screen sharing popups) and the main process.
- `src/profiles.js` keeps the list of profiles and says where each one's files and session are; main opens each as an object holding its session, settings, history, bookmarks and the rest, and gives every window one.
- `src/settings.js` lists every setting, grouped in sections (each a profile's own or shared), with its type and default; it also loads, checks and saves them. `src/settings.html` is the Settings popup, drawn entirely from that list, so a new setting only needs an entry there (plus a control in `settings.html` if it brings a new type). Each window shows the popup in its own transparent view over the tabs. While a shortcut is recorded, main passes the key presses to it instead of the menu.
- `src/shortcuts.js` turns key presses into Electron accelerators, checks them, and labels them (⇧⌘W). `src/downloads.js` picks a free file name in Downloads and words each download's progress and size; main follows each download from `will-download` to `done`, keeping this session's list, and `src/downloads.html` is the Downloads popup, a panel hanging from the toolbar button in the same kind of transparent view as Settings. `src/find.js` holds each tab's find state; main runs the searches with Chromium's `findInPage` and sends the counts to the toolbar with the tabs. `src/zoom.js` holds the zoom steps and loads and saves each site's zoom. `src/permissions.js` decides which permission requests Lit asks about and keeps each site's answers; main answers Chromium's permission requests and checks from them, or queues a prompt on the tab that asked, moving its page down while the toolbar shows it. `src/signin.js` decides which of Electron's `login` events Lit asks about and words the prompt; main queues those the same way, and the toolbar sends back what was typed. `src/share.html` is the screen sharing picker and `src/share.js` lists what it offers; main answers the site's request with the choice.
- Closed tabs and windows go on a list in `src/main.js`, each with its `navigationHistory` entries, which Reopen Closed Tab restores. `src/session.js` loads and saves the open windows in the same shape, for the next launch. `src/history.js` keeps the pages visited (one entry per address) and finds the address bar's suggestions; main decides which navigations count as visits. `src/history.html` is the History popup, shown the same way as Settings. `src/bookmarks.js` keeps the bookmarks and their folders; the toolbar draws the bar, and `src/bookmarks.html` is the Bookmarks popup, which lists a folder (or what doesn't fit the bar) and holds the form that edits a bookmark. `src/suggestions.html` is the suggestions list, in a view of its own laid over the page under the address field, since the toolbar's page ends above the tabs; the toolbar keeps focus and handles the keys.
- `src/adblock.js` blocks ads and trackers with Ghostery's engine (`@ghostery/adblocker-electron`) in each profile's session (and its private windows'), all sharing one engine: it reads the engine saved in `adblock.bin`, or builds one from freshly downloaded lists, and switches each session on and off with its profile's setting.
- `src/passwords.js` keeps a profile's saved logins and decides when to offer saving one; main encrypts and decrypts them, and is the only place a password is until someone picks it. `src/page.js` runs in every web page's top frame, apart from the page's scripts, to notice sign-ins and login fields and fill the login picked. `src/logins.html` is the list under a login field.
- `src/passkeys.js` runs in every web page and the frames inside it and refuses passkey requests. Unless Security Keys is on, main also runs Chromium without `PublicKeyCredential`, and Electron's `platformPasskeys`, which macOS refuses for want of the entitlement, fails any request made anyway (except in frames from another site than their page's). With it on, `passkeys.js` refuses only requests no key could answer.
- `src/errors.js` words the page shown for a failed load, an empty HTTP error or a crash. Main notices each and hides the tab's view, and the toolbar draws the error page in the space under it.
- `src/commands.js` builds the command palette's list from the application menu, the window's tabs and the settings, and matches what is typed; main runs the command picked (a menu item as if clicked in the menu), and `src/palette.html` only draws them.
- `src/menus.js` decides what each right-click menu holds, for a page (from Chromium's context-menu details) and for a tab; main turns those items into native menus and runs what is chosen.
- `src/quicksearch.js` lists the quick search sites and turns a shortcut and search into the site's address, and a half-typed shortcut into the sites it could be; main tries it before `src/url.js`, and the toolbar draws a typed shortcut as its site's chip. `src/url.js` turns typed text into a URL or a search with the chosen engine, and splits a page's address into the parts the address bar draws; `src/tabs.js` holds the tab and window rules (which tab to show after closing one, next/previous, ⌘1–9, how many closed tabs to remember, where one reopens, whether a window is still on screen, where tabs show and what Show Tab Sidebar changes, and which tabs may go to sleep). Main puts them to sleep by closing their page and gives them a new one when shown. `url.js`, `quicksearch.js`, `tabs.js`, `menus.js`, `commands.js`, `settings.js`, `history.js`, `bookmarks.js`, `session.js`, `shortcuts.js`, `downloads.js`, `find.js`, `zoom.js`, `permissions.js`, `passwords.js`, `page.js` (its choice of fields), `share.js`, `signin.js`, `passkeys.js`, `errors.js`, `profiles.js` and `adblock.js` (with the engine replaced) are plain Node, tested in `test/`.
