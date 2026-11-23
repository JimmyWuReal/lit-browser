# Agent notes

- Settings: when you add a behavior people could reasonably want different (an engine, a default, a toggle), make it a setting in `SECTIONS` in `src/settings.js`, not a hard-coded constant. Put it in the section people would look in, read it from `settings` in main, and list it in the README's Settings section. When you change or remove that behavior, update or remove its setting.
- Shortcuts: a new menu command gets a `shortcut(...)` entry in the Keyboard Shortcuts section, and its menu item reads `key('<command>')`. A fixed accelerator that can't be changed goes in `RESERVED` in `src/shortcuts.js`.
