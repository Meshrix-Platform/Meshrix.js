#!/usr/bin/env node
// Deterministic upstream service fixture for Meshrix gateway verification.
//
// Standalone HTTP mode (REST API + OpenAPI document + MCP JSON-RPC at /mcp):
//   node tools/server-scripts/upstream-fixture-service.ts --mode http --port 8091
// MCP stdio mode (newline-delimited JSON-RPC on stdin/stdout):
//   node tools/server-scripts/upstream-fixture-service.ts --mode mcp-stdio
//
// When the token environment variable (default MESHRIX_UPSTREAM_FIXTURE_TOKEN) is
// set, HTTP endpoints under /api and /mcp require `Authorization: Bearer <token>`
// and the session.identity surfaces report a hash proof of the received token.
import {
  UPSTREAM_FIXTURE_TOKEN_ENV,
  createUpstreamFixtureHttpService,
  runUpstreamFixtureMcpStdio
} from "./lib/upstream-fixture-service.ts";

function parseArgs(argv: any = []) : any {
  const options: Record<string, any> = { mode: "http", host: "127.0.0.1", port: 0, tokenEnv: UPSTREAM_FIXTURE_TOKEN_ENV };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    const next: any = () : any => String(argv[++index] ?? "");
    if (arg === "--mode") options.mode = next();
    else if (arg === "--host") options.host = next();
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--token-env") options.tokenEnv = next();
    else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exit(64);
    }
  }
  if (!["http", "mcp-stdio"].includes(options.mode)) {
    process.stderr.write(`Unsupported --mode: ${options.mode} (expected http or mcp-stdio)\n`);
    process.exit(64);
  }
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) {
    process.stderr.write(`Invalid --port: ${options.port}\n`);
    process.exit(64);
  }
  return options;
}

const options: any = parseArgs(process.argv.slice(2));
const token: any = String(process.env[options.tokenEnv] || "").trim();

if (options.mode === "mcp-stdio") {
  runUpstreamFixtureMcpStdio({ token });
} else {
  const service: any = createUpstreamFixtureHttpService({ token });
  const started: any = await service.start({ host: options.host, port: options.port });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "http",
    url: started.url,
    authRequired: Boolean(token),
    tokenEnv: options.tokenEnv
  })}\n`);
  const shutdown: any = async () : Promise<any> => {
    await started.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
