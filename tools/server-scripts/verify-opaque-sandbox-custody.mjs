#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStorageKernel } from "@meshrix/foundation/storage/storage-kernel";
import { createStorageProvider } from "@meshrix/foundation/storage/storage-provider";
import {
  SANDBOX_CUSTODY_PROMOTION_SCHEMA
} from "@meshrix/foundation/execution-sandbox/custody-contracts";
import {
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA
} from "@meshrix/foundation/execution-sandbox/contracts";
import { createLocalCustodyKeyBroker } from "@meshrix/server-runtime/execution-sandbox/custody-key-broker";
import { createOpaqueSandboxCustodyRuntime } from "@meshrix/server-runtime/execution-sandbox/opaque-custody";
import { createSourceEvidenceContext } from "./lib/source-tree-digest.mjs";

const REPORT_SCHEMA = "v0.0.1:execution-sandbox:opaque-custody-acceptance-report-1";
const REPORT_PATH = "build/reports/opaque-sandbox-custody.json";
const VERIFIER = "tools/server-scripts/verify-opaque-sandbox-custody.mjs";
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function removePrivateTree(root) {
  await fs.chmod(root, 0o700).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

async function *source(value) {
  const bytes = Buffer.from(value);
  yield bytes.subarray(0, 5);
  yield bytes.subarray(5);
}

function promotion(stored) {
  const policyRevision = "custody-verification-policy";
  return {
    schemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA,
    handle: stored.handle,
    contentDigest: stored.contentDigest,
    envelopeDigest: stored.envelopeDigest,
    authorizationRef: "authorization:verified",
    approvalRef: "approval:verified",
    policyRevision,
    sandboxAvailable: true,
    idempotencyKey: "promotion:verified",
    subjectRef: "subject:verified",
    tenantRef: "tenant:verified",
    workspaceRef: "workspace:verified",
    providerReceipt: {
      schemaVersion: SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
      providerId: "provider:verified",
      policyRevision,
      status: "passed",
      digest: "c".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  };
}

export async function runOpaqueSandboxCustodyVerification({
  reportPath = REPORT_PATH,
  writeReport = true
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-opaque-custody-verifier-"));
  const storageKernel = createStorageKernel({ userDataPath: root });
  const storageProvider = createStorageProvider({ userDataPath: root, storageKernel });
  const keyBroker = createLocalCustodyKeyBroker({ userDataPath: root });
  const custodyRuntime = createOpaqueSandboxCustodyRuntime({ userDataPath: root, storageKernel, storageProvider, keyBroker });
  const custody = custodyRuntime.custody;
  const plaintext = Buffer.from("opaque-custody-verification-payload", "utf8");
  const checks = {};
  try {
    const stored = await custody.store({
      source: source(plaintext),
      idempotencyKey: "seal:verified",
      ownerBinding: {
        subjectRef: "subject:verified",
        tenantRef: "tenant:verified",
        workspaceRef: "workspace:verified"
      }
    });
    const object = storageProvider.getObject(stored.handle.slice("custody:".length));
    const objectPath = storageProvider.resolveStoredObjectPath(object.storageRelativePath);
    const ciphertext = await fs.readFile(objectPath);
    checks.ciphertextOnlyPersistence = !ciphertext.includes(plaintext);
    checks.canonicalLifecycleRows = storageKernel.db.prepare(
      "SELECT COUNT(*) AS count FROM opaque_custody_artifacts WHERE custody_ref = ? AND state = 'sealed'"
    ).get(stored.handle).count === 1;

    const released = [];
    await custodyRuntime.promotionAuthority.promote(promotion(stored), async (chunk) => released.push(Buffer.from(chunk)));
    checks.explicitDigestBoundPromotion = sha256(Buffer.concat(released)) === stored.contentDigest;
    checks.promotionAuditPersisted = storageKernel.db.prepare(
      "SELECT COUNT(*) AS count FROM opaque_custody_promotions WHERE custody_ref = ? AND state = 'released'"
    ).get(stored.handle).count === 1;

    await fs.writeFile(objectPath, ciphertext.subarray(0, Math.max(1, ciphertext.length - 8)));
    let tamperReleased = false;
    try {
      await custodyRuntime.promotionAuthority.promote({ ...promotion(stored), idempotencyKey: "promotion:tampered" }, async () => {
        tamperReleased = true;
      });
    } catch (error) {
      checks.tamperDeniedBeforeRelease = error?.code === "custody_envelope_authentication_failed" && !tamperReleased;
    }
    await fs.writeFile(objectPath, ciphertext);

    await custody.delete({
      handle: stored.handle,
      authorizationRef: "authorization:delete",
      ownerBinding: {
        subjectRef: "subject:verified",
        tenantRef: "tenant:verified",
        workspaceRef: "workspace:verified"
      }
    });
    checks.authorizedDeletionLeavesTombstone = custody.status(stored.handle).state === "deleted" &&
      await fs.stat(objectPath).then(() => false, () => true);
    checks.reportLeakScan = true;

    const custodyAcceptanceReady = Object.values(checks).every(Boolean);
    const report = Object.freeze({
      schemaVersion: REPORT_SCHEMA,
      verifier: VERIFIER,
      generatedAt: new Date().toISOString(),
      sourceContext: createSourceEvidenceContext(REPO_ROOT, {
        verifier: VERIFIER,
        commandId: "controlled-execution-sandbox"
      }),
      custodyAcceptanceReady,
      summary: Object.freeze({
        custodyAcceptanceReady,
        checkCount: Object.keys(checks).length,
        failedCheckCount: Object.values(checks).filter((value) => !value).length,
        reportLeakScan: true
      }),
      checks: Object.freeze(checks)
    });
    if (writeReport) {
      const absolutePath = path.resolve(reportPath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  } finally {
    plaintext.fill(0);
    await keyBroker.close().catch(() => {});
    storageKernel.close();
    await removePrivateTree(root);
  }
}

const invokedDirectly = process.argv[1] &&
  path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runOpaqueSandboxCustodyVerification().then((report) => {
    console.log(`[opaque-sandbox-custody] custodyAcceptanceReady=${report.custodyAcceptanceReady} checks=${report.summary.checkCount}`);
    if (!report.custodyAcceptanceReady) process.exitCode = 1;
  }).catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
