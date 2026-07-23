#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INDEX_PATH = "packages/foundation/config/deployment/index.json";

export async function loadDeploymentIndex({ cwd = REPO_ROOT } = {}) {
  return JSON.parse(await fs.readFile(path.join(cwd, INDEX_PATH), "utf8"));
}

function usage() {
  return [
    "Usage:",
    "  node tools/server-scripts/deployment-index.mjs summary",
    "  node tools/server-scripts/deployment-index.mjs show",
    "  node tools/server-scripts/deployment-index.mjs section dockerPresets"
  ].join("\n");
}

function readSection(index, sectionPath) {
  return String(sectionPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => value?.[key], index);
}

async function main() {
  const command = process.argv[2] || "summary";
  const index = await loadDeploymentIndex();
  if (command === "summary") {
    console.log(JSON.stringify({
      kind: index.kind,
      dockerImage: index.dockerPresets?.mainService?.imageName,
      sourcePackage: index.sourcePackages?.mainService,
      validation: index.validation
    }, null, 2));
    return;
  }
  if (command === "show") {
    console.log(JSON.stringify(index, null, 2));
    return;
  }
  if (command === "section") {
    console.log(JSON.stringify(readSection(index, process.argv[3]), null, 2));
    return;
  }
  throw new Error(`Unknown deployment-index command: ${command}\n${usage()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
