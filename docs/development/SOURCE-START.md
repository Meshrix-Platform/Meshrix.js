# Source startup entry

The root READMEs expose one local source-checkout command:

```bash
node tools/start.mjs
```

Download and extract the repository first. Node.js 24 and npm are prerequisites;
this is not a globally published npm installer and does not download Node.js.
The command works without an existing `node_modules` directory. It resolves the
checkout from its own file location rather than the caller's working directory.

## Command ownership

`tools/start.mjs` is a dependency-free convenience entry over existing commands:

| Step | Existing implementation | Outcome |
| --- | --- | --- |
| Dependencies | `npm ci` | Install exactly the lockfile dependency set. |
| Build | `npm run build` | Build the server packages and Web Console. |
| Console | `tools/server-scripts/start-server.ts` | Start the Core server with the built console, on loopback port 7228. |

The entry runs these steps sequentially on each invocation. It does not claim a
warm-start cache: dependency installation and build work are repeated. The
existing local lifecycle and service commands remain available in the
[Runbook](../RUNBOOK.md#local-startup) for normal operation after setup.

The entry passes `--conditions=source` to Node.js and `--profile core`,
`--host 127.0.0.1`, `--port 7228`, `--with-ui`, and `--strict-port` to the
existing server. It adds no alternative server, deployment stage engine,
plugin selection, authorization path, or npm package-script alias. The
existing package registry continues to own the npm commands it invokes.

An occupied port is checked before dependency installation. The entry reports
the conflict without stopping the existing process, changing ports, or
replacing its data. The server's own strict-port handling remains the final
check for races. Any failed step stops the sequence and returns a nonzero exit
status. Ctrl+C stops the launcher's own child process tree. No success message
is printed on behalf of the server before it has started.

This entry is for a local source trial. Production deployment, credentials,
upgrades, instance reuse, and stop/restart operations stay in the existing
[Runbook](../RUNBOOK.md); none is reimplemented here.

## Tests

The dependency-free cases can run before npm installation:

```bash
node --test tests/lib/source-start-cases.mjs
```

They are also registered with existing Vitest discovery through
`tests/vitest/server/source-start.test.ts`:

```bash
npm run vitest -- tests/vitest/server/source-start.test.ts
```

The cases cover command order, supported source-running Node versions,
Windows npm invocation, checkout/lockfile checks, port-conflict short circuit,
step failures, subprocess exit codes, and signal-listener cleanup. Their
injected command runner does not install the real dependency graph or boot
the real console. Run the full source command in a clean checkout with Node.js
24, then check the console and shutdown, before claiming end-to-end startup
verification. Windows command construction is not Windows execution evidence.
