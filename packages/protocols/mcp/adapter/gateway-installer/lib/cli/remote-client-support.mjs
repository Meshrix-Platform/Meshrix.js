export function remoteTokenEnvScript() {
  return [
    "set -e",
    "IFS= read -r token",
    "env_name=\"$LICO_TOKEN_ENV\"",
    "case \"$env_name\" in",
    "  ''|*[!A-Za-z0-9_]*|[0-9]*) echo 'invalid token env' >&2; exit 2 ;;",
    "esac",
    "mkdir -p \"$HOME/.lico/mcp\"",
    "umask 077",
    "escaped=$(printf '%s' \"$token\" | sed \"s/'/'\\\\''/g\")",
    "printf \"export %s='%s'\\n\" \"$env_name\" \"$escaped\" > \"$HOME/.lico/mcp/env\"",
    "profile=\"$HOME/.profile\"",
    "if ! grep -q 'LicoMesh MCP token env' \"$profile\" 2>/dev/null; then",
    "  printf '\\n# LicoMesh MCP token env\\n[ -f \"$HOME/.lico/mcp/env\" ] && . \"$HOME/.lico/mcp/env\"\\n' >> \"$profile\"",
    "fi"
  ].join("\n");
}

export function orbRuntimeEnv() {
  const home = String(process.env.LICO_MCP_ORB_HOME || "").trim();
  return home ? { HOME: home } : {};
}
