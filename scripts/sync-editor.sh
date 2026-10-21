#!/usr/bin/env bash
# Refresh docs/editor/ from a look-webCLI checkout (the editor build is built and patched there; see its scripts/).
#   scripts/sync-editor.sh ../look-webCLI
set -euo pipefail
src="${1:?usage: scripts/sync-editor.sh <path-to-look-webCLI>}/docs/editor"
dst="$(cd "$(dirname "$0")/.." && pwd)/docs/editor"
[ -f "$src/index.html" ] || { echo "no editor build at $src" >&2; exit 1; }
rm -rf "$dst"
cp -R "$src" "$dst"
echo "docs/editor/ refreshed from $src. Run: npm test"
