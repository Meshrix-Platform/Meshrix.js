#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serviceRoot = path.join(root, "services", "model-gateway");
const pluginRoot = path.join(root, "plugins", "model-gateway");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(read(relativePath)) as Record<string, unknown>;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (/\.(?:mjs|ts)$/u.test(entry.name)) files.push(target);
  }
  return files.sort();
}

const servicePackage = readJson("services/model-gateway/package.json");
assert.deepEqual(servicePackage.dependencies ?? {}, {}, "standalone service must not depend on Meshrix packages");
assert.equal((servicePackage.scripts as Record<string, unknown>).start, "node src/main.mjs");

for (const file of sourceFiles(serviceRoot)) {
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()["']@meshrix\//u,
    `${path.relative(root, file)} must not import Meshrix runtime packages`);
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()["'](?:\.\.\/){2,}/u,
    `${path.relative(root, file)} must remain inside the standalone service root`);
}

const serviceDockerfile = read("services/model-gateway/Dockerfile");
assert.match(serviceDockerfile, /ENTRYPOINT \["node", "src\/main\.mjs"\]/u);
assert.doesNotMatch(serviceDockerfile, /COPY[^\n]*(?:packages|plugins|apps|tools)/u,
  "standalone service image must not copy Meshrix runtime roots");

const releaseDefinition = readJson("tools/registry/release-definition.registry.json");
const releaseManifests = (releaseDefinition.packages as { manifests?: unknown[] }).manifests ?? [];
assert.ok(!releaseManifests.includes("services/model-gateway/package.json"),
  "standalone service must not enter the runtime-ui package manifest set");
const runtimeDockerfile = read("Dockerfile");
assert.doesNotMatch(runtimeDockerfile, /COPY[^\n]*services(?:\/|\s)/u,
  "runtime-ui image must not copy standalone services");

const pluginPackage = readJson("plugins/model-gateway/package.json");
assert.deepEqual(pluginPackage.dependencies, { "@meshrix/contracts": "0.0.1" },
  "adapter may depend only on the neutral contract package");
const manifest = readJson("plugins/model-gateway/plugin.json");
assert.equal(manifest.defaultEnabled, false);
assert.deepEqual(manifest.routes, []);
assert.deepEqual(manifest.hostCapabilities, []);

const schema = readJson("plugins/model-gateway/configuration.schema.json");
assert.deepEqual(Object.keys(schema.properties as Record<string, unknown>).sort(), ["enabled", "serviceRef", "timeoutMs"]);
assert.equal(schema.additionalProperties, false);

for (const file of [path.join(pluginRoot, "runtime.mjs"), ...sourceFiles(path.join(pluginRoot, "src"))]) {
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()["'][^"']*services\/model-gateway/u,
    `${path.relative(root, file)} must not import the standalone service implementation`);
  assert.doesNotMatch(source,
    /(?:from\s+|import\s*\()["'](?:node:)?(?:fs|http|https|net|tls|dgram|child_process|worker_threads|better-sqlite3)(?:[/"'])/u,
    `${path.relative(root, file)} must not own network, process, or durable-state authority`);
  assert.doesNotMatch(source, /\bfetch\s*\(/u,
    `${path.relative(root, file)} must use only the externalService Host port`);
}

process.stdout.write("[model-gateway-detachment] ok\n");
