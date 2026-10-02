# Meshrix.js MCP Installation

The MCP installer is implemented once in the `meshrix.js` Node.js package. Its
`meshrix-mcp` executable owns argument validation, credential handling,
discovery, client configuration and registration, and uninstall. The former
standalone shell and PowerShell installer copies are retired.

After the release gate passes, install or update through the public package
entrypoint:

```sh
npx --yes --package meshrix.js@<version> meshrix-mcp install
npx --yes --package meshrix.js@<version> meshrix-mcp register
npx --yes --package meshrix.js@<version> meshrix-mcp doctor --json
```

Use `--target` to select a supported client. Supply credentials through a
protected environment variable or standard input; never place an API key in
command arguments. Use `--no-env` when registration should not persist the
non-secret discovery environment values.

After GitHub Release publication, a verified portable archive is also
available for systems without a separately installed Node.js runtime. Verify
the archive against the release workflow's Sigstore bundle and signed
`RELEASE_SHA256SUMS` before extracting it. The archive contains a small
platform launcher and the verified Node runtime; all installer behavior
continues to execute through the same `meshrix-mcp` Node CLI. Run
`./meshrix-mcp` on POSIX systems or `./meshrix-mcp.ps1` in PowerShell on
Windows.
