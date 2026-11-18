#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INDEX_PATH: any = "packages/foundation/config/deployment/index.json";

export async function loadDeploymentIndex({ cwd = REPO_ROOT }: Record<string, any> = {}) : Promise<any> {
  return JSON.parse(await fs.readFile(path.join(cwd, INDEX_PATH), "utf8"));
}

function usage() : any {
  return [
    "Usage:",
    "  node tools/server-scripts/deployment-index.ts summary",
    "  node tools/server-scripts/deployment-index.ts show",
    "  node tools/server-scripts/deployment-index.ts section dockerPresets"
  ].join("\n");
}

function readSection(index?: any, sectionPath?: any) : any {
  return String(sectionPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((value?: any, key?: any) : any => value?.[key], index);
}

async function main() : Promise<any> {
  const command: any = process.argv[2] || "summary";
  const index: any = await loadDeploymentIndex();
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
  main().catch((error?: any) : any => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
