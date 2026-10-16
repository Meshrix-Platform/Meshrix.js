#!/usr/bin/env bash
# Build the entry-gui debug binary, install it into /Applications, relaunch.
# Idempotent: safe to run after every GUI change.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP="/Applications/Meshrix Entry.app"
BIN="$ROOT/target/debug/meshrix-entry-gui"
APP_PARENT="$(dirname "$APP")"
APP_BINARY="$APP/Contents/MacOS/meshrix-entry-gui"
LEGACY_BACKUP="$APP_BINARY.bak"

backup_path() {
  local base="$APP_PARENT/Meshrix Entry.app.meshrix-entry-gui.backup"
  local candidate="$base"
  local suffix=1
  while [ -e "$candidate" ]; do
    candidate="$base.$suffix"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "$candidate"
}

stop_binary() {
  pkill -TERM -f -x "$1" 2>/dev/null || {
    status=$?
    if [[ "$status" -ne 1 ]]; then return "$status"; fi
  }
  while pgrep -f -x "$1" >/dev/null; do
    sleep 0.1
  done
}

cargo build --manifest-path "$ROOT/Cargo.toml" -p meshrix-entry-gui
stop_binary "$APP_BINARY"
stop_binary "$BIN"
mkdir -p "$APP/Contents/MacOS"
preserved_existing=false
if [ -f "$LEGACY_BACKUP" ]; then
  mv "$LEGACY_BACKUP" "$(backup_path)"
  preserved_existing=true
fi
if [ -f "$APP_BINARY" ] && [ "$preserved_existing" != true ]; then
  cp "$APP_BINARY" "$(backup_path)"
fi
cp "$BIN" "$APP_BINARY"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
open "$APP"
echo "redeployed: $APP"
