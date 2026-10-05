#!/usr/bin/env python3
"""Adds one released plugin version to index.json.

Usage: update-index.py <folder> <tag> <plugin.json> <hash>

Only the released version's entry is written. Other versions are kept as they are, including
WebAssembly-era entries (api 1 to 3, a "wasm" URL and no "entry"), which Alas skips.
A manifest with a page (API 12 `web`) also gets the release's page asset as `web`, named like the file.
"""
import json
import os
import sys

REPO = "https://github.com/mrmans0n/alas-plugins"

folder, tag, manifest_path, digest = sys.argv[1:5]
manifest = json.load(open(manifest_path))
index = json.load(open("index.json"))

plugin = next((p for p in index["plugins"] if p["id"] == manifest["id"]), None)
if plugin is None:
    plugin = {"id": manifest["id"], "versions": []}
    index["plugins"].append(plugin)
plugin["name"] = manifest["name"]
plugin["summary"] = manifest.get("summary", "")
plugin["homepage"] = f"{REPO}/tree/main/plugins/{folder}"

download = f"{REPO}/releases/download/{tag}"
version = {
    "version": manifest["version"],
    "api": manifest["api"],
    "capabilities": manifest.get("capabilities", []),
    "manifest": f"{download}/plugin.json",
    "entry": f"{download}/plugin.js",
}
if "web" in manifest:
    version["web"] = f"{download}/{os.path.basename(manifest['web'])}"
version["hash"] = digest
versions = [v for v in plugin["versions"] if v["version"] != version["version"]] + [version]
versions.sort(key=lambda v: [int(part) for part in v["version"].split(".")], reverse=True)
plugin["versions"] = versions
index["plugins"].sort(key=lambda p: p["id"])

with open("index.json", "w") as f:
    json.dump(index, f, indent=2)
    f.write("\n")
