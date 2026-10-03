import { runCli } from "../../packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts";

await runCli(["doctor", "--json", ...process.argv.slice(2)]);
