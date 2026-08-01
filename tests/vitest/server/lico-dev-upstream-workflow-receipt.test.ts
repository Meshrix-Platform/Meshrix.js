import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  computeLicoDevUpstreamWorkflowReceiptDigest,
  loadAndVerifyLicoDevUpstreamWorkflowReceipt,
  verifyLicoDevUpstreamWorkflowReceipt
} from "../../../tools/server-scripts/verify-lico-dev-upstream-workflow-receipt.ts";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RECEIPT_PATH: any = path.join(REPO_ROOT, "tools/registry/lico-dev-upstream-workflow-receipt.json");
const EXPECTED_SOURCE_ALLOWLIST: readonly any[] = Object.freeze([
  { path: "config/repositories.json", role: "repository-routing" },
  { path: "lib/constants.ts", role: "workflow-planner" },
  { path: "lib/io.ts", role: "workflow-planner" },
  { path: "lib/privacy-classifier.ts", role: "workflow-planner" },
  { path: "lib/repositories.ts", role: "workflow-planner" },
  { path: "lib/workflow.ts", role: "workflow-planner" },
  { path: "tests/helpers.ts", role: "workflow-tests" },
  { path: "tests/workflow.test.ts", role: "workflow-tests" },
  { path: "workflows/catalog.json", role: "workflow-catalog" },
  { path: "skills/catalog.json", role: "skill-catalog" },
  { path: "skills/lico-upstream-service-publishing/SKILL.md", role: "skill-contract" },
  {
    path: "skills/lico-upstream-service-publishing/references/publishing-contract.md",
    role: "skill-contract"
  }
]);
const EXPECTED_ROUTES: Readonly<Record<string, any>> = Object.freeze({
  prepublication: Object.freeze({
    profile: "upstream-service-prepublication",
    taskOrder: Object.freeze([
      "meshrix.upstream-service-report-template",
      "meshrix.upstream-service-prepublication"
    ])
  }),
  full: Object.freeze({
    profile: "upstream-service-publishing",
    taskOrder: Object.freeze([
      "meshrix.typecheck",
      "meshrix.upstream-service-report-template",
      "meshrix.upstream-service-publishing",
      "meshrix.release-journey"
    ])
  })
});
const SHA256: any = /^sha256:[a-f0-9]{64}$/u;

async function fixture() : Promise<any> {
  return JSON.parse(await fs.readFile(RECEIPT_PATH, "utf8"));
}

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key?: any) : any => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value?: any) : any {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function withoutDigest(value?: any, digestKey?: any) : any {
  const payload: any = structuredClone(value);
  delete payload[digestKey];
  return payload;
}

function routeDigest(route?: any) : any {
  return sha256(canonicalJson(withoutDigest(route, "taskOrderDigest")));
}

function externalTestFactDigest(externalTest?: any) : any {
  return sha256(canonicalJson(withoutDigest(externalTest, "factDigest")));
}

function repairedDigest(receipt?: any) : any {
  receipt.receiptDigest = computeLicoDevUpstreamWorkflowReceiptDigest(receipt);
}

function expectAcceptedBaseline(receipt?: any) : any {
  expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).not.toThrow();
}

describe("lico-dev upstream workflow receipt", () : any => {
  it("accepts one Meshrix-owned immutable receipt for both current lico-dev routes", async () : Promise<any> => {
    const receipt: any = await fixture();

    expect(receipt).toMatchObject({
      schemaVersion: "v1:meshrix:lico-dev-upstream-workflow-receipt",
      receiptId: "meshrix:lico-dev-upstream-workflows",
      owner: "meshrix",
      source: {
        repository: "lico-dev",
        revisionAlgorithm: "git-sha1",
        treeDigestAlgorithm: "sha256-canonical-json-v1"
      },
      routes: {
        digestAlgorithm: "sha256-canonical-json-v1"
      },
      externalTest: {
        command: {
          executable: "node",
          args: ["--test", "tests/workflow.test.ts"]
        },
        passed: true,
        exitCode: 0
      },
      privacy: {
        rawOutputIncluded: false,
        localInformationIncluded: false
      }
    });
    expect(receipt.source.allowlist.map(({ path: sourcePath, role }: Record<string, any>) : any => ({
      path: sourcePath,
      role
    }))).toEqual(EXPECTED_SOURCE_ALLOWLIST);
    expect(new Set<any>(receipt.source.allowlist.map((entry?: any) : any => entry.path)).size)
      .toBe(EXPECTED_SOURCE_ALLOWLIST.length);
    expect(receipt.source.allowlist.every((entry?: any) : any => SHA256.test(entry.digest))).toBe(true);
    expect(receipt.source.treeDigest).toBe(
      sha256(canonicalJson(receipt.source.allowlist))
    );

    for (const [name, expected] of (Object.entries(EXPECTED_ROUTES) as [string, any][])) {
      expect(receipt.routes[name]).toMatchObject(expected);
      expect(receipt.routes[name].taskOrder).toEqual(expected.taskOrder);
      expect(receipt.routes[name].taskOrderDigest).toBe(routeDigest(receipt.routes[name]));
    }
    expect(receipt.externalTest.commandDigest).toBe(
      sha256(canonicalJson(receipt.externalTest.command))
    );
    expect(receipt.externalTest.revision).toBe(receipt.source.revision);
    expect(receipt.externalTest.sourceTreeDigest).toBe(receipt.source.treeDigest);
    expect(receipt.externalTest.factDigest).toBe(
      externalTestFactDigest(receipt.externalTest)
    );
    expect(receipt.receiptDigest).toBe(
      computeLicoDevUpstreamWorkflowReceiptDigest(receipt)
    );

    await expect(loadAndVerifyLicoDevUpstreamWorkflowReceipt()).resolves.toMatchObject({
      ok: true,
      externalTestPassed: true,
      privacySafe: true
    });
  });

  for (const [name, mutate] of [
    ["substituted receipt owner", (receipt?: any) : any => { receipt.owner = "lico-dev"; }],
    ["substituted source repository", (receipt?: any) : any => { receipt.source.repository = "other"; }],
    ["substituted prepublication profile", (receipt?: any) : any => {
      receipt.routes.prepublication.profile = "changed";
    }],
    ["omitted prepublication task", (receipt?: any) : any => {
      receipt.routes.prepublication.taskOrder.pop();
    }],
    ["reordered full-route tasks", (receipt?: any) : any => {
      [
        receipt.routes.full.taskOrder[1],
        receipt.routes.full.taskOrder[2]
      ] = [
        receipt.routes.full.taskOrder[2],
        receipt.routes.full.taskOrder[1]
      ];
    }],
    ["omitted full route", (receipt?: any) : any => { delete receipt.routes.full; }],
    ["substituted external test", (receipt?: any) : any => {
      receipt.externalTest.command.args = ["--test", "tests/other.test.ts"];
    }]
  ]) {
    it(`rejects ${name} even after repairing the receipt summary digest`, async () : Promise<any> => {
      const receipt: any = await fixture();
      expectAcceptedBaseline(receipt);
      mutate(receipt);
      repairedDigest(receipt);
      expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
    });
  }

  for (const [name, mutateAndRepairNestedFact] of [
    ["a source allowlist omission", (receipt?: any) : any => {
      receipt.source.allowlist.pop();
      receipt.source.treeDigest = sha256(canonicalJson(receipt.source.allowlist));
    }],
    ["a source allowlist substitution", (receipt?: any) : any => {
      receipt.source.allowlist[0].path = "config/substituted.json";
      receipt.source.treeDigest = sha256(canonicalJson(receipt.source.allowlist));
    }],
    ["a source allowlist reorder", (receipt?: any) : any => {
      [
        receipt.source.allowlist[0],
        receipt.source.allowlist[1]
      ] = [
        receipt.source.allowlist[1],
        receipt.source.allowlist[0]
      ];
      receipt.source.treeDigest = sha256(canonicalJson(receipt.source.allowlist));
    }],
    ["a prepublication route omission", (receipt?: any) : any => {
      receipt.routes.prepublication.taskOrder.pop();
      receipt.routes.prepublication.taskOrderDigest =
        routeDigest(receipt.routes.prepublication);
    }],
    ["a full-route reorder", (receipt?: any) : any => {
      receipt.routes.full.taskOrder.reverse();
      receipt.routes.full.taskOrderDigest = routeDigest(receipt.routes.full);
    }]
  ]) {
    it(`rejects ${name} even after repairing nested and summary digests`, async () : Promise<any> => {
      const receipt: any = await fixture();
      expectAcceptedBaseline(receipt);
      mutateAndRepairNestedFact(receipt);
      repairedDigest(receipt);
      expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
    });
  }

  it("rejects a jointly stale source and test binding after every derived digest is repaired", async () : Promise<any> => {
    const receipt: any = await fixture();
    expectAcceptedBaseline(receipt);
    receipt.source.revision = "0".repeat(40);
    receipt.source.allowlist[0].digest = sha256("stale-source-bytes");
    receipt.source.treeDigest = sha256(canonicalJson(receipt.source.allowlist));
    receipt.externalTest.revision = receipt.source.revision;
    receipt.externalTest.sourceTreeDigest = receipt.source.treeDigest;
    receipt.externalTest.factDigest = externalTestFactDigest(receipt.externalTest);
    repairedDigest(receipt);

    expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
  });

  for (const [name, mutate] of [
    ["a stale external-test revision", (receipt?: any) : any => {
      receipt.externalTest.revision = "0".repeat(40);
    }],
    ["a stale external-test source tree", (receipt?: any) : any => {
      receipt.externalTest.sourceTreeDigest = `sha256:${"0".repeat(64)}`;
    }],
    ["a failed external test", (receipt?: any) : any => {
      receipt.externalTest.passed = false;
      receipt.externalTest.exitCode = 1;
    }]
  ]) {
    it(`rejects ${name} even when its fact and summary digests are repaired`, async () : Promise<any> => {
      const receipt: any = await fixture();
      expectAcceptedBaseline(receipt);
      mutate(receipt);
      receipt.externalTest.factDigest = externalTestFactDigest(receipt.externalTest);
      repairedDigest(receipt);
      expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
    });
  }

  for (const [name, mutate] of [
    ["raw test output", (receipt?: any) : any => {
      receipt.externalTest.rawOutput = "private runtime output";
    }],
    ["a local source path", (receipt?: any) : any => {
      receipt.source.localPath = ["", "Users", "example", "lico-dev"].join("/");
    }],
    ["a host fact", (receipt?: any) : any => {
      receipt.routes.full.hostname = "private-host";
    }],
    ["a protected token", (receipt?: any) : any => {
      receipt.routes.prepublication.token = "synthetic-protected-value";
    }]
  ]) {
    it(`rejects privacy-unsafe ${name} even when the summary digest is repaired`, async () : Promise<any> => {
      const receipt: any = await fixture();
      expectAcceptedBaseline(receipt);
      mutate(receipt);
      repairedDigest(receipt);
      expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
    });
  }

  for (const [name, mutate] of [
    ["allowlist entry digest", (receipt?: any) : any => {
      receipt.source.allowlist[0].digest = "sha256:invalid";
    }],
    ["source tree digest", (receipt?: any) : any => {
      receipt.source.treeDigest = "sha256:invalid";
    }],
    ["prepublication route digest", (receipt?: any) : any => {
      receipt.routes.prepublication.taskOrderDigest = "sha256:invalid";
    }],
    ["full-route digest", (receipt?: any) : any => {
      receipt.routes.full.taskOrderDigest = "sha256:invalid";
    }],
    ["external command digest", (receipt?: any) : any => {
      receipt.externalTest.commandDigest = "sha256:invalid";
    }],
    ["external test fact digest", (receipt?: any) : any => {
      receipt.externalTest.factDigest = "sha256:invalid";
    }]
  ]) {
    it(`rejects a malformed ${name} after repairing the summary digest`, async () : Promise<any> => {
      const receipt: any = await fixture();
      expectAcceptedBaseline(receipt);
      mutate(receipt);
      repairedDigest(receipt);
      expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
    });
  }

  it("rejects a malformed receipt digest", async () : Promise<any> => {
    const receipt: any = await fixture();
    expectAcceptedBaseline(receipt);
    receipt.receiptDigest = "sha256:invalid";
    expect(() : any => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
  });
});
