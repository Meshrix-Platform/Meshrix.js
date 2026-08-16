# Meshrix.js MCP Native Installer

This directory owns the user-device MCP installer entrypoints.

After the release gate passes, the user entrypoints are platform-native:

- macOS and Linux use `meshrix-mcp-install.sh` and `meshrix-mcp-uninstall.sh`.
- Windows uses `meshrix-mcp-install.ps1` and `meshrix-mcp-uninstall.ps1`.
- Windows entrypoints use the PowerShell scripts exclusively.

The scripts are narrow launchers. They reject API Keys in arguments, validate
environment-variable names, and delegate to the connector from the same verified
portable bundle. The connector exclusively owns signed hub discovery, local
agent search, batch install, interactive selection, client config, and local
uninstall. A pre-issued strict `mxak1` API Key must be supplied through protected
standard input or the configured environment variable. Shell and PowerShell
remain narrow launchers for that connector-owned workflow.

Supported targets are backed by pinned operator-provided client-adapter packages. No client-specific runtime, command probing, configuration mutation, or compatibility test is embedded in Core.

This release currently installs local connector-managed clients. OrbStack and
remote-Linux direct HTTP client modes remain remaining qualification work and
currently fail before installation because they are outside the published
target matrix.

After GitHub Release publication, download a versioned portable archive,
`RELEASE_SHA256SUMS`, and `RELEASE_SHA256SUMS.sigstore.json`. Verify the
Sigstore bundle against the exact release workflow identity and GitHub Actions
issuer, then use the signed checksum to verify the archive before running these
local entrypoints. The MCP-local `SHA256SUMS` is not an independent release
authority. Never pipe a remote response to a shell.

## POSIX

```bash
packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh
packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh --target auto --json
packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh --target openclaw,codex,claude-code,antigravity,opencode,pi,kimi --json
packages/protocols/mcp/adapter/native-installer/meshrix-mcp-uninstall.sh --target openclaw,codex,claude-code,antigravity,opencode,pi,kimi
```

## Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\packages\protocols\mcp\adapter\native-installer\meshrix-mcp-install.ps1 -Command install
powershell -ExecutionPolicy Bypass -File .\packages\protocols\mcp\adapter\native-installer\meshrix-mcp-install.ps1 -Command install -Target auto -Json
powershell -ExecutionPolicy Bypass -File .\packages\protocols\mcp\adapter\native-installer\meshrix-mcp-uninstall.ps1 -Target openclaw,codex,claude-code,antigravity,opencode,pi,kimi
```
