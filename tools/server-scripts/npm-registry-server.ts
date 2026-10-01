#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { createLockBackedNpmRegistry } from "./lib/lock-backed-npm-registry.ts";

function argumentValue(name?: any, fallback?: any) : any {
  const index: any = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const planPath: any = path.resolve(argumentValue("--artifacts", "/artifacts/registry-artifacts.json"));
const plan: any = JSON.parse(await fs.readFile(planPath, "utf8"));
const registry: any = await createLockBackedNpmRegistry({
  lockPath: "/app/package-lock.json",
  cacheRoot: "/opt/meshrix-npm-cache",
  extraTarballs: Array.isArray(plan.artifacts) ? plan.artifacts : [],
  host: "0.0.0.0",
  port: 4873,
  advertisedOrigin: "http://meshrix-registry:4873"
});

let closing: Promise<void> | null = null;
async function close() : Promise<void> {
  if (!closing) closing = registry.close();
  await closing;
}

process.once("SIGTERM", () : any => { void close().then(() : any => process.exit(0)); });
process.once("SIGINT", () : any => { void close().then(() : any => process.exit(0)); });
console.log(JSON.stringify({ status: "ready", artifactCount: registry.artifactCount, packageCount: registry.packageCount }));
