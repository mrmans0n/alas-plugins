#!/usr/bin/env bash
# Builds this plugin and installs it into the Alas plugins folder, using this
# folder's name as the install folder. Copy the whole directory to start your own.
# Needs Node.js; run `npm install` at the repository root once.
set -euo pipefail
cd "$(dirname "$0")"
npm run --silent build
# ALAS_APP_SUPPORT_DIR installs into an isolated Alas profile instead of the everyday one.
dest="${ALAS_APP_SUPPORT_DIR:-$HOME/Library/Application Support/Alas}/Plugins/$(basename "$PWD")"
mkdir -p "$dest"
cp plugin.json "$dest/plugin.json"
cp dist/plugin.js "$dest/plugin.js"
cp dist/ui.js "$dest/ui.js"
rm -f "$dest/plugin.wasm"
echo "Installed to $dest"
