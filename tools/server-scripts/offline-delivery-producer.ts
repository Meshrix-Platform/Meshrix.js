#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assembleEnterpriseOfflineBundle,
  ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS,
  createEnterpriseOfflineBundleFixture,
} from "./enterprise-single-node-offline-bundle.ts";
import {
  OFFLINE_DELIVERY_FIRST_GOVERNED_CALL,
  OFFLINE_DELIVERY_INSTRUCTIONS_RELATIVE_PATH,
  OFFLINE_DELIVERY_LIFECYCLE_STEPS,
  failOfflineDelivery,
  isRecord,
} from "./offline-delivery-shared.ts";

function snapshotCompose(bundle?: any) : any {
  if (!isRecord(bundle?.compose)) {
    failOfflineDelivery(
      "offline_delivery_compose_invalid",
      "Offline delivery bundle compose is invalid.",
    );
  }
  if (bundle.compose.pull_policy !== "never" || bundle.compose.optional_service !== false) {
    failOfflineDelivery(
      "offline_delivery_compose_invalid",
      "Offline delivery bundle must use pull never with optional services disabled.",
    );
  }
  const args: any = Array.isArray(bundle.compose.args) ? bundle.compose.args.map(String) : [];
  if (!args.includes("--no-build") || !args.includes("never")) {
    failOfflineDelivery(
      "offline_delivery_rebuild_forbidden",
      "Offline delivery bundle must activate without rebuild or pull.",
    );
  }
  return Object.freeze({
    composeFile: "compose/compose.yaml",
    imageDigestPinned: typeof bundle.compose.image === "string"
      && bundle.compose.image.includes("@sha256:"),
    pullPolicy: "never",
    buildAllowed: false,
    networkRequired: false,
    args: Object.freeze([...args]),
  });
}

export function buildOfflineDeliveryInstructions(bundle?: any) : any {
  const activation: any = snapshotCompose(bundle);
  const platforms: any = Array.isArray(bundle?.platforms) ? [...bundle.platforms] : [];
  if (
    JSON.stringify(platforms)
    !== JSON.stringify([...ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS])
  ) {
    failOfflineDelivery(
      "offline_delivery_platform_mismatch",
      "Offline delivery instructions require linux/amd64 and linux/arm64.",
    );
  }
  return Object.freeze({
    instructionSheet: OFFLINE_DELIVERY_INSTRUCTIONS_RELATIVE_PATH,
    platforms: Object.freeze(platforms),
    lifecycle: Object.freeze([...OFFLINE_DELIVERY_LIFECYCLE_STEPS]),
    activation,
    import: Object.freeze({
      payload: "oci-layout",
      sourceDirectory: "files",
      networkRequired: false,
      rebuild: false,
    }),
    firstGovernedCall: OFFLINE_DELIVERY_FIRST_GOVERNED_CALL,
    stop: Object.freeze({
      executable: "docker",
      args: Object.freeze(["compose", "-f", "compose/compose.yaml", "stop", "meshrix-server"]),
      networkRequired: false,
      rebuild: false,
    }),
    cleanup: Object.freeze({
      executable: "docker",
      args: Object.freeze([
        "compose",
        "-f",
        "compose/compose.yaml",
        "down",
        "--remove-orphans",
        "--volumes",
      ]),
      networkRequired: false,
      rebuild: false,
    }),
    claims: Object.freeze({
      nativeLinuxSupport: false,
      capacityCertified: false,
      publication: false,
    }),
  });
}

function hasCompleteMaterials(materials?: any) : any {
  return Boolean(
    isRecord(materials)
    && materials.sourceCandidate
    && materials.releaseImageAuthority
    && materials.releaseImageEvidence
    && typeof materials.ociLayoutPath === "string"
    && materials.ociLayoutPath.trim() !== ""
    && typeof materials.artifactSigner?.sign === "function"
    && isRecord(materials.trustedPublicKeys)
  );
}

export async function produceOfflineDeliveryBundle({
  outputRoot,
  materials,
  allowContractFixture = false,
}: Record<string, any> = {}) : Promise<any> {
  if (typeof outputRoot !== "string" || outputRoot.trim() === "") {
    failOfflineDelivery(
      "offline_delivery_output_root_missing",
      "Offline delivery output root is required.",
    );
  }
  const ownedRoots: any[] = [];
  try {
    let resolvedMaterials: any = materials;
    let contractFixtureUsed: any = false;
    if (!hasCompleteMaterials(resolvedMaterials)) {
      if (allowContractFixture !== true) {
        failOfflineDelivery(
          "offline_delivery_candidate_materials_missing",
          "Candidate-bound OCI materials are required.",
        );
      }
      const fixtureRoot: any = await fs.mkdtemp(
        path.join(os.tmpdir(), "meshrix-offline-delivery-fixture-"),
      );
      ownedRoots.push(fixtureRoot);
      resolvedMaterials = await createEnterpriseOfflineBundleFixture(fixtureRoot);
      contractFixtureUsed = true;
    }
    const bundle: any = await assembleEnterpriseOfflineBundle({
      sourceCandidate: resolvedMaterials.sourceCandidate,
      releaseImageAuthority: resolvedMaterials.releaseImageAuthority,
      releaseImageEvidence: resolvedMaterials.releaseImageEvidence,
      ociLayoutPath: resolvedMaterials.ociLayoutPath,
      artifactSigner: resolvedMaterials.artifactSigner,
      trustedPublicKeys: resolvedMaterials.trustedPublicKeys,
      optionalServiceEnabled: false,
      outputRoot,
    });
    const instructions: any = buildOfflineDeliveryInstructions(bundle);
    return Object.freeze({
      bundle,
      instructions,
      contractFixtureUsed,
      outputRoot,
      trustedPublicKeys: resolvedMaterials.trustedPublicKeys,
      hasInventory: true,
      hasSbom: true,
      hasProvenance: true,
      hasSignatures: true,
      hasInstructions: true,
      platforms: Object.freeze([...ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS]),
    });
  } finally {
    await Promise.all(
      ownedRoots.map((root?: any) : any => fs.rm(root, { recursive: true, force: true })),
    );
  }
}
