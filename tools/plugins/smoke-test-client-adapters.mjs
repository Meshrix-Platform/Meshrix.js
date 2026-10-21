#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { adapterDescriptors } from "./client-adapter-components.mjs";
import { repoRoot, sanitizeError } from "./lib/repository.mjs";

function exec(command, args, cwd, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.resume();
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      try { resolve({ code, ...JSON.parse(stdout) }); }
      catch { reject(new Error("Bundled client adapter returned invalid JSON")); }
    });
    child.stdin.end(input);
  });
}

async function main() {
  const descriptors = await adapterDescriptors();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-client-adapters-"));
  try {
    const home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const fakeClient = path.join(root, "client");
    await fs.copyFile(path.join(repoRoot, "tests/plugins/fixtures/fake-mcp-client.mjs"), fakeClient);
    await fs.chmod(fakeClient, 0o700);
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot };
    const supported = [], unsupported = [];
    for (const { descriptor, packageJson } of descriptors) {
      const target = descriptor.target;
      const entrypoint = fileURLToPath(import.meta.resolve(`${packageJson.name}/${descriptor.entrypoint}`));
      const invoke = (action, request = {}) => exec(process.execPath, [entrypoint, action], root, JSON.stringify(request), env);
      const described = await invoke("describe");
      if (!described.ok || described.result?.target !== target || described.result?.packageName !== packageJson.name || described.result?.version !== packageJson.version || described.result?.protocol !== descriptor.protocol) throw new Error(`Bundled adapter descriptor failed: ${target}`);
      const configPath = path.join(root, target, target === "codex" ? "config.toml" : "mcp.json");
      const request = {
        schemaVersion: descriptor.protocol,
        baseUrl: "https://gateway.invalid", serverName: "work",
        credentialRef: { kind: "env", name: "MESHRIX_WORK_KEY" },
        client: { command: fakeClient, configPath, marketplaceRoot: path.join(root, "marketplace") }
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const installed = await invoke("install", request);
      if (!described.result.nativeRegistration.supported) {
        if (installed.ok || installed.error?.code !== "unsupported_protected_header_reference") throw new Error(`Unsupported capability was not rejected: ${target}`);
        try { await fs.stat(configPath); throw new Error(`Unsupported adapter mutated configuration: ${target}`); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        unsupported.push(target);
        continue;
      }
      if (!installed.ok || installed.result?.status !== "configured" || installed.result?.connectivity !== "not-run") throw new Error(`Bundled native configuration failed: ${target}`);
      const text = await fs.readFile(configPath, "utf8");
      const config = target === "codex" ? parseToml(text) : JSON.parse(text);
      const entries = target === "codex" ? config.mcp_servers : target === "opencode" ? config.mcp : target === "openclaw" ? config.mcp.servers : config.mcpServers;
      const entry = entries.work;
      if (entry.url !== `${request.baseUrl}/mcp` || entry.command || entry.args || !JSON.stringify(entry).includes("MESHRIX_WORK_KEY")) throw new Error(`Native endpoint/reference was not written: ${target}`);
      const verified = await invoke("verify", request);
      if (!verified.ok || !verified.result.installed) throw new Error(`Exact native verification failed: ${target}`);
      const removed = await invoke("uninstall", request);
      if (!removed.ok || removed.result?.installed !== false || removed.result?.credentialsPreserved !== true) throw new Error(`Credential-safe removal failed: ${target}`);
      supported.push(target);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, adapterCount: descriptors.length, supported, unsupported, connectivity: "not-run", source: "meshrix-root-workspace" })}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
