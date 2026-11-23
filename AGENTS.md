# Agent notes

- Settings: when you add a user-facing behavior with a choice people could reasonably want different (an engine, a default, a toggle), make it a setting in `SECTIONS` in `src/settings.js`, not a hard-coded constant. Put it in the section where people would look for it, read it in main from `settings`, and list it in the README. When you change or remove behavior a setting controls, update or remove the setting too.
