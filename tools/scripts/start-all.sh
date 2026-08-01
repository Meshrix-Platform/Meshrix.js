#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--conditions=source"
exec node "${SCRIPT_DIR}/start-all.ts" "$@"
