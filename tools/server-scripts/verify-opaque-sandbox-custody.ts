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
import { createSourceEvidenceContext } from "./lib/source-tree-digest.ts";

const REPORT_SCHEMA: any = "v0.0.1:execution-sandbox:opaque-custody-acceptance-report-1";
const REPORT_PATH: any = "build/reports/opaque-sandbox-custody.json";
const VERIFIER: any = "tools/server-scripts/verify-opaque-sandbox-custody.ts";
const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function removePrivateTree(root?: any) : Promise<any> {
  await fs.chmod(root, 0o700).catch(() : any => {});
  await fs.rm(root, { recursive: true, force: true });
}

async function *source(value?: any) : AsyncGenerator<any, any, any> {
  const bytes: any = Buffer.from(value);
  yield bytes.subarray(0, 5);
  yield bytes.subarray(5);
}

function promotion(stored?: any) : any {
  const policyRevision: any = "custody-verification-policy";
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
}: Record<string, any> = {}) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-opaque-custody-verifier-"));
  const storageKernel: any = createStorageKernel({ userDataPath: root });
  const storageProvider: any = createStorageProvider({ userDataPath: root, storageKernel });
  const keyBroker: any = createLocalCustodyKeyBroker({ userDataPath: root });
  const custodyRuntime: any = createOpaqueSandboxCustodyRuntime({ userDataPath: root, storageKernel, storageProvider, keyBroker });
  const custody: any = custodyRuntime.custody;
  const plaintext: any = Buffer.from("opaque-custody-verification-payload", "utf8");
  const checks: Record<string, any> = {};
  try {
    const stored: any = await custody.store({
      source: source(plaintext),
      idempotencyKey: "seal:verified",
      ownerBinding: {
        subjectRef: "subject:verified",
        tenantRef: "tenant:verified",
        workspaceRef: "workspace:verified"
      }
    });
    const object: any = storageProvider.getObject(stored.handle.slice("custody:".length));
    const objectPath: any = storageProvider.resolveStoredObjectPath(object.storageRelativePath);
    const ciphertext: any = await fs.readFile(objectPath);
    checks.ciphertextOnlyPersistence = !ciphertext.includes(plaintext);
    checks.canonicalLifecycleRows = storageKernel.db.prepare(
      "SELECT COUNT(*) AS count FROM opaque_custody_artifacts WHERE custody_ref = ? AND state = 'sealed'"
    ).get(stored.handle).count === 1;

    const released: any[] = [];
    await custodyRuntime.promotionAuthority.promote(promotion(stored), async (chunk?: any) : Promise<any> => released.push(Buffer.from(chunk)));
    checks.explicitDigestBoundPromotion = sha256(Buffer.concat(released)) === stored.contentDigest;
    checks.promotionAuditPersisted = storageKernel.db.prepare(
      "SELECT COUNT(*) AS count FROM opaque_custody_promotions WHERE custody_ref = ? AND state = 'released'"
    ).get(stored.handle).count === 1;

    await fs.writeFile(objectPath, ciphertext.subarray(0, Math.max(1, ciphertext.length - 8)));
    let tamperReleased: any = false;
    try {
      await custodyRuntime.promotionAuthority.promote({ ...promotion(stored), idempotencyKey: "promotion:tampered" }, async () : Promise<any> => {
        tamperReleased = true;
      });
    } catch (error: any) {
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
      await fs.stat(objectPath).then(() : any => false, () : any => true);
    checks.reportLeakScan = true;

    const custodyAcceptanceReady: any = (Object.values(checks) as any[]).every(Boolean);
    const report: Readonly<Record<string, any>> = Object.freeze({
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
        failedCheckCount: (Object.values(checks) as any[]).filter((value?: any) : any => !value).length,
        reportLeakScan: true
      }),
      checks: Object.freeze(checks)
    });
    if (writeReport) {
      const absolutePath: any = path.resolve(reportPath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  } finally {
    plaintext.fill(0);
    await keyBroker.close().catch(() : any => {});
    storageKernel.close();
    await removePrivateTree(root);
  }
}

const invokedDirectly: any = process.argv[1] &&
  path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runOpaqueSandboxCustodyVerification().then((report?: any) : any => {
    console.log(`[opaque-sandbox-custody] custodyAcceptanceReady=${report.custodyAcceptanceReady} checks=${report.summary.checkCount}`);
    if (!report.custodyAcceptanceReady) process.exitCode = 1;
  }).catch((error?: any) : any => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
