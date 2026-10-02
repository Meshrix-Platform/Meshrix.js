#!/usr/bin/env node
import { isDirectCliEntry, runCli } from "@meshrix/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp";

if (isDirectCliEntry(import.meta.url)) {
  await runCli();
}
