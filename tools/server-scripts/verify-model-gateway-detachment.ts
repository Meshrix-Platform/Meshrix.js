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

type DockerCopyInstruction = Readonly<{
  line: number;
  sources: readonly string[];
  stage: string;
}>;

function dockerLogicalLines(dockerfile: string): ReadonlyArray<Readonly<{ line: number; text: string }>> {
  const logicalLines: Array<Readonly<{ line: number; text: string }>> = [];
  let current = "";
  let startLine = 0;
  const physicalLines = dockerfile.split(/\r?\n/u);
  for (let index = 0; index < physicalLines.length; index += 1) {
    const trimmed = physicalLines[index].trim();
    if (!current && (!trimmed || trimmed.startsWith("#"))) continue;
    if (!current) startLine = index + 1;
    const continued = /\\$/u.test(trimmed);
    const fragment = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    current = current ? `${current} ${fragment}` : fragment;
    if (!continued) {
      logicalLines.push(Object.freeze({ line: startLine, text: current }));
      current = "";
    }
  }
  assert.equal(current, "", "runtime-ui Dockerfile must not end with an unterminated instruction");
  return Object.freeze(logicalLines);
}

function dockerShellTokens(value: string, line: number): string[] {
  const tokens = value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/gu) ?? [];
  assert.ok(tokens.length >= 2, `runtime-ui Dockerfile COPY at line ${line} must declare source and destination`);
  return tokens.map((token) => {
    if ((token.startsWith("\"") && token.endsWith("\"")) ||
        (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function dockerCopySources(value: string, line: number): string[] {
  let copy = value.trim();
  while (copy.startsWith("--")) {
    const flag = copy.match(/^--[^\s]+\s+/u);
    assert.ok(flag, `runtime-ui Dockerfile COPY flag at line ${line} is invalid`);
    copy = copy.slice(flag[0].length).trimStart();
  }
  if (copy.startsWith("[")) {
    let tokens: unknown;
    try {
      tokens = JSON.parse(copy);
    } catch {
      assert.fail(`runtime-ui Dockerfile JSON COPY at line ${line} is invalid`);
    }
    assert.ok(Array.isArray(tokens) && tokens.length >= 2 &&
      tokens.every((token) => typeof token === "string"),
    `runtime-ui Dockerfile JSON COPY at line ${line} must contain string sources and a destination`);
    return tokens.slice(0, -1) as string[];
  }
  return dockerShellTokens(copy, line).slice(0, -1);
}

function dockerCopyInstructions(dockerfile: string): readonly DockerCopyInstruction[] {
  const copies: DockerCopyInstruction[] = [];
  let stage = "";
  for (const instruction of dockerLogicalLines(dockerfile)) {
    const from = instruction.text.match(/^FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?$/iu);
    if (from) {
      stage = String(from[1] || "").toLowerCase();
      continue;
    }
    const copy = instruction.text.match(/^COPY\s+(.+)$/iu);
    if (!copy) continue;
    assert.ok(stage, `runtime-ui Dockerfile COPY at line ${instruction.line} must belong to a named stage`);
    copies.push(Object.freeze({
      line: instruction.line,
      sources: Object.freeze(dockerCopySources(copy[1], instruction.line)),
      stage
    }));
  }
  return Object.freeze(copies);
}

function serviceSourcePath(source: string): string {
  const normalized = path.posix.normalize(source.replaceAll("\\", "/"));
  if (normalized === ".") return "<repository-context>";
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  const serviceIndex = segments.indexOf("services");
  return serviceIndex < 0 ? "" : segments.slice(serviceIndex).join("/");
}

export function assertRuntimeDockerfileServiceIsolation(dockerfile: string): void {
  const allowedStages = Object.freeze(["build", "build-ui"]);
  const allowedSource = "services/model-gateway/contracts";
  const canonicalCopies: string[] = [];
  for (const instruction of dockerCopyInstructions(dockerfile)) {
    for (const source of instruction.sources) {
      const serviceSource = serviceSourcePath(source);
      if (!serviceSource) continue;
      assert.ok(
        allowedStages.includes(instruction.stage) && serviceSource === allowedSource,
        `runtime-ui Dockerfile stage ${instruction.stage} must not copy service source ${serviceSource} (line ${instruction.line})`
      );
      canonicalCopies.push(instruction.stage);
    }
  }
  assert.deepEqual(
    canonicalCopies.sort(),
    [...allowedStages].sort(),
    "runtime-ui build stages must each copy exactly the canonical Model Gateway contracts root"
  );
}

export function verifyModelGatewayDetachment(): void {
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
  assertRuntimeDockerfileServiceIsolation(read("Dockerfile"));

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
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) verifyModelGatewayDetachment();
