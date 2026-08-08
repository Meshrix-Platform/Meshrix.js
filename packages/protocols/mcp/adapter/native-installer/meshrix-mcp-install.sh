#!/usr/bin/env sh
set -eu

JSON_OUTPUT=0
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

fail() {
  if [ "$JSON_OUTPUT" = "1" ]; then
    printf '{"ok":false,"error":"native_installer_security_requirement_failed"}\n'
  else
    printf '%s\n' "$1" >&2
  fi
  exit 1
}

valid_env_name() {
  case "$1" in
    ""|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;;
    *) return 0 ;;
  esac
}

validate_arguments() {
  expect_env_name=0
  for argument in "$@"; do
    [ "$argument" = "--json" ] && JSON_OUTPUT=1
    if [ "$expect_env_name" = "1" ]; then
      valid_env_name "$argument" ||
        fail "Invalid --token-env name. Use letters, digits, and underscores with a non-digit first character."
      expect_env_name=0
      continue
    fi
    case "$argument" in
      *mxak1.*)
        fail "Raw API Keys are not accepted in process arguments. Use --token-stdin or an exported API Key environment variable."
        ;;
      --token|--token=*)
        fail "Raw API Keys are not accepted in process arguments. Use --token-stdin or an exported API Key environment variable."
        ;;
      --token-env)
        expect_env_name=1
        ;;
      --token-env=*)
        token_env_name=${argument#--token-env=}
        valid_env_name "$token_env_name" ||
          fail "Invalid --token-env name. Use letters, digits, and underscores with a non-digit first character."
        ;;
    esac
  done
  [ "$expect_env_name" = "0" ] ||
    fail "--token-env requires an environment variable name."
}

exec_connector() {
  connector="$1"
  shift
  case "$connector" in
    *.ts)
      command -v node >/dev/null 2>&1 ||
        fail "The repository connector requires Node.js. Use a verified portable release bundle when Node.js is unavailable."
      exec node "$connector" "$@"
      ;;
    *)
      [ -x "$connector" ] ||
        fail "The configured MCP connector is not executable."
      exec "$connector" "$@"
      ;;
  esac
}

resolve_and_exec_connector() {
  if [ -x "$SCRIPT_DIR/meshrix-mcp" ]; then
    exec_connector "$SCRIPT_DIR/meshrix-mcp" "$@"
  fi

  repository_connector="$SCRIPT_DIR/../gateway-installer/bin/meshrix-mcp.ts"
  if [ -f "$repository_connector" ]; then
    exec_connector "$repository_connector" "$@"
  fi

  fail "No verified Meshrix.js MCP connector was found. Download a release bundle, verify its published SHA256, extract it, and run this script from that bundle."
}

main() {
  validate_arguments "$@"
  if [ "$#" -eq 0 ]; then
    set -- install
  else
    case "$1" in
      install|register|scan|discover-local|uninstall|doctor|help|version) ;;
      *) set -- install "$@" ;;
    esac
  fi
  resolve_and_exec_connector "$@"
}

main "$@"
