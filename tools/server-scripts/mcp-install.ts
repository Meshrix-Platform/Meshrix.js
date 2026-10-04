import { runCli } from "@meshrix/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp";

await runCli(["install", ...process.argv.slice(2)]);
