import { runCli } from "../../packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts";

await runCli(["install", ...process.argv.slice(2)]);
