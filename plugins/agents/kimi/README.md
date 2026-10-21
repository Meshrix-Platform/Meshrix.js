# Kimi Code Agent Adapter

Bundled private component: `@meshrix/agent-kimi-adapter` (`agent-kimi`).

Current Kimi Code reads `$KIMI_CODE_HOME/mcp.json`, default
`~/.kimi-code/mcp.json`. `client.configPath` and `client.configRoot` override this
location. Archived Python Kimi CLI's `.kimi` configuration is not the current path.

Native remote transport exists, but the verified protected reference is
`bearerTokenEnvVar`. Meshrix requires an `mxak1` value in
`X-Meshrix.js-Api-Key` and rejects Bearer authentication. Protected arbitrary-header
interpolation has not been qualified.

Consequently native installation returns `unsupported_protected_header_reference`
before accessing or changing configuration. It never substitutes plaintext headers,
another credential, OAuth or a local proxy. Scan and verification do not report the
combination as configured. Removal can remove an exactly identified prior generated
proxy for the same binding while preserving credentials; other entries are untouched.

See the [shared contract](../client-adapter-kit/README.md) and
[current official MCP documentation](https://moonshotai.github.io/kimi-code/en/customization/mcp.html).
