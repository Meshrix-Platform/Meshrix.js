#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { produceOfflineDeliveryBundle } from "./offline-delivery-producer.ts";
import { failOfflineDelivery, isRecord } from "./offline-delivery-shared.ts";
import { resolveOfflineDeliveryVmMaterials } from "./offline-delivery-vm-target.ts";

export const OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT: any = "build/offline-delivery-bundle";
export const OFFLINE_DELIVERY_PACK_RELATIVE_OCI: any = "build/offline-delivery-oci";
export const OFFLINE_DELIVERY_USAGE_SKILLS_RELATIVE: any = "build/usage-skills";

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

async function runPackUsageSkills(repoRoot?: any) : Promise<any> {
  await new Promise((resolve, reject) => {
    const child: any = spawn(
      process.execPath,
      [path.join(repoRoot, "tools", "pack-usage-skills.mjs")],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code?: any) : any => {
      if (code === 0) resolve(undefined);
      else reject(new Error(stderr.trim() || `pack-usage-skills exited ${code}`));
    });
  });
}

async function embedUsageSkills({
  repoRoot,
  outputRoot,
}: Record<string, any> = {}) : Promise<any> {
  const source: any = path.join(repoRoot, OFFLINE_DELIVERY_USAGE_SKILLS_RELATIVE);
  const destination: any = path.join(outputRoot, "usage-skills");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  return "usage-skills";
}

export function buildOfflineDeliveryPackReceipt({
  produced,
  outputRelativePath = OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT,
  usageSkillsRelativePath = null,
}: Record<string, any> = {}) : any {
  if (produced?.contractFixtureUsed === true) {
    failOfflineDelivery(
      "offline_delivery_contract_fixture_refused",
      "Operator pack refuses contract-fixture bytes.",
    );
  }
  const platforms: any[] = Array.isArray(produced?.platforms) ? [...produced.platforms] : [];
  return Object.freeze({
    ok: true,
    output: String(outputRelativePath),
    platforms: Object.freeze(platforms),
    contractFixtureUsed: false,
    hasInventory: produced?.hasInventory === true,
    hasSbom: produced?.hasSbom === true,
    hasProvenance: produced?.hasProvenance === true,
    hasSignatures: produced?.hasSignatures === true,
    usageSkills: usageSkillsRelativePath
      ? `${String(outputRelativePath).replace(/\/$/, "")}/${usageSkillsRelativePath}`
      : OFFLINE_DELIVERY_USAGE_SKILLS_RELATIVE,
    imageDigest: typeof produced?.bundle?.image_digest === "string"
      ? produced.bundle.image_digest
      : "",
  });
}

export async function packOfflineDeliveryBundle({
  repoRoot = repoRootFromMeta(),
  outputRelativePath = OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT,
}: Record<string, any> = {}) : Promise<any> {
  const outputRoot: any = path.join(repoRoot, outputRelativePath);
  const ociRoot: any = path.join(repoRoot, OFFLINE_DELIVERY_PACK_RELATIVE_OCI);
  await runPackUsageSkills(repoRoot);
  await fs.rm(ociRoot, { recursive: true, force: true });
  await fs.mkdir(ociRoot, { recursive: true, mode: 0o700 });
  try {
    const materials: any = await resolveOfflineDeliveryVmMaterials({
      repoRoot,
      ociLayoutOutput: ociRoot,
    });
    if (!isRecord(materials)) {
      failOfflineDelivery(
        "offline_delivery_candidate_materials_missing",
        "Server + Web Console offline images are unavailable.",
      );
    }
    const produced: any = await produceOfflineDeliveryBundle({
      outputRoot,
      materials,
      allowContractFixture: false,
    });
    const usageSkillsRelativePath: any = await embedUsageSkills({
      repoRoot,
      outputRoot,
    });
    return buildOfflineDeliveryPackReceipt({
      produced,
      outputRelativePath,
      usageSkillsRelativePath,
    });
  } finally {
    await fs.rm(ociRoot, { recursive: true, force: true });
  }
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  packOfflineDeliveryBundle().then((result?: any) : any => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "offline_delivery_pack_failed",
    })}\n`);
    process.exitCode = 1;
  });
}
