import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { readJson, repoRoot, sanitizeError } from "./lib/repository.mjs";

export const adapterBuildRoot = path.join(repoRoot, "build", "adapters");
export const adapterTargets = Object.freeze(["antigravity", "claude-code", "codex", "kimi", "openclaw", "opencode", "pi"]);
export const kitRoot = path.join(repoRoot, "plugins", "agents", "client-adapter-kit");

function exec(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(sanitizeError(stderr || stdout))));
  });
}

export async function adapterDescriptors() {
  const descriptors = [];
  for (const target of adapterTargets) {
    const root = path.join(repoRoot, "plugins", "agents", target);
    const descriptor = await readJson(path.join(root, "adapter.json"));
    const packageJson = await readJson(path.join(root, "package.json"));
    if (descriptor.schemaVersion !== "v0.0.1:meshrix:client-adapter-descriptor-1" ||
        descriptor.protocol !== "v0.0.1:meshrix:client-adapter-json-stdio-1" || descriptor.target !== target ||
        descriptor.packageName !== packageJson.name || descriptor.version !== packageJson.version ||
        descriptor.entrypoint !== "adapter.mjs" || !packageJson.bin?.[`meshrix-agent-${target}-adapter`]) {
      throw new Error(`Client adapter descriptor is invalid: ${target}`);
    }
    const actions = ["describe", "scan", "install", "verify", "uninstall"];
    if (JSON.stringify(descriptor.actions) !== JSON.stringify(actions) || JSON.stringify(descriptor.locations) !== '["local"]') {
      throw new Error(`Client adapter capabilities are invalid: ${target}`);
    }
    descriptors.push({ root, descriptor, packageJson });
  }
  return descriptors;
}

async function packOne(root) {
  const result = await exec("npm", ["pack", "--json", "--pack-destination", adapterBuildRoot], root);
  const parsed = JSON.parse(result.stdout);
  const record = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!record?.filename) throw new Error("npm pack did not return an archive name");
  const bytes = await fs.readFile(path.join(adapterBuildRoot, record.filename));
  return { fileName: record.filename, byteSize: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

export async function packClientAdapters() {
  await fs.rm(adapterBuildRoot, { recursive: true, force: true });
  await fs.mkdir(adapterBuildRoot, { recursive: true, mode: 0o700 });
  const kitPackage = await readJson(path.join(kitRoot, "package.json"));
  const kitArchive = await packOne(kitRoot);
  const packages = [];
  for (const item of await adapterDescriptors()) {
    const archive = await packOne(item.root);
    packages.push({
      pluginId: `agent-${item.descriptor.target}`,
      target: item.descriptor.target,
      packageName: item.packageJson.name,
      version: item.packageJson.version,
      entrypoint: item.descriptor.entrypoint,
      protocol: item.descriptor.protocol,
      ...archive
    });
  }
  const index = {
    schemaVersion: "v0.0.1:client-adapter:release-index-1",
    kit: { packageName: kitPackage.name, version: kitPackage.version, ...kitArchive },
    packages
  };
  await fs.writeFile(path.join(adapterBuildRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  packClientAdapters().then((index) => console.log(JSON.stringify({ ok: true, adapterCount: index.packages.length }))).catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
}
