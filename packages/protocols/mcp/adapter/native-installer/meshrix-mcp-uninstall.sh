#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ! -f "$SCRIPT_DIR/meshrix-mcp-install.sh" ]; then
  printf '%s\n' "The verified installer entrypoint is required for uninstall." >&2
  exit 1
fi

exec "$SCRIPT_DIR/meshrix-mcp-install.sh" uninstall "$@"
