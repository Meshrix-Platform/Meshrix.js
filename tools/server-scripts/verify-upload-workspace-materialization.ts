#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import {
  createUploadWorkspaceMaterializationTransactionStore
} from "../../packages/server-runtime/src/composition/upload-workspace-materialization-provider.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifier: any =
  "tools/server-scripts/verify-upload-workspace-materialization.ts";
const reportRelativePath: any =
  "build/reports/upload-workspace-materialization.json";
const reportPath: any = path.join(repoRoot, reportRelativePath);
const logicalTarget: any = "imports/asset.txt";
const MAX_RESPONSE_BYTES: any = 1024 * 1024;
const SAFE_TOKEN: any = /^[a-z0-9][a-z0-9:._-]{0,79}$/u;
const FORBIDDEN_ADMISSION_ALIASES: readonly any[] = Object.freeze([
  "allow",
  "allowed",
  "authorized",
  "body",
  "buffer",
  "bytes",
  "content",
  "contentBase64",
  "descriptor",
  "fileDescriptor",
  "materializationDescriptor",
  "mutation",
  "credential",
  "encryptionKey",
  "key",
  "secret",
  "accessToken",
  "bearer",
  "sessionToken",
  "token",
  "authorization",
  "capability",
  "permit",
  "proof",
  "approvalReceipt",
  "authorizationReceipt",
  "receipt",
  "settlementReceipt",
  "absolutePath",
  "destination",
  "sourcePath",
  "targetPath"
]);

const sha256: any = (value?: any) : any =>
  crypto.createHash("sha256").update(value).digest("hex");
const sleep: any = (milliseconds?: any) : any =>
  new Promise((resolve?: any) : any => setTimeout(resolve, milliseconds));

let verifierStage: any = "startup";

function safeToken(value?: any, fallback?: any) : any {
  const normalized: any = String(value || "").trim().toLowerCase();
  return SAFE_TOKEN.test(normalized) ? normalized : fallback;
}

async function main() : Promise<any> {
  const startedAt: any = new Date();
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-upload-materialization-")
  );
  let server: any;
  let verified: any = false;
  try {
    verifierStage = "server-start";
    server = await startHttpServer({
      userDataPath,
      distPath: "",
      port: 0,
      runtimeOptions: { profile: "minimal" }
    });

    verifierStage = "authentication";
    await installAuthenticatedFetch(server, { safetyConfirm: false });

    const api: any = async (method?: any, route?: any, body?: any, confirm: any = true) : Promise<any> => {
      const response: any = await fetch(`${server.url}${route}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(confirm
            ? { "x-meshrix-safety-confirm": "true" }
            : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const responseText: any = await response.text();
      assert.ok(
        Buffer.byteLength(responseText, "utf8") <= MAX_RESPONSE_BYTES,
        "Verifier response exceeded its bounded admission."
      );
      return {
        status: response.status,
        payload: responseText ? JSON.parse(responseText) : {}
      };
    };

    verifierStage = "workspace-create";
    const created: any = await api("POST", "/api/agent-workspaces", {
      title: "Materialization verification",
      objective: "Verify governed queued materialization."
    });
    assert.equal(created.status, 201);
    const workspaceId: any = created.payload.workspace.workspaceId;

    verifierStage = "workspace-parent-create";
    const parent: any = await api(
      "POST",
      `/api/agent-workspaces/${encodeURIComponent(
        workspaceId
      )}/folders`,
      {
        folderPath: "imports"
      }
    );
    assert.equal(parent.status, 201);

    verifierStage = "workspace-seed";
    const seed: any = await api(
      "POST",
      `/api/agent-workspaces/${encodeURIComponent(workspaceId)}/files`,
      {
        path: "seed.txt",
        fileName: "seed.txt",
        content: "seed"
      }
    );
    assert.equal(seed.status, 201);
    const expectedWorkspaceRevision: any = seed.payload.stateCommit.afterRoot;

    verifierStage = "upload-session-create";
    const content: any = Buffer.from("materialized-content");
    const session: any = await api("POST", "/api/upload-sessions", {
      checkpoint: {
        checkpointId: "materialization-checkpoint"
      },
      manifest: {
        manifestDigest: sha256("manifest"),
        inputDigest: sha256("input")
      },
      files: [{
        relativePath: "asset.txt",
        sha256: sha256(content),
        byteSize: content.length,
        mediaType: "text/plain"
      }]
    });
    assert.equal(session.status, 200);

    verifierStage = "upload-chunk";
    const chunk: any = await fetch(
      `${server.url}/api/upload-sessions/${
        encodeURIComponent(session.payload.sessionId)
      }/files/0?offset=0`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: content
      }
    );
    assert.equal(chunk.status, 200);

    const request: Record<string, any> = {
      uploadSessionId: session.payload.sessionId,
      workspaceId,
      expectedWorkspaceRevision,
      logicalTarget,
      safetyConfirm: true
    };

    verifierStage = "closed-admission";
    for (const alias of FORBIDDEN_ADMISSION_ALIASES) {
      for (const forbidden of [
        { [alias]: "caller-supplied" },
        {
          confirm: {
            envelope: [{
              facts: { [alias]: "caller-supplied" }
            }]
          }
        }
      ]) {
        const rejected: any = await api(
          "POST",
          "/api/jobs/upload-workspace-materializations",
          {
            ...request,
            ...forbidden
          }
        );
        assert.equal(rejected.status, 400);
      }
    }
    const closedAdmissionStore: any =
      createUploadWorkspaceMaterializationTransactionStore({
        userDataPath
      });
    try {
      assert.equal(closedAdmissionStore.count(), 0);
    } finally {
      closedAdmissionStore.close();
    }

    verifierStage = "approval-denial";
    const denied: any = await api(
      "POST",
      "/api/jobs/upload-workspace-materializations",
      {
        ...request,
        safetyConfirm: false
      },
      false
    );
    assert.equal(denied.status, 428);

    verifierStage = "materialization-admission";
    const admitted: any = await api(
      "POST",
      "/api/jobs/upload-workspace-materializations",
      request,
      true
    );
    assert.equal(admitted.status, 202);
    assert.ok(admitted.payload.requestRef);

    verifierStage = "materialization-read";
    let read: any = null;
    for (let attempt: any = 0; attempt < 200; attempt += 1) {
      read = await api(
        "GET",
        `/api/agent-workspaces/${encodeURIComponent(
          workspaceId
        )}/files/download?path=${encodeURIComponent(
          logicalTarget
        )}&includeText=true`,
        undefined
      );
      if (read.status === 200) break;
      await sleep(25);
    }
    if (read?.status !== 200) {
      const transactionStore: any =
        createUploadWorkspaceMaterializationTransactionStore({
          userDataPath
        });
      let transaction: any;
      try {
        transaction = await transactionStore.get(
          admitted.payload.requestRef
        );
      } finally {
        transactionStore.close();
      }
      throw Object.assign(
        new Error("Materialization did not reach its readable state."),
        {
          code: safeToken(
            transaction?.error?.code || transaction?.status,
            "materialization_incomplete"
          )
        }
      );
    }
    assert.equal(read?.status, 200);
    assert.equal(read.payload.content, "materialized-content");

    verifierStage = "materialization-terminal";
    const transactionStore: any =
      createUploadWorkspaceMaterializationTransactionStore({
        userDataPath
      });
    let transaction: any = null;
    try {
      for (let attempt: any = 0; attempt < 200; attempt += 1) {
        transaction = await transactionStore.get(
          admitted.payload.requestRef
        );
        if (
          ["cancelled", "completed", "failed"].includes(
            transaction?.status
          )
        ) {
          break;
        }
        await sleep(25);
      }
    } finally {
      transactionStore.close();
    }
    if (transaction?.status !== "completed") {
      throw Object.assign(
        new Error(
          "Materialization did not reach its completed transaction."
        ),
        {
          code: safeToken(
            transaction?.error?.code || transaction?.status,
            "materialization_incomplete"
          )
        }
      );
    }
    assert.equal(transaction.stage, "completed");
    assert.equal(
      transaction.result.contentDigest,
      sha256(content)
    );
    assert.equal(
      transaction.result.workspaceRevision,
      transaction.publishedRevision
    );
    assert.deepEqual(
      Object.keys(transaction.evidence).sort(),
      [
        "auditCreatedAt",
        "auditId",
        "auditRef",
        "proofOutcomeKey",
        "proofRef",
        "settlementDigest"
      ]
    );

    verifierStage = "materialization-replay";
    const replay: any = await api(
      "POST",
      "/api/jobs/upload-workspace-materializations",
      request,
      true
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.payload.deduped, true);
    assert.equal(
      replay.payload.requestRef,
      admitted.payload.requestRef
    );
    assert.equal(replay.payload.result.replayed, true);
    assert.equal(replay.payload.result.status, "completed");

    verifierStage = "report-finalize";
    const finishedAt: any = new Date();
    const provenance: Record<string, any> = {
      producer: "meshrix-core-upload-workspace-materialization",
      commandId: "upload-workspace-materialization",
      sourceRevision: await computeVerifierSourceRevision(repoRoot, [
        "packages/agents/src/agent-workspace/agent-workspace-materialization.ts",
        "packages/server-runtime/src/composition/composition-root.ts",
        "packages/server-runtime/src/jobs/upload-workspace-materialization.ts",
        "packages/server-runtime/src/composition/upload-workspace-materialization-provider.ts",
        verifier
      ])
    };
    const report: any = finalizeSensitiveReport({
      schemaVersion:
        "v0.0.1:jobs:upload-workspace-materialization-report-1",
      verifier,
      generatedAt: finishedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ok: true,
      summary: {
        verificationPassed: true,
        productionComposition: true,
        canonicalQueue: true,
        canonicalWorkspaceRevision: true,
        canonicalLogicalTarget: true,
        closedAdmissionPassed: true,
        closedEvidencePassed: true,
        completedTransactionPassed: true,
        approvalDenialBeforeAdmission: true,
        idempotentReplayPassed: true,
        materializedContentVerified: true
      },
      checks: [
        { id: "closed-admission", status: "passed" },
        { id: "approval-denial", status: "passed" },
        { id: "queued-production-admission", status: "passed" },
        { id: "canonical-workspace-mutation", status: "passed" },
        { id: "closed-evidence", status: "passed" },
        { id: "completed-transaction", status: "passed" },
        { id: "idempotent-replay", status: "passed" }
      ]
    }, { provenance });

    verifierStage = "report-privacy";
    assertNoSensitiveReportLeak(
      report,
      "upload workspace materialization report"
    );
    verifierStage = "report-provenance";
    assertReportProvenance(report, provenance);
    verifierStage = "report-write";
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`
    );
    verified = true;
  } finally {
    await server?.close?.();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }

  if (verified) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      report: reportRelativePath
    })}\n`);
  }
}

main().catch((error?: any) : any => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    reason: "upload_workspace_materialization_verification_failed",
    errorCode: safeToken(
      error?.code || error?.name,
      "verification_error"
    ),
    stage: safeToken(verifierStage, "verification")
  })}\n`);
  process.exitCode = 1;
});
