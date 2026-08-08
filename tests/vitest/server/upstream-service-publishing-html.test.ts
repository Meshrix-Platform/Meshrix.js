import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  UPSTREAM_SERVICE_PUBLISHING_BLANK_TEMPLATE_PATH,
  UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH,
  UPSTREAM_SERVICE_PUBLISHING_REPORT_SECTIONS,
  renderUpstreamServicePublishingBlankTemplate,
  renderUpstreamServicePublishingHtml as renderVerifiedUpstreamServicePublishingHtml
} from "../../../tools/server-scripts/lib/upstream-service-publishing-html.ts";
import {
  RELEASE_JOURNEY_STEPS
} from "../../../tools/server-scripts/lib/release-journey-report.ts";

const BASIC_CONFIG_DOCUMENT: Readonly<Record<string, any>> = Object.freeze({
  descriptor: {
    healthPath: "/readyz",
    operations: [
      {
        operationKey: "convert-require-approval-debug",
        method: "POST",
        path: "/v1/convert",
        risk: "safe_write",
        requiredScopes: ["gateway:write"],
        requiresApproval: true,
        requiredApproval: { required: true },
        timeoutMs: 30_000,
        payloadTransport: {
          request: {
            mode: "artifact_multipart",
            maxBytes: 53_477_376,
            mediaTypes: ["multipart/form-data"],
            multipart: {
              artifactParts: [{ argument: "file", partName: "file", required: true }],
              scalarFields: [{
                argument: "targetFormat",
                partName: "targetFormat",
                required: false
              }]
            }
          },
          response: {
            mode: "artifact",
            maxBytes: 104_857_600,
            mediaTypes: [
              "application/pdf",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ],
            allowRanges: true
          }
        }
      },
      {
        operationKey: "convert-full-access-debug",
        method: "POST",
        path: "/v1/convert",
        risk: "safe_write",
        requiredScopes: ["gateway:write"],
        timeoutMs: 30_000,
        payloadTransport: {
          request: {
            mode: "artifact_multipart",
            maxBytes: 53_477_376,
            mediaTypes: ["multipart/form-data"],
            multipart: {
              artifactParts: [{ argument: "file", partName: "file", required: true }],
              scalarFields: [{
                argument: "targetFormat",
                partName: "targetFormat",
                required: false
              }]
            }
          },
          response: {
            mode: "artifact",
            maxBytes: 104_857_600,
            mediaTypes: [
              "application/pdf",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ],
            allowRanges: true
          }
        }
      }
    ]
  }
});
const BASIC_CONFIG_TEXT: any = `${JSON.stringify(BASIC_CONFIG_DOCUMENT, null, 2)}\n`;
const BASIC_CONFIG_SHA256: any = createHash("sha256").update(BASIC_CONFIG_TEXT).digest("hex");
const SYNTHETIC_SCREENSHOT_BYTES: any = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
SYNTHETIC_SCREENSHOT_BYTES.writeUInt32BE(2880, 16);
SYNTHETIC_SCREENSHOT_BYTES.writeUInt32BE(2000, 20);
const SYNTHETIC_SCREENSHOT_SHA256: any = createHash("sha256")
  .update(SYNTHETIC_SCREENSHOT_BYTES)
  .digest("hex");

function renderUpstreamServicePublishingHtml(
  report?: any,
  journey?: any,
  candidateReceipt: any = verifiedCandidateReceipt()
) : any {
  const visualEvidenceFiles: any = new Map<any, any>(
    journey.visualEvidence.map((item?: any) : any => [item.file, SYNTHETIC_SCREENSHOT_BYTES])
  );
  return renderVerifiedUpstreamServicePublishingHtml(
    report,
    journey,
    BASIC_CONFIG_TEXT,
    visualEvidenceFiles,
    candidateReceipt
  );
}

const VISUAL_EVIDENCE: readonly any[] = Object.freeze([
  ["console-authenticated", "Authenticated Meshrix.js Workbench", "/"],
  ["console-organization-permissions", "Published organization and permission projection", "/admin/organization-governance"],
  ["console-upstream-basic-config", "Upstream service basic configuration", "/admin/publish-upstream-service"],
  ["console-upstream-operation-config", "Upstream operation configuration", "/admin/publish-upstream-service"],
  ["console-upstream-published", "Published upstream service and runtime health", "/admin/publish-upstream-service"],
  ["console-published-tool", "Published operation in the tool catalog", "/admin/tool-list"],
  ["console-api-key-generated", "Issued organization-scoped API Key record", "/admin/api-key-distribution"],
  ["console-downstream-agent-configured", "Downstream agent configured with the pre-issued API Key", "/admin/api-key-distribution"],
  ["console-operation-approval-pending", "Pending Operation Permission approval", "/approval"],
  ["console-operation-approval-completed", "Completed Operation Permission approval", "/approval"],
  ["console-downstream-mcp-call", "Downstream MCP call in the Console audit", "/admin/tool-stats"]
]);
const MANUAL_GROUPS: readonly any[] = Object.freeze([
  ["organization-structure-configuration", "组织架构的配置", [
    "console-authenticated", "console-organization-permissions"
  ]],
  ["upstream-service-registration-publishing", "上游服务的注册到发布", [
    "console-upstream-basic-config", "console-upstream-operation-config", "console-upstream-published"
  ]],
  ["tool-permission-configuration", "工具权限的配置", [
    "console-published-tool", "console-api-key-generated"
  ]],
  ["mcp-service-request", "MCP 服务的请求", [
    "console-downstream-agent-configured", "console-operation-approval-pending",
    "console-operation-approval-completed", "console-downstream-mcp-call"
  ]]
]);
const VERIFIED_JOURNEY_STEP_IDS: any = Object.freeze(
  RELEASE_JOURNEY_STEPS.filter((id?: any) : any => id !== "cleanup")
);
const VERIFIED_CLEANUP_DETAILS: readonly any[] = Object.freeze([
  { id: "connector-uninstall:codex", status: "passed", durationMs: 300 },
  { id: "compose-down", status: "passed", durationMs: 400 },
  { id: "server-image-remove", status: "passed", durationMs: 200 },
  { id: "temp-workdir", status: "passed", durationMs: 300 }
]);
const VERIFIED_CLEANUP_DURATION_MS: any = 1_200;
const CLIENT_LIFECYCLE_HEADERS: readonly any[] = Object.freeze([
  "Client",
  "Discovery",
  "Install",
  "Upload",
  "tools/list",
  "full-access-debug",
  "require-approval-debug",
  "Uninstall",
  "Cleanup"
]);
const FORBIDDEN_INLINE_SCRIPT_API: any =
  /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|eval|innerHTML)\b/u;

function reportTable(html?: any, slot?: any) : any {
  const start: any = html.indexOf(`data-report-slot="${slot}"`);
  const end: any = start < 0 ? -1 : html.indexOf("</table>", start);
  return start < 0 || end < 0 ? "" : html.slice(start, end + "</table>".length);
}

function inlineScriptBodies(html?: any) : any {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)]
    .map((match?: any) : any => match[1]);
}

function englishTableHeaders(table?: any) : any {
  return [...table.matchAll(/<th>([\s\S]*?)<\/th>/gu)].map((match?: any) : any =>
    match[1].match(/\bdata-en="([^"]+)"/u)?.[1]
      || match[1].replace(/<[^>]+>/gu, "").trim()
  );
}

function statusTableRows(table?: any) : any {
  return [...table.matchAll(
    /<tr>\s*<td><code>([^<]+)<\/code><\/td>\s*<td><span\b[^>]*data-en="([^"]+)"[^>]*>[^<]*<\/span><\/td>\s*<td>(\d+) ms<\/td>\s*<\/tr>/gu
  )].map((match?: any) : any => ({
    id: match[1],
    status: match[2].toLowerCase(),
    durationMs: Number(match[3])
  }));
}

function verifiedReport() : any {
  return {
    schemaVersion: "synthetic-schema",
    commandId: "verify:upstream-service-publishing",
    generatedAt: "2026-01-01T00:00:00.000Z",
    deploymentMode: "temporary-isolated",
    sourceRevision: "sha256:synthetic",
    payloadDigest: "sha256:synthetic-payload",
    summary: {
      assertionCount: 1,
      passedCount: 1,
      failedCount: 0,
      boundaryCount: 1,
      revisionEdgeCount: 1,
      verificationPassed: true,
      reportLeakScan: true
    },
    assertions: [{
      requirement: "REQ-USP-001",
      phase: "control-plane",
      passed: true
    }],
    productionBoundaries: [{ id: "control-plane", traversed: true }],
    revisionEdges: [{ scenario: "create", from: 0, to: 1, outcome: "advanced" }],
    protocolCohorts: [{ id: "affected-ack", outcome: "acknowledged", count: 1 }]
  };
}

function verifiedCandidateReceipt() : any {
  return {
    schemaVersion: "v0.0.1:report:upstream-service-publishing-candidate-1",
    claim: "upstream-publishing-prepublication-passed",
    generatedAt: "2026-01-01T00:04:01.000Z",
    release: {
      version: "0.0.1",
      tag: "v0.0.1",
      definitionVersion: "v0.0.1:registry:release-definition-1",
      definitionSha256: `sha256:${"a".repeat(64)}`
    },
    source: {
      commit: "b".repeat(40),
      tree: "c".repeat(40)
    },
    artifacts: [],
    receiptSha256: `sha256:${"d".repeat(64)}`
  };
}

function verifiedJourneyReport() : any {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:04:00.000Z",
    generatedAt: "2026-01-01T00:00:00.000Z",
    releaseReady: true,
    artifactPolicy: {
      storage: "local-build-only",
      cloudUploadAllowed: false,
      gitIgnored: true,
      screenshotMasking: "protected-values-only"
    },
    configuration: {
      startup: {
        command: "docker compose --profile format-convert up -d",
        composeProfile: "format-convert",
        buildTarget: "runtime-ui",
        consoleEnabled: true
      },
      upload: {
        transport: "connector-authenticated-upload-session",
        chunkContentType: "application/octet-stream",
        contentEncoding: "identity",
        base64Encoded: false,
        artifactReference: "upload:<session-id>:0",
        upstreamRepresentation: "artifact_multipart",
        externalFileBudgetBytes: 52_428_800,
        multipartRequestMaxBytes: 53_477_376
      },
      upstreamServiceBasicConfig: {
        file: "build/reports/upstream-service-publishing/upstream-service-basic-config.json",
        contentType: "application/json",
        source: "actual-publishing-input",
        byteLength: Buffer.byteLength(BASIC_CONFIG_TEXT),
        sha256: BASIC_CONFIG_SHA256
      },
      connector: {
        transport: "stdio",
        targetSelection: "all-detected-supported-local-clients",
        validationMode: "real-local-clients",
        fallback: {
          used: false,
          reason: "",
          catalogScanComplete: true
        },
        targetCatalog: [
          { target: "openclaw", label: "OpenClaw", status: "not_detected" },
          { target: "codex", label: "Codex", status: "detected" },
          { target: "claude-code", label: "Claude Code", status: "not_detected" },
          { target: "antigravity", label: "Antigravity", status: "not_detected" },
          { target: "opencode", label: "OpenCode", status: "not_detected" },
          { target: "pi", label: "Pi", status: "not_detected" },
          { target: "kimi", label: "Kimi CLI", status: "not_detected" }
        ],
        toolsets: ["meshrix.gateway.write"],
        scopes: ["gateway:write"],
        maxRisk: "safe_write",
        publishedCapabilities: [
          "cap:upstream:<generated-service-id>:convert-require-approval-debug",
          "cap:upstream:<generated-service-id>:convert-full-access-debug"
        ],
        operations: {
          requireApproval: "convert-require-approval-debug",
          fullAccess: "convert-full-access-debug",
          upstreamPath: "/v1/convert",
          fullAccessStillGoverned: true
        },
        allowedService: "<generated-service-id>"
      }
    },
    clientAcceptanceMatrix: [{
      target: "codex",
      label: "Codex",
      adapterTarget: "codex",
      validationMode: "real-local-client",
      status: "passed",
      installed: true,
      upload: "passed",
      toolsList: "passed",
      fullAccessDebug: "completed",
      requireApprovalDebug: "approved_and_completed_once",
      uninstall: "passed",
      cleanup: "passed"
    }],
    steps: VERIFIED_JOURNEY_STEP_IDS.map((id?: any, index?: any) : any => ({
      id,
      status: "passed",
      durationMs: (index + 1) * 100,
      receipt: id === "upstream-publish"
        ? {
            serviceId: "<generated-service-id>",
            state: "server_published",
            serviceRevision: 1,
            setRevision: 1,
            publication: {
              status: "server_published"
            },
            health: {
              ok: true,
              status: 200,
              healthyEndpoints: 1,
              endpoints: 1
            }
          }
        : id === "approval-branch"
          ? {
              pendingCount: 1,
              successfulBeforeApproval: 0,
              successfulAfterApproval: 1,
              exactlyOnce: true,
              expectedOutOfScopeWorkspaceDenials: 1
            }
          : {}
    })),
    cleanup: {
      performed: true,
      durationMs: VERIFIED_CLEANUP_DURATION_MS,
      details: VERIFIED_CLEANUP_DETAILS.map((detail?: any) : any => ({ ...detail }))
    },
    visualEvidence: VISUAL_EVIDENCE.map(([id, title, route]: any[]) : any => ({
      id,
      title,
      status: "passed",
      source: "meshrix-web-console",
      route,
      localOnly: true,
      maskingPolicy: "protected-values-only",
      protectedValuesMasked: true,
      protectedElementCount: 1,
      maskedElementCount: 1,
      serviceAddressMasked: true,
      file: `build/reports/upstream-service-publishing/screenshots/${id}.png`,
      viewportWidth: 1440,
      viewportHeight: 1000,
      deviceScaleFactor: 2,
      pixelWidth: 2880,
      pixelHeight: 2000,
      byteLength: SYNTHETIC_SCREENSHOT_BYTES.byteLength,
      sha256: SYNTHETIC_SCREENSHOT_SHA256
    }))
  };
}

describe("upstream service publishing HTML report", () : any => {
  it("renders one offline human-readable projection", () : any => {
    const report: any = verifiedReport();
    report.assertions[0].phase = "<control & plane>";
    const html: any = renderUpstreamServicePublishingHtml(report, verifiedJourneyReport());

    expect(UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH).toBe(
      "build/reports/upstream-service-publishing.html"
    );
    expect(html).toContain("&lt;control &amp; plane&gt;");
    expect(html).toContain("Registration to downstream invocation");
    expect(html).toContain("从注册到下游调用");
    expect(html).toContain("Publish an Upstream Service through Meshrix.js");
    expect(html).toContain("通过 Meshrix.js 发布上游服务");
    expect(html).toContain("Where to go");
    expect(html).toContain("去哪里");
    expect(html).toContain("What is produced");
    expect(html).toContain("生成什么");
    expect(html).toContain("Why this matters");
    expect(html).toContain("这一步的作用");
    expect(html).toContain("local Git-ignored build output");
    expect(html).toContain("本地 Git 忽略的 build 产物");
    expect(html).toContain("Open actual JSON configuration");
    expect(html).toContain("打开真实 JSON 配置文件");
    expect(html).toContain("docker compose --profile format-convert up -d");
    expect(html).toContain("Native file upload");
    expect(html).toContain("原生文件上传");
    expect(html).toContain("application/octet-stream");
    expect(html).toContain("upload:&lt;session-id&gt;:0");
    expect(html).toContain("it is not Meshrix.js&#39;s global upload limit");
    expect(html).toContain("并非 Meshrix.js 的全局上传上限");
    expect(html).toContain("MCP acceptance matrix");
    expect(html).toContain("MCP 验收矩阵");
    expect(html).toContain(".provenance .panel");
    expect(html).toContain("word-break: break-word");
    expect(html).toContain("<td><strong>Codex</strong></td>");
    expect(html).not.toContain("<strong>Codex</strong><br><code>codex</code>");
    expect(html).toContain("convert-require-approval-debug");
    expect(html).toContain("convert-full-access-debug");
    expect(html).toContain("Published upstream interfaces");
    expect(html).toContain("已发布上游接口");
    expect(html).toContain("GET /readyz");
    expect(html).toContain("POST /v1/convert");
    expect(html).toContain("artifact_multipart");
    expect(html).toContain("multipart/form-data");
    expect(html).toContain("application/pdf");
    expect(html).toContain("104857600 B");
    expect(html).toContain("30000 ms");
    expect(html).toContain(BASIC_CONFIG_SHA256);
    expect(html).toContain("not a standalone download endpoint");
    expect(html).toContain("不是独立的下载接口");
    expect(html).toContain("forwarded through the governed Meshrix.js gateway");
    expect(html.match(/data-service-interface=/gu)).toHaveLength(3);
    expect(html).toContain("cap:upstream:&lt;generated-service-id&gt;:convert-full-access-debug");
    expect(html).toContain("Pending → approved → completed once");
    expect(html).toContain("Approve and execute once");
    expect(html).toContain("批准并仅执行一次");
    expect(html).toContain("Approval and execution remain separate states");
    expect(html).toContain("审批与执行保持为两个独立状态");
    expect(html).toContain("Decision, execution, and result traceable");
    expect(html).toContain("决定、执行与结果可追溯");
    expect(html).toContain('data-flow-phase="decision"');
    expect(html).toContain('data-flow-phase="execution"');
    expect(html).toContain('data-flow-phase="audit"');
    expect(html).toContain('class="decision-contract"');
    expect(html).toContain('class="approval-proof"');
    expect(html).toContain('data-evidence-kind="decision"');
    expect(html).toContain('data-evidence-kind="execution"');
    expect(html).toContain('data-evidence-kind="audit"');
    expect(html).toContain('data-alt-en="Authenticated Meshrix.js Workbench"');
    expect(html).toContain('data-alt-zh="已认证的 Meshrix.js 工作台"');
    expect(html).toContain("image.dataset.altZh");
    expect(html.match(/<article class="manual-step"[^>]*data-evidence-kind=/gu)).toHaveLength(VISUAL_EVIDENCE.length);
    expect(html).toContain("MESHRIX_BUILD_TARGET=runtime-ui");
    expect(html).toContain("MESHRIX_SERVER_WITH_UI=1");
    expect(html).toContain("@media (max-width: 900px)");
    expect(html).toContain("@media (max-width: 620px)");
    expect(html).toContain("@media print");
    expect(html).toContain("overflow-x: hidden");
    expect(html).toContain("overflow-y: auto");
    expect(html).not.toMatch(/body\s*\{[^}]*overflow:\s*hidden/gu);
    expect(html).toContain("break-inside: avoid");
    expect(html).toContain("expected meshrix.agentWorkspace.list denials");
    expect(html).toContain("预期的 meshrix.agentWorkspace.list 拒绝记录");
    expect(html).not.toContain("undefined");
    expect(html).not.toMatch(/svc_[A-Za-z0-9_-]+/u);
    expect(html).toContain('<link rel="icon" href="data:,">');
    expect(html).toContain('data-report-portability="single-file"');
    expect(html.match(/src="data:image\/png;base64,/gu)).toHaveLength(VISUAL_EVIDENCE.length);
    expect(html.match(/2880×2000 · 2×/gu)).toHaveLength(VISUAL_EVIDENCE.length);
    expect(html).toContain('href="data:application/json;charset=utf-8;base64,');
    expect(html).toContain('data-report-slot="candidate-scope"');
    expect(html).toMatch(
      /<main\b(?=[^>]*\bid="report-content")(?=[^>]*\btabindex="-1")[^>]*>/u
    );
    const srcValues: any = [...html.matchAll(/\bsrc="([^"]+)"/gu)].map((match?: any) : any => match[1]);
    const hrefValues: any = [...html.matchAll(/\bhref="([^"]+)"/gu)].map((match?: any) : any => match[1]);
    expect(srcValues.every((value?: any) : any => value.startsWith("data:"))).toBe(true);
    expect(hrefValues.every((value?: any) : any =>
      value.startsWith("data:") || /^#[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
    )).toBe(true);
    expect(hrefValues.some((value?: any) : any => value.startsWith("#"))).toBe(true);
    expect([...srcValues, ...hrefValues].every((value?: any) : any =>
      !/^(?:https?:|blob:|file:|\/\/)/iu.test(value)
    )).toBe(true);
    expect(html).not.toContain("upstream-service-publishing/screenshots/");
    const scriptBodies: any = inlineScriptBodies(html);
    expect(scriptBodies).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]+src=/u);
    expect(html).toContain('data-language="zh-CN"');
    expect(html).toContain('data-language="en"');
    expect(scriptBodies.every((body?: any) : any => !FORBIDDEN_INLINE_SCRIPT_API.test(body))).toBe(true);
  });

  it("keeps the operation guide first and moves technical material into the final appendix", () : any => {
    const html: any = renderUpstreamServicePublishingHtml(verifiedReport(), verifiedJourneyReport());
    const sectionLabels: any = [...html.matchAll(
      /<p class="eyebrow"><span data-en="([^"]+)"/gu
    )].map((match?: any) : any => match[1]);

    expect(sectionLabels.slice(0, 2)).toEqual(["Operation guide", "Appendix"]);
    expect(sectionLabels).toContain("Executive summary");
    expect(sectionLabels).toContain("Exact safe configuration");
    expect(sectionLabels).toContain("MCP acceptance matrix");
    expect(sectionLabels).not.toContain("Live Console evidence");
    expect([...html.matchAll(/data-report-section="([^"]+)"/gu)].map((match?: any) : any => match[1]))
      .toEqual(UPSTREAM_SERVICE_PUBLISHING_REPORT_SECTIONS.map(([id]: any[]) : any => id));
    expect(html.indexOf('data-report-section="operation-guide"'))
      .toBeLessThan(html.indexOf('data-report-section="appendix"'));
    expect(html.indexOf('data-report-section="appendix"'))
      .toBeLessThan(html.indexOf('data-appendix-section="executive-summary"'));
  });

  it("renders an eleven-step Console manual followed by a bounded appendix", () : any => {
    const html: any = renderUpstreamServicePublishingHtml(
      verifiedReport(),
      verifiedJourneyReport()
    );
    const sectionIds: any = UPSTREAM_SERVICE_PUBLISHING_REPORT_SECTIONS.map(([id]: any[]) : any => id);
    const navigation: any = html.match(
      /<nav[^>]*aria-label="Report sections"[^>]*>[\s\S]*?<\/nav>/u
    )?.[0];
    const sectionTags: any[] = [...html.matchAll(/<section\b[^>]*data-report-section="([^"]+)"[^>]*>/gu)];
    const tables: any[] = [...html.matchAll(/<table\b/gu)];
    const captions: any[] = [...html.matchAll(/<caption\b/gu)];
    const images: any = [...html.matchAll(/<img\b[^>]*>/gu)].map((match?: any) : any => match[0]);
    const lifecycleTable: any = reportTable(html, "client-lifecycle");
    const journeyStepTable: any = reportTable(html, "journey-step-status");
    const cleanupTable: any = reportTable(html, "cleanup-summary");
    const manualGroupTags: any[] = [...html.matchAll(
      /<section\b[^>]*data-manual-group="([^"]+)"[^>]*>[\s\S]*?<\/section>/gu
    )];
    const groupIndexes: any[] = [...html.matchAll(
      /<ol\b[^>]*data-manual-group-index="([^"]+)"[^>]*>[\s\S]*?<\/ol>/gu
    )];
    const evidenceTargets: any = groupIndexes.flatMap((groupIndex?: any) : any =>
      [...groupIndex[0].matchAll(/href="#([^"]+)"/gu)].map((match?: any) : any => match[1])
    );
    const stepIds: any = [...html.matchAll(/<article\b[^>]*\bclass="manual-step"[^>]*\bid="([^"]+)"[^>]*>/gu)]
      .map((match?: any) : any => match[1]);
    const manualSteps: any = [...html.matchAll(/<article\b[^>]*\bclass="manual-step"[^>]*>[\s\S]*?<\/article>/gu)]
      .map((match?: any) : any => match[0]);

    expect(html.match(/<main\b/gu)).toHaveLength(1);
    expect(navigation).toBeTruthy();
    expect(
      [...navigation.matchAll(/href="#([^"]+)"/gu)].map((match?: any) : any => match[1])
    ).toEqual(sectionIds);
    expect(sectionTags.map((match?: any) : any => match[1])).toEqual(sectionIds);
    for (const [index, id] of sectionIds.entries()) {
      expect(sectionTags[index][0]).toContain(`id="${id}"`);
      expect(sectionTags[index][0]).toContain(`aria-labelledby="${id}-title"`);
      expect(html).toContain(`id="${id}-title"`);
    }
    expect(tables.length).toBeGreaterThan(0);
    expect(captions).toHaveLength(tables.length);

    const safeConfiguration: any = html.slice(
      html.indexOf('data-appendix-section="safe-configuration"'),
      html.indexOf('data-appendix-section="mcp-acceptance"')
    );
    const runtimeHealthOffset: any = safeConfiguration.indexOf(
      'data-report-slot="upstream-publication-runtime-health"'
    );
    const interfaceCatalogOffset: any = safeConfiguration.indexOf(
      'data-report-slot="upstream-service-interface-catalog"'
    );
    expect(runtimeHealthOffset).toBeGreaterThan(0);
    expect(runtimeHealthOffset).toBeLessThan(interfaceCatalogOffset);
    expect(safeConfiguration).toContain("<dd>server_published</dd>");
    expect(safeConfiguration).toContain("<dd>200</dd>");
    expect(safeConfiguration).toContain("<dd>1 / 1</dd>");
    expect(safeConfiguration.indexOf('data-service-interface="health"')).toBeGreaterThan(0);
    expect(safeConfiguration.indexOf('data-service-interface="health"'))
      .toBeLessThan(safeConfiguration.indexOf(
        'data-service-interface="convert-require-approval-debug"'
      ));

    expect(html).toContain('data-report-authority="scoped-candidate"');
    expect(html).toContain(
      'data-candidate-claim="upstream-publishing-prepublication-passed"'
    );
    expect(html).not.toContain('data-report-authority="functional-release"');
    expect(html).not.toContain("Functional release accepted");
    expect(html).toContain('data-report-timing="journey-total"');
    expect(html).toContain('data-duration-ms="240000"');
    expect(html).toContain('data-report-cleanup="passed"');
    expect(html).toContain('data-duration-ms="1200"');
    expect(englishTableHeaders(lifecycleTable)).toEqual(CLIENT_LIFECYCLE_HEADERS);
    const journeyStepRows: any = statusTableRows(journeyStepTable);
    expect(journeyStepRows).toEqual(
      VERIFIED_JOURNEY_STEP_IDS.map((id?: any, index?: any) : any => ({
        id,
        status: "passed",
        durationMs: (index + 1) * 100
      }))
    );
    expect(journeyStepRows.map((row?: any) : any => row.id)).toContain("artifact-fetch");
    expect(statusTableRows(cleanupTable)).toEqual(VERIFIED_CLEANUP_DETAILS);
    expect(VERIFIED_CLEANUP_DETAILS.reduce(
      (total?: any, detail?: any) : any => total + detail.durationMs,
      0
    )).toBe(VERIFIED_CLEANUP_DURATION_MS);

    expect(images).toHaveLength(VISUAL_EVIDENCE.length);
    expect(images.every((tag?: any) : any => tag.includes('loading="lazy"'))).toBe(true);
    expect(images.every((tag?: any) : any => tag.includes('decoding="async"'))).toBe(true);
    expect(images.every((tag?: any) : any => /\balt="[^"]+"/u.test(tag))).toBe(true);
    expect(images.every((tag?: any) : any => tag.includes('width="2880"'))).toBe(true);
    expect(images.every((tag?: any) : any => tag.includes('height="2000"'))).toBe(true);
    expect(manualSteps).toHaveLength(VISUAL_EVIDENCE.length);
    expect(manualGroupTags.map((match?: any) : any => match[1]))
      .toEqual(MANUAL_GROUPS.map(([id]: any[]) : any => id));
    expect(groupIndexes.map((match?: any) : any => match[1]))
      .toEqual(MANUAL_GROUPS.map(([id]: any[]) : any => id));
    for (const [groupId, chineseTitle, stepIds] of MANUAL_GROUPS) {
      const group: any = manualGroupTags.find((match?: any) : any => match[1] === groupId)?.[0] || "";
      expect(group).toContain(chineseTitle);
      expect([...group.matchAll(/data-manual-step="([^"]+)"/gu)].map((match?: any) : any => match[1]))
        .toEqual(stepIds);
    }
    for (const step of manualSteps) {
      expect([...step.matchAll(/data-manual-field="([^"]+)"/gu)].map((match?: any) : any => match[1]))
        .toEqual(["location", "action", "result", "purpose"]);
      expect(step).toContain("<figure>");
    }
    expect(evidenceTargets).toHaveLength(VISUAL_EVIDENCE.length);
    expect(new Set<any>(evidenceTargets).size).toBe(VISUAL_EVIDENCE.length);
    expect(stepIds).toEqual(evidenceTargets);
  });

  it("keeps the tracked blank template aligned with the renderer contract", () : any => {
    const template: any = readFileSync(
      new URL(`../../../${UPSTREAM_SERVICE_PUBLISHING_BLANK_TEMPLATE_PATH}`, import.meta.url),
      "utf8"
    );
    expect(template).toBe(renderUpstreamServicePublishingBlankTemplate());
    expect(template).toContain('data-report-template="upstream-service-publishing"');
    expect(template).toContain('data-report-portability="single-file"');
    expect(template).toContain("embed verified images and downloadable attachments");
    expect(template).toContain("内嵌已验证图片和可下载附件");
    const templateSlots: any = [...template.matchAll(/data-report-slot="([^"]+)"/gu)]
      .map((match?: any) : any => match[1]);
    expect(templateSlots).toContain("operation-guide-groups");
    expect(templateSlots).toContain("candidate-scope");
    expect(templateSlots).toContain("upstream-publication-runtime-health");
    expect(templateSlots).toContain("upstream-service-interface-catalog");
    expect(templateSlots).toContain("client-lifecycle");
    expect(templateSlots).toContain("journey-timings");
    expect(templateSlots).toContain("cleanup-summary");
    expect(templateSlots.filter((slot?: any) : any => slot.startsWith("manual-screenshot-")))
      .toHaveLength(VISUAL_EVIDENCE.length);
    const placeholderSteps: any = [...template.matchAll(/<article\b[^>]*data-manual-step="[^"]+"[^>]*>[\s\S]*?<\/article>/gu)]
      .map((match?: any) : any => match[0]);
    expect(placeholderSteps).toHaveLength(VISUAL_EVIDENCE.length);
    expect([...template.matchAll(/data-manual-group="([^"]+)"/gu)].map((match?: any) : any => match[1]))
      .toEqual(MANUAL_GROUPS.map(([id]: any[]) : any => id));
    expect(placeholderSteps.every((step?: any) : any =>
      [...step.matchAll(/data-manual-field="([^"]+)"/gu)].map((match?: any) : any => match[1]).join(",")
        === "location,action,result,purpose"
    )).toBe(true);
    expect(template.indexOf('data-report-slot="upstream-publication-runtime-health"'))
      .toBeLessThan(template.indexOf('data-report-slot="upstream-service-interface-catalog"'));
    expect(englishTableHeaders(reportTable(template, "client-lifecycle")))
      .toEqual(CLIENT_LIFECYCLE_HEADERS);
    expect(template).toContain("Not executed");
    expect(template).toContain("未执行");
    expect(template).not.toContain("Verified end to end");
    expect(template).not.toContain("build/reports");
    const sectionIds: any = UPSTREAM_SERVICE_PUBLISHING_REPORT_SECTIONS.map(([id]: any[]) : any => id);
    expect([...template.matchAll(/data-report-section="([^"]+)"/gu)].map((match?: any) : any => match[1]))
      .toEqual(sectionIds);
    const navigation: any = template.match(
      /<nav[^>]*aria-label="Report sections"[^>]*>[\s\S]*?<\/nav>/u
    )?.[0];
    expect(navigation).toBeTruthy();
    expect([...navigation.matchAll(/href="#([^"]+)"/gu)].map((match?: any) : any => match[1]))
      .toEqual(sectionIds);
    expect(template.match(/<main\b/gu)).toHaveLength(1);
    expect(template).toMatch(
      /<main\b(?=[^>]*\bid="report-content")(?=[^>]*\btabindex="-1")[^>]*>/u
    );
    expect(template.match(/<caption\b/gu)).toHaveLength(template.match(/<table\b/gu)?.length);
    const scriptBodies: any = inlineScriptBodies(template);
    expect(scriptBodies).toHaveLength(1);
    expect(template).not.toMatch(/<script[^>]+src=/u);
    expect(scriptBodies.every((body?: any) : any => !FORBIDDEN_INLINE_SCRIPT_API.test(body))).toBe(true);
  });

  it("rejects interface facts that are not bound to the exact publication bytes", () : any => {
    expect(() : any => renderVerifiedUpstreamServicePublishingHtml(
      verifiedReport(),
      verifiedJourneyReport(),
      `${BASIC_CONFIG_TEXT} `
    )).toThrow("interface catalog is not bound");

    const changed: any = structuredClone(BASIC_CONFIG_DOCUMENT);
    changed.descriptor.operations[0].payloadTransport.request.maxBytes = 1;
    const changedText: any = JSON.stringify(changed);
    const journey: any = verifiedJourneyReport();
    journey.configuration.upstreamServiceBasicConfig.byteLength = Buffer.byteLength(changedText);
    journey.configuration.upstreamServiceBasicConfig.sha256 =
      createHash("sha256").update(changedText).digest("hex");
    expect(() : any => renderVerifiedUpstreamServicePublishingHtml(
      verifiedReport(),
      journey,
      changedText
    )).toThrow("interface catalog is not bound");
  });

  it("rejects a missing or digest-mismatched screenshot instead of leaving a file dependency", () : any => {
    const journey: any = verifiedJourneyReport();
    const visualEvidenceFiles: any = new Map<any, any>(
      journey.visualEvidence.map((item?: any) : any => [item.file, SYNTHETIC_SCREENSHOT_BYTES])
    );
    visualEvidenceFiles.delete(journey.visualEvidence[0].file);
    expect(() : any => renderVerifiedUpstreamServicePublishingHtml(
      verifiedReport(),
      journey,
      BASIC_CONFIG_TEXT,
      visualEvidenceFiles
    )).toThrow("embedded release journey visual evidence is invalid");

    visualEvidenceFiles.set(
      journey.visualEvidence[0].file,
      Buffer.concat([SYNTHETIC_SCREENSHOT_BYTES.subarray(0, -1), Buffer.from([0])])
    );
    expect(() : any => renderVerifiedUpstreamServicePublishingHtml(
      verifiedReport(),
      journey,
      BASIC_CONFIG_TEXT,
      visualEvidenceFiles
    )).toThrow("embedded release journey visual evidence is invalid");
  });

  it("rejects an unverified source report", () : any => {
    const report: any = verifiedReport();
    report.summary.verificationPassed = false;

    expect(() : any => renderUpstreamServicePublishingHtml(report, verifiedJourneyReport())).toThrow(
      "verified upstream publishing report"
    );
  });

  it("rejects contradictory detail rows even when the summary claims success", () : any => {
    const report: any = verifiedReport();
    report.assertions[0].passed = false;

    expect(() : any => renderUpstreamServicePublishingHtml(report, verifiedJourneyReport())).toThrow(
      "verified upstream publishing report"
    );
  });

  it("rejects aggregate counts or boundary rows that disagree with the detail source", () : any => {
    const report: any = verifiedReport();
    report.productionBoundaries[0].traversed = false;

    expect(() : any => renderUpstreamServicePublishingHtml(report, verifiedJourneyReport())).toThrow(
      "verified upstream publishing report"
    );

    report.productionBoundaries[0].traversed = true;
    report.summary.passedCount = 0;
    expect(() : any => renderUpstreamServicePublishingHtml(report, verifiedJourneyReport())).toThrow(
      "verified upstream publishing report"
    );
  });

  it("rejects missing visual evidence", () : any => {
    const journey: any = verifiedJourneyReport();
    journey.visualEvidence = [];
    expect(() : any => renderUpstreamServicePublishingHtml(verifiedReport(), journey)).toThrow(
      "verified upstream publishing report"
    );
  });

  it("rejects visual evidence that does not prove complete protected-value masking", () : any => {
    const journey: any = verifiedJourneyReport();
    journey.visualEvidence[0].maskedElementCount = 0;
    journey.visualEvidence[0].serviceAddressMasked = false;

    expect(() : any => renderUpstreamServicePublishingHtml(verifiedReport(), journey)).toThrow(
      "visual evidence is invalid"
    );
  });

  it("rejects reordered visual evidence instead of projecting stale card order", () : any => {
    const journey: any = verifiedJourneyReport();
    [journey.visualEvidence[7], journey.visualEvidence[8]] =
      [journey.visualEvidence[8], journey.visualEvidence[7]];

    expect(() : any => renderUpstreamServicePublishingHtml(verifiedReport(), journey)).toThrow(
      "verified upstream publishing report"
    );
  });

  it("rejects an approval receipt that merges the decision and execution result", () : any => {
    const journey: any = verifiedJourneyReport();
    journey.steps.find((step?: any) : any => step.id === "approval-branch")
      .receipt.successfulBeforeApproval = 1;

    expect(() : any => renderUpstreamServicePublishingHtml(verifiedReport(), journey)).toThrow(
      "verified upstream publishing report"
    );
  });

  it("rejects missing or non-passed detected-client lifecycle evidence", () : any => {
    const missing: any = verifiedJourneyReport();
    missing.clientAcceptanceMatrix = [];
    expect(() : any => renderUpstreamServicePublishingHtml(verifiedReport(), missing)).toThrow(
      "verified upstream publishing report"
    );

    const nonPassedValues: any[] = [
      ["status", "failed"],
      ["installed", false],
      ["upload", "failed"],
      ["toolsList", "failed"],
      ["fullAccessDebug", "failed"],
      ["requireApprovalDebug", "failed"],
      ["uninstall", "failed"],
      ["cleanup", "failed"]
    ];
    for (const [field, value] of nonPassedValues) {
      const journey: any = verifiedJourneyReport();
      journey.clientAcceptanceMatrix[0][field] = value;
      expect(
        () : any => renderUpstreamServicePublishingHtml(verifiedReport(), journey),
        `${field} must remain a passed lifecycle observation`
      ).toThrow("detected MCP client did not pass the acceptance matrix");
    }
  });

  it("renders a declared simulation fallback only after a complete zero-client scan", () : any => {
    const journey: any = verifiedJourneyReport();
    journey.configuration.connector.targetCatalog =
      journey.configuration.connector.targetCatalog.map((target?: any) : any => ({
        ...target,
        status: "not_detected"
      }));
    journey.configuration.connector.targetSelection = "zero-detected-client-mcp-simulation";
    journey.configuration.connector.validationMode = "simulated-fallback";
    journey.configuration.connector.fallback = {
      used: true,
      reason: "no_supported_local_client_detected_after_complete_catalog_scan",
      catalogScanComplete: true
    };
    journey.clientAcceptanceMatrix = [{
      target: "mcp-simulator",
      label: "MCP protocol simulation fallback",
      adapterTarget: "kimi",
      validationMode: "simulated-fallback",
      status: "passed",
      installed: true,
      upload: "passed",
      toolsList: "passed",
      fullAccessDebug: "completed",
      requireApprovalDebug: "approved_and_completed_once",
      uninstall: "passed",
      cleanup: "passed"
    }];

    const html: any = renderUpstreamServicePublishingHtml(verifiedReport(), journey);
    expect(html).toContain("No local client was detected; MCP protocol simulation was used");
    expect(html).toContain("未发现本机客户端；已使用 MCP 协议模拟");
    expect(html).toContain("MCP protocol simulator");
    expect(html).not.toContain("<code>mcp-simulator</code>");
    expect(html).toContain("does not count as client compatibility evidence");
  });

  it("renders a failed journey as a redacted non-authoritative recovery projection", () : any => {
    const journey: any = verifiedJourneyReport();
    journey.releaseReady = false;
    journey.visualEvidence = [];
    journey.steps = Array.from({ length: 20 }, (_?: any, index?: any) : any => ({
      id: `step-${String(index).padStart(2, "0")}`,
      status: "passed",
      durationMs: index,
      message: "step-message-must-not-render",
      receipt: { runtimeData: "step-receipt-must-not-render" }
    }));
    journey.cleanup.details = Array.from({ length: 40 }, (_?: any, index?: any) : any => ({
      id: `cleanup-${String(index).padStart(2, "0")}`,
      status: "passed",
      durationMs: index,
      message: "cleanup-message-must-not-render",
      receipt: { runtimeData: "cleanup-receipt-must-not-render" }
    }));
    journey.configuration.runtimeData = "configuration-runtime-must-not-render";
    journey.failure = {
      step: "client-discovery",
      code: "release_journey_client_discovery_failed",
      message: [
        "token=synthetic-secret-value",
        ["/", "Users", "private", "runtime"].join("/")
      ].join(" ")
    };
    const html: any = renderVerifiedUpstreamServicePublishingHtml(
      verifiedReport(),
      journey,
      BASIC_CONFIG_TEXT,
      new Map<any, any>(),
      null
    );

    expect(html).toContain('data-report-authority="non-authoritative-failure"');
    expect(html).toContain('data-release-evidence="rejected"');
    expect(html).toContain("Failed journey — not release evidence");
    expect(html).toContain("失败路线——不是发布证据");
    expect(html.match(/release_journey_client_discovery_failed/gu)).toHaveLength(1);
    expect(html).toContain("Run the complete upstream publishing journey again");
    expect(html).toContain("Completed journey steps");
    expect(html).toContain("Cleanup progress");
    const journeyStepCount: any = RELEASE_JOURNEY_STEPS.filter((step?: any) : any => step !== "cleanup").length;
    const lastBoundedStep: any = `step-${String(journeyStepCount - 1).padStart(2, "0")}`;
    const firstExcludedStep: any = `step-${String(journeyStepCount).padStart(2, "0")}`;
    expect(html).toContain(`<code>${lastBoundedStep}</code>`);
    expect(html).not.toContain(`<code>${firstExcludedStep}</code>`);
    expect(html).toContain("<code>cleanup-31</code>");
    expect(html).not.toContain("<code>cleanup-32</code>");
    expect(html).not.toContain("step-message-must-not-render");
    expect(html).not.toContain("step-receipt-must-not-render");
    expect(html).not.toContain("cleanup-message-must-not-render");
    expect(html).not.toContain("cleanup-receipt-must-not-render");
    expect(html).not.toContain("configuration-runtime-must-not-render");
    expect(html).not.toContain("synthetic-secret-value");
    expect(html).not.toContain("/Users/");
    expect(html).not.toContain("functional-complete");
    expect(html).not.toContain('data-candidate-claim="upstream-publishing-prepublication-passed"');
    expect(html).not.toContain("data:image/png;base64");
    expect(html).toMatch(/<main\b[^>]*\btabindex="-1"[^>]*>/u);
    expect(html).toContain('data-language="zh-CN"');
    expect(html).toContain('data-language="en"');
    const scriptBodies: any = inlineScriptBodies(html);
    expect(scriptBodies).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]+src=/u);
    expect(scriptBodies.every((body?: any) : any => !FORBIDDEN_INLINE_SCRIPT_API.test(body))).toBe(true);
  });
});
