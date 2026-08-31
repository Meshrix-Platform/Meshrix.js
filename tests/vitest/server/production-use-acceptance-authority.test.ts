import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CURRENT_PLAN_CODE, validateCurrentPlanAuthority } from "../../../tools/plan/current-plan-authority.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("production-use acceptance authority boundary", () => {
  it("keeps product evidence independent from canonical Plan execution state", async () => {
    const checkpointPath = path.join(
      repoRoot, "docs/plans/production-use-closure/Checkpoints.json",
    );
    const before = await fs.readFile(checkpointPath, "utf8");
    const executionState = JSON.parse(before);
    await expect(validateCurrentPlanAuthority({ repoRoot })).resolves.toMatchObject({
      plan: CURRENT_PLAN_CODE,
      delivery_status: executionState.delivery_status,
    });
    expect(await fs.readFile(checkpointPath, "utf8")).toBe(before);

    const linuxVerifier = await fs.readFile(
      path.join(repoRoot, "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts"), "utf8",
    );
    expect(linuxVerifier).not.toContain("Checkpoints.json");
    expect(linuxVerifier).toContain("productEvidenceUnits");

    const unifiedVerifier = await fs.readFile(
      path.join(repoRoot, "tools/server-scripts/verify-unified-production-closure.ts"), "utf8",
    );
    expect(unifiedVerifier).toContain("validateCurrentPlanAuthority");
    expect(unifiedVerifier).toContain("resolveCurrentAcceptanceGeneration");
    expect(unifiedVerifier).toContain("currentPlan: CURRENT_PLAN_CODE");
    expect(unifiedVerifier).toContain("liveGovernedOperationReady");
    expect(unifiedVerifier).toContain("activeServiceReady");
    expect(unifiedVerifier).toContain("native?.existingServiceActiveBeforeUpgrade === true");
    expect(unifiedVerifier).toContain("native?.rollbackAvailable === true");
    expect(unifiedVerifier).toContain("promotion?.stableAuthorityValid === true");
    expect(unifiedVerifier).toContain("promotion?.releaseAuthorityValid === true");
    expect(unifiedVerifier).not.toContain("pointer?.generation");
    expect(unifiedVerifier).not.toMatch(/sourcePlanClassifications|legacyExecutionTruth/u);
  });
});
