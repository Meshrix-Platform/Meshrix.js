import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";

import {
  distinctHanCodepoints,
  embeddedFontNames,
  inflatePdfStreams,
  toUnicodeCodepoints,
  verifyConvertedPdf
} from "../../../tools/server-scripts/lib/release-journey-pdf.ts";
import {
  RELEASE_JOURNEY_STEPS,
  createRedaction,
  createReleaseJourneyReport,
  finalizeReleaseJourneyReport,
  stepReceipt
} from "../../../tools/server-scripts/lib/release-journey-report.ts";
import {
  releaseJourneyUploadCheckpointId,
  safePublicToolSegment,
  uploadBinaryFixtureThroughConnector
} from "../../../tools/server-scripts/lib/release-journey-mcp.ts";
import {
  discoverReleaseJourneyClients
} from "../../../tools/server-scripts/lib/release-journey-adapter.ts";
import {
  apiKeyUploadAuthSession,
  authSubjectFromSession
} from "../../../packages/protocols/http/controllers/jobs-controller-access.ts";
import { uploadSessionOwnerAccess } from "../../../packages/server-runtime/src/state/upload-session-owner.ts";
import {
  apiKeyUploadOperation,
  authorizeApiKeyUpload
} from "../../../apps/server/runtime/http-server-routes.ts";

const FIXTURE_TEXT: any = "格式转换服务中文验收样例\n第一段：Meshrix.js 格式转换服务将 UTF-8 纯文本文档转换为 DOCX 或 PDF。";

function streamOf(payload?: any) : any {
  return Buffer.concat([Buffer.from("stream\n"), deflateSync(payload), Buffer.from("\nendstream")]);
}

function syntheticPdf({ fontName = "BAAAAA+NotoSerifCJKjp-Regular-VKana", codepoints = [] }: Record<string, any> = {}) : any {
  const font: any = streamOf(Buffer.from(`/BaseFont /${fontName} /FontName /${fontName}`, "latin1"));
  const cmapEntries: any = codepoints.map((codepoint?: any) : any => `<${codepoint.toString(16).toUpperCase().padStart(4, "0")}>`).join(" ");
  const cmap: any = streamOf(Buffer.from(`beginbfchar ${cmapEntries} endbfchar`, "latin1"));
  return Buffer.concat([Buffer.from("%PDF-1.6\n"), Buffer.alloc(2048, 0x20), font, cmap, Buffer.from("%%EOF")]);
}

describe("release-journey-pdf", () : any => {
  it("collects distinct Han codepoints from the source text", () : any => {
    const codepoints: any = distinctHanCodepoints(FIXTURE_TEXT);
    expect(codepoints.length).toBeGreaterThan(10);
    expect(codepoints).toContain("格".codePointAt(0));
    expect(codepoints).toContain("样".codePointAt(0));
    expect(new Set<any>(codepoints).size).toBe(codepoints.length);
  });

  it("inflates FlateDecode streams and finds embedded fonts", () : any => {
    const pdf: any = syntheticPdf();
    const inflated: any = inflatePdfStreams(pdf);
    expect(inflated.length).toBe(2);
    const fonts: any = embeddedFontNames([pdf, ...inflated]);
    expect(fonts).toContain("BAAAAA+NotoSerifCJKjp-Regular-VKana");
  });

  it("collects ToUnicode codepoints only from CMap streams", () : any => {
    const codepoint: any = "验".codePointAt(0);
    const pdf: any = syntheticPdf({ codepoints: [codepoint] });
    const mapped: any = toUnicodeCodepoints([pdf, ...inflatePdfStreams(pdf)]);
    expect(mapped.has(codepoint)).toBe(true);
    expect(mapped.has("格".codePointAt(0))).toBe(false);
  });

  it("accepts a fully covered CJK PDF", () : any => {
    const codepoints: any = distinctHanCodepoints(FIXTURE_TEXT);
    const result: any = verifyConvertedPdf(syntheticPdf({ codepoints }), FIXTURE_TEXT);
    expect(result.ok).toBe(true);
    expect(result.magicOk).toBe(true);
    expect(result.notoCjkEmbedded).toBe(true);
    expect(result.hanFullCoverage).toBe(true);
    expect(result.hanCodepointsMapped).toBe(result.hanCodepointsInSource);
  });

  it("rejects a PDF without an embedded Noto CJK font", () : any => {
    const codepoints: any = distinctHanCodepoints(FIXTURE_TEXT);
    const result: any = verifyConvertedPdf(
      syntheticPdf({ fontName: "CAAAAA+LiberationSerif", codepoints }),
      FIXTURE_TEXT
    );
    expect(result.ok).toBe(false);
    expect(result.notoCjkEmbedded).toBe(false);
  });

  it("rejects incomplete ToUnicode Han coverage and reports missing codepoints", () : any => {
    const result: any = verifyConvertedPdf(syntheticPdf({ codepoints: [] }), FIXTURE_TEXT);
    expect(result.ok).toBe(false);
    expect(result.hanFullCoverage).toBe(false);
    expect(result.hanCodepointsMapped).toBe(0);
    expect(result.missingHanCodepoints.length).toBeGreaterThan(0);
    expect(result.missingHanCodepoints[0]).toMatch(/^U\+[0-9A-F]{4}$/u);
  });

  it("rejects non-PDF bytes and undersized payloads", () : any => {
    expect(verifyConvertedPdf(Buffer.from("not a pdf at all"), FIXTURE_TEXT).ok).toBe(false);
    expect(verifyConvertedPdf(Buffer.from("%PDF-"), FIXTURE_TEXT).sizeOk).toBe(false);
  });
});

describe("release-journey-mcp safePublicToolSegment", () : any => {
  it("matches the server-side segment encoding for upstream identities", () : any => {
    expect(safePublicToolSegment("file-parser/format-convert")).toBe("file-parser-format-convert");
    expect(safePublicToolSegment("svc_z6cc0xJR6qEUsDv9EtHH4-jOtmyk0-ddwYmK5G3mTe4")).toBe("svc_z6cc0xJR6qEUsDv9EtHH4-jOtmyk0-ddwYmK5G3mTe4");
    expect(safePublicToolSegment("convert")).toBe("convert");
    expect(safePublicToolSegment("///")).toBe("service");
  });
});

describe("release-journey upload checkpoint identity", () : any => {
  it("isolates deterministic upload sessions by connector target", () : any => {
    const fixtureDigest: any = "f".repeat(64);
    const first: any = releaseJourneyUploadCheckpointId("codex", fixtureDigest);
    const repeated: any = releaseJourneyUploadCheckpointId("codex", fixtureDigest);
    const sibling: any = releaseJourneyUploadCheckpointId("claude-code", fixtureDigest);
    expect(first).toBe(repeated);
    expect(first).not.toBe(sibling);
    expect(first).toMatch(/^release-journey-[a-f0-9]{16}-[a-f0-9]{16}$/u);
  });
});

describe("release-journey native upload", () : any => {
  it("uses an upload session and raw octet-stream bytes without Base64", async () : Promise<any> => {
    const fixtureBytes: any = Buffer.from("native upload fixture", "utf8");
    const calls: any[] = [];
    const protectedValues: any[] = [];
    const result: any = await uploadBinaryFixtureThroughConnector({
      baseUrl: "http://127.0.0.1:8080",
      fixtureBytes,
      fixtureFileName: "fixture.txt",
      addNeedle: (value?: any) : any => protectedValues.push(value),
      resolveCredentials: async () : Promise<any> => ({
        token: "synthetic-token",
        identity: null
      }),
      buildIdentityHeaders: () : any => ({ "x-meshrix-signature": "synthetic-signature" }),
      fetchImpl: async (url?: any, options?: any) : Promise<any> => {
        calls.push({ url: String(url), options });
        if (new URL(url).pathname === "/api/upload-sessions") {
          return {
            ok: true,
            status: 200,
            text: async () : Promise<any> => JSON.stringify({ sessionId: "upload_session_synthetic" })
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () : Promise<any> => JSON.stringify({
            status: "complete",
            files: [{ receivedBytes: fixtureBytes.length }]
          })
        };
      }
    });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].options.body).files[0]).not.toHaveProperty("dataBase64");
    expect(calls[1].options.body).toBe(fixtureBytes);
    expect(calls[1].options.headers["Content-Type"]).toBe("application/octet-stream");
    expect(result.reference).toBe("upload:upload_session_synthetic:0");
    expect(result.receipt.base64Encoded).toBe(false);
    expect(result.receipt.contentEncoding).toBe("identity");
    expect(result.receipt.processIdentityBound).toBe(true);
    expect(protectedValues).toEqual(["synthetic-token", "upload_session_synthetic"]);
  });

  it("uses a scoped API key without fabricating process identity headers", async () : Promise<any> => {
    const fixtureBytes: any = Buffer.from("api key upload fixture", "utf8");
    const calls: any[] = [];
    const result: any = await uploadBinaryFixtureThroughConnector({
      baseUrl: "http://127.0.0.1:8080",
      fixtureBytes,
      fixtureFileName: "fixture.txt",
      resolveCredentials: async () : Promise<any> => ({
        token: `mxak1.${"a".repeat(22)}.${"b".repeat(43)}`,
        identity: null
      }),
      buildIdentityHeaders: () : any => ({}),
      fetchImpl: async (url?: any, options?: any) : Promise<any> => {
        calls.push({ url: String(url), options });
        if (new URL(url).pathname === "/api/upload-sessions") {
          return {
            ok: true,
            status: 200,
            text: async () : Promise<any> => JSON.stringify({ sessionId: "upload_session_api_key" })
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () : Promise<any> => JSON.stringify({
            status: "complete",
            files: [{ receivedBytes: fixtureBytes.length }]
          })
        };
      }
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call?: any) : any => !call.options.headers["x-meshrix-signature"])).toBe(true);
    expect(result.receipt.processIdentityBound).toBe(false);
    expect(result.receipt.workloadIdentityBound).toBe(true);
  });
});

describe("release-journey API key upload owner", () : any => {
  it("uses two rendered-console credentials for the sibling organization journey", async () : Promise<any> => {
    const source: any = await import("node:fs/promises").then((fs?: any) : any =>
      fs.readFile(new URL(
        "../../../tools/server-scripts/verify-release-journey.ts",
        import.meta.url
      ), "utf8")
    );
    expect(source).toContain('organizationNodeId: "organization:secondary"');
    expect(source).toContain('allowedTools: ["uploads.get_session"]');
    expect(source).toContain("siblingProvisioned.apiKey");
    expect(source).toContain("siblingOrganizationCredential");
    expect(source).toContain("installMatrixTargetWithApiKey");
    expect(source).toContain("missingCredentialDeniedBeforeUse");
    expect(source).toContain('credentialSource: "pre-issued-api-key"');
    expect(source).not.toContain("startConnectorInstall");
    expect(source).not.toContain("approvePendingAuthorizations");
    expect(source).not.toContain("x-meshrix-organization-node-id");
  });

  it("binds one frozen workload principal and never accepts caller identity claims", () : any => {
    const authorization: any = Object.freeze({
      credentialKind: "scoped_api_key",
      keyId: "key-id-hidden",
      workloadPrincipalId: "workload-generated-principal",
      organizationNodeId: "group:team",
      lifecycleRevision: 1,
      policyFingerprint: "policy-fingerprint",
      policy: Object.freeze({
        scopeIds: Object.freeze(["uploads:write"]),
        resources: Object.freeze({ workspaceIds: Object.freeze(["workspace-a"]) })
      })
    });
    const session: any = apiKeyUploadAuthSession(authorization);
    expect(session).toMatchObject({
      credentialKind: "scoped_api_key",
      apiKeyAuthorization: authorization,
      user: {
        type: "scoped-api-key",
        subjectId: "workload-generated-principal",
        organizationNodeId: "group:team",
        tenantId: "local",
        scopes: ["uploads:write"],
        allowedWorkspaceIds: ["workspace-a"]
      }
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.user)).toBe(true);
    expect(apiKeyUploadAuthSession({ ...authorization, credentialKind: "tool-grant" })).toBeNull();
  });

  it("denies an actual sibling-organization credential before principal ownership comparison", () : any => {
    const primary: any = apiKeyUploadAuthSession({
      credentialKind: "scoped_api_key",
      workloadPrincipalId: "primary-workload",
      organizationNodeId: "group:team",
      lifecycleRevision: 1,
      policy: { scopeIds: ["uploads:write"], resources: { workspaceIds: [] } }
    });
    const sibling: any = apiKeyUploadAuthSession({
      credentialKind: "scoped_api_key",
      workloadPrincipalId: "sibling-workload",
      organizationNodeId: "organization:secondary",
      lifecycleRevision: 1,
      policy: { scopeIds: ["uploads:write"], resources: { workspaceIds: [] } }
    });
    const primaryOwner: any = authSubjectFromSession(primary);
    const siblingOwner: any = authSubjectFromSession(sibling);
    expect(primaryOwner.organizationNodeId).toBe("group:team");
    expect(siblingOwner.organizationNodeId).toBe("organization:secondary");
    expect(uploadSessionOwnerAccess({
      ownerSubjectId: primaryOwner.subjectId,
      ownerUserId: primaryOwner.userId,
      ownerOrganizationNodeId: primaryOwner.organizationNodeId
    }, siblingOwner)).toMatchObject({
      ok: false,
      reasonCode: "upload_session_organization_mismatch"
    });
  });

  it("requires the exact upload operation and revalidates the immutable lifecycle", async () : Promise<any> => {
    const operation: any = apiKeyUploadOperation("POST", "/api/upload-sessions");
    const context: any = Object.freeze({
      credentialKind: "scoped_api_key",
      keyId: "key-id-hidden",
      workloadPrincipalId: "workload-generated-principal",
      organizationNodeId: "group:team",
      lifecycleRevision: 3,
      policyFingerprint: "policy-fingerprint",
      policy: Object.freeze({
        scopeIds: Object.freeze(["uploads:write"]),
        allowedTools: Object.freeze(["uploads.create_session"]),
        resources: Object.freeze({ workspaceIds: Object.freeze([]) })
      })
    });
    let current: any = { handled: true, ok: true, apiKeyAuthorization: context };
    const authorization: any = await authorizeApiKeyUpload({
      request: { headers: {} },
      requestBody: Buffer.from("{}"),
      url: new URL("http://server.invalid/api/upload-sessions"),
      method: "POST",
      operation,
      toolSkillManagementProvider: {
        authorizeRequest: async () : Promise<any> => current,
        revalidateApiKeyAuthorization: async () : Promise<any> => current.ok === true
          ? { ok: true, apiKeyAuthorization: current.apiKeyAuthorization }
          : current
      }
    });
    expect(authorization).toMatchObject({ ok: true, credentialKind: "scoped_api_key" });
    expect(Object.isFrozen(authorization.authSession)).toBe(true);
    expect(await authorization.revalidateAuthorization()).toMatchObject({ ok: true });
    current = { handled: true, ok: false, status: 410, reasonCode: "api_key_revoked" };
    expect(await authorization.revalidateAuthorization()).toMatchObject({
      ok: false,
      status: 410,
      reasonCode: "api_key_revoked"
    });
  });

  it("denies a scoped key that omits the upload operation before controller effects", async () : Promise<any> => {
    const result: any = await authorizeApiKeyUpload({
      request: { headers: {} },
      requestBody: Buffer.from("{}"),
      url: new URL("http://server.invalid/api/upload-sessions"),
      method: "POST",
      operation: apiKeyUploadOperation("POST", "/api/upload-sessions"),
      toolSkillManagementProvider: {
        authorizeRequest: async () : Promise<any> => ({
          handled: true,
          ok: true,
          apiKeyAuthorization: {
            credentialKind: "scoped_api_key",
            keyId: "key-id-hidden",
            workloadPrincipalId: "workload-generated-principal",
            organizationNodeId: "group:team",
            lifecycleRevision: 1,
            policyFingerprint: "policy-fingerprint",
            policy: {
              scopeIds: ["uploads:write"],
              allowedTools: ["upstream.service.convert"],
              resources: { workspaceIds: [] }
            }
          }
        })
      }
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      reasonCode: "api_key_operation_denied"
    });
  });
});

describe("release-journey-report", () : any => {
  it("redacts runtime secrets and local paths from free text", () : any => {
    const { addNeedle, redact } = createRedaction({ repoRoot: "/repo/root" });
    addNeedle("sap_superSecretPassword123");
    const text: any = redact("login with sap_superSecretPassword123 at /repo/root/tools ok");
    expect(text).not.toContain("sap_superSecretPassword123");
    expect(text).toContain("[redacted-secret]");
  });

  it("fails closed when a secret survives into the report", () : any => {
    const { addNeedle, assertNoLeak } = createRedaction({ repoRoot: "/repo/root" });
    addNeedle("token-abcdef123456");
    const report: any = createReleaseJourneyReport({});
    report.steps.push(stepReceipt("preflight", { status: "passed", receipt: { note: "token-abcdef123456" } }));
    expect(() : any => finalizeReleaseJourneyReport(report, { assertNoLeak })).toThrow(/secret/u);
  });

  it("computes releaseReady from step and cleanup outcomes", () : any => {
    const report: any = createReleaseJourneyReport({
      startedAt: "2026-07-29T00:00:00.000Z"
    });
    report.finishedAt = "2026-07-29T00:04:00.000Z";
    for (const id of RELEASE_JOURNEY_STEPS.filter((step?: any) : any => step !== "cleanup")) {
      report.steps.push(stepReceipt(id, { status: "passed", durationMs: 1_000 }));
    }
    report.cleanup = {
      performed: true,
      startedAt: "2026-07-29T00:03:58.800Z",
      finishedAt: "2026-07-29T00:04:00.000Z",
      durationMs: 1_200,
      details: [
        { id: "connector-uninstall", status: "passed", durationMs: 400 },
        { id: "compose-down", status: "passed", durationMs: 600 },
        { id: "temp-workdir", status: "passed", durationMs: 200 }
      ]
    };
    const { report: finalized, serialized } = finalizeReleaseJourneyReport(report);
    expect(finalized.releaseReady).toBe(true);
    expect(finalized.generatedAt).toBeTruthy();
    expect(finalized.timing).toEqual({
      totalDurationMs: 240_000,
      stepDurationMs: 13_000,
      cleanupDurationMs: 1_200
    });
    expect(finalized.cleanup.details.reduce(
      (total?: any, detail?: any) : any => total + detail.durationMs,
      0
    )).toBe(finalized.cleanup.durationMs);
    expect(serialized.endsWith("\n")).toBe(true);

    const failed: any = createReleaseJourneyReport({});
    failed.steps.push(stepReceipt("connector-install-matrix", { status: "failed", error: { message: "boom" } }));
    expect(finalizeReleaseJourneyReport(failed).report.releaseReady).toBe(false);
  });

  it("keeps incomplete, skipped, or uncleaned journeys out of candidate evidence", () : any => {
    const missingStep: any = createReleaseJourneyReport({});
    for (const id of RELEASE_JOURNEY_STEPS.filter(
      (step?: any) : any => step !== "cleanup" && step !== "pdf-verify"
    )) {
      missingStep.steps.push(stepReceipt(id, { status: "passed", durationMs: 1 }));
    }
    missingStep.cleanup = {
      performed: true,
      durationMs: 1,
      details: [{ id: "compose-down", status: "passed", durationMs: 1 }]
    };
    expect(finalizeReleaseJourneyReport(missingStep).report.releaseReady).toBe(false);

    const skipped: any = createReleaseJourneyReport({});
    for (const id of RELEASE_JOURNEY_STEPS.filter((step?: any) : any => step !== "cleanup")) {
      skipped.steps.push(stepReceipt(id, {
        status: id === "client-discovery" ? "skipped" : "passed",
        durationMs: 1
      }));
    }
    skipped.cleanup = {
      performed: true,
      durationMs: 1,
      details: [{ id: "compose-down", status: "passed", durationMs: 1 }]
    };
    expect(finalizeReleaseJourneyReport(skipped).report.releaseReady).toBe(false);

    const cleanupMissing: any = createReleaseJourneyReport({});
    for (const id of RELEASE_JOURNEY_STEPS.filter((step?: any) : any => step !== "cleanup")) {
      cleanupMissing.steps.push(stepReceipt(id, { status: "passed", durationMs: 1 }));
    }
    expect(finalizeReleaseJourneyReport(cleanupMissing).report.releaseReady).toBe(false);
  });

  it("produces step receipts with bounded error payloads", () : any => {
    const receipt: any = stepReceipt("adapter-seed", {
      status: "failed",
      durationMs: 3.7,
      error: { code: "release_journey_adapter_source_missing", message: "x".repeat(2000) }
    });
    expect(receipt.durationMs).toBe(4);
    expect(receipt.error.message.length).toBeLessThanOrEqual(800);
    expect(receipt.error.code).toBe("release_journey_adapter_source_missing");
  });
});

describe("release-journey client selection", () : any => {
  it("uses every detected real client and forbids simulation", async () : Promise<any> => {
    const result: any = await discoverReleaseJourneyClients({
      cacheRoot: "<adapter-cache>",
      baseUrl: "http://127.0.0.1:7228",
      scanTargets: async () : Promise<any> => ({
        candidates: [
          {
            target: "codex",
            status: "detected",
            optionOverrides: { __meshrixAdapterClient: { command: "codex" } }
          },
          {
            target: "kimi",
            status: "detected",
            optionOverrides: { __meshrixAdapterClient: { command: "kimi" } }
          }
        ]
      })
    });

    expect(result.detected.map((entry?: any) : any => entry.target)).toEqual(["codex", "kimi"]);
    expect(result.fallback).toBeNull();
  });

  it("permits a declared MCP simulator only after the complete scan detects zero clients", async () : Promise<any> => {
    const result: any = await discoverReleaseJourneyClients({
      cacheRoot: "<adapter-cache>",
      baseUrl: "http://127.0.0.1:7228",
      fallbackCommand: "node",
      scanTargets: async () : Promise<any> => ({ candidates: [] })
    });

    expect(result.detected).toEqual([]);
    expect(result.report).toHaveLength(7);
    expect(result.report.every((entry?: any) : any => entry.status === "not_detected")).toBe(true);
    expect(result.fallback).toMatchObject({
      target: "kimi",
      reportTarget: "mcp-simulator",
      command: "node",
      validationMode: "simulated-fallback"
    });
  });
});
