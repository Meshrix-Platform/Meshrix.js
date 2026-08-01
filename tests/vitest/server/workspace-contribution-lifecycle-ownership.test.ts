import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION,
  createContributionRegistry
} from "../../../packages/agents/src/workspace-contribution/index.ts";
import {
  normalizeContribution,
  publicAssetRecord
} from "../../../packages/agents/src/workspace-contribution/package-validation.ts";

const extensionLifecycleDefinition: Readonly<Record<string, any>> = Object.freeze({
  ...structuredClone(CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION),
  machineId: "sample-contribution.lifecycle",
  entityType: "sample_contribution",
  version: "sample-contribution-lifecycle-test-version",
  description: "Synthetic extension contribution lifecycle."
});

describe("workspace contribution lifecycle ownership", () : any => {
  it("requires every caller to inject its lifecycle authority", () : any => {
    expect(() : any => createContributionRegistry()).toThrow("explicit lifecycle definition");
  });

  it("keeps the generic core lifecycle usable without an extension activation", () : any => {
    expect(CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION.machineId)
      .toBe("workspace-contribution.lifecycle");
    expect(extensionLifecycleDefinition.machineId).toBe("sample-contribution.lifecycle");
    expect(extensionLifecycleDefinition.machineId)
      .not.toBe(CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION.machineId);

    const registry: any = createContributionRegistry({
      workspaceId: "core-workspace",
      lifecycleDefinition: CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION
    });
    const submitted: any = registry.submitContribution({
      contributionId: "core-contribution",
      workspaceId: "core-workspace",
      title: "Core contribution"
    });
    const scanReceipt: Record<string, any> = {
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
    const reviewed: any = registry.reviewContribution("core-contribution", {
      reviewerId: "reviewer",
      decision: "approved"
    });
    const published: any = registry.publishContribution("core-contribution", { actorId: "reviewer" });

    expect(submitted.contribution.status).toBe("submitted");
    expect(reviewed.contribution.status).toBe("reviewed");
    expect(published.contribution.status).toBe("published");
  });

  it("accepts extension-owned contribution semantics only through explicit adapters", () : any => {
    const registry: any = createContributionRegistry({
      workspaceId: "extension-workspace",
      lifecycleDefinition: extensionLifecycleDefinition,
      contributionNormalizer(input?: any, defaults?: any) : any {
        return {
          ...normalizeContribution({ ...input, contributionType: "tool" }, defaults),
          contributionType: "extensionAsset"
        };
      },
      assetRecordProjector(record?: any) : any {
        return {
          ...publicAssetRecord({ ...record, contributionType: "tool" }),
          contributionType: "extensionAsset"
        };
      },
      assetBucketResolver(contributionType?: any) : any {
        if (contributionType !== "extensionAsset") throw new Error("Unexpected extension contribution type.");
        return "extension-assets";
      },
      assetBuckets: ["extension-assets"]
    });
    const submitted: any = registry.submitContribution({
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

  it("rejects persistence paths that escape the configured data root", () : any => {
    const userDataPath: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-contribution-root-"));
    try {
      expect(() : any => createContributionRegistry({
        userDataPath,
        registryRelativePath: "../outside.json",
        lifecycleDefinition: CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION
      })).toThrow("outside the server data directory");
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
