import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION,
  createContributionRegistry
} from "../../../packages/agents/src/workspace-contribution/index.mjs";
import {
  normalizeContribution,
  publicAssetRecord
} from "../../../packages/agents/src/workspace-contribution/package-validation.mjs";

const extensionLifecycleDefinition = Object.freeze({
  ...structuredClone(CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION),
  machineId: "sample-contribution.lifecycle",
  entityType: "sample_contribution",
  version: "sample-contribution-lifecycle-test-version",
  description: "Synthetic extension contribution lifecycle."
});

describe("workspace contribution lifecycle ownership", () => {
  it("requires every caller to inject its lifecycle authority", () => {
    expect(() => createContributionRegistry()).toThrow("explicit lifecycle definition");
  });

  it("keeps the generic core lifecycle usable without an extension activation", () => {
    expect(CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION.machineId)
      .toBe("workspace-contribution.lifecycle");
    expect(extensionLifecycleDefinition.machineId).toBe("sample-contribution.lifecycle");
    expect(extensionLifecycleDefinition.machineId)
      .not.toBe(CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION.machineId);

    const registry = createContributionRegistry({
      workspaceId: "core-workspace",
      lifecycleDefinition: CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION
    });
    const submitted = registry.submitContribution({
      contributionId: "core-contribution",
      workspaceId: "core-workspace",
      title: "Core contribution"
    });
    const scanReceipt = {
      runId: "core-scan-run",
      workloadKind: "contribution_scan",
      status: "succeeded",
      cleanupStatus: "destroyed",
      workloadArtifactDigest: "a".repeat(64),
      inputDigest: submitted.contribution.packageChecksum,
      packageDigest: submitted.contribution.packageChecksum
    };
    registry.recordExecutionReceipt("core-contribution", { receipt: scanReceipt });
    registry.scanContribution("core-contribution", { scanReceipt, actorId: "scanner" });
    const reviewed = registry.reviewContribution("core-contribution", {
      reviewerId: "reviewer",
      decision: "approved"
    });
    const published = registry.publishContribution("core-contribution", { actorId: "reviewer" });

    expect(submitted.contribution.status).toBe("submitted");
    expect(reviewed.contribution.status).toBe("reviewed");
    expect(published.contribution.status).toBe("published");
  });

  it("accepts extension-owned contribution semantics only through explicit adapters", () => {
    const registry = createContributionRegistry({
      workspaceId: "extension-workspace",
      lifecycleDefinition: extensionLifecycleDefinition,
      contributionNormalizer(input, defaults) {
        return {
          ...normalizeContribution({ ...input, contributionType: "tool" }, defaults),
          contributionType: "extensionAsset"
        };
      },
      assetRecordProjector(record) {
        return {
          ...publicAssetRecord({ ...record, contributionType: "tool" }),
          contributionType: "extensionAsset"
        };
      },
      assetBucketResolver(contributionType) {
        if (contributionType !== "extensionAsset") throw new Error("Unexpected extension contribution type.");
        return "extension-assets";
      },
      assetBuckets: ["extension-assets"]
    });
    const submitted = registry.submitContribution({
      contributionId: "extension-contribution",
      workspaceId: "extension-workspace",
      contributionType: "extensionAsset",
      title: "Extension contribution"
    });

    expect(submitted).toMatchObject({
      contribution: { status: "submitted", contributionType: "extensionAsset" },
      assetRecord: { contributionType: "extensionAsset", bucket: "extension-assets" }
    });
    expect(registry.listWorkspaceAssets()).toMatchObject({
      fixedBuckets: ["extension-assets"],
      count: 1
    });
  });

  it("rejects persistence paths that escape the configured data root", () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lico-contribution-root-"));
    try {
      expect(() => createContributionRegistry({
        userDataPath,
        registryRelativePath: "../outside.json",
        lifecycleDefinition: CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION
      })).toThrow("outside the server data directory");
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
