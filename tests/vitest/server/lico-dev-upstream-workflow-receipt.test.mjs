import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  computeLicoDevUpstreamWorkflowReceiptDigest,
  loadAndVerifyLicoDevUpstreamWorkflowReceipt,
  verifyLicoDevUpstreamWorkflowReceipt
} from "../../../tools/server-scripts/verify-lico-dev-upstream-workflow-receipt.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RECEIPT_PATH = path.join(REPO_ROOT, "tools/registry/lico-dev-upstream-workflow-receipt.json");

async function fixture() {
  return JSON.parse(await fs.readFile(RECEIPT_PATH, "utf8"));
}

function repairedDigest(receipt) {
  receipt.receiptDigest = computeLicoDevUpstreamWorkflowReceiptDigest(receipt);
}

describe("lico-dev upstream workflow receipt", () => {
  it("accepts the exact immutable privacy-safe workflow binding", async () => {
    await expect(loadAndVerifyLicoDevUpstreamWorkflowReceipt()).resolves.toMatchObject({
      ok: true,
      externalTestPassed: true,
      privacySafe: true
    });
  });

  for (const [name, mutate] of [
    ["missing allowlist fact", (receipt) => { receipt.source.allowlist.pop(); }],
    ["stale revision", (receipt) => { receipt.source.revision = "0".repeat(40); receipt.externalTest.revision = receipt.source.revision; }],
    ["substituted workflow", (receipt) => { receipt.workflow.id = "core.gateway-boundary"; receipt.workflow.changedRouting.selectedWorkflowId = receipt.workflow.id; }],
    ["extra fact", (receipt) => { receipt.workflow.compatibility = true; }],
    ["malformed digest", (receipt) => { receipt.source.treeDigest = "sha256:invalid"; }],
    ["privacy-unsafe value", (receipt) => { receipt.source.localPath = ["", "Users", "example", "lico-dev"].join("/"); }],
    ["failed external test", (receipt) => { receipt.externalTest.passed = false; receipt.externalTest.exitCode = 1; }]
  ]) {
    it(`rejects ${name} even when the summary digest is repaired`, async () => {
      const receipt = await fixture();
      mutate(receipt);
      repairedDigest(receipt);
      expect(() => verifyLicoDevUpstreamWorkflowReceipt(receipt)).toThrow();
    });
  }
});
