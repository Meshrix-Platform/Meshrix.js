#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { produceOfflineDeliveryBundle } from "./offline-delivery-producer.ts";
import { failOfflineDelivery, isRecord } from "./offline-delivery-shared.ts";
import { resolveOfflineDeliveryVmMaterials } from "./offline-delivery-vm-target.ts";

export const OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT: any = "build/offline-delivery-bundle";
export const OFFLINE_DELIVERY_PACK_RELATIVE_OCI: any = "build/offline-delivery-oci";

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export function buildOfflineDeliveryPackReceipt({
  produced,
  outputRelativePath = OFFLINE_DELIVERY_PACK_RELATIVE_OUTPUT,
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
    return buildOfflineDeliveryPackReceipt({
      produced,
      outputRelativePath,
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
