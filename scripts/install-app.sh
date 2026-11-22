#!/bin/sh
# Build Lit.app and install it into /Applications, replacing any older copy.
# Run it again (npm run app) whenever you want the installed app updated.
set -e
cd "$(dirname "$0")/.."

npx electron-builder

# electron-builder names the folder by architecture (mac-arm64 or mac).
built=$(ls -d out/mac*/Lit.app | head -n 1)

# Quit the running copy so the new one starts fresh.
osascript -e 'quit app "Lit"' 2>/dev/null || true

rm -rf /Applications/Lit.app
ditto "$built" /Applications/Lit.app
echo "Installed /Applications/Lit.app"
open /Applications/Lit.app
