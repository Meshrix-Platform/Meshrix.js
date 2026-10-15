#!/usr/bin/env bash
# Build the entry-gui debug binary, install it into /Applications, relaunch.
# Idempotent: safe to run after every GUI change.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="/Applications/Meshrix Entry.app"
BIN="$ROOT/target/debug/meshrix-entry-gui"

cargo build --manifest-path "$ROOT/Cargo.toml" -p meshrix-entry-gui
mkdir -p "$APP/Contents/MacOS"
if [ -f "$APP/Contents/MacOS/meshrix-entry-gui" ] && [ ! -f "$APP/Contents/MacOS/meshrix-entry-gui.bak" ]; then
  cp "$APP/Contents/MacOS/meshrix-entry-gui" "$APP/Contents/MacOS/meshrix-entry-gui.bak"
fi
cp "$BIN" "$APP/Contents/MacOS/meshrix-entry-gui"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
pkill -f "Meshrix Entry.app" 2>/dev/null || true
sleep 0.5
open "$APP"
echo "redeployed: $APP"
