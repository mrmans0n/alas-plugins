#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npm run --silent build
dest="${ALAS_APP_SUPPORT_DIR:-$HOME/Library/Application Support/Alas}/Plugins/$(basename "$PWD")"
mkdir -p "$dest"
cp plugin.json "$dest/plugin.json"
cp dist/plugin.js "$dest/plugin.js"
cp dist/ui.js "$dest/ui.js"
echo "Installed to $dest"
