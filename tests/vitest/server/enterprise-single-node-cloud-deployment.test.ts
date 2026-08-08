import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createEnterpriseSingleNodeCloudDeploymentPlan,
  validateEnterpriseSecretCustody,
} from "../../../tools/server-scripts/enterprise-single-node-cloud-deployment.ts";

const CANDIDATE: any =
  "registry.example/meshrix-js/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PREVIOUS: any =
  "registry.example/meshrix-js/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("enterprise single-node cloud deployment", () : any => {
  it("activates an admitted immutable candidate without build or network access", () : any => {
    const plan: any = createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: CANDIDATE,
      offline: true,
      secretKeySourceConfigured: true,
      proofSignerSecretSourceConfigured: true,
      securePublicBaseUrlConfigured: true,
      trustedProxyConfigured: true,
    });
    expect(plan.environment).toEqual({
      MESHRIX_IMAGE_NAME: CANDIDATE,
      MESHRIX_PULL_POLICY: "never",
    });
    expect(plan.phases[0]).toMatchObject({
      id: "admit-candidate",
      command: { args: ["image", "inspect", CANDIDATE], networkRequired: false },
    });
    expect(plan.phases.find((phase?: any) : any => phase.id === "pre-upgrade-backup"))
      .toMatchObject({ operationId: "storage.backups.create", requiredReceipt: true });
    expect(plan.phases.find((phase?: any) : any => phase.id === "activate-candidate")?.command.args)
      .toContain("--no-build");
    expect(plan.phases.find((phase?: any) : any => phase.id === "activate-candidate")?.command.args)
      .toContain("never");
    expect(plan.invariants).toMatchObject({
      imageDigestPinned: true,
      independentBackupVolumeRequired: true,
      nonRootUid: 10001,
      readOnlyRootFilesystem: true,
    });
  });

  it("keeps rollback bound to a different prior digest and governed restore operations", () : any => {
    const plan: any = createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: CANDIDATE,
      previousImage: PREVIOUS,
      secretKeySourceConfigured: true,
      proofSignerSecretSourceConfigured: true,
      securePublicBaseUrlConfigured: true,
      trustedProxyConfigured: true,
    });
    expect(plan.rollback).toMatchObject({
      environment: {
        MESHRIX_IMAGE_NAME: PREVIOUS,
        MESHRIX_PULL_POLICY: "never",
      },
      restorePreviewOperationId: "storage.backups.restore_preview",
      restoreOperationId: "storage.backups.restore",
    });
    expect(plan.blockers).toContain(
      "real_n_minus_one_released-image_receipt_pending",
    );
  });

  it("rejects floating tags, raw image ids, and same-candidate rollback", () : any => {
    expect(() : any => createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: "registry.example/meshrix-js/runtime:latest",
      secretKeySourceConfigured: true,
      proofSignerSecretSourceConfigured: true,
      securePublicBaseUrlConfigured: true,
      trustedProxyConfigured: true,
    })).toThrow("cloud_deployment_candidate_digest_required");
    expect(() : any => createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: `sha256:${"a".repeat(64)}`,
      secretKeySourceConfigured: true,
      proofSignerSecretSourceConfigured: true,
      securePublicBaseUrlConfigured: true,
      trustedProxyConfigured: true,
    })).toThrow("cloud_deployment_candidate_digest_required");
    expect(() : any => createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: CANDIDATE,
      previousImage: CANDIDATE,
      secretKeySourceConfigured: true,
      proofSignerSecretSourceConfigured: true,
      securePublicBaseUrlConfigured: true,
      trustedProxyConfigured: true,
    })).toThrow("cloud_deployment_previous_candidate_must_differ");
    expect(() : any => createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: CANDIDATE,
      proofSignerSecretSourceConfigured: true,
      securePublicBaseUrlConfigured: true,
      trustedProxyConfigured: true,
    })).toThrow("cloud_deployment_secret_key_source_required");
    expect(() : any => createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: CANDIDATE,
      secretKeySourceConfigured: true,
      proofSignerSecretSourceConfigured: true,
    })).toThrow("cloud_deployment_secure_public_base_url_required");
    expect(() : any => createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: CANDIDATE,
      secretKeySourceConfigured: true,
      securePublicBaseUrlConfigured: true,
      trustedProxyConfigured: true,
    })).toThrow("cloud_deployment_proof_signer_secret_source_required");
    expect(() : any => createEnterpriseSingleNodeCloudDeploymentPlan({
      candidateImage: CANDIDATE,
      secretKeySourceConfigured: true,
      proofSignerSecretSourceConfigured: true,
      securePublicBaseUrlConfigured: true,
    })).toThrow("cloud_deployment_trusted_proxy_required");
  });

  it("admits only external, distinct encryption and proof-signing secrets", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-cloud-secret-custody-"));
    const encryptionSecretPath: any = path.join(root, "encryption");
    const proofSignerSecretPath: any = path.join(root, "proof-signer");
    try {
      await fs.writeFile(encryptionSecretPath, "a".repeat(64), { mode: 0o600 });
      await fs.writeFile(proofSignerSecretPath, "a".repeat(64), { mode: 0o600 });
      await expect(validateEnterpriseSecretCustody({
        encryptionSecretPath,
        proofSignerSecretPath
      })).rejects.toThrow("cloud_deployment_secret_custody_separation_required");

      await fs.writeFile(proofSignerSecretPath, "b".repeat(64), { mode: 0o600 });
      await expect(validateEnterpriseSecretCustody({
        encryptionSecretPath,
        proofSignerSecretPath
      })).resolves.toEqual({ ready: true, distinct: true, external: true });
      await expect(validateEnterpriseSecretCustody({
        encryptionSecretPath,
        proofSignerSecretPath: encryptionSecretPath
      })).rejects.toThrow("cloud_deployment_secret_custody_separation_required");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
