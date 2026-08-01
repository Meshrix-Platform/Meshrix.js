export function remoteTokenEnvScript() {
    return [
        "set -e",
        "IFS= read -r token",
        "env_name=\"$MESHRIX_TOKEN_ENV\"",
        "case \"$env_name\" in",
        "  ''|*[!A-Za-z0-9_]*|[0-9]*) echo 'invalid token env' >&2; exit 2 ;;",
        "esac",
        "mkdir -p \"$HOME/.meshrix/mcp\"",
        "umask 077",
        "escaped=$(printf '%s' \"$token\" | sed \"s/'/'\\\\''/g\")",
        "printf \"export %s='%s'\\n\" \"$env_name\" \"$escaped\" > \"$HOME/.meshrix/mcp/env\"",
        "profile=\"$HOME/.profile\"",
        "if ! grep -q 'Meshrix MCP token env' \"$profile\" 2>/dev/null; then",
        "  printf '\\n# Meshrix MCP token env\\n[ -f \"$HOME/.meshrix/mcp/env\" ] && . \"$HOME/.meshrix/mcp/env\"\\n' >> \"$profile\"",
        "fi"
    ].join("\n");
}
export function orbRuntimeEnv() {
    const home = String(process.env.MESHRIX_MCP_ORB_HOME || "").trim();
    return home ? { HOME: home } : {};
}
//# sourceMappingURL=remote-client-support.js.map