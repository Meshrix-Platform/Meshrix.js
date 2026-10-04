#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adapterDescriptors } from "./client-adapter-components.mjs";
import { sanitizeError } from "./lib/repository.mjs";

function exec(command, args, cwd, input = "", env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(sanitizeError(stderr || stdout))));
    child.stdin.end(input);
  });
}

function parseResponse(stdout, label) {
  try { return JSON.parse(stdout); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

async function main() {
  const descriptors = await adapterDescriptors();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-client-adapters-"));
  try {
    const home = path.join(temporaryRoot, "home");
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
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
      "if (args[0] === 'plugin') process.exit(0);",
      "process.exit(1);"
    ].join("\n"), { mode: 0o700 });

    const request = {
      schemaVersion: "v0.0.1:meshrix:client-adapter-json-stdio-1",
      baseUrl: "http://127.0.0.1:3010",
      tokenEnv: "MESHRIX_MCP_TOKEN",
      connector: { command: process.execPath, args: ["connector.mjs"] },
      client: { command: fakeClient }
    };
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MESHRIX_ADAPTER_SMOKE_STATE: fakeState
    };

    for (const { descriptor, packageJson } of descriptors) {
      const entrypoint = fileURLToPath(import.meta.resolve(`${packageJson.name}/${descriptor.entrypoint}`));
      const response = parseResponse((await exec(process.execPath, [entrypoint, "describe"], temporaryRoot, "", env)).stdout, `${descriptor.target} describe`);
      if (!response.ok || response.result?.target !== descriptor.target ||
          response.result?.packageName !== packageJson.name || response.result?.version !== packageJson.version ||
          response.result?.protocol !== descriptor.protocol) {
        throw new Error(`Bundled client adapter descriptor failed: ${descriptor.target}`);
      }
      if (descriptor.target === "pi") {
        await import(import.meta.resolve(`${packageJson.name}/extension.mjs`));
      }
    }

    for (const target of ["codex", "pi"]) {
      const { descriptor, packageJson } = descriptors.find((item) => item.descriptor.target === target);
      const entrypoint = fileURLToPath(import.meta.resolve(`${packageJson.name}/${descriptor.entrypoint}`));
      const targetRequest = target === "codex"
        ? { ...request, client: { ...request.client, marketplaceRoot: path.join(temporaryRoot, "marketplace") } }
        : { ...request, client: { ...request.client, configPath: path.join(temporaryRoot, "pi.json") } };
      const installed = parseResponse((await exec(process.execPath, [entrypoint, "install"], temporaryRoot, JSON.stringify(targetRequest), env)).stdout, `${target} install`);
      if (!installed.ok || !installed.result?.installed) throw new Error(`${target} bundled install smoke failed`);
      if (target === "pi") {
        const state = JSON.parse(await fs.readFile(fakeState, "utf8"));
        if (await fs.realpath(state.source) !== await fs.realpath(path.dirname(entrypoint))) {
          throw new Error("Pi did not reuse the installed root-component source directory");
        }
      }
      const removed = parseResponse((await exec(process.execPath, [entrypoint, "uninstall"], temporaryRoot, JSON.stringify(targetRequest), env)).stdout, `${target} uninstall`);
      if (!removed.ok || removed.result?.installed !== false) throw new Error(`${target} bundled uninstall smoke failed`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, adapterCount: descriptors.length, source: "meshrix-root-workspace" })}\n`);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
