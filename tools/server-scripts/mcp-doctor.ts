import { runCli } from "@meshrix/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp";

await runCli(["doctor", "--json", ...process.argv.slice(2)]);
