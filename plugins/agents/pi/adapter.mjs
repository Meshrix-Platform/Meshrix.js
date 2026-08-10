#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientCommand, connectorFrom, descriptor, homePath, isDirectInvocation, run, runAdapterCli, writeJson
} from "@meshrix/client-adapter-kit";

const PACKAGE_NAME = "@meshrix/agent-pi-adapter";
const LOCAL_PACKAGE_SOURCE = path.dirname(fileURLToPath(import.meta.url));
export const description = descriptor({ target: "pi", label: "Pi", version: "0.0.1", packageName: PACKAGE_NAME, commandNames: ["pi"], installMode: "external-client-adapter" });
function configPath(request) { return String(request?.client?.configPath || homePath(".lico", "mcp", "pi.json")); }
function packageSource(request) { return String(request?.client?.packageSource || LOCAL_PACKAGE_SOURCE); }
async function packageInstalled(command, source) { const result = await run(command, ["list"], { allowFailure: true }); return result.ok && (result.stdout.includes(PACKAGE_NAME) || result.stdout.includes(source)); }
export const adapter = {
  description,
  async scan(request) { const command = clientCommand(request, "pi"); const probe = await run(command, ["install", "--help"], { allowFailure: true }); const available = probe.ok && /pi install <source>/iu.test(`${probe.stdout}\n${probe.stderr}`); return { available, installed: available && await packageInstalled(command, packageSource(request)) }; },
  async install(request) { const command = clientCommand(request, "pi"); const source = packageSource(request); if (!await packageInstalled(command, source)) await run(command, ["install", source]); const connector = connectorFrom(request, "pi"); await writeJson(configPath(request), { serverName: "lico", command: connector.command, args: connector.args }); return { installed: await packageInstalled(command, source) }; },
  async verify(request) { return { installed: await packageInstalled(clientCommand(request, "pi"), packageSource(request)) }; },
  async uninstall(request) { const command = clientCommand(request, "pi"); const source = packageSource(request); const existed = await packageInstalled(command, source); await run(command, ["remove", source], { allowFailure: true }); await fs.rm(configPath(request), { force: true }); return { removed: existed, installed: await packageInstalled(command, source) }; }
};
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
