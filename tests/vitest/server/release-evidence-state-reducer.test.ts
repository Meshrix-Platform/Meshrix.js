import { describe, expect, it } from "vitest";

import {
  RELEASE_EVIDENCE_STATES,
  reduceReleaseEvidenceStates
} from "../../../tools/server-scripts/lib/platform-acceptance-reducer.ts";

function command(id?: any, report?: any, dependsOn: any = []) : any {
  return { id, report, ownedReports: report ? [report] : [], dependsOn };
}

function result(id?: any, status: any = "passed") : any {
  return { id, status, reasonChain: status === "passed" ? [] : [`direct:${status}`] };
}

function evidence(overrides: Record<string, any> = {}) : any {
  return {
    validationPassed: true,
    releaseReady: true,
    reportLeakScan: true,
    liveStatus: "passed",
    reasons: [],
    ...overrides
  };
}

describe("release evidence state reducer", () : any => {
  it("reduces the complete bounded state algebra deterministically", () : any => {
    const commands: any[] = [
      command("current", "current.json"),
      command("pending", "pending.json"),
      command("blocked", "blocked.json"),
      command("failed", "failed.json"),
      command("skipped", "skipped.json"),
      command("stale", "stale.json"),
      command("missing", "missing.json"),
      command("privacy", "privacy.json")
    ];
    const reduced: any = reduceReleaseEvidenceStates({
      commands,
      results: [
        result("current"),
        result("blocked", "blocked"),
        result("failed", "failed"),
        result("skipped", "skipped"),
        result("stale"),
        result("missing"),
        result("privacy")
      ],
      reportEvidence: {
        "current.json": evidence(),
        "blocked.json": evidence({ releaseReady: false, liveStatus: "blocked" }),
        "failed.json": evidence({ releaseReady: false }),
        "skipped.json": evidence(),
        "stale.json": evidence({ releaseReady: false, reasons: ["required-report-timestamp-too-old"] }),
        "privacy.json": evidence({ reportLeakScan: false })
      }
    });

    expect(RELEASE_EVIDENCE_STATES).toEqual([
      "current", "pending", "blocked", "failed", "skipped", "stale", "missing", "privacy-unsafe"
    ]);
    expect(reduced.nodes.map(({ commandId, state }: Record<string, any>) : any => [commandId, state])).toEqual([
      ["current", "current"],
      ["pending", "pending"],
      ["blocked", "blocked"],
      ["failed", "failed"],
      ["skipped", "skipped"],
      ["stale", "stale"],
      ["missing", "missing"],
      ["privacy", "privacy-unsafe"]
    ]);
    expect((Object.values(reduced.stateCounts) as any[])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(reduced.current).toBe(false);
  });

  it("propagates dependency state with stable reasons and owner chains", () : any => {
    const reduced: any = reduceReleaseEvidenceStates({
      commands: [
        command("root", "root.json"),
        command("child", "child.json", ["root"]),
        command("leaf", "leaf.json", ["child"])
      ],
      results: [result("root", "blocked"), result("child", "blocked"), result("leaf", "blocked")],
      reportEvidence: {
        "root.json": evidence({ releaseReady: false, liveStatus: "blocked" }),
        "child.json": evidence({ releaseReady: false, liveStatus: "blocked" }),
        "leaf.json": evidence({ releaseReady: false, liveStatus: "blocked" })
      }
    });
    const leaf: any = reduced.nodes.find((node?: any) : any => node.commandId === "leaf");
    expect(leaf).toMatchObject({
      state: "blocked",
      ownerChain: ["leaf", "child", "root"]
    });
    expect(leaf.reasons).toEqual(expect.arrayContaining([
      "dependency-state:child:blocked",
      "dependency-state:root:blocked",
      "direct:blocked"
    ]));
  });
});
