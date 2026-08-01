import { describe, expect, it } from "vitest";

import {
  executeEnterpriseUpgradeRollback
} from "../../../tools/server-scripts/upgrade/enterprise-upgrade-rollback.ts";

const CANDIDATE: any =
  "ghcr.io/licoland/meshrix@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PREVIOUS: any =
  "ghcr.io/licoland/meshrix@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function harness({ candidateHealthy = true, restoreSucceeds = true }: Record<string, any> = {}) : any {
  const calls: any[] = [];
  const journals: any[] = [];
  return {
    calls,
    journals,
    ports: {
      candidate: {
        async admit(image?: any) : Promise<any> {
          calls.push(["admit", image]);
        }
      },
      backup: {
        async create() : Promise<any> {
          calls.push(["backup"]);
          return { ok: true, backupId: "backup_fixture", receiptId: "receipt_fixture" };
        }
      },
      activation: {
        async activate(image?: any) : Promise<any> {
          calls.push(["activate", image]);
        }
      },
      validation: {
        async check(image?: any) : Promise<any> {
          calls.push(["validate", image]);
          return image === CANDIDATE
            ? { healthy: candidateHealthy, governedOperationOk: candidateHealthy }
            : { healthy: true, governedOperationOk: true };
        }
      },
      restore: {
        async preview(backupId?: any) : Promise<any> {
          calls.push(["restore-preview", backupId]);
          return { ok: true, integrityVerified: true };
        },
        async apply(backupId?: any) : Promise<any> {
          calls.push(["restore", backupId]);
          return { ok: restoreSucceeds, applied: restoreSucceeds };
        }
      },
      journal: {
        async write(record?: any) : Promise<any> {
          journals.push({ ...record });
        }
      }
    }
  };
}

describe("enterprise N-1 upgrade rollback", () : any => {
  it("admits, backs up, activates, and validates one immutable candidate", async () : Promise<any> => {
    const fixture: any = harness();
    await expect(executeEnterpriseUpgradeRollback({
      candidateImage: CANDIDATE,
      previousImage: PREVIOUS,
      ...fixture.ports
    })).resolves.toMatchObject({ ok: true, outcome: "upgraded" });
    expect(fixture.calls).toEqual([
      ["admit", CANDIDATE],
      ["backup"],
      ["activate", CANDIDATE],
      ["validate", CANDIDATE]
    ]);
    expect(fixture.journals.at(-1)).toMatchObject({
      phase: "complete",
      outcome: "upgraded"
    });
  });

  it("reactivates the prior digest and restores state after candidate validation fails", async () : Promise<any> => {
    const fixture: any = harness({ candidateHealthy: false });
    await expect(executeEnterpriseUpgradeRollback({
      candidateImage: CANDIDATE,
      previousImage: PREVIOUS,
      ...fixture.ports
    })).resolves.toMatchObject({
      ok: false,
      outcome: "rolled-back",
      failureCode: "enterprise_upgrade_candidate_validation_failed"
    });
    expect(fixture.calls).toEqual([
      ["admit", CANDIDATE],
      ["backup"],
      ["activate", CANDIDATE],
      ["validate", CANDIDATE],
      ["activate", PREVIOUS],
      ["restore-preview", "backup_fixture"],
      ["restore", "backup_fixture"],
      ["validate", PREVIOUS]
    ]);
  });

  it("records in_doubt and fences blind retry when rollback cannot restore state", async () : Promise<any> => {
    const fixture: any = harness({ candidateHealthy: false, restoreSucceeds: false });
    await expect(executeEnterpriseUpgradeRollback({
      candidateImage: CANDIDATE,
      previousImage: PREVIOUS,
      ...fixture.ports
    })).rejects.toMatchObject({ code: "enterprise_upgrade_rollback_in_doubt" });
    expect(fixture.journals.at(-1)).toMatchObject({
      phase: "in-doubt",
      outcome: "in_doubt",
      rollbackFailureCode: "enterprise_upgrade_restore_failed"
    });
  });

  it("rejects floating or identical images before side effects", async () : Promise<any> => {
    const fixture: any = harness();
    await expect(executeEnterpriseUpgradeRollback({
      candidateImage: "ghcr.io/licoland/meshrix:latest",
      previousImage: PREVIOUS,
      ...fixture.ports
    })).rejects.toMatchObject({ code: "enterprise_upgrade_candidate_digest_required" });
    await expect(executeEnterpriseUpgradeRollback({
      candidateImage: CANDIDATE,
      previousImage: CANDIDATE,
      ...fixture.ports
    })).rejects.toMatchObject({ code: "enterprise_upgrade_candidate_must_differ" });
    expect(fixture.calls).toEqual([]);
  });
});
