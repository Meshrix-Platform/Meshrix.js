import { createHash } from "node:crypto";
import {
  RELEASE_JOURNEY_VISUAL_CAPTURE,
  readPngDimensions
} from "./release-journey-visual-contract.ts";

export const UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH: any =
  "build/reports/upstream-service-publishing.html";
export const UPSTREAM_SERVICE_BASIC_CONFIG_JSON_PATH: any =
  "build/reports/upstream-service-publishing/upstream-service-basic-config.json";
export const UPSTREAM_SERVICE_PUBLISHING_BLANK_TEMPLATE_PATH: any =
  "docs/examples/upstream-service-publishing-report-template.html";

export const UPSTREAM_SERVICE_PUBLISHING_REPORT_SECTIONS: readonly any[] = Object.freeze([
  ["executive-summary", "Executive summary", "执行摘要"],
  ["safe-configuration", "Exact safe configuration", "精确安全配置"],
  ["mcp-acceptance", "MCP acceptance matrix", "MCP 验收矩阵"],
  ["live-console-evidence", "Live Console evidence", "实时管控台证据"],
  ["golden-path", "Golden path", "黄金路径"],
  ["requirements", "Requirements", "需求"],
  ["production-composition", "Production composition", "生产组成"],
  ["revision-semantics", "Revision semantics", "修订语义"],
  ["protocol-delivery", "Protocol delivery", "协议交付"],
  ["provenance", "Provenance", "来源"]
]);

const INTERFACE_CATALOG_COLUMNS: readonly any[] = Object.freeze([
  ["Interface", "接口"],
  ["Method and path", "方法与路径"],
  ["Request and upload", "请求与上传"],
  ["Response and download", "响应与下载"],
  ["Gateway governance", "网关治理"]
]);

const FLOW: readonly any[] = Object.freeze([
  {
    phase: "publish",
    actor: ["Service owner", "服务所有者"],
    title: ["Register the governed service", "注册受治理服务"],
    detail: [
      "An authenticated owner submits the closed service descriptor through the control plane.",
      "已认证的服务所有者通过控制面提交封闭的服务描述符。"
    ],
    outcome: ["Descriptor accepted", "描述符已接受"]
  },
  {
    phase: "publish",
    actor: ["Meshrix runtime", "Meshrix 运行时"],
    title: ["Publish one consistent revision", "发布一致修订"],
    detail: [
      "Manifest persistence, gateway snapshot, and Operation Permission catalog converge before discovery.",
      "清单持久化、网关快照与 Operation Permission 目录一致后，才进入发现阶段。"
    ],
    outcome: ["Gateway and catalog agree", "网关与目录一致"]
  },
  {
    phase: "connect",
    actor: ["Detected MCP client", "已发现 MCP 客户端"],
    title: ["Discover only the granted surface", "仅发现已授权能力"],
    detail: [
      "Each detected client installs in isolation and receives the tag-scoped tool projection.",
      "每个已发现客户端在隔离环境中安装，并仅获得标签范围内的工具投影。"
    ],
    outcome: ["Scoped tools visible", "限定工具可见"]
  },
  {
    phase: "request",
    actor: ["Execution target", "执行目标"],
    title: ["Request one bounded conversion", "请求一次有界转换"],
    detail: [
      "The client uploads raw bytes, passes an owner-bound artifact reference, and creates a pending operation.",
      "客户端上传原始字节，传递所有者绑定的制品引用，并创建待审批操作。"
    ],
    outcome: ["Upstream effects remain at zero", "上游影响仍为零"]
  },
  {
    phase: "decision",
    actor: ["Approver", "审批者"],
    title: ["Approve the subject and its effect", "批准明确主体及其影响"],
    detail: [
      "The decision covers this request and one execution only; it does not create standing or unrelated authority.",
      "该决定仅覆盖本次请求与一次执行，不形成长期权限，也不扩大无关权限。"
    ],
    outcome: ["Approve and execute once", "批准并仅执行一次"]
  },
  {
    phase: "execution",
    actor: ["Execution permit", "执行许可"],
    title: ["Consume the decision, then execute", "消费审批决定后再执行"],
    detail: [
      "Approval and execution remain separate states. The permit is consumed before one upstream call resumes.",
      "审批与执行保持为两个独立状态；执行许可被消费后，仅恢复一次上游调用。"
    ],
    outcome: ["Exactly one successful execution", "恰好一次成功执行"]
  },
  {
    phase: "audit",
    actor: ["Console audit", "管控台审计"],
    title: ["Close the loop with evidence", "以证据闭合流程"],
    detail: [
      "The completed operation and downstream call are correlated without exposing protected identities or payloads.",
      "已完成操作与下游调用完成关联，同时不暴露受保护身份或载荷。"
    ],
    outcome: ["Decision, execution, and result traceable", "决定、执行与结果可追溯"]
  }
]);

const VISUAL_TITLES: Readonly<Record<string, any>> = Object.freeze({
  "console-authenticated": "已认证的 Meshrix 管控台",
  "console-upstream-basic-config": "上游服务基础配置",
  "console-upstream-operation-config": "上游操作配置",
  "console-upstream-published": "已发布上游服务及运行时健康状态",
  "console-published-tool": "工具目录中的已发布操作",
  "console-token-authorization-pending": "待处理的 MCP 设备授权",
  "console-token-authorization-consumed": "已完成的 MCP 设备授权",
  "console-operation-approval-pending": "待处理的 Operation Permission 审批",
  "console-operation-approval-completed": "已完成的 Operation Permission 审批",
  "console-downstream-mcp-call": "管控台审计中的下游 MCP 调用"
});

const VISUAL_CONTEXT: Readonly<Record<string, any>> = Object.freeze({
  "console-authenticated": ["access", "Authenticated session", "已认证会话"],
  "console-upstream-basic-config": ["configuration", "Service subject", "服务主体"],
  "console-upstream-operation-config": ["configuration", "Operation impact", "操作影响"],
  "console-upstream-published": ["publication", "Published revision", "已发布修订"],
  "console-published-tool": ["discovery", "Granted surface", "授权能力面"],
  "console-token-authorization-pending": ["decision", "Authorization decision", "授权决定"],
  "console-token-authorization-consumed": ["outcome", "Authorization outcome", "授权结果"],
  "console-operation-approval-pending": ["decision", "Execution decision", "执行决定"],
  "console-operation-approval-completed": ["execution", "Execution outcome", "执行结果"],
  "console-downstream-mcp-call": ["audit", "Audit closure", "审计闭环"]
});

const VISUAL_ORDER: any = Object.freeze(Object.keys(VISUAL_TITLES));
const JOURNEY_STEP_ORDER: readonly any[] = Object.freeze([
  "preflight",
  "stack-build-up",
  "admin-bootstrap",
  "upstream-publish",
  "adapter-seed",
  "client-discovery",
  "connector-install-matrix",
  "binary-upload-matrix",
  "mcp-acceptance-matrix",
  "approval-branch",
  "artifact-fetch",
  "pdf-verify"
]);
const VISUAL_EVIDENCE_FILE_PREFIX: any =
  "build/reports/upstream-service-publishing/screenshots/";

export function renderUpstreamServicePublishingHtml(
  report?: any,
  journeyReport?: any,
  upstreamServiceBasicConfigText?: any,
  visualEvidenceFiles?: any,
  candidateReceipt?: any
) : any {
  if (journeyReport?.releaseReady !== true) {
    return renderFailedUpstreamServicePublishingHtml(journeyReport);
  }
  const approvalReceipt: any = journeyReport?.steps?.find((step?: any) : any => step.id === "approval-branch")?.receipt;
  const publishReceipt: any = journeyReport?.steps?.find((step?: any) : any => step.id === "upstream-publish")?.receipt;
  const journeyStepsValid: any = (
    Array.isArray(journeyReport?.steps)
    && journeyReport.steps.length === JOURNEY_STEP_ORDER.length
    && journeyReport.steps.every((step?: any, index?: any) : any => (
      step?.id === JOURNEY_STEP_ORDER[index]
      && step?.status === "passed"
      && Number.isSafeInteger(step?.durationMs)
      && step.durationMs >= 0
    ))
  );
  if (
    !report
    || typeof report !== "object"
    || report.summary?.verificationPassed !== true
    || report.summary?.failedCount !== 0
    || report.summary?.reportLeakScan !== true
    || !Array.isArray(report.assertions)
    || report.assertions.length === 0
    || report.assertions.some((assertion?: any) : any => assertion?.passed !== true)
    || report.summary?.assertionCount !== report.assertions.length
    || report.summary?.passedCount !== report.assertions.length
    || !Array.isArray(report.productionBoundaries)
    || report.productionBoundaries.length === 0
    || report.productionBoundaries.some(
      (boundary?: any) : any => boundary?.traversed !== true || typeof boundary?.id !== "string",
    )
    || report.summary?.boundaryCount !== report.productionBoundaries.length
    || !Array.isArray(report.revisionEdges)
    || report.revisionEdges.length === 0
    || report.summary?.revisionEdgeCount !== report.revisionEdges.length
    || !Array.isArray(report.protocolCohorts)
    || report.protocolCohorts.length === 0
    || !journeyReport
    || !Array.isArray(journeyReport.visualEvidence)
    || journeyReport.visualEvidence.length !== VISUAL_ORDER.length
    || journeyReport.visualEvidence.some((item?: any, index?: any) : any => item?.id !== VISUAL_ORDER[index])
    || journeyReport.configuration?.startup?.command !== "docker compose --profile format-convert up -d"
    || journeyReport.configuration?.startup?.buildTarget !== "runtime-ui"
    || journeyReport.configuration?.startup?.consoleEnabled !== true
    || journeyReport.configuration?.upload?.transport !== "connector-authenticated-upload-session"
    || journeyReport.configuration?.upload?.chunkContentType !== "application/octet-stream"
    || journeyReport.configuration?.upload?.contentEncoding !== "identity"
    || journeyReport.configuration?.upload?.base64Encoded !== false
    || journeyReport.configuration?.upload?.artifactReference !== "upload:<session-id>:0"
    || journeyReport.configuration?.upload?.upstreamRepresentation !== "artifact_multipart"
    || journeyReport.configuration?.upload?.externalFileBudgetBytes !== 52_428_800
    || journeyReport.configuration?.upload?.multipartRequestMaxBytes !== 53_477_376
    || journeyReport.configuration?.upstreamServiceBasicConfig?.file !== UPSTREAM_SERVICE_BASIC_CONFIG_JSON_PATH
    || journeyReport.configuration?.upstreamServiceBasicConfig?.contentType !== "application/json"
    || journeyReport.configuration?.upstreamServiceBasicConfig?.source !== "actual-publishing-input"
    || !Number.isInteger(journeyReport.configuration?.upstreamServiceBasicConfig?.byteLength)
    || journeyReport.configuration.upstreamServiceBasicConfig.byteLength <= 0
    || !/^[a-f0-9]{64}$/u.test(journeyReport.configuration?.upstreamServiceBasicConfig?.sha256 || "")
    || journeyReport.configuration?.connector?.transport !== "stdio"
    || !["all-detected-supported-local-clients", "zero-detected-client-mcp-simulation"]
      .includes(journeyReport.configuration?.connector?.targetSelection)
    || !["real-local-clients", "simulated-fallback"]
      .includes(journeyReport.configuration?.connector?.validationMode)
    || !Array.isArray(journeyReport.configuration?.connector?.targetCatalog)
    || journeyReport.configuration.connector.targetCatalog.length !== 7
    || journeyReport.configuration?.connector?.operations?.requireApproval !== "convert-require-approval-debug"
    || journeyReport.configuration?.connector?.operations?.fullAccess !== "convert-full-access-debug"
    || journeyReport.configuration?.connector?.operations?.upstreamPath !== "/v1/convert"
    || journeyReport.configuration?.connector?.operations?.fullAccessStillGoverned !== true
    || !Array.isArray(journeyReport.configuration?.connector?.publishedCapabilities)
    || journeyReport.configuration.connector.publishedCapabilities.length !== 2
    || !Array.isArray(journeyReport.clientAcceptanceMatrix)
    || journeyReport.clientAcceptanceMatrix.length === 0
    || approvalReceipt?.pendingCount !== journeyReport.clientAcceptanceMatrix.length
    || approvalReceipt?.successfulBeforeApproval !== 0
    || approvalReceipt?.successfulAfterApproval !== journeyReport.clientAcceptanceMatrix.length
    || approvalReceipt?.exactlyOnce !== true
    || approvalReceipt?.expectedOutOfScopeWorkspaceDenials !== journeyReport.clientAcceptanceMatrix.length
    || publishReceipt?.publication?.status !== "server_published"
    || publishReceipt?.health?.ok !== true
    || !Number.isSafeInteger(publishReceipt?.health?.status)
    || publishReceipt.health.status < 200
    || publishReceipt.health.status >= 300
    || !Number.isSafeInteger(publishReceipt?.health?.healthyEndpoints)
    || !Number.isSafeInteger(publishReceipt?.health?.endpoints)
    || publishReceipt.health.endpoints <= 0
    || publishReceipt.health.healthyEndpoints !== publishReceipt.health.endpoints
    || !journeyStepsValid
    || journeyReport.artifactPolicy?.storage !== "local-build-only"
    || journeyReport.artifactPolicy?.cloudUploadAllowed !== false
    || journeyReport.artifactPolicy?.gitIgnored !== true
    || journeyReport.artifactPolicy?.screenshotMasking !== "protected-values-only"
    || journeyReport.cleanup?.performed !== true
    || !Number.isSafeInteger(journeyReport.cleanup?.durationMs)
    || !Array.isArray(journeyReport.cleanup?.details)
    || journeyReport.cleanup.details.length === 0
    || journeyReport.cleanup.details.some((detail?: any) : any => (
      detail?.status !== "passed"
      || !/^[a-z0-9:-]{1,96}$/u.test(String(detail?.id || ""))
      || !Number.isSafeInteger(detail?.durationMs)
      || detail.durationMs < 0
    ))
    || !Array.isArray(journeyReport.configuration?.connector?.toolsets)
    || !Array.isArray(journeyReport.configuration?.connector?.scopes)
  ) {
    const error: Error & Record<string, any> = new Error("The verified upstream publishing report is required.");
    error.code = "upstream_service_publishing_html_source_invalid";
    throw error;
  }
  const upstreamServiceInterfaces: any = readVerifiedUpstreamServiceInterfaces({
    journeyReport,
    sourceText: upstreamServiceBasicConfigText
  });
  const embeddedBasicConfigHref: any = `data:application/json;charset=utf-8;base64,${
    Buffer.from(upstreamServiceBasicConfigText, "utf8").toString("base64")
  }`;
  const matrixByTarget: any = new Map<any, any>(
    journeyReport.clientAcceptanceMatrix.map((row?: any) : any => [row.target, row])
  );
  const fallbackUsed: any = journeyReport.configuration.connector.fallback?.used === true;
  if (
    journeyReport.configuration.connector.fallback?.catalogScanComplete !== true
    || fallbackUsed !== (journeyReport.configuration.connector.validationMode === "simulated-fallback")
  ) {
    throw Object.assign(new Error("The MCP fallback evidence is inconsistent."), {
      code: "upstream_service_publishing_html_client_fallback_invalid"
    });
  }
  for (const target of journeyReport.configuration.connector.targetCatalog) {
    if (!["detected", "not_detected"].includes(target.status)) {
      throw Object.assign(new Error("The MCP target catalog status is invalid."), {
        code: "upstream_service_publishing_html_client_matrix_invalid"
      });
    }
    if (target.status === "detected") {
      const row: any = matrixByTarget.get(target.target);
      if (
        row?.status !== "passed"
        || row?.installed !== true
        || row?.upload !== "passed"
        || row?.toolsList !== "passed"
        || row?.fullAccessDebug !== "completed"
        || row?.requireApprovalDebug !== "approved_and_completed_once"
        || row?.uninstall !== "passed"
        || row?.cleanup !== "passed"
      ) {
        throw Object.assign(new Error("A detected MCP client did not pass the acceptance matrix."), {
          code: "upstream_service_publishing_html_client_matrix_invalid"
        });
      }
    }
  }
  if (fallbackUsed) {
    const fallbackRow: any = matrixByTarget.get("mcp-simulator");
    if (
      journeyReport.configuration.connector.targetCatalog.some((target?: any) : any => target.status === "detected")
      || journeyReport.clientAcceptanceMatrix.length !== 1
      || journeyReport.configuration.connector.fallback.reason !== "no_supported_local_client_detected_after_complete_catalog_scan"
      || fallbackRow?.validationMode !== "simulated-fallback"
      || fallbackRow?.status !== "passed"
      || fallbackRow?.installed !== true
      || fallbackRow?.upload !== "passed"
      || fallbackRow?.toolsList !== "passed"
      || fallbackRow?.fullAccessDebug !== "completed"
      || fallbackRow?.requireApprovalDebug !== "approved_and_completed_once"
      || fallbackRow?.uninstall !== "passed"
      || fallbackRow?.cleanup !== "passed"
    ) {
      throw Object.assign(new Error("The zero-client MCP simulation fallback is invalid."), {
        code: "upstream_service_publishing_html_client_fallback_invalid"
      });
    }
  } else {
    const detectedTargets: any = new Set<any>(
      journeyReport.configuration.connector.targetCatalog
        .filter((target?: any) : any => target.status === "detected")
        .map((target?: any) : any => target.target)
    );
    if (
      journeyReport.clientAcceptanceMatrix.length !== detectedTargets.size
      || journeyReport.clientAcceptanceMatrix.some(
        (row?: any) : any => row.validationMode !== "real-local-client" || !detectedTargets.has(row.target)
      )
    ) {
    throw Object.assign(new Error("A real local MCP client row is not marked as real."), {
      code: "upstream_service_publishing_html_client_matrix_invalid"
    });
    }
  }

  const assertions: any = report.assertions.map((assertion?: any) : any => `
      <tr>
        <td><code>${escapeHtml(assertion.requirement)}</code></td>
        <td>${escapeHtml(assertion.phase)}</td>
        <td><span class="pass">${bilingual(
          assertion.passed === true ? "Passed" : "Failed",
          assertion.passed === true ? "通过" : "失败"
        )}</span></td>
      </tr>`).join("");
  const boundaries: any = report.productionBoundaries.map((boundary?: any) : any =>
    `<li>${escapeHtml(boundary.id)}</li>`
  ).join("");
  const revisions: any = report.revisionEdges.map((edge?: any) : any => `
      <tr>
        <td>${escapeHtml(edge.scenario)}</td>
        <td>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</td>
        <td>${escapeHtml(edge.outcome)}</td>
      </tr>`).join("");
  const cohorts: any = report.protocolCohorts.map((cohort?: any) : any => `
      <tr>
        <td>${escapeHtml(cohort.id)}</td>
        <td>${escapeHtml(cohort.outcome)}</td>
        <td>${escapeHtml(cohort.count)}</td>
      </tr>`).join("");
  const flow: any = FLOW.map((step?: any, index?: any) : any => `
    <li data-flow-phase="${step.phase}">
      <span class="flow-index">${String(index + 1).padStart(2, "0")}</span>
      <div class="flow-copy">
        <p class="flow-actor">${bilingual(step.actor[0], step.actor[1])}</p>
        <h3>${bilingual(step.title[0], step.title[1])}</h3>
        <p>${bilingual(step.detail[0], step.detail[1])}</p>
      </div>
      <strong class="flow-outcome">${bilingual(step.outcome[0], step.outcome[1])}</strong>
    </li>`).join("");
  const startup: any = journeyReport.configuration.startup;
  const upload: any = journeyReport.configuration.upload;
  const connector: any = journeyReport.configuration.connector;
  const basicConfig: any = journeyReport.configuration.upstreamServiceBasicConfig;
  const interfaceCatalogRows: any = renderInterfaceCatalogRows(upstreamServiceInterfaces);
  const connectorToolsets: any = connector.toolsets.map((value?: any) : any => `<li>${escapeHtml(value)}</li>`).join("");
  const connectorScopes: any = connector.scopes.map((value?: any) : any => `<li>${escapeHtml(value)}</li>`).join("");
  const connectorCapabilities: any = connector.publishedCapabilities
    .map((value?: any) : any => `<li>${escapeHtml(value)}</li>`)
    .join("");
  const catalogMatrix: any = connector.targetCatalog.map((target?: any) : any => {
    const row: any = matrixByTarget.get(target.target);
    const detected: any = target.status === "detected";
    return `<tr data-client-status="${detected ? "detected" : "not-detected"}">
      <td><strong>${escapeHtml(target.label)}</strong></td>
      <td><span class="status-badge ${detected ? "status-badge--pass" : "status-badge--neutral"}">${bilingual(detected ? "Detected" : "Not detected", detected ? "已发现" : "未发现")}</span></td>
      <td>${detected ? bilingual("Installed", "已安装") : "—"}</td>
      <td>${detected && row?.upload === "passed" ? bilingual("Passed", "通过") : "—"}</td>
      <td>${detected && row?.toolsList === "passed" ? bilingual("Passed", "通过") : "—"}</td>
      <td>${detected ? `<span class="state-stack"><small>${bilingual("Execution", "执行")}</small>${bilingual("Completed immediately", "立即完成")}</span>` : "—"}</td>
      <td>${detected && row?.requireApprovalDebug === "approved_and_completed_once"
        ? `<span class="state-stack state-stack--approval"><small>${bilingual("Decision → execution", "决定 → 执行")}</small>${bilingual("Pending → approved → completed once", "待审批 → 已批准 → 单次完成")}</span>`
        : "—"}</td>
      <td>${detected && row?.uninstall === "passed" ? bilingual("Passed", "通过") : "—"}</td>
      <td>${detected && row?.cleanup === "passed" ? bilingual("Passed", "通过") : "—"}</td>
    </tr>`;
  }).join("");
  const fallbackMatrix: any = fallbackUsed
    ? `<tr>
      <td><strong>${bilingual("MCP protocol simulator", "MCP 协议模拟器")}</strong></td>
      <td><span class="status-badge status-badge--neutral">${bilingual("Fallback after zero-client scan", "零客户端扫描后的回退")}</span></td>
      <td>${bilingual("Isolated simulated binding", "隔离模拟绑定")}</td>
      <td>${bilingual("Passed", "通过")}</td>
      <td>${bilingual("Passed", "通过")}</td>
      <td><span class="state-stack"><small>${bilingual("Execution", "执行")}</small>${bilingual("Completed immediately", "立即完成")}</span></td>
      <td><span class="state-stack state-stack--approval"><small>${bilingual("Decision → execution", "决定 → 执行")}</small>${bilingual("Pending → approved → completed once", "待审批 → 已批准 → 单次完成")}</span></td>
      <td>${bilingual("Passed", "通过")}</td>
      <td>${bilingual("Passed", "通过")}</td>
    </tr>`
    : "";
  const clientMatrix: any = `${catalogMatrix}${fallbackMatrix}`;
  const journeyStepRows: any = journeyReport.steps.map((step?: any) : any => `
      <tr>
        <td><code>${escapeHtml(step.id)}</code></td>
        <td>${bilingual("Passed", "通过")}</td>
        <td>${escapeHtml(step.durationMs)} ms</td>
      </tr>`).join("");
  const cleanupRows: any = journeyReport.cleanup.details.map((detail?: any) : any => `
      <tr>
        <td><code>${escapeHtml(detail.id)}</code></td>
        <td>${bilingual("Passed", "通过")}</td>
        <td>${escapeHtml(detail.durationMs)} ms</td>
      </tr>`).join("");
  const visualEvidence: any = journeyReport.visualEvidence.map((item?: any, index?: any) : any => {
    const prefix: any = "build/reports/";
    if (
      item?.status !== "passed"
      || item?.source !== "meshrix-web-console"
      || item?.localOnly !== true
      || item?.maskingPolicy !== "protected-values-only"
      || item?.protectedValuesMasked !== true
      || !Number.isSafeInteger(item?.protectedElementCount)
      || item.protectedElementCount <= 0
      || item?.maskedElementCount !== item.protectedElementCount
      || item?.serviceAddressMasked !== true
      || typeof item?.file !== "string"
      || !item.file.startsWith(prefix)
      || !Number.isSafeInteger(item?.byteLength)
      || item.byteLength <= 0
      || item?.viewportWidth !== RELEASE_JOURNEY_VISUAL_CAPTURE.viewport.width
      || item?.viewportHeight !== RELEASE_JOURNEY_VISUAL_CAPTURE.viewport.height
      || item?.deviceScaleFactor !== RELEASE_JOURNEY_VISUAL_CAPTURE.deviceScaleFactor
      || item?.pixelWidth !== RELEASE_JOURNEY_VISUAL_CAPTURE.pixelWidth
      || item?.pixelHeight !== RELEASE_JOURNEY_VISUAL_CAPTURE.pixelHeight
      || !/^[a-f0-9]{64}$/u.test(item?.sha256 || "")
    ) {
      const error: Error & Record<string, any> = new Error("The release journey visual evidence is invalid.");
      error.code = "upstream_service_publishing_html_visual_evidence_invalid";
      throw error;
    }
    const chineseTitle: any = VISUAL_TITLES[item.id] || item.title;
    const [contextKind, contextEnglish, contextChinese] =
      VISUAL_CONTEXT[item.id] || ["evidence", "Evidence", "证据"];
    const embeddedImageSource: any = renderEmbeddedVisualEvidenceSource({
      item,
      visualEvidenceFiles
    });
    const configAttachment: any = item.id === "console-upstream-basic-config"
      ? `<a class="evidence-file" href="${escapeHtml(embeddedBasicConfigHref)}" download="upstream-service-basic-config.json">${bilingual("Open actual JSON configuration", "打开真实 JSON 配置文件")}<code>application/json · sha256:${escapeHtml(basicConfig.sha256.slice(0, 12))}</code></a>`
      : "";
    const figureId: any = `evidence-${item.id}`;
    return `<figure data-evidence-kind="${contextKind}" id="${figureId}">
      <div class="evidence-image"><img src="${embeddedImageSource}" width="${escapeHtml(item.pixelWidth)}" height="${escapeHtml(item.pixelHeight)}" loading="lazy" decoding="async" alt="${escapeHtml(item.title)}" data-alt-en="${escapeHtml(item.title)}" data-alt-zh="${escapeHtml(chineseTitle)}"></div>
      <figcaption>
        <span class="evidence-step">${bilingual(`Step ${index + 1}`, `步骤 ${index + 1}`)}</span>
        <span class="evidence-context">${bilingual(contextEnglish, contextChinese)}</span>
        <strong>${bilingual(item.title, chineseTitle)}</strong>
        <code>${escapeHtml(item.route)} · ${escapeHtml(item.pixelWidth)}×${escapeHtml(item.pixelHeight)} · 2× · sha256:${escapeHtml(item.sha256.slice(0, 12))}</code>
        ${configAttachment}
      </figcaption>
    </figure>`;
  }).join("");
  const visualEvidenceIndex: any = journeyReport.visualEvidence.map((item?: any) : any => {
    const chineseTitle: any = VISUAL_TITLES[item.id] || item.title;
    return `<li><a href="#evidence-${item.id}">${bilingual(item.title, chineseTitle)}</a></li>`;
  }).join("");
  if (
    candidateReceipt?.claim !== "upstream-publishing-prepublication-passed"
    || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
      .test(String(candidateReceipt?.release?.tag || ""))
    || !/^sha256:[a-f0-9]{64}$/u
      .test(String(candidateReceipt?.release?.definitionSha256 || ""))
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u
      .test(String(candidateReceipt?.source?.commit || ""))
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u
      .test(String(candidateReceipt?.source?.tree || ""))
  ) {
    const error: Error & Record<string, any> = new Error("The scoped candidate context is required.");
    error.code = "upstream_service_publishing_html_candidate_invalid";
    throw error;
  }
  const startedAtMs: any = Date.parse(journeyReport.startedAt);
  const finishedAtMs: any = Date.parse(journeyReport.finishedAt);
  const totalDurationMs: any = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : 0;
  const cleanupDurationMs: any = Number.isSafeInteger(journeyReport.cleanup?.durationMs)
    ? journeyReport.cleanup.durationMs
    : 0;
  const candidateBound: any = (
    Array.isArray(candidateReceipt?.artifacts)
    && /^sha256:[a-f0-9]{64}$/u.test(
      String(candidateReceipt?.receiptSha256 || "")
    )
  );
  const candidateAuthorityAttributes: any = candidateBound
    ? 'data-report-authority="scoped-candidate" data-candidate-claim="upstream-publishing-prepublication-passed"'
    : 'data-report-authority="scoped-evidence-unbound" data-candidate-state="unbound"';
  const candidateScope: any = `<article class="config-card" data-report-slot="candidate-scope" data-candidate-scope-status="${candidateBound ? "bound" : "unbound"}">
      <header class="config-card-header"><div><p class="card-kicker">${bilingual("Candidate scope", "候选范围")}</p><h3>${bilingual(candidateBound ? "Scoped candidate receipt bound" : "Fresh scoped evidence; candidate binding pending", candidateBound ? "已绑定限定候选收据" : "全新限定证据；候选绑定待完成")}</h3></div></header>
      <dl><dt>${bilingual("Release tag", "发布标签")}</dt><dd>${escapeHtml(candidateReceipt.release.tag)}</dd><dt>${bilingual("Claim boundary", "声明边界")}</dt><dd>${bilingual(candidateBound ? "Upstream publishing prepublication only" : "No candidate-passed claim", candidateBound ? "仅限上游发布预发布" : "不含候选通过声明")}</dd></dl>
    </article>`;
  const reportNavigation: any = renderReportNavigation();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Meshrix Upstream Service Publishing Release Report</title>
  <style>
    :root {
      --ink: #17231d;
      --ink-soft: #34443b;
      --paper: #f3f4ef;
      --surface: #ffffff;
      --surface-subtle: #f8faf7;
      --line: #d9e0da;
      --line-strong: #bcc8bf;
      --muted: #657269;
      --accent: #176547;
      --accent-deep: #0e4934;
      --accent-soft: #e5f0ea;
      --decision: #6044a8;
      --decision-soft: #f0ecfa;
      --execution: #8a5a16;
      --execution-soft: #fbf1df;
      --shadow: 0 24px 70px #17231d1f;
    }
    * { box-sizing: border-box; }
    html {
      background: #e4e8e3;
      color: var(--ink);
      font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      text-rendering: optimizeLegibility;
    }
    body {
      max-width: 1160px;
      margin: 28px auto;
      overflow-x: hidden;
      overflow-y: auto;
      background: var(--paper);
      border: 1px solid #d5ddd6;
      border-radius: 22px;
      box-shadow: var(--shadow);
    }
    h1, h2, h3, p { text-wrap: pretty; }
    code {
      font: inherit;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
    }
    .cover {
      min-height: 590px;
      padding: 76px clamp(32px, 8vw, 92px);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background: var(--ink);
      color: #fff;
    }
    .cover-main { max-width: 900px; }
    .kicker, .eyebrow {
      margin: 0;
      font-size: .73rem;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    .kicker { color: #a7c9b7; }
    .eyebrow { color: var(--accent); }
    .cover h1 {
      max-width: 900px;
      margin: .22em 0 .3em;
      font-size: clamp(2.8rem, 7vw, 5.8rem);
      line-height: .98;
      letter-spacing: -.055em;
    }
    .verdict {
      display: inline-flex;
      align-items: center;
      min-height: 36px;
      margin: 0;
      padding: 7px 14px;
      border: 1px solid #70b494;
      border-radius: 999px;
      background: #1d7653;
      font-size: .84rem;
      font-weight: 800;
    }
    .cover-meta {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 48px;
    }
    .cover-meta p {
      min-width: 0;
      margin: 0;
      padding-top: 12px;
      border-top: 1px solid #ffffff2e;
      color: #ccd8d1;
      overflow-wrap: anywhere;
    }
    .section {
      padding: 58px clamp(26px, 8vw, 92px);
      border-bottom: 1px solid var(--line);
      content-visibility: auto;
      contain-intrinsic-size: auto 760px;
    }
    .section:last-of-type { border-bottom: 0; }
    .section-heading {
      max-width: 760px;
      margin-bottom: 26px;
    }
    .section h2 {
      margin: .18em 0 0;
      font-size: clamp(1.8rem, 4vw, 2.55rem);
      line-height: 1.12;
      letter-spacing: -.035em;
    }
    .section-intro {
      max-width: 760px;
      margin: 12px 0 0;
      color: var(--muted);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .metric, .panel, .config-card {
      min-width: 0;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 14px;
    }
    .metric {
      min-height: 126px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      color: var(--muted);
    }
    .metric strong {
      display: block;
      color: var(--ink);
      font-size: 2.35rem;
      line-height: 1;
      letter-spacing: -.045em;
    }
    .authority-note {
      margin: 18px 0 0;
      padding: 15px 17px;
      border-left: 3px solid var(--accent);
      background: var(--accent-soft);
      color: var(--ink-soft);
    }
    .approval-proof {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      margin-top: 18px;
      overflow: hidden;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      background: var(--surface);
    }
    .approval-proof article {
      min-width: 0;
      padding: 18px 20px;
      border-right: 1px solid var(--line);
    }
    .approval-proof article:last-child { border-right: 0; }
    .approval-proof small {
      display: block;
      color: var(--muted);
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .approval-proof strong {
      display: block;
      margin: 7px 0 2px;
      font-size: 1.08rem;
      line-height: 1.3;
    }
    .approval-proof span { color: var(--muted); }
    .approval-proof .proof-decision {
      background: var(--decision-soft);
      color: #49337e;
    }
    .approval-proof .proof-execution {
      background: var(--execution-soft);
      color: #70460f;
    }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .config-card { padding: 22px; }
    .config-card--connector { grid-column: 1 / -1; }
    .config-card-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }
    .config-card h3 { margin: 0; font-size: 1.1rem; }
    .card-kicker {
      margin: 0;
      color: var(--muted);
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .config-command {
      display: block;
      padding: 15px 16px;
      border-radius: 10px;
      background: var(--ink);
      color: #fff;
      font: 700 .85rem/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .environment-lines {
      display: grid;
      gap: 5px;
      margin-top: 10px;
      color: var(--ink-soft);
      font: 650 .82rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .config-card dl {
      display: grid;
      grid-template-columns: minmax(130px, auto) minmax(0, 1fr);
      gap: 8px 16px;
      margin: 16px 0 0;
    }
    .config-card dt { color: var(--muted); }
    .config-card dd {
      min-width: 0;
      margin: 0;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .connector-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(240px, .6fr);
      gap: 24px;
    }
    .technical-stack {
      display: grid;
      align-content: start;
      gap: 14px;
      padding: 16px;
      border-radius: 11px;
      background: var(--surface-subtle);
      border: 1px solid var(--line);
    }
    .technical-stack strong {
      font-size: .75rem;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .config-list {
      min-width: 0;
      margin: 5px 0 0;
      padding-left: 18px;
      overflow-wrap: anywhere;
    }
    .note {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .interface-catalog {
      margin-top: 18px;
      padding: 22px;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      background: var(--surface);
    }
    .interface-catalog header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px 18px;
      align-items: baseline;
      margin-bottom: 14px;
    }
    .interface-catalog h3 { margin: 0; }
    .interface-catalog header code {
      color: var(--muted);
      font-size: .72rem;
      overflow-wrap: anywhere;
    }
    .interface-catalog td code { display: block; }
    .interface-catalog td small {
      display: block;
      margin-top: 4px;
      color: var(--muted);
    }
    .table-shell {
      width: 100%;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--surface);
    }
    table {
      width: 100%;
      min-width: 720px;
      border-collapse: collapse;
      background: var(--surface);
    }
    th, td {
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    tr:last-child td { border-bottom: 0; }
    th {
      color: var(--muted);
      background: var(--surface-subtle);
      font-size: .7rem;
      font-weight: 800;
      letter-spacing: .075em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    td { overflow-wrap: anywhere; }
    .status-badge {
      display: inline-flex;
      min-height: 24px;
      align-items: center;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: .74rem;
      font-weight: 800;
      white-space: nowrap;
    }
    .status-badge--pass { background: var(--accent-soft); color: var(--accent-deep); }
    .status-badge--neutral { background: #edf0ed; color: var(--muted); }
    .state-stack {
      display: grid;
      gap: 3px;
      min-width: 150px;
      color: var(--accent-deep);
      font-weight: 750;
    }
    .state-stack small {
      color: var(--muted);
      font-size: .68rem;
      font-weight: 800;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .state-stack--approval { color: var(--decision); }
    .visual-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 24px;
    }
    .visual-grid figure {
      margin: 0;
      overflow: hidden;
      border: 1px solid var(--line-strong);
      border-radius: 16px;
      background: var(--surface);
      break-inside: avoid;
    }
    .visual-grid figure[data-evidence-kind="decision"] {
      border-color: #b9aadf;
      box-shadow: inset 4px 0 0 var(--decision);
    }
    .visual-grid figure[data-evidence-kind="execution"],
    .visual-grid figure[data-evidence-kind="outcome"] {
      border-color: #dec99e;
      box-shadow: inset 4px 0 0 var(--execution);
    }
    .visual-grid figure[data-evidence-kind="audit"] {
      border-color: #9dc7b2;
      box-shadow: inset 4px 0 0 var(--accent);
    }
    .evidence-image {
      padding: 10px;
      background: #e9ede9;
      border-bottom: 1px solid var(--line);
    }
    .visual-grid img {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 9px;
      background: #fff;
    }
    .visual-grid figcaption {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 4px 14px;
      padding: 16px 18px 17px;
    }
    .evidence-step {
      grid-row: 1 / 4;
      min-width: 58px;
      color: var(--accent);
      font-size: .76rem;
      font-weight: 850;
    }
    .evidence-context {
      color: var(--muted);
      font-size: .7rem;
      font-weight: 800;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .visual-grid figcaption strong {
      min-width: 0;
      font-size: 1rem;
      line-height: 1.35;
    }
    .visual-grid figcaption code {
      min-width: 0;
      color: var(--muted);
      font-size: .72rem;
      overflow-wrap: anywhere;
    }
    .evidence-file {
      grid-column: 2;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      align-items: center;
      width: max-content;
      max-width: 100%;
      margin-top: 7px;
      padding: 8px 11px;
      border-radius: 8px;
      background: var(--accent-soft);
      color: var(--accent-deep);
      font-weight: 800;
      text-decoration: none;
    }
    .evidence-file:hover { text-decoration: underline; }
    .evidence-file:focus-visible {
      outline: 3px solid #72b594;
      outline-offset: 2px;
    }
    .evidence-file code { color: var(--muted); font-weight: 650; }
    .flow {
      position: relative;
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .flow::before {
      position: absolute;
      top: 27px;
      bottom: 27px;
      left: 25px;
      width: 1px;
      background: var(--line-strong);
      content: "";
    }
    .flow li {
      position: relative;
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr) minmax(180px, .42fr);
      gap: 18px;
      align-items: center;
      min-height: 112px;
      padding: 18px 20px 18px 0;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--surface);
    }
    .flow li[data-flow-phase="decision"] {
      border-color: #b9aadf;
      background: var(--decision-soft);
    }
    .flow li[data-flow-phase="execution"] {
      border-color: #dec99e;
      background: var(--execution-soft);
    }
    .flow li[data-flow-phase="audit"] { border-color: #9dc7b2; }
    .flow-index {
      position: relative;
      z-index: 1;
      display: grid;
      width: 34px;
      height: 34px;
      place-items: center;
      justify-self: center;
      border: 4px solid var(--surface);
      border-radius: 50%;
      background: var(--accent);
      color: #fff;
      font-size: .7rem;
      font-weight: 850;
    }
    .flow li[data-flow-phase="decision"] .flow-index {
      border-color: var(--decision-soft);
      background: var(--decision);
    }
    .flow li[data-flow-phase="execution"] .flow-index {
      border-color: var(--execution-soft);
      background: var(--execution);
    }
    .flow-copy { min-width: 0; }
    .flow-actor {
      margin: 0 0 2px;
      color: var(--muted);
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .flow h3 { margin: 0; font-size: 1.05rem; }
    .flow-copy > p:last-child { margin: 5px 0 0; color: var(--muted); }
    .flow-outcome {
      min-width: 0;
      padding: 10px 12px;
      border-radius: 9px;
      background: var(--accent-soft);
      color: var(--accent-deep);
      font-size: .78rem;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .flow li[data-flow-phase="decision"] .flow-outcome {
      background: #e2daf6;
      color: #49337e;
    }
    .flow li[data-flow-phase="execution"] .flow-outcome {
      background: #f3e3c5;
      color: #70460f;
    }
    .decision-contract {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 22px;
    }
    .decision-contract article {
      min-width: 0;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--surface);
    }
    .decision-contract article:nth-child(1) { border-top: 4px solid var(--decision); }
    .decision-contract article:nth-child(2) { border-top: 4px solid var(--execution); }
    .decision-contract article:nth-child(3) { border-top: 4px solid var(--accent); }
    .decision-contract h3 { margin: 6px 0 10px; }
    .decision-contract dl {
      display: grid;
      gap: 8px;
      margin: 0;
    }
    .decision-contract dt {
      color: var(--muted);
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .decision-contract dd {
      margin: -5px 0 0;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .boundaries {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .boundaries li {
      padding: 7px 11px;
      border: 1px solid #c8d9cf;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-deep);
      font-size: .82rem;
      font-weight: 700;
    }
    .pass { color: var(--accent); font-weight: 800; }
    .na { color: var(--muted); }
    .provenance {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .provenance .panel {
      min-width: 0;
      padding: 24px;
    }
    .provenance p {
      margin: 0 0 20px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .provenance p:last-child { margin-bottom: 0; }
    .provenance strong {
      color: var(--muted);
      font-size: .72rem;
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .report-navigation {
      display: flex;
      gap: 8px;
      padding: 16px clamp(26px, 8vw, 92px);
      overflow-x: auto;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }
    .report-navigation a {
      flex: 0 0 auto;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--accent-deep);
      font-size: .78rem;
      font-weight: 750;
      text-decoration: none;
    }
    .skip-link {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 30;
      padding: 9px 13px;
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      font-weight: 800;
      transform: translateY(-180%);
    }
    .skip-link:focus { transform: translateY(0); }
    .language-switch {
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 20;
      display: flex;
      gap: 3px;
      padding: 4px;
      border: 1px solid #ffffff40;
      border-radius: 999px;
      background: #17231dea;
      box-shadow: 0 8px 24px #17231d33;
      backdrop-filter: blur(10px);
    }
    .language-switch button {
      min-height: 34px;
      padding: 6px 12px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #d7e0da;
      font: 750 .78rem/1 ui-sans-serif, system-ui;
      cursor: pointer;
    }
    .language-switch button[aria-pressed="true"] {
      background: #fff;
      color: var(--ink);
    }
    .language-switch button:focus-visible {
      outline: 3px solid #80d4b3;
      outline-offset: 2px;
    }
    @media (max-width: 900px) {
      body { margin: 0; border: 0; border-radius: 0; }
      .cover, .section { padding-inline: clamp(22px, 6vw, 48px); }
      .cover-meta, .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .connector-layout { grid-template-columns: 1fr; }
      .flow li { grid-template-columns: 52px minmax(0, 1fr); }
      .flow-outcome { grid-column: 2; justify-self: start; }
      .decision-contract { grid-template-columns: 1fr; }
      .language-switch { top: 10px; right: 10px; }
    }
    @media (max-width: 620px) {
      html { font-size: 14px; }
      .cover { min-height: 520px; padding-block: 58px 36px; }
      .cover-meta, .metrics, .config-grid, .provenance, .approval-proof {
        grid-template-columns: 1fr;
      }
      .cover-meta { gap: 8px; }
      .approval-proof article { border-right: 0; border-bottom: 1px solid var(--line); }
      .approval-proof article:last-child { border-bottom: 0; }
      .config-card--connector { grid-column: auto; }
      .config-card dl { grid-template-columns: 1fr; gap: 2px; }
      .config-card dd { margin-bottom: 8px; }
      .visual-grid figcaption { grid-template-columns: 1fr; }
      .evidence-step { grid-row: auto; min-width: 0; }
      .evidence-file { grid-column: 1; width: 100%; }
      .flow::before { left: 21px; }
      .flow li {
        grid-template-columns: 42px minmax(0, 1fr);
        gap: 10px;
        padding-right: 14px;
      }
      .flow-index { width: 30px; height: 30px; }
    }
    @media print {
      :root {
        --paper: #fff;
        --surface-subtle: #fff;
        --shadow: none;
      }
      @page { margin: 13mm; }
      html {
        background: #fff;
        font-size: 9.5pt;
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      body {
        max-width: none;
        margin: 0;
        overflow: visible;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .cover {
        min-height: 245mm;
        padding: 18mm;
        break-after: page;
      }
      .section {
        padding: 11mm 4mm;
        break-inside: auto;
      }
      .section-heading {
        break-inside: avoid;
        break-after: avoid;
        page-break-inside: avoid;
        page-break-after: avoid;
      }
      h2, h3 { break-after: avoid; }
      .metric, .panel, .config-card, .approval-proof, .approval-proof article,
      .table-shell, table, tr, figure, .flow li, .decision-contract article {
        break-inside: avoid;
      }
      .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .metric { min-height: 92px; padding: 13px; }
      .config-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .connector-layout { grid-template-columns: minmax(0, 1.4fr) minmax(180px, .6fr); }
      .decision-contract { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .table-shell { overflow: visible; }
      table { min-width: 0; font-size: 8pt; }
      th, td { padding: 7px 8px; }
      .visual-grid { gap: 10mm; }
      .evidence-image { padding: 5px; }
      .flow li { min-height: 82px; }
      .language-switch, .report-navigation, .skip-link { display: none; }
      .section {
        content-visibility: visible;
        contain-intrinsic-size: auto;
      }
    }
  </style>
</head>
<body data-report-portability="single-file" ${candidateAuthorityAttributes}>
  <a class="skip-link" href="#report-content">${bilingual("Skip to report content", "跳到报告内容")}</a>
  <nav class="language-switch" aria-label="Language / 语言">
    <button type="button" data-language="zh-CN" aria-pressed="false">中文</button>
    <button type="button" data-language="en" aria-pressed="true">English</button>
  </nav>
  <header class="cover">
    <div class="cover-main">
      <p class="kicker">${bilingual("Mandatory pre-release evidence", "发布前强制证据")}</p>
      <h1>${bilingual("Upstream Service Publishing", "上游服务发布")}</h1>
      <p class="verdict">${bilingual("Scoped upstream journey verified", "限定上游路线验证通过")}</p>
    </div>
    <div class="cover-meta">
      <p><strong>${bilingual("Generated", "生成时间")}</strong><br>${escapeHtml(journeyReport.generatedAt)}</p>
      <p>${bilingual("Deployment mode: isolated external-service journey", "部署模式：隔离的外部服务旅程")}</p>
      <p>${bilingual("Storage: local Git-ignored build output; cloud upload disabled", "存储：本地 Git 忽略的 build 产物；禁止上传云端")}</p>
      <p data-report-timing="journey-total" data-duration-ms="${totalDurationMs}"><strong>${bilingual("Journey duration", "路线耗时")}</strong><br>${totalDurationMs} ms</p>
      <p data-report-cleanup="passed" data-duration-ms="${cleanupDurationMs}"><strong>${bilingual("Cleanup", "清理")}</strong><br>${cleanupDurationMs} ms · ${bilingual("passed", "通过")}</p>
    </div>
  </header>
  ${reportNavigation}
  <main id="report-content" tabindex="-1">
  <section class="section" id="executive-summary" aria-labelledby="executive-summary-title" data-report-section="executive-summary">
    <header class="section-heading">
      <p class="eyebrow">${bilingual("Executive summary", "执行摘要")}</p>
      <h2 id="executive-summary-title">${bilingual("One governed route, one verified result", "一条受治理路径，一个已验证结果")}</h2>
      <p class="section-intro">${bilingual("The approval branch proves a visible decision boundary: no upstream effect before approval, one bounded execution after approval, and an audit record that closes the loop.", "审批分支证明了清晰可见的决策边界：审批前没有上游影响，审批后仅执行一次，并由审计记录闭合流程。")}</p>
    </header>
    <div class="metrics">
      <div class="metric"><strong>${escapeHtml(report.summary.passedCount)}</strong>${bilingual("assertions passed", "项断言通过")}</div>
      <div class="metric"><strong>${escapeHtml(report.summary.boundaryCount)}</strong>${bilingual("boundaries traversed", "个边界已穿越")}</div>
      <div class="metric"><strong>${escapeHtml(report.summary.revisionEdgeCount)}</strong>${bilingual("revision edges", "条修订边")}</div>
      <div class="metric"><strong>0</strong>${bilingual("failed assertions", "项断言失败")}</div>
    </div>
    ${candidateScope}
    <div class="approval-proof" aria-label="Approval and execution proof">
      <article>
        <small>${bilingual("Before approval", "审批前")}</small>
        <strong>${escapeHtml(approvalReceipt.successfulBeforeApproval)} ${bilingual("successful upstream executions", "次成功上游执行")}</strong>
        <span>${bilingual("The request remains pending without an external effect.", "请求保持待审批状态，不产生外部影响。")}</span>
      </article>
      <article class="proof-decision">
        <small>${bilingual("Decision", "审批决定")}</small>
        <strong>${escapeHtml(approvalReceipt.pendingCount)} ${bilingual("request-scoped approvals", "个请求级审批")}</strong>
        <span>${bilingual("Each decision authorizes this subject and one effect only.", "每个决定仅授权当前主体及一次影响。")}</span>
      </article>
      <article class="proof-execution">
        <small>${bilingual("After approval", "审批后")}</small>
        <strong>${escapeHtml(approvalReceipt.successfulAfterApproval)} ${bilingual("exactly-once executions", "次单次执行")}</strong>
        <span>${bilingual("Execution resumes after the decision and is recorded separately.", "执行在决定之后恢复，并以独立状态记录。")}</span>
      </article>
    </div>
    <p class="authority-note">${bilingual(candidateBound ? "This HTML document is a local-only human-readable projection of a scoped candidate receipt. Synthetic fixture and generated platform identifiers remain visible; credentials and protected identities remain protected. The Functional Release Gate remains the sole platform release authority." : "This HTML document is a local-only human-readable projection of fresh scoped evidence. It remains unbound until an external candidate receipt hashes the final HTML and complete artifact set; it is not a candidate-passed claim. The Functional Release Gate remains the sole platform release authority.", candidateBound ? "此 HTML 文档是限定候选收据的本地可读投影。合成测试与平台生成标识保持可见；凭据及受保护身份仍受保护。Functional Release Gate 仍是唯一的平台发布权威。" : "此 HTML 文档是全新限定证据的本地可读投影。在外部候选收据对最终 HTML 与完整制品集进行哈希绑定前，它保持未绑定状态，也不构成候选通过声明。Functional Release Gate 仍是唯一的平台发布权威。")}</p>
  </section>
  <section class="section" id="safe-configuration" aria-labelledby="safe-configuration-title" data-report-section="safe-configuration">
    <header class="section-heading">
      <p class="eyebrow">${bilingual("Exact safe configuration", "精确安全配置")}</p>
      <h2 id="safe-configuration-title">${bilingual("Startup, binary upload, and downstream connector", "启动参数、二进制上传与下游连接器")}</h2>
    </header>
    <article class="config-card">
      <header class="config-card-header"><div><p class="card-kicker">${bilingual("Runtime", "运行时")}</p><h3>${bilingual("Isolated service stack", "隔离服务栈")}</h3></div></header>
      <code class="config-command">${escapeHtml(startup.command)}</code>
      <div class="environment-lines"><span>MESHRIX_BUILD_TARGET=${escapeHtml(startup.buildTarget)}</span><span>MESHRIX_SERVER_WITH_UI=1</span></div>
      <dl><dt>${bilingual("Compose profile", "Compose 配置档")}</dt><dd>${escapeHtml(startup.composeProfile)}</dd><dt>${bilingual("Web Console", "Web 管控台")}</dt><dd>${bilingual("Enabled", "已启用")}</dd></dl>
    </article>
    <article class="config-card" data-report-slot="upstream-publication-runtime-health">
      <header class="config-card-header"><div><p class="card-kicker">${bilingual("Publication and runtime health", "发布与运行时健康")}</p><h3>${bilingual("Published revision is healthy", "已发布修订健康")}</h3></div></header>
      <dl>
        <dt>${bilingual("Publication status", "发布状态")}</dt><dd>${escapeHtml(publishReceipt.publication.status)}</dd>
        <dt>${bilingual("Service revision", "服务修订")}</dt><dd>${escapeHtml(publishReceipt.serviceRevision)}</dd>
        <dt>${bilingual("Set revision", "集合修订")}</dt><dd>${escapeHtml(publishReceipt.setRevision)}</dd>
        <dt>${bilingual("Health status", "健康状态")}</dt><dd>${escapeHtml(publishReceipt.health.status)}</dd>
        <dt>${bilingual("Healthy endpoints", "健康端点")}</dt><dd>${escapeHtml(publishReceipt.health.healthyEndpoints)} / ${escapeHtml(publishReceipt.health.endpoints)}</dd>
      </dl>
    </article>
    <article class="interface-catalog" data-report-slot="upstream-service-interface-catalog">
      <header>
        <div><p class="card-kicker">${bilingual("Mandatory gateway forwarding evidence", "强制网关转发证据")}</p><h3>${bilingual("Published upstream interfaces", "已发布上游接口")}</h3></div>
        <code>application/json · ${escapeHtml(basicConfig.byteLength)} B · sha256:${escapeHtml(basicConfig.sha256)}</code>
      </header>
      <div class="table-shell"><table><caption>${bilingual("Published upstream interface catalog", "已发布上游接口清单")}</caption><thead><tr>${INTERFACE_CATALOG_COLUMNS.map(([english, chinese]: any[]) : any => `<th>${bilingual(english, chinese)}</th>`).join("")}</tr></thead><tbody>${interfaceCatalogRows}</tbody></table></div>
      <p class="note">${bilingual("Download is the artifact response of the same conversion POST, not a standalone download endpoint. Every listed interface shape is forwarded through the governed Meshrix gateway.", "下载是同一个转换 POST 的制品响应，不是独立的下载接口。表中每种接口形态都通过受治理的 Meshrix 网关尽职转发。")}</p>
    </article>
    <div class="config-grid">
      <article class="config-card">
        <header class="config-card-header"><div><p class="card-kicker">${bilingual("Data plane", "数据平面")}</p><h3>${bilingual("Native file upload", "原生文件上传")}</h3></div></header>
        <dl><dt>${bilingual("Ingress", "入口")}</dt><dd>${escapeHtml(upload.transport)}</dd><dt>${bilingual("Chunk media type", "分块媒体类型")}</dt><dd>${escapeHtml(upload.chunkContentType)}</dd><dt>${bilingual("Content encoding", "内容编码")}</dt><dd>${escapeHtml(upload.contentEncoding)}</dd><dt>${bilingual("Base64 JSON", "Base64 JSON")}</dt><dd>${bilingual("No", "否")}</dd><dt>${bilingual("Artifact reference", "制品引用")}</dt><dd>${escapeHtml(upload.artifactReference)}</dd><dt>${bilingual("Upstream representation", "上游表示")}</dt><dd>${escapeHtml(upload.upstreamRepresentation)}</dd><dt>${bilingual("External file budget", "外部服务文件预算")}</dt><dd>${escapeHtml(upload.externalFileBudgetBytes)} B (50 MiB)</dd><dt>${bilingual("Multipart request envelope", "Multipart 请求封装上限")}</dt><dd>${escapeHtml(upload.multipartRequestMaxBytes)} B (51 MiB)</dd></dl>
        <p class="note">${bilingual("The multipart value bounds one upstream request envelope; it is not Meshrix's global upload limit.", "Multipart 数值约束单次上游请求封装，并非 Meshrix 的全局上传上限。")}</p>
      </article>
      <article class="config-card config-card--connector">
        <header class="config-card-header"><div><p class="card-kicker">${bilingual("Governed delivery", "受治理交付")}</p><h3>${bilingual("Downstream MCP connector", "下游 MCP 连接器")}</h3></div></header>
        <div class="connector-layout">
          <div>
            <dl><dt>${bilingual("Transport", "传输方式")}</dt><dd>${escapeHtml(connector.transport)}</dd><dt>${bilingual("Validation mode", "验证模式")}</dt><dd>${bilingual(fallbackUsed ? "Simulated fallback after confirmed zero-client scan" : "Real requests from every detected local client", fallbackUsed ? "确认零客户端后的模拟回退" : "所有已发现本机客户端的真实请求")}</dd><dt>${bilingual("Maximum risk", "最高风险")}</dt><dd>${escapeHtml(connector.maxRisk)}</dd><dt>${bilingual("Upstream route", "上游路由")}</dt><dd>${escapeHtml(connector.operations.upstreamPath)}</dd><dt>${bilingual("Approval interface", "审批接口")}</dt><dd>${escapeHtml(connector.operations.requireApproval)}</dd><dt>${bilingual("Immediate interface", "直通接口")}</dt><dd>${escapeHtml(connector.operations.fullAccess)}</dd><dt>${bilingual("Allowed service", "允许服务")}</dt><dd>${escapeHtml(connector.allowedService)}</dd></dl>
            <p class="note">${bilingual("The full-access-debug projection skips operation approval only. Grant, scope, risk, service, owner, and execution-permit checks remain enforced.", "full-access-debug 投影仅跳过操作审批；Grant、权限域、风险、服务、所有者及执行许可检查仍然生效。")}</p>
          </div>
          <div class="technical-stack">
            <div><strong>${bilingual("Capabilities", "能力")}</strong><ul class="config-list">${connectorCapabilities}</ul></div>
            <div><strong>${bilingual("Toolsets", "工具集")}</strong><ul class="config-list">${connectorToolsets}</ul></div>
            <div><strong>${bilingual("Scopes", "权限域")}</strong><ul class="config-list">${connectorScopes}</ul></div>
          </div>
        </div>
      </article>
    </div>
  </section>
  <section class="section" id="mcp-acceptance" aria-labelledby="mcp-acceptance-title" data-report-section="mcp-acceptance">
    <header class="section-heading"><p class="eyebrow">${bilingual("MCP acceptance matrix", "MCP 验收矩阵")}</p><h2 id="mcp-acceptance-title">${bilingual(fallbackUsed ? "No local client was detected; MCP protocol simulation was used" : "Every detected local client completed a real connector request", fallbackUsed ? "未发现本机客户端；已使用 MCP 协议模拟" : "每个已发现的本机客户端均完成真实连接器请求")}</h2></header>
    <div class="table-shell" data-report-slot="client-lifecycle"><table><caption>${bilingual("Detected-client connector lifecycle acceptance", "已发现客户端连接器生命周期验收")}</caption><thead><tr><th>${bilingual("Client", "客户端")}</th><th>${bilingual("Discovery", "发现")}</th><th>${bilingual("Install", "安装")}</th><th>${bilingual("Upload", "上传")}</th><th>tools/list</th><th>full-access-debug</th><th>require-approval-debug</th><th>${bilingual("Uninstall", "卸载")}</th><th>${bilingual("Cleanup", "清理")}</th></tr></thead><tbody>${clientMatrix}</tbody></table></div>
    <p class="note">${bilingual(fallbackUsed ? "All seven supported client commands were absent. Simulation is a declared fallback and does not count as client compatibility evidence." : "Not detected means the supported client command was absent on this host. Every detected row is mandatory and passed in an isolated temporary client configuration; simulation is forbidden while any real client is detected.", fallbackUsed ? "全部七个受支持客户端命令均不存在。模拟是明确标注的回退，不计作客户端兼容性证据。" : "未发现表示本机不存在该受支持客户端命令。每个已发现行均为强制验收项，并在隔离的临时客户端配置中通过；只要发现任一真实客户端，就禁止使用模拟。")}</p>
    <p class="note">${bilingual(`The audit also contains ${approvalReceipt.expectedOutOfScopeWorkspaceDenials} expected meshrix.agentWorkspace.list denials—one per execution target. Workspace authority is deliberately absent from this journey Grant; these boundary denials prove that full-access-debug does not widen unrelated authority and are not failures of either format-convert interface.`, `审计还包含 ${approvalReceipt.expectedOutOfScopeWorkspaceDenials} 条预期的 meshrix.agentWorkspace.list 拒绝记录，每个执行目标一条。本次路线 Grant 有意不授予工作空间权限；这些边界拒绝证明 full-access-debug 不会扩大无关权限，并非两个格式转换接口的失败。`)}</p>
  </section>
  <section class="section" id="live-console-evidence" aria-labelledby="live-console-evidence-title" data-report-section="live-console-evidence">
    <header class="section-heading"><p class="eyebrow">${bilingual("Live Console evidence", "实时管控台证据")}</p><h2 id="live-console-evidence-title">${bilingual("Real product pages from configuration to MCP invocation", "从配置到 MCP 调用的真实产品页面")}</h2><p class="section-intro">${bilingual("Decision screenshots identify the subject and effect; execution and audit screenshots independently show what happened afterward.", "决策截图说明主体与影响；执行和审计截图分别展示之后实际发生的结果。")}</p></header>
    <ol class="boundaries" data-report-slot="visual-evidence-index">${visualEvidenceIndex}</ol>
    <div class="visual-grid">${visualEvidence}</div>
  </section>
  <section class="section" id="golden-path" aria-labelledby="golden-path-title" data-report-section="golden-path">
    <header class="section-heading"><p class="eyebrow">${bilingual("Golden path", "黄金路径")}</p><h2 id="golden-path-title">${bilingual("Registration to downstream invocation", "从注册到下游调用")}</h2><p class="section-intro">${bilingual("The route separates requester, approver, execution permit, and audit so a decision is never mistaken for the resulting effect.", "该路径分离请求者、审批者、执行许可与审计，避免将审批决定误认为执行结果。")}</p></header>
    <ol class="flow">${flow}</ol>
    <div class="decision-contract">
      <article><p class="card-kicker">${bilingual("Approval decision", "审批决定")}</p><h3>${bilingual("What is authorized", "授权了什么")}</h3><dl><dt>${bilingual("Subject", "主体")}</dt><dd>${bilingual("Each pending conversion request", "每个待处理的转换请求")}</dd><dt>${bilingual("Effect", "影响")}</dt><dd>${bilingual("Resume one upstream conversion", "恢复一次上游转换")}</dd><dt>${bilingual("Limit", "限制")}</dt><dd>${bilingual("No standing or unrelated authority", "不形成长期或无关权限")}</dd></dl></article>
      <article><p class="card-kicker">${bilingual("Execution result", "执行结果")}</p><h3>${bilingual("What happened afterward", "之后发生了什么")}</h3><dl><dt>${bilingual("State", "状态")}</dt><dd>${bilingual("Approval consumed before execution", "执行前已消费审批")}</dd><dt>${bilingual("Count", "次数")}</dt><dd>${escapeHtml(approvalReceipt.successfulAfterApproval)} ${bilingual("successful executions", "次成功执行")}</dd><dt>${bilingual("Semantics", "语义")}</dt><dd>${bilingual("Exactly once per approved request", "每个已批准请求恰好一次")}</dd></dl></article>
      <article><p class="card-kicker">${bilingual("Audit closure", "审计闭环")}</p><h3>${bilingual("How it remains traceable", "如何保持可追溯")}</h3><dl><dt>${bilingual("Decision", "决定")}</dt><dd>${bilingual("Pending → approved", "待审批 → 已批准")}</dd><dt>${bilingual("Execution", "执行")}</dt><dd>${bilingual("Approved → completed once", "已批准 → 单次完成")}</dd><dt>${bilingual("Boundary", "边界")}</dt><dd>${escapeHtml(approvalReceipt.expectedOutOfScopeWorkspaceDenials)} ${bilingual("expected non-amplification denials", "条预期的权限不扩张拒绝")}</dd></dl></article>
    </div>
  </section>
  <section class="section" id="requirements" aria-labelledby="requirements-title" data-report-section="requirements"><header class="section-heading"><p class="eyebrow">${bilingual("Requirements", "需求")}</p><h2 id="requirements-title">${bilingual("Verified assertions", "已验证断言")}</h2></header><div class="table-shell"><table><caption>${bilingual("Verified requirement assertions", "已验证需求断言")}</caption><thead><tr><th>${bilingual("Requirement", "需求")}</th><th>${bilingual("Phase", "阶段")}</th><th>${bilingual("Result", "结果")}</th></tr></thead><tbody>${assertions}</tbody></table></div></section>
  <section class="section" id="production-composition" aria-labelledby="production-composition-title" data-report-section="production-composition"><header class="section-heading"><p class="eyebrow">${bilingual("Production composition", "生产组成")}</p><h2 id="production-composition-title">${bilingual("Traversed boundaries", "已穿越边界")}</h2></header><ul class="boundaries">${boundaries}</ul></section>
  <section class="section" id="revision-semantics" aria-labelledby="revision-semantics-title" data-report-section="revision-semantics"><header class="section-heading"><p class="eyebrow">${bilingual("Revision semantics", "修订语义")}</p><h2 id="revision-semantics-title">${bilingual("Lifecycle outcomes", "生命周期结果")}</h2></header><div class="table-shell"><table><caption>${bilingual("Verified revision lifecycle outcomes", "已验证修订生命周期结果")}</caption><thead><tr><th>${bilingual("Scenario", "场景")}</th><th>${bilingual("Revision", "修订")}</th><th>${bilingual("Outcome", "结果")}</th></tr></thead><tbody>${revisions}</tbody></table></div></section>
  <section class="section" id="protocol-delivery" aria-labelledby="protocol-delivery-title" data-report-section="protocol-delivery"><header class="section-heading"><p class="eyebrow">${bilingual("Protocol delivery", "协议交付")}</p><h2 id="protocol-delivery-title">${bilingual("Downstream cohorts", "下游队列")}</h2></header><div class="table-shell"><table><caption>${bilingual("Verified downstream protocol cohorts", "已验证下游协议队列")}</caption><thead><tr><th>${bilingual("Cohort", "队列")}</th><th>${bilingual("Outcome", "结果")}</th><th>${bilingual("Count", "数量")}</th></tr></thead><tbody>${cohorts}</tbody></table></div></section>
  <section class="section" id="provenance" aria-labelledby="provenance-title" data-report-section="provenance">
    <header class="section-heading"><p class="eyebrow">${bilingual("Provenance", "来源")}</p><h2 id="provenance-title">${bilingual("Evidence identity", "证据标识")}</h2></header>
    <div class="provenance">
      <div class="panel"><p><strong>${bilingual("Schema", "模式")}</strong><br>${escapeHtml(report.schemaVersion)}</p><p><strong>${bilingual("Command", "命令")}</strong><br>${escapeHtml(report.commandId)}</p></div>
      <div class="panel"><p><strong>${bilingual("Source revision", "源修订")}</strong><br>${escapeHtml(report.sourceRevision)}</p><p><strong>${bilingual("Payload digest", "载荷摘要")}</strong><br>${escapeHtml(report.payloadDigest)}</p></div>
    </div>
    <div class="table-shell" data-report-slot="journey-step-status">
      <table><caption>${bilingual("Journey step status and bounded duration", "路线步骤状态与有界耗时")}</caption><thead><tr><th>${bilingual("Step", "步骤")}</th><th>${bilingual("Status", "状态")}</th><th>${bilingual("Duration", "耗时")}</th></tr></thead><tbody>${journeyStepRows}</tbody></table>
    </div>
    <div class="table-shell" data-report-slot="cleanup-summary">
      <table><caption>${bilingual("Cleanup status and bounded duration", "清理状态与有界耗时")}</caption><thead><tr><th>${bilingual("Cleanup", "清理")}</th><th>${bilingual("Status", "状态")}</th><th>${bilingual("Duration", "耗时")}</th></tr></thead><tbody>${cleanupRows}</tbody></table>
    </div>
  </section>
  </main>
  <script>
    (() => {
      const buttons = Array.from(document.querySelectorAll("[data-language]"));
      const nodes = Array.from(document.querySelectorAll("[data-en][data-zh]"));
      const localizedImages = Array.from(document.querySelectorAll("img[data-alt-en][data-alt-zh]"));
      const applyLanguage = (requested) => {
        const language = requested === "zh-CN" ? "zh-CN" : "en";
        document.documentElement.lang = language;
        document.title = language === "zh-CN"
          ? "Meshrix 上游服务发布报告"
          : "Meshrix Upstream Service Publishing Release Report";
        for (const node of nodes) {
          node.textContent = language === "zh-CN" ? node.dataset.zh : node.dataset.en;
        }
        for (const image of localizedImages) {
          image.alt = language === "zh-CN" ? image.dataset.altZh : image.dataset.altEn;
        }
        for (const button of buttons) {
          button.setAttribute("aria-pressed", String(button.dataset.language === language));
        }
      };
      for (const button of buttons) {
        button.addEventListener("click", () => applyLanguage(button.dataset.language));
      }
      applyLanguage(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
    })();
  </script>
</body>
  </html>
`;
}

function renderReportNavigation() : any {
  const links: any = UPSTREAM_SERVICE_PUBLISHING_REPORT_SECTIONS.map(
    ([id, english, chinese]: any[]) : any =>
      `<a href="#${id}">${bilingual(english, chinese)}</a>`
  ).join("");
  return `<nav class="report-navigation" aria-label="Report sections">${links}</nav>`;
}

function renderFailedUpstreamServicePublishingHtml(journeyReport?: any) : any {
  const candidateCode: any = String(
    journeyReport?.failure?.code || "release_journey_failed"
  );
  const failureCode: any = /^[a-z0-9_]{1,120}$/u.test(candidateCode)
    ? candidateCode
    : "release_journey_failed";
  const candidateStage: any = String(journeyReport?.failure?.step || "unknown-stage");
  const failureStage: any = /^[a-z0-9-]{1,80}$/u.test(candidateStage)
    ? candidateStage
    : "unknown-stage";
  const boundedStatusRows: any = (items: any, { limit, emptyLabel }: Record<string, any>) : any => {
    const rows: any = (Array.isArray(items) ? items : [])
      .slice(0, limit)
      .filter((item?: any) : any => (
        /^[a-z0-9:-]{1,96}$/u.test(String(item?.id || ""))
        && ["passed", "failed", "skipped"].includes(item?.status)
        && Number.isSafeInteger(item?.durationMs)
        && item.durationMs >= 0
      ))
      .map((item?: any) : any => `<tr><td><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.durationMs)} ms</td></tr>`)
      .join("");
    return rows || `<tr><td colspan="3">${escapeHtml(emptyLabel)}</td></tr>`;
  };
  const completedStepRows: any = boundedStatusRows(journeyReport?.steps, {
    limit: JOURNEY_STEP_ORDER.length,
    emptyLabel: "No completed steps"
  });
  const boundedCleanupRows: any = boundedStatusRows(journeyReport?.cleanup?.details, {
    limit: 32,
    emptyLabel: "No completed cleanup actions"
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Meshrix Upstream Service Publishing — Failed Journey</title>
  <style>
    :root { color: #2d1e1b; background: #eee9e5; font: 16px/1.6 system-ui, sans-serif; }
    body { max-width: 760px; margin: 8vh auto; padding: 32px; background: #fff; border: 1px solid #cdbcb5; border-radius: 16px; }
    main { display: grid; gap: 18px; }
    h1 { margin: 0; font-size: clamp(2rem, 7vw, 4rem); line-height: 1; }
    .status { padding: 14px; border-left: 4px solid #a03d2f; background: #f8ece8; }
    code { overflow-wrap: anywhere; }
    .table-shell { max-width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    caption { padding: 8px 0; font-weight: 800; text-align: left; }
    th, td { padding: 8px; border: 1px solid #d8cbc5; text-align: left; }
    .language-switch { position: fixed; top: 12px; right: 12px; display: flex; gap: 4px; padding: 4px; border-radius: 999px; background: #2d1e1bea; }
    button { padding: 7px 11px; border: 0; border-radius: 999px; background: transparent; color: white; cursor: pointer; }
    button[aria-pressed="true"] { background: white; color: #2d1e1b; }
    @media print { .language-switch { display: none; } }
  </style>
</head>
<body data-report-portability="single-file" data-report-authority="non-authoritative-failure" data-release-evidence="rejected" data-report-status="failed">
  <nav class="language-switch" aria-label="Language / 语言">
    <button type="button" data-language="zh-CN" aria-pressed="false">中文</button>
    <button type="button" data-language="en" aria-pressed="true">English</button>
  </nav>
  <main id="report-content" tabindex="-1">
    <p>${bilingual("Recovery projection", "恢复投影")}</p>
    <h1>${bilingual("Failed journey — not release evidence", "失败路线——不是发布证据")}</h1>
    <p class="status"><strong>${bilingual("Failing stage", "失败阶段")}</strong><br><code>${escapeHtml(failureStage)}</code><br><strong>${bilingual("Failure code", "失败代码")}</strong><br><code>${escapeHtml(failureCode)}</code></p>
    <div class="table-shell"><table><caption>${bilingual("Completed journey steps", "已完成路线步骤")}</caption><thead><tr><th>${bilingual("Step", "步骤")}</th><th>${bilingual("Status", "状态")}</th><th>${bilingual("Duration", "耗时")}</th></tr></thead><tbody>${completedStepRows}</tbody></table></div>
    <div class="table-shell"><table><caption>${bilingual("Cleanup progress", "清理进度")}</caption><thead><tr><th>${bilingual("Cleanup", "清理")}</th><th>${bilingual("Status", "状态")}</th><th>${bilingual("Duration", "耗时")}</th></tr></thead><tbody>${boundedCleanupRows}</tbody></table></div>
    <p>${bilingual("Run the complete upstream publishing journey again after correcting the reported failure. Only a new fully successful run may produce scoped candidate evidence.", "修复所报告的失败后，重新运行完整的上游服务发布路线。只有全新且完全成功的运行才能生成限定候选证据。")}</p>
  </main>
  <script>
    (() => {
      const buttons = Array.from(document.querySelectorAll("[data-language]"));
      const nodes = Array.from(document.querySelectorAll("[data-en][data-zh]"));
      const applyLanguage = (requested) => {
        const language = requested === "zh-CN" ? "zh-CN" : "en";
        document.documentElement.lang = language;
        for (const node of nodes) node.textContent = language === "zh-CN" ? node.dataset.zh : node.dataset.en;
        for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.language === language));
      };
      for (const button of buttons) button.addEventListener("click", () => applyLanguage(button.dataset.language));
      applyLanguage(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
    })();
  </script>
</body>
</html>
`;
}

export function renderUpstreamServicePublishingBlankTemplate() : any {
  const sections: any = UPSTREAM_SERVICE_PUBLISHING_REPORT_SECTIONS.map(
    ([id, english, chinese]: any[]) : any => {
      let sectionSlots: any = "";
      if (id === "executive-summary") {
        sectionSlots = `<article class="catalog" data-report-slot="candidate-scope">
          <h3>${bilingual("Candidate scope — not bound", "候选范围——未绑定")}</h3>
          <p>${bilingual("Not executed; no candidate claim is present.", "未执行；不存在候选声明。")}</p>
        </article>`;
      } else if (id === "safe-configuration") {
        sectionSlots = `<article class="catalog" data-report-slot="upstream-publication-runtime-health">
          <h3>${bilingual("Publication and runtime health — required", "发布与运行时健康——必填")}</h3>
          <p>${bilingual("Not executed; populate only from the bounded upstream-publish receipt.", "未执行；只能从有界 upstream-publish 收据填充。")}</p>
        </article>
        <article class="catalog" data-report-slot="upstream-service-interface-catalog">
          <h3>${bilingual("Published upstream interfaces — required", "已发布上游接口——必填")}</h3>
          <p>${bilingual("Fill this catalog only from the digest-bound publication input.", "此清单只能从摘要绑定的实际发布输入中填写。")}</p>
          <div class="table-shell"><table><caption>${bilingual("Published upstream interface catalog", "已发布上游接口清单")}</caption><thead><tr>${INTERFACE_CATALOG_COLUMNS.map(([columnEnglish, columnChinese]: any[]) : any => `<th>${bilingual(columnEnglish, columnChinese)}</th>`).join("")}</tr></thead>
          <tbody><tr data-service-interface="required-placeholder"><td colspan="5">${bilingual("Required before generation: health route plus every published operation. Do not invent a download endpoint.", "生成前必填：健康检查路径及每个已发布操作。不得虚构下载接口。")}</td></tr></tbody></table></div>
        </article>`;
      } else if (id === "mcp-acceptance") {
        sectionSlots = `<div class="table-shell" data-report-slot="client-lifecycle"><table><caption>${bilingual("Client lifecycle — required", "客户端生命周期——必填")}</caption><thead><tr><th>${bilingual("Client", "客户端")}</th><th>${bilingual("Discovery", "发现")}</th><th>${bilingual("Install", "安装")}</th><th>${bilingual("Upload", "上传")}</th><th>tools/list</th><th>full-access-debug</th><th>require-approval-debug</th><th>${bilingual("Uninstall", "卸载")}</th><th>${bilingual("Cleanup", "清理")}</th></tr></thead><tbody><tr><td colspan="9">${bilingual("Not executed", "未执行")}</td></tr></tbody></table></div>`;
      } else if (id === "live-console-evidence") {
        sectionSlots = `<ol class="catalog" data-report-slot="visual-evidence-index"><li>${bilingual("Not executed; ten ordered Console evidence entries are required.", "未执行；需要十条有序管控台证据索引。")}</li></ol>`;
      } else if (id === "provenance") {
        sectionSlots = `<article class="catalog" data-report-slot="journey-timings"><h3>${bilingual("Journey timings", "路线耗时")}</h3><p>${bilingual("Not executed", "未执行")}</p></article>
        <article class="catalog" data-report-slot="cleanup-summary"><h3>${bilingual("Cleanup summary", "清理摘要")}</h3><p>${bilingual("Not executed", "未执行")}</p></article>`;
      }
      return `<section id="${id}" aria-labelledby="${id}-title" data-report-section="${id}">
        <p class="eyebrow">${bilingual(english, chinese)}</p>
        <h2 id="${id}-title">${bilingual("Not executed", "未执行")}</h2>
        <div class="placeholder">${bilingual("Populate from verified evidence when generating a release report.", "生成发布报告时从已验证证据中填充。")}</div>
${sectionSlots ? `        ${sectionSlots}\n` : ""}      </section>`;
    }
  ).join("\n  ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Meshrix Upstream Service Publishing Report Template</title>
  <style>
    :root { color: #17231d; background: #e4e8e3; font: 15px/1.6 system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { max-width: 1120px; margin: 24px auto; overflow-x: hidden; overflow-y: auto; background: #f3f4ef; border: 1px solid #d5ddd6; }
    header, section { padding: 42px clamp(24px, 7vw, 76px); border-bottom: 1px solid #d9e0da; }
    section { content-visibility: auto; contain-intrinsic-size: auto 560px; }
    header { background: #17231d; color: white; }
    h1 { margin: .15em 0; font-size: clamp(2.3rem, 6vw, 4.8rem); line-height: 1; }
    h2, h3 { margin: .2em 0 .7em; }
    .eyebrow { color: #176547; font-size: .75rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .status, .placeholder, .catalog { padding: 16px; border: 1px solid #bcc8bf; border-radius: 12px; background: white; }
    .status { display: inline-block; color: #6044a8; font-weight: 800; }
    .catalog { margin-top: 16px; }
    .report-navigation { display: flex; gap: 8px; padding: 14px 20px; overflow-x: auto; background: white; border-bottom: 1px solid #d9e0da; }
    .report-navigation a { flex: 0 0 auto; color: #176547; font-size: .78rem; font-weight: 750; }
    .skip-link { position: fixed; top: 12px; left: 12px; z-index: 30; padding: 8px 12px; background: white; color: #17231d; transform: translateY(-180%); }
    .skip-link:focus { transform: translateY(0); }
    .table-shell { width: 100%; overflow-x: auto; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; }
    th, td { padding: 11px 12px; border: 1px solid #d9e0da; text-align: left; vertical-align: top; }
    th { color: #657269; background: #f8faf7; font-size: .72rem; text-transform: uppercase; }
    .language-switch { position: fixed; top: 12px; right: 12px; display: flex; gap: 4px; padding: 4px; border-radius: 999px; background: #17231dea; }
    button { padding: 7px 11px; border: 0; border-radius: 999px; background: transparent; color: white; cursor: pointer; }
    button[aria-pressed="true"] { background: white; color: #17231d; }
    @media (max-width: 700px) { body { margin: 0; border: 0; } header, section { padding-inline: 20px; } }
    @media print { body { margin: 0; border: 0; } .language-switch, .report-navigation, .skip-link { display: none; } section { break-inside: avoid; content-visibility: visible; contain-intrinsic-size: auto; } }
  </style>
</head>
<body data-report-template="upstream-service-publishing" data-report-portability="single-file">
  <a class="skip-link" href="#report-content">${bilingual("Skip to report content", "跳到报告内容")}</a>
  <nav class="language-switch" aria-label="Language / 语言">
    <button type="button" data-language="zh-CN" aria-pressed="false">中文</button>
    <button type="button" data-language="en" aria-pressed="true">English</button>
  </nav>
  <header>
    <p>${bilingual("Portable single-file structural template — not release evidence", "可携带的单文件结构模板——不是发布证据")}</p>
    <h1>${bilingual("Upstream Service Publishing", "上游服务发布")}</h1>
    <p class="status">${bilingual("Not executed", "未执行")}</p>
    <p>${bilingual("Generated reports embed every verified image and downloadable attachment; no neighboring resource files are required.", "生成的报告会内嵌每一张已验证图片及可下载附件，无需任何同目录资源文件。")}</p>
    <p>${bilingual("Live Console screenshots are captured at a 1440 × 1000 CSS viewport with 2× device scale, producing 2880 × 2000 PNG evidence.", "实时管控台截图采用 1440 × 1000 CSS 视口及 2× 设备缩放，生成 2880 × 2000 PNG 证据。")}</p>
  </header>
  ${renderReportNavigation()}
  <main id="report-content" tabindex="-1">
  ${sections}
  </main>
  <script>
    (() => {
      const buttons = Array.from(document.querySelectorAll("[data-language]"));
      const nodes = Array.from(document.querySelectorAll("[data-en][data-zh]"));
      const applyLanguage = (requested) => {
        const language = requested === "zh-CN" ? "zh-CN" : "en";
        document.documentElement.lang = language;
        for (const node of nodes) node.textContent = language === "zh-CN" ? node.dataset.zh : node.dataset.en;
        for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.language === language));
      };
      for (const button of buttons) button.addEventListener("click", () => applyLanguage(button.dataset.language));
      applyLanguage(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
    })();
  </script>
</body>
</html>
`;
}

function bilingual(english?: any, chinese?: any) : any {
  return `<span data-en="${escapeHtml(english)}" data-zh="${escapeHtml(chinese)}">${escapeHtml(english)}</span>`;
}

function renderInterfaceCatalogRows(catalog?: any) : any {
  const healthRow: any = `<tr data-service-interface="health">
    <td><strong>${bilingual("Health check", "健康检查")}</strong><small>${bilingual("Runtime readiness", "运行时就绪状态")}</small></td>
    <td><code>GET ${escapeHtml(catalog.healthPath)}</code></td>
    <td>${bilingual("No upload body", "无上传请求体")}</td>
    <td>${bilingual("Readiness response", "就绪状态响应")}</td>
    <td>${bilingual("Forwarded through the Meshrix gateway runtime health path", "通过 Meshrix 网关运行时健康路径转发")}</td>
  </tr>`;
  const operationRows: any = catalog.operations.map((operation?: any) : any => `<tr data-service-interface="${escapeHtml(operation.operationKey)}">
    <td><strong>${escapeHtml(operation.operationKey)}</strong><small>${bilingual(operation.approvalRequired ? "Approval-gated conversion" : "Immediate governed conversion", operation.approvalRequired ? "需审批的格式转换" : "立即执行但仍受治理的格式转换")}</small></td>
    <td><code>${escapeHtml(operation.method)} ${escapeHtml(operation.path)}</code></td>
    <td><code>${escapeHtml(operation.requestMode)} · ${escapeHtml(operation.requestMediaTypes.join(", "))}</code><small>${bilingual(`Required file; optional targetFormat; external file budget ${catalog.externalFileBudgetBytes} B; request envelope ${operation.requestMaxBytes} B`, `必填 file；可选 targetFormat；外部文件预算 ${catalog.externalFileBudgetBytes} B；请求封装上限 ${operation.requestMaxBytes} B`)}</small></td>
    <td><code>${escapeHtml(operation.responseMode)} · ${escapeHtml(operation.responseMediaTypes.join(", "))}</code><small>${bilingual(`Artifact response; byte ranges enabled; maximum ${operation.responseMaxBytes} B`, `制品响应；支持字节范围；上限 ${operation.responseMaxBytes} B`)}</small></td>
    <td><code>${escapeHtml(operation.requiredScopes.join(", "))} · ${escapeHtml(operation.risk)} · ${escapeHtml(operation.timeoutMs)} ms</code><small>${bilingual(operation.approvalRequired ? "Request approval required; forwarded through the governed Meshrix gateway" : "No approval wait; Grant, scope, risk, owner, permit, and audit checks remain enforced by the Meshrix gateway", operation.approvalRequired ? "需要请求级审批；通过受治理的 Meshrix 网关转发" : "无需等待审批；Meshrix 网关仍执行 Grant、权限域、风险、所有者、许可与审计检查")}</small></td>
  </tr>`).join("");
  return `${healthRow}${operationRows}`;
}

function renderEmbeddedVisualEvidenceSource({ item, visualEvidenceFiles }: Record<string, any>) : any {
  const relativeScreenshotPath: any = item.file.slice(VISUAL_EVIDENCE_FILE_PREFIX.length);
  const sourceBytes: any = visualEvidenceFiles instanceof Map
    ? visualEvidenceFiles.get(item.file)
    : undefined;
  const bytes: any = Buffer.isBuffer(sourceBytes)
    ? sourceBytes
    : sourceBytes instanceof Uint8Array
      ? Buffer.from(sourceBytes)
      : null;
  const dimensions: any = readPngDimensions(bytes);
  if (
    !item.file.startsWith(VISUAL_EVIDENCE_FILE_PREFIX)
    || !/^[a-z0-9][a-z0-9-]*\.png$/u.test(relativeScreenshotPath)
    || bytes === null
    || bytes.byteLength !== item.byteLength
    || dimensions?.width !== item.pixelWidth
    || dimensions?.height !== item.pixelHeight
    || createHash("sha256").update(bytes).digest("hex") !== item.sha256
  ) {
    const error: Error & Record<string, any> = new Error("The embedded release journey visual evidence is invalid.");
    error.code = "upstream_service_publishing_html_embedded_visual_evidence_invalid";
    throw error;
  }
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function readVerifiedUpstreamServiceInterfaces({ journeyReport, sourceText }: Record<string, any>) : any {
  const sourceBinding: any = journeyReport?.configuration?.upstreamServiceBasicConfig;
  if (
    typeof sourceText !== "string"
    || Buffer.byteLength(sourceText, "utf8") !== sourceBinding?.byteLength
    || createHash("sha256").update(sourceText).digest("hex") !== sourceBinding?.sha256
  ) {
    throw interfaceCatalogError();
  }

  let sourceDocument: any;
  try {
    sourceDocument = JSON.parse(sourceText);
  } catch {
    throw interfaceCatalogError();
  }

  const descriptor: any = sourceDocument?.descriptor;
  const connectorOperations: any = journeyReport?.configuration?.connector?.operations;
  const expectedOperations: any = new Map<any, any>([
    [connectorOperations?.requireApproval, true],
    [connectorOperations?.fullAccess, false]
  ]);
  if (
    !isSafeInterfacePath(descriptor?.healthPath)
    || !Array.isArray(descriptor?.operations)
    || descriptor.operations.length !== expectedOperations.size
    || expectedOperations.size !== 2
  ) {
    throw interfaceCatalogError();
  }

  const operations: any = descriptor.operations.map((operation?: any) : any => {
    const approvalRequired: any = operation?.requiresApproval === true
      || operation?.requiredApproval?.required === true;
    const request: any = operation?.payloadTransport?.request;
    const response: any = operation?.payloadTransport?.response;
    const filePart: any = request?.multipart?.artifactParts?.find(
      (part?: any) : any => part?.argument === "file" && part?.partName === "file"
    );
    const targetFormatField: any = request?.multipart?.scalarFields?.find(
      (field?: any) : any => field?.argument === "targetFormat" && field?.partName === "targetFormat"
    );
    if (
      expectedOperations.get(operation?.operationKey) !== approvalRequired
      || !/^(?:GET|POST|PUT|PATCH|DELETE)$/u.test(operation?.method || "")
      || !isSafeInterfacePath(operation?.path)
      || operation.path !== connectorOperations?.upstreamPath
      || request?.mode !== "artifact_multipart"
      || !Array.isArray(request?.mediaTypes)
      || !request.mediaTypes.includes("multipart/form-data")
      || filePart?.required !== true
      || targetFormatField?.required !== false
      || !Number.isSafeInteger(request?.maxBytes)
      || request.maxBytes !== journeyReport.configuration.upload.multipartRequestMaxBytes
      || response?.mode !== "artifact"
      || !Array.isArray(response?.mediaTypes)
      || !response.mediaTypes.includes("application/pdf")
      || !response.mediaTypes.includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
      || response?.allowRanges !== true
      || !Number.isSafeInteger(response?.maxBytes)
      || response.maxBytes <= 0
      || !Array.isArray(operation?.requiredScopes)
      || !operation.requiredScopes.includes("gateway:write")
      || operation?.risk !== "safe_write"
      || !Number.isSafeInteger(operation?.timeoutMs)
      || operation.timeoutMs <= 0
    ) {
      throw interfaceCatalogError();
    }
    return Object.freeze({
      operationKey: operation.operationKey,
      method: operation.method,
      path: operation.path,
      approvalRequired,
      requestMode: request.mode,
      requestMediaTypes: Object.freeze([...request.mediaTypes]),
      requestMaxBytes: request.maxBytes,
      responseMode: response.mode,
      responseMediaTypes: Object.freeze([...response.mediaTypes]),
      responseMaxBytes: response.maxBytes,
      allowRanges: response.allowRanges,
      requiredScopes: Object.freeze([...operation.requiredScopes]),
      risk: operation.risk,
      timeoutMs: operation.timeoutMs
    });
  });

  if (new Set<any>(operations.map((operation?: any) : any => operation.operationKey)).size !== 2) {
    throw interfaceCatalogError();
  }
  return Object.freeze({
    healthPath: descriptor.healthPath,
    externalFileBudgetBytes: journeyReport.configuration.upload.externalFileBudgetBytes,
    operations: Object.freeze(operations)
  });
}

function isSafeInterfacePath(value?: any) : any {
  return typeof value === "string"
    && value.length > 1
    && value.length <= 256
    && /^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]*$/u.test(value);
}

function interfaceCatalogError() : any {
  const error: Error & Record<string, any> = new Error(
    "The published upstream service interface catalog is not bound to the verified configuration."
  );
  error.code = "upstream_service_publishing_html_interface_catalog_invalid";
  return error;
}

function escapeHtml(value?: any) : any {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
