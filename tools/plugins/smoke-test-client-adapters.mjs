#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { adapterBuildRoot, packClientAdapters } from "./client-adapter-packages.mjs";
import { sanitizeError } from "./lib/repository.mjs";

function exec(command, args, cwd, input = "") {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.npm_config_allow_scripts;
    delete env.NPM_CONFIG_ALLOW_SCRIPTS;
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(sanitizeError(stderr || stdout))));
    child.stdin.end(input);
  });
}

function parseResponse(stdout, label) {
  try { return JSON.parse(stdout); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

async function main() {
  const index = await packClientAdapters();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-client-adapters-"));
  try {
    await fs.writeFile(path.join(temporaryRoot, "package.json"), '{"private":true,"type":"module"}\n');
    const archives = [index.kit, ...index.packages].map((record) => path.join(adapterBuildRoot, record.fileName));
    await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...archives], temporaryRoot);
    await exec("npm", ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], temporaryRoot);
    for (const record of index.packages) {
      const entrypoint = path.join(temporaryRoot, "node_modules", ...record.packageName.split("/"), record.entrypoint);
      const result = await exec(process.execPath, [entrypoint, "describe"], temporaryRoot);
      const response = parseResponse(result.stdout, `${record.target} describe`);
      if (!response.ok || response.result?.target !== record.target || response.result?.protocol !== record.protocol) {
        throw new Error(`Client adapter clean smoke failed: ${record.target}`);
      }
      if (record.target === "pi") {
        await import(pathToFileURL(path.join(path.dirname(entrypoint), "extension.mjs")).href);
      }
    }
    const fakeClient = path.join(temporaryRoot, "fake-client.mjs");
    const fakeState = path.join(temporaryRoot, "fake-state.json");
    await fs.writeFile(fakeClient, [
      "#!/usr/bin/env node",
      "const fs = await import('node:fs');",
      "const file = process.env.MESHRIX_ADAPTER_SMOKE_STATE;",
      "const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
      "const args = process.argv.slice(2);",
      "const save = () => fs.writeFileSync(file, JSON.stringify(state));",
      "if (args[0] === 'list') { if (state.pi) console.log('@meshrix/agent-pi-adapter'); process.exit(0); }",
      "if (args[0] === 'install' && args[1] === '--help') { console.log('pi install <source>'); process.exit(0); }",
      "if (args[0] === 'install') { state.pi = true; state.source = args[1]; save(); process.exit(0); }",
      "if (args[0] === 'remove') { state.pi = false; save(); process.exit(0); }",
      "if (args[0] === 'mcp' && args[1] === 'get') { if (state.codex) console.log('lico'); process.exit(state.codex ? 0 : 1); }",
      "if (args[0] === 'mcp' && args[1] === 'add') { state.codex = true; save(); process.exit(0); }",
      "if (args[0] === 'mcp' && args[1] === 'remove') { state.codex = false; save(); process.exit(0); }",
      "process.exit(1);"
    ].join("\n"), { mode: 0o700 });
    const previousState = process.env.MESHRIX_ADAPTER_SMOKE_STATE;
    process.env.MESHRIX_ADAPTER_SMOKE_STATE = fakeState;
    try {
      const request = { schemaVersion: "v0.0.1:meshrix:client-adapter-json-stdio-1", baseUrl: "http://127.0.0.1:3010", tokenEnv: "MESHRIX_MCP_TOKEN", connector: { command: process.execPath, args: ["connector.mjs"] }, client: { command: fakeClient } };
      for (const target of ["codex", "pi"]) {
        const record = index.packages.find((item) => item.target === target);
        const entrypoint = path.join(temporaryRoot, "node_modules", ...record.packageName.split("/"), record.entrypoint);
        const targetRequest = target === "codex"
          ? { ...request, client: { ...request.client, marketplaceRoot: path.join(temporaryRoot, "marketplace") } }
          : { ...request, client: { ...request.client, configPath: path.join(temporaryRoot, "pi.json") } };
        const installed = parseResponse((await exec(process.execPath, [entrypoint, "install"], temporaryRoot, JSON.stringify(targetRequest))).stdout, `${target} install`);
        if (!installed.ok || !installed.result?.installed) throw new Error(`${target} clean install smoke failed`);
        if (target === "pi") {
          const state = JSON.parse(await fs.readFile(fakeState, "utf8"));
          if (await fs.realpath(state.source) !== await fs.realpath(path.dirname(entrypoint))) throw new Error("Pi did not reuse the verified local package source");
        }
        const removed = parseResponse((await exec(process.execPath, [entrypoint, "uninstall"], temporaryRoot, JSON.stringify(targetRequest))).stdout, `${target} uninstall`);
        if (!removed.ok || removed.result?.installed !== false) throw new Error(`${target} clean uninstall smoke failed`);
      }
    } finally {
      if (previousState === undefined) delete process.env.MESHRIX_ADAPTER_SMOKE_STATE;
      else process.env.MESHRIX_ADAPTER_SMOKE_STATE = previousState;
    }
    console.log(JSON.stringify({ ok: true, adapterCount: index.packages.length }));
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
