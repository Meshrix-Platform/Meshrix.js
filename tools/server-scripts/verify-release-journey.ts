#!/usr/bin/env node
// verify-release-journey.ts — Mandatory release journey gate.
//
// Re-runs the v0.1.0-alpha release-defining scenario deterministically on
// every release: every detected supported local MCP client installs the
// Meshrix.js MCP connector, publishes the containerized file-parser/format-convert upstream
// service, uploads a tracked Chinese UTF-8 fixture through the native
// authenticated upload-session byte stream, converts it through the governed
// gateway via an owner-bound upload: artifact reference, and downloads the resulting
// resource_link URL. The MCP steps run over the real connector stdio proxy —
// the identical transport an MCP client uses; no LLM client is required.
//
// Flags:
//   --plan                  Print the step list without executing anything.
//   --keep-stack            Leave the compose stack running (debug).
//   --port N                Pin the host port (must be free).
//   --adapter-source PATH   Directory or .tgz with the client adapters
//                           or MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE).
//   --image-name NAME       operator-supplied format-convert image.
//   --json                  Also print the final report JSON to stdout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONVERTER_IMAGE,
  RELEASE_JOURNEY_COMPOSE_PROJECT,
  RELEASE_JOURNEY_CONVERTER_CONTAINER,
  RELEASE_JOURNEY_SERVER_CONTAINER,
  RELEASE_JOURNEY_SERVER_IMAGE,
  RELEASE_JOURNEY_SAFE_START_CONFIGURATION,
  RELEASE_JOURNEY_STACK_UP_ARGS,
  assertDockerAvailable,
  chooseHostPort,
  composeEnv,
  dockerImageExists,
  runCompose,
  runDocker,
  waitForConverterReady,
  waitForHttpOk
} from "./lib/release-journey-compose.ts";
import {
  createConsoleClient,
  inspectPublishedUpstreamService,
  listOperationAudit,
  listPendingOperations,
  rotateOwnerPassword
} from "./lib/release-journey-console.ts";
import {
  discoverReleaseJourneyClients,
  seedClientAdapterCaches
} from "./lib/release-journey-adapter.ts";
import {
  createMatrixTargetEnvironment,
  installMatrixTargetWithApiKey,
  uninstallMatrixTarget
} from "./lib/release-journey-client-matrix.ts";
import {
  diagnoseArtifactGet,
  probeApiKeyUploadRequest,
  runMcpDeniedCall,
  runMcpApprovalRequest,
  runConnectorBinaryUpload,
  runConnectorFetch,
  runMcpJourney
} from "./lib/release-journey-mcp.ts";
import {
  RELEASE_JOURNEY_FIXTURE_BYTES,
  RELEASE_JOURNEY_FIXTURE_FILENAME,
  RELEASE_JOURNEY_FIXTURE_SHA256,
  RELEASE_JOURNEY_FIXTURE_TEXT
} from "./lib/release-journey-fixture.ts";
import { verifyConvertedPdf } from "./lib/release-journey-pdf.ts";
import {
  RELEASE_JOURNEY_REPORT_PATH,
  RELEASE_JOURNEY_STEPS,
  createRedaction,
  createReleaseJourneyReport,
  finalizeReleaseJourneyReport,
  stepReceipt
} from "./lib/release-journey-report.ts";
import {
  createReleaseJourneyVisualRecorder,
  validateReleaseJourneyVisualEvidence
} from "./lib/release-journey-visual-evidence.ts";
import {
  UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH
} from "./lib/upstream-service-publishing-evidence.ts";
import { MCP_SUPPORTED_TARGETS } from "../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts";
import {
  UPSTREAM_SERVICE_BASIC_CONFIG_JSON_PATH,
  UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH,
  renderUpstreamServicePublishingHtml
} from "./lib/upstream-service-publishing-html.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, RELEASE_JOURNEY_REPORT_PATH);
const coreReportPath: any = path.join(repoRoot, UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH);
const htmlReportPath: any = path.join(repoRoot, UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH);
const basicConfigReportPath: any = path.join(repoRoot, UPSTREAM_SERVICE_BASIC_CONFIG_JSON_PATH);
const connectorScript: any = path.join(repoRoot, "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts");
const binaryUploadChildScript: any = path.join(repoRoot, "tools/server-scripts/lib/release-journey-binary-upload-child.ts");
const descriptorPath: any = path.join(repoRoot, "docs/examples/file-parser-format-convert.upstream.json");
const releaseDefinitionPath: any = path.join(
  repoRoot,
  "tools/registry/release-definition.registry.json"
);
const execFileAsync: any = promisify(execFile);

const API_KEY_TOOLSETS: any = "meshrix.gateway.write,meshrix.storage.read,meshrix.storage.write,meshrix.uploads.write";
const API_KEY_SCOPES: any = "gateway:read,gateway:write,storage:read,storage:write,uploads:write";
const API_KEY_MAX_RISK: any = "safe_write";
const APPROVAL_OPERATION_KEY: any = "convert-require-approval-debug";
const IMMEDIATE_OPERATION_KEY: any = "convert-full-access-debug";

function usage() : any {
  process.stdout.write(`Usage: node tools/server-scripts/verify-release-journey.ts [options]

  --plan                 Print the gate step list and exit.
  --keep-stack           Leave the compose stack running for debugging.
  --port N               Pin the loopback host port for the server.
  --adapter-source PATH  Client adapter package source (dir or .tgz).
  --image-name NAME      format-convert image (default ${DEFAULT_CONVERTER_IMAGE}).
  --json                 Print the final report JSON to stdout.
`);
}

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = { plan: false, keepStack: false, port: 0, adapterSource: "", imageName: DEFAULT_CONVERTER_IMAGE, json: false };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (arg === "--plan") options.plan = true;
    else if (arg === "--keep-stack") options.keepStack = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--port") options.port = Number(argv[++index] || 0) || 0;
    else if (arg === "--adapter-source") options.adapterSource = String(argv[++index] || "");
    else if (arg === "--image-name") options.imageName = String(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      const error: Error & Record<string, any> = new Error(`Unknown argument: ${arg}`);
      error.code = "release_journey_argument_invalid";
      throw error;
    }
  }
  return options;
}

async function readVisualEvidenceFiles(root?: any, visualEvidence?: any) : Promise<any> {
  return new Map<any, any>(await Promise.all(visualEvidence.map(async (item?: any) : Promise<any> => {
    if (
      typeof item?.file !== "string"
      || !/^build\/reports\/upstream-service-publishing\/screenshots\/[a-z0-9][a-z0-9-]*\.png$/u
        .test(item.file)
    ) {
      const error: Error & Record<string, any> = new Error("The release journey contains an unsafe screenshot path.");
      error.code = "release_journey_visual_evidence_path_invalid";
      throw error;
    }
    return [item.file, await fs.readFile(path.join(root, item.file))];
  })));
}

async function createCandidateProjection() : Promise<any> {
  const [releaseDefinitionText, commitResult, treeResult] = await Promise.all([
    fs.readFile(releaseDefinitionPath, "utf8"),
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }),
    execFileAsync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    })
  ]);
  const releaseDefinition: any = JSON.parse(releaseDefinitionText);
  const releaseDefinitionSha256: any =
    `sha256:${createHash("sha256").update(releaseDefinitionText).digest("hex")}`;
  const sourceCommit: any = commitResult.stdout.trim();
  const sourceTree: any = treeResult.stdout.trim();
  const candidate: Record<string, any> = {
    releaseTag: String(releaseDefinition?.release?.tag || ""),
    releaseVersion: String(releaseDefinition?.release?.version || ""),
    releaseDefinitionVersion: String(releaseDefinition?.version || ""),
    sourceCommit,
    sourceTree,
    releaseDefinitionSha256
  };
  return {
    candidate,
    projection: {
      claim: "upstream-publishing-prepublication-passed",
      release: {
        version: candidate.releaseVersion,
        tag: candidate.releaseTag,
        definitionVersion: candidate.releaseDefinitionVersion,
        definitionSha256: candidate.releaseDefinitionSha256
      },
      source: {
        commit: sourceCommit,
        tree: sourceTree
      }
    }
  };
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  if (options.plan) {
    process.stdout.write(`${JSON.stringify({ ok: true, schemaVersion: "v0.0.1:report:release-journey-1", plan: RELEASE_JOURNEY_STEPS }, null, 2)}\n`);
    return;
  }

  const candidateContext: any = await createCandidateProjection();
  const redaction: any = createRedaction({ repoRoot });
  const report: any = createReleaseJourneyReport({});
  report.candidate = candidateContext.candidate;
  const { addNeedle, redact, assertNoLeak } = redaction;
  const workDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-journey-"));
  const adapterCacheRoot: any = path.join(workDir, "adapter-cache");
  const fetchOutputPath: any = path.join(workDir, "output.pdf");
  await fs.rm(htmlReportPath, { force: true });
  let visualRecorder: any = null;

  let hostPort: any = 0;
  let stackStarted: any = false;
  let currentStep: any = "preflight";
  const targetEnvs: any = new Map<any, any>();
  const installedTargets: any[] = [];

  async function recordStep(id?: any, fn?: any) : Promise<any> {
    currentStep = id;
    const started: any = Date.now();
    try {
      const receipt: any = await fn();
      report.steps.push(stepReceipt(id, { status: "passed", durationMs: Date.now() - started, receipt }));
      return receipt;
    } catch (error: any) {
      error.message = redact(error?.message || String(error));
      report.steps.push(stepReceipt(id, { status: "failed", durationMs: Date.now() - started, error }));
      report.failure = { step: id, code: String(error?.code || "release_journey_failed"), message: String(error.message).slice(-800) };
      throw error;
    }
  }

  async function cleanup() : Promise<any> {
    report.cleanup.startedAt = new Date().toISOString();
    const details: any = report.cleanup.details;
    for (const target of installedTargets) {
      const started: any = Date.now();
      try {
        const result: any = await uninstallMatrixTarget({
          connectorScript,
          target,
          env: targetEnvs.get(target),
          adapterCacheRoot,
          redact
        });
        details.push({
          id: `connector-uninstall:${target}`,
          status: result.ok ? "passed" : "failed",
          durationMs: Date.now() - started,
          error: result.ok ? "" : redact(String(result.detail || "uninstall failed")).slice(-400)
        });
        const matrixRow: any = report.clientAcceptanceMatrix?.find(
          (row?: any) : any => row.adapterTarget === target
        );
        if (matrixRow) matrixRow.uninstall = result.ok ? "passed" : "failed";
      } catch (error: any) {
        details.push({
          id: `connector-uninstall:${target}`,
          status: "failed",
          durationMs: Date.now() - started,
          error: redact(error?.message || String(error)).slice(-300)
        });
        const matrixRow: any = report.clientAcceptanceMatrix?.find(
          (row?: any) : any => row.adapterTarget === target
        );
        if (matrixRow) matrixRow.uninstall = "failed";
      }
    }
    if (stackStarted && !options.keepStack) {
      const started: any = Date.now();
      try {
        await runCompose(["--profile", "format-convert", "down", "-v"], {
          cwd: repoRoot,
          env: composeEnv({ hostPort, converterImage: options.imageName }),
          redact,
          allowFailure: true
        });
        details.push({ id: "compose-down", status: "passed", durationMs: Date.now() - started });
      } catch (error: any) {
        details.push({ id: "compose-down", status: "failed", durationMs: Date.now() - started, error: redact(error?.message || String(error)).slice(-300) });
      }
      const imageStarted: any = Date.now();
      try {
        await runDocker(["image", "rm", "-f", RELEASE_JOURNEY_SERVER_IMAGE], { redact, allowFailure: true });
        details.push({ id: "server-image-remove", status: "passed", durationMs: Date.now() - imageStarted });
      } catch (error: any) {
        details.push({ id: "server-image-remove", status: "failed", durationMs: Date.now() - imageStarted, error: redact(error?.message || String(error)).slice(-300) });
      }
    }
    if (options.keepStack) {
      details.push({ id: "compose-down", status: "skipped", note: "--keep-stack requested" });
    }
    const tempStarted: any = Date.now();
    try {
      await fs.rm(workDir, { recursive: true, force: true });
      details.push({ id: "temp-workdir", status: "passed", durationMs: Date.now() - tempStarted });
    } catch (error: any) {
      details.push({ id: "temp-workdir", status: "failed", durationMs: Date.now() - tempStarted, error: redact(error?.message || String(error)).slice(-300) });
    }
    report.cleanup.performed = true;
    report.cleanup.finishedAt = new Date().toISOString();
    report.cleanup.durationMs = details.reduce(
      (total?: any, detail?: any) : any =>
        total + (Number.isSafeInteger(detail?.durationMs) ? detail.durationMs : 0),
      0
    );
    const cleanupPassed: any = details.every((detail?: any) : any => detail?.status === "passed");
    for (const row of report.clientAcceptanceMatrix || []) {
      row.cleanup = cleanupPassed && row.uninstall === "passed"
        ? "passed"
        : "failed";
    }
    report.finishedAt = report.cleanup.finishedAt;
  }

  let publishReceipt: any = null;
  let journeyResult: any = null;
  let provisionedApiKey: any = null;
  let apiKeyBoundaryReceipt: any = null;
  let detectedClients: any[] = [];
  const uploadsByTarget: any = new Map<any, any>();
  const matrixJourneys: any = new Map<any, any>();
  try {
    await recordStep("preflight", async () : Promise<any> => {
      const engineVersion: any = await assertDockerAvailable();
      await fs.access(descriptorPath);
      await fs.access(connectorScript);
      await fs.access(binaryUploadChildScript);
      const ignoreRules: any = await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8");
      if (!ignoreRules.split(/\r?\n/u).some((line?: any) : any => line.trim() === "/build/")) {
        const error: Error & Record<string, any> = new Error("The local report root must remain ignored by Git.");
        error.code = "release_journey_build_ignore_missing";
        throw error;
      }
      const fixtureDigest: any = createHash("sha256").update(RELEASE_JOURNEY_FIXTURE_BYTES).digest("hex");
      if (fixtureDigest !== RELEASE_JOURNEY_FIXTURE_SHA256) {
        const error: Error & Record<string, any> = new Error("The tracked release journey fixture does not match its pinned sha256.");
        error.code = "release_journey_fixture_drift";
        throw error;
      }
      hostPort = await chooseHostPort({ explicitPort: options.port });
      report.environment = {
        dockerServerVersion: engineVersion,
        composeProject: RELEASE_JOURNEY_COMPOSE_PROJECT,
        serverImage: RELEASE_JOURNEY_SERVER_IMAGE,
        converterImage: options.imageName,
        converterContainer: RELEASE_JOURNEY_CONVERTER_CONTAINER,
        serverContainer: RELEASE_JOURNEY_SERVER_CONTAINER,
        identityStoreMode: "file (isolated temporary HOME; no OS credential backend, no user client configuration)"
      };
      report.configuration = {
        startup: RELEASE_JOURNEY_SAFE_START_CONFIGURATION,
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
        connector: {
          transport: "stdio",
          targetSelection: "pending-local-client-discovery",
          validationMode: "pending",
          fallback: {
            used: false,
            reason: "",
            catalogScanComplete: false
          },
          targetCatalog: [],
          toolsets: API_KEY_TOOLSETS.split(","),
          scopes: API_KEY_SCOPES.split(","),
          maxRisk: API_KEY_MAX_RISK,
          operations: {
            requireApproval: APPROVAL_OPERATION_KEY,
            fullAccess: IMMEDIATE_OPERATION_KEY,
            upstreamPath: "/v1/convert",
            fullAccessStillGoverned: true
          }
        }
      };
      report.artifactPolicy = {
        storage: "local-build-only",
        cloudUploadAllowed: false,
        gitIgnored: true,
        screenshotMasking: "protected-values-only"
      };
      visualRecorder = await createReleaseJourneyVisualRecorder({
        repoRoot,
        baseUrl: `http://127.0.0.1:${hostPort}`
      });
      return { dockerServerVersion: engineVersion, hostPort };
    });

    await recordStep("stack-build-up", async () : Promise<any> => {
      const env: any = composeEnv({ hostPort, converterImage: options.imageName });
      if (!dockerImageExists(options.imageName)) {
        const error: Error & Record<string, any> = new Error(
          `Operator-supplied format-convert image ${options.imageName} is unavailable. Pass --image-name with a locally present image.`
        );
        error.code = "release_journey_image_missing";
        throw error;
      }
      await runCompose(["--profile", "format-convert", "build", "meshrix-server"], { cwd: repoRoot, env, redact });
      await runCompose(RELEASE_JOURNEY_STACK_UP_ARGS, { cwd: repoRoot, env, redact });
      stackStarted = true;
      const baseUrl: any = `http://127.0.0.1:${hostPort}`;
      await waitForHttpOk(`${baseUrl}/api/healthz`, { timeoutMs: 180000 });
      await waitForConverterReady({ containerName: RELEASE_JOURNEY_CONVERTER_CONTAINER, env });
      return { serverHealth: "ok", converterReady: true };
    });

    const baseUrl: any = `http://127.0.0.1:${hostPort}`;
    const consoleClient: any = createConsoleClient({ baseUrl, addNeedle });

    await recordStep("admin-bootstrap", async () : Promise<any> => {
      const password: any = await rotateOwnerPassword({
        containerName: RELEASE_JOURNEY_SERVER_CONTAINER,
        env: composeEnv({ hostPort, converterImage: options.imageName }),
        redact
      });
      addNeedle(password);
      const session: any = await consoleClient.login({ username: "owner", password });
      await visualRecorder.login({ username: "owner", password });
      const organization: any = await visualRecorder.configureOrganizationGovernance();
      runDocker(["restart", RELEASE_JOURNEY_SERVER_CONTAINER], {
        env: composeEnv({ hostPort, converterImage: options.imageName }),
        redact
      });
      await waitForHttpOk(`${baseUrl}/api/healthz`, { timeoutMs: 120_000 });
      const reloadedSession: any = await consoleClient.login({ username: "owner", password });
      if (!reloadedSession.runtimeAdministrationAuthorized) {
        throw Object.assign(
          new Error("Organization governance publication removed the Console owner administration scope."),
          { code: "release_journey_owner_runtime_scope_lost" }
        );
      }
      await visualRecorder.ensureAuthenticated({ username: "owner", password });
      return {
        consoleUser: session.username,
        roleId: session.roleId,
        organization,
        runtimeAdministrationAuthorized: true,
        apiKeyRecoveryAuthorityReloaded: true
      };
    });

    publishReceipt = await recordStep("upstream-publish", async () : Promise<any> => {
      const descriptorBytes: any = await fs.readFile(descriptorPath);
      const descriptorDocument: any = JSON.parse(descriptorBytes.toString("utf8"));
      await fs.mkdir(path.dirname(basicConfigReportPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(basicConfigReportPath, descriptorBytes, { mode: 0o600 });
      report.configuration.upstreamServiceBasicConfig = {
        file: UPSTREAM_SERVICE_BASIC_CONFIG_JSON_PATH,
        contentType: "application/json",
        source: "actual-publishing-input",
        byteLength: descriptorBytes.byteLength,
        sha256: createHash("sha256").update(descriptorBytes).digest("hex")
      };
      const published: any = await visualRecorder.loadAndPublishUpstreamService(descriptorDocument);
      const receipt: any = await inspectPublishedUpstreamService({
        consoleClient,
        serviceId: published.serviceId
      });
      await visualRecorder.capturePublishedTool(receipt.serviceId);
      report.configuration.connector.publishedCapabilities = [
        `cap:upstream:<generated-service-id>:${APPROVAL_OPERATION_KEY}`,
        `cap:upstream:<generated-service-id>:${IMMEDIATE_OPERATION_KEY}`
      ];
      report.configuration.connector.allowedService = "<generated-service-id>";
      return receipt;
    });

    await recordStep("adapter-seed", async () : Promise<any> => {
      const receipts: any = await seedClientAdapterCaches({
        repoRoot,
        adapterSource: options.adapterSource,
        cacheRoot: adapterCacheRoot
      });
      return {
        catalogTargetCount: receipts.length,
        descriptorCount: receipts.filter((receipt?: any) : any => receipt.descriptorOk).length,
        targets: receipts.map(({ target, coordinate, descriptorOk }: Record<string, any>) : any => ({
          target,
          coordinate,
          descriptorOk
        }))
      };
    });

    await recordStep("client-discovery", async () : Promise<any> => {
      const discovery: any = await discoverReleaseJourneyClients({
        cacheRoot: adapterCacheRoot,
        baseUrl
      });
      const fallbackUsed: any = discovery.detected.length === 0;
      detectedClients = fallbackUsed ? [discovery.fallback] : discovery.detected;
      report.configuration.connector.targetCatalog = discovery.report;
      report.configuration.connector.targetSelection = fallbackUsed
        ? "zero-detected-client-mcp-simulation"
        : "all-detected-supported-local-clients";
      report.configuration.connector.validationMode = fallbackUsed
        ? "simulated-fallback"
        : "real-local-clients";
      report.configuration.connector.fallback = {
        used: fallbackUsed,
        reason: fallbackUsed ? "no_supported_local_client_detected_after_complete_catalog_scan" : "",
        catalogScanComplete: discovery.report.length === MCP_SUPPORTED_TARGETS.length
      };
      for (const client of detectedClients) {
        targetEnvs.set(client.target, await createMatrixTargetEnvironment({
          workDir,
          target: client.target,
          adapterCacheRoot
        }));
      }
      return {
        catalogTargetCount: discovery.report.length,
        detectedTargetCount: discovery.detected.length,
        executionTargetCount: detectedClients.length,
        validationMode: report.configuration.connector.validationMode,
        fallbackUsed,
        targets: discovery.report
      };
    });

    await recordStep("api-key-workload", async () : Promise<any> => {
      const connectorTarget: any = detectedClients[0]?.target;
      if (!connectorTarget) {
        throw Object.assign(new Error("The API Key workload requires one detected downstream connector."), {
          code: "release_journey_api_key_connector_unavailable"
        });
      }
      provisionedApiKey = await visualRecorder.provisionApiKeyWorkload({
        serviceId: publishReceipt.serviceId,
        targetIds: detectedClients.map((client?: any) : any => client.target),
        operationKey: IMMEDIATE_OPERATION_KEY,
        toolsetIds: [
          "meshrix.gateway.write",
          "meshrix.storage.read",
          "meshrix.storage.write",
          "meshrix.uploads.write",
          `upstream:${publishReceipt.serviceId}`
        ]
      });
      addNeedle(provisionedApiKey.apiKey);
      const missingCredential: any = await probeApiKeyUploadRequest({
        baseUrl,
        target: connectorTarget,
        env: {
          ...targetEnvs.get(connectorTarget),
          MESHRIX_MCP_TOKEN: ""
        }
      });
      if (missingCredential.status !== 0 || !/missing.*credential/iu.test(missingCredential.code)) {
        throw Object.assign(new Error("A connector without credentials was not denied before discovery or use."), {
          code: "release_journey_api_key_missing_credential_not_denied"
        });
      }
      for (const client of detectedClients) {
        targetEnvs.set(client.target, Object.freeze({
          ...targetEnvs.get(client.target),
          MESHRIX_MCP_TOKEN: provisionedApiKey.apiKey
        }));
      }
      const ambiguous: any = await probeApiKeyUploadRequest({
        baseUrl,
        target: connectorTarget,
        env: targetEnvs.get(connectorTarget),
        ambiguousCredential: true
      });
      if (ambiguous.status !== 400 || ambiguous.code !== "mcp_credential_ambiguous") {
        throw Object.assign(new Error("Ambiguous API key credentials were not rejected before upload admission."), {
          code: "release_journey_api_key_ambiguous_not_denied"
        });
      }

      return {
        organization: provisionedApiKey.organization,
        credential: {
          kind: "scoped_api_key",
          plaintextArtifactWritten: false,
          childTransfer: "environment-only",
          grantSynthesized: false
        },
        connectorTargets: detectedClients.length,
        missingCredentialDeniedBeforeUse: true,
        ambiguousCredential: ambiguous.status
      };
    });

    await recordStep("connector-install-matrix", async () : Promise<any> => {
      const installed: any[] = [];
      for (const client of detectedClients) {
        const result: any = await installMatrixTargetWithApiKey({
          connectorScript,
          target: client.target,
          clientCommand: client.command,
          baseUrl,
          adapterCacheRoot,
          env: targetEnvs.get(client.target),
          redact
        });
        installedTargets.push(result.target);
        installed.push(result);
      }
      await visualRecorder.captureDownstreamAgentConfigured({ installedCount: installed.length });
      return {
        requiredCount: detectedClients.length,
        passedCount: installed.length,
        credentialSource: "pre-issued-api-key",
        deviceAuthorizationStarted: false,
        targets: installed
      };
    });

    await recordStep("binary-upload-matrix", async () : Promise<any> => {
      const rows: any[] = [];
      for (const client of detectedClients) {
        const upload: any = await runConnectorBinaryUpload({
          childScript: binaryUploadChildScript,
          target: client.target,
          baseUrl,
          fixtureBytes: RELEASE_JOURNEY_FIXTURE_BYTES,
          fixtureFileName: RELEASE_JOURNEY_FIXTURE_FILENAME,
          addNeedle,
          env: targetEnvs.get(client.target)
        });
        uploadsByTarget.set(client.target, upload);
        rows.push({ target: client.target, status: "passed", ...upload.receipt });
      }
      const connectorTarget: any = detectedClients[0].target;
      const apiUpload: any = uploadsByTarget.get(connectorTarget);
      const siblingProvisioned: any = await visualRecorder.provisionApiKeyWorkload({
        serviceId: publishReceipt.serviceId,
        targetIds: [connectorTarget],
        operationKey: IMMEDIATE_OPERATION_KEY,
        organizationNodeId: "organization:secondary",
        workloadName: "Release journey sibling isolation probe",
        toolsetIds: ["meshrix.uploads.write"],
        requestsPerMinute: 4
      });
      addNeedle(siblingProvisioned.apiKey);
      if (
        provisionedApiKey.record.organizationNodeId !== "group:team"
        || siblingProvisioned.record.organizationNodeId !== "organization:secondary"
        || siblingProvisioned.record.organizationNodeId === provisionedApiKey.record.organizationNodeId
      ) {
        throw Object.assign(new Error("Sibling API key credentials were not bound to distinct organization branches."), {
          code: "release_journey_api_key_sibling_scope_invalid"
        });
      }
      const siblingApiKeyEnv: any = Object.freeze({
        ...targetEnvs.get(connectorTarget),
        MESHRIX_MCP_TOKEN: siblingProvisioned.apiKey
      });
      const primarySessionId: any = String(apiUpload.reference).split(":")[1] || "";
      const siblingOrganization: any = await probeApiKeyUploadRequest({
        baseUrl,
        target: connectorTarget,
        env: siblingApiKeyEnv,
        method: "GET",
        pathname: `/api/upload-sessions/${encodeURIComponent(primarySessionId)}`
      });
      if (![403, 404].includes(siblingOrganization.status)) {
        const denialCode: any = String(siblingOrganization.code || "unknown").replace(/[^a-z0-9_]+/giu, "_").slice(0, 80);
        throw Object.assign(new Error("A sibling-organization API key accessed the primary organization session."), {
          code: `release_journey_api_key_sibling_organization_not_denied_http_${siblingOrganization.status}_${denialCode}`
        });
      }
      const siblingRevoked: any = await consoleClient.api(
        `/api/operation-permission/v1/api-keys/${encodeURIComponent(siblingProvisioned.record.keyId)}/revoke`,
        {
          method: "POST",
          body: {
            expectedLifecycleRevision: siblingProvisioned.record.lifecycleRevision,
            reasonCode: "isolation_probe_complete"
          },
          safetyConfirm: true
        }
      );
      if (!siblingRevoked.ok || siblingRevoked.payload?.record?.status !== "revoked") {
        throw Object.assign(new Error("Sibling isolation API key revocation did not complete."), {
          code: "release_journey_api_key_sibling_revoke_failed"
        });
      }
      apiKeyBoundaryReceipt = {
        siblingOrganizationCredential: siblingOrganization.status,
        siblingOrganizationDistinct: true
      };
      return {
        requiredCount: detectedClients.length,
        passedCount: rows.length,
        credentialKind: "scoped_api_key",
        siblingOrganizationDenial: apiKeyBoundaryReceipt,
        targets: rows
      };
    });

    await recordStep("mcp-acceptance-matrix", async () : Promise<any> => {
      const rows: any[] = [];
      for (const client of detectedClients) {
        const upload: any = uploadsByTarget.get(client.target);
        const immediate: any = await runMcpJourney({
          connectorScript,
          target: client.target,
          baseUrl,
          serviceId: publishReceipt.serviceId,
          fixtureBytes: RELEASE_JOURNEY_FIXTURE_BYTES,
          fixtureFileName: RELEASE_JOURNEY_FIXTURE_FILENAME,
          artifactReference: upload.reference,
          operationKey: IMMEDIATE_OPERATION_KEY,
          expectedCoreTools: ["meshrix.discovery"],
          expectedOperationKeys: [APPROVAL_OPERATION_KEY, IMMEDIATE_OPERATION_KEY],
          env: targetEnvs.get(client.target),
          redact
        });
        const approval: any = await runMcpApprovalRequest({
          connectorScript,
          target: client.target,
          baseUrl,
          serviceId: publishReceipt.serviceId,
          artifactReference: upload.reference,
          operationKey: APPROVAL_OPERATION_KEY,
          env: targetEnvs.get(client.target),
          redact
        });
        addNeedle(approval.pendingOperationId);
        matrixJourneys.set(client.target, { immediate, approval });
        if (!journeyResult) {
          journeyResult = {
            ...immediate.receipt,
            artifactId: immediate.artifactId,
            artifactUrl: immediate.artifactUrl,
            target: client.target
          };
        }
        rows.push({
          target: client.reportTarget || client.target,
          label: client.label,
          adapterTarget: client.target,
          validationMode: client.validationMode || "real-local-client",
          status: "passed",
          installed: true,
          upload: "passed",
          uninstall: "pending",
          cleanup: "pending",
          toolsList: "passed",
          fullAccessDebug: "completed",
          requireApprovalDebug: approval.status,
          immediateTool: immediate.receipt.convert.tool,
          approvalTool: approval.tool
        });
      }
      const disallowedTool: any = "system.health";
      const effectsBeforeDenial: any = await listOperationAudit(consoleClient, {
        toolId: disallowedTool,
        status: "ok"
      });
      const disallowed: any = await runMcpDeniedCall({
        connectorScript,
        target: detectedClients[0].target,
        baseUrl,
        toolName: disallowedTool,
        artifactReference: uploadsByTarget.get(detectedClients[0].target).reference,
        env: targetEnvs.get(detectedClients[0].target)
      });
      const effectsAfterDenial: any = await listOperationAudit(consoleClient, {
        toolId: disallowedTool,
        status: "ok"
      });
      if (!disallowed.denied || effectsAfterDenial.length !== effectsBeforeDenial.length) {
        throw Object.assign(new Error("A disallowed API Key operation reached the effect path."), {
          code: "release_journey_api_key_disallowed_effect_observed"
        });
      }
      report.clientAcceptanceMatrix = rows;
      return {
        requiredCount: detectedClients.length,
        passedCount: rows.length,
        credentialKind: "scoped_api_key",
        disallowedOperationDeniedBeforeEffects: true,
        targets: rows
      };
    });

    await recordStep("approval-branch", async () : Promise<any> => {
      const approvalTool: any = `upstream.${publishReceipt.serviceId}.${APPROVAL_OPERATION_KEY}`;
      const pendingOperations: any = await listPendingOperations(consoleClient);
      const expectedPendingIds: any = new Set<any>(
        [...matrixJourneys.values()].map((entry?: any) : any => entry.approval.pendingOperationId)
      );
      const visiblePendingIds: any = new Set<any>(
        pendingOperations.map((entry?: any) : any => String(entry.pendingOperationId || ""))
      );
      if (
        pendingOperations.filter((entry?: any) : any => entry.toolId === approvalTool).length !== detectedClients.length
        || [...expectedPendingIds].some((id?: any) : any => !visiblePendingIds.has(id))
      ) {
        const error: Error & Record<string, any> = new Error("Approval-required matrix operations are not all visible as pending.");
        error.code = "release_journey_approval_pending_matrix_incomplete";
        throw error;
      }
      const successfulBeforeApproval: any = await listOperationAudit(consoleClient, {
        toolId: approvalTool,
        status: "ok"
      });
      if (successfulBeforeApproval.length !== 0) {
        const error: Error & Record<string, any> = new Error("Approval-required operation reached the upstream path before approval.");
        error.code = "release_journey_approval_side_effect_before_approval";
        throw error;
      }
      await visualRecorder.approvePendingOperations({
        toolName: approvalTool,
        expectedCount: detectedClients.length
      });
      const deadline: any = Date.now() + 120_000;
      let successfulAfterApproval: any[] = [];
      while (Date.now() < deadline) {
        successfulAfterApproval = await listOperationAudit(consoleClient, {
          toolId: approvalTool,
          status: "ok"
        });
        if (successfulAfterApproval.length === detectedClients.length) break;
        await new Promise((resolve?: any) : any => setTimeout(resolve, 500));
      }
      if (successfulAfterApproval.length !== detectedClients.length) {
        const error: Error & Record<string, any> = new Error("Approved operations did not resume exactly once for every detected client.");
        error.code = "release_journey_approval_resume_count_mismatch";
        throw error;
      }
      await visualRecorder.captureCompletedOperations({
        toolName: approvalTool,
        expectedCount: detectedClients.length
      });
      const immediateTool: any = `upstream.${publishReceipt.serviceId}.${IMMEDIATE_OPERATION_KEY}`;
      const expectedBoundaryDenials: any = await listOperationAudit(consoleClient, {
        toolId: "meshrix.agentWorkspace.list",
        status: "denied"
      });
      if (expectedBoundaryDenials.length !== detectedClients.length) {
        const error: Error & Record<string, any> = new Error("The out-of-scope workspace discovery boundary was not enforced once per detected client.");
        error.code = "release_journey_workspace_boundary_count_mismatch";
        throw error;
      }
      await visualRecorder.captureDownstreamMcpCalls({
        toolNames: [approvalTool, immediateTool],
        minimumRowCount: detectedClients.length * 2
      });
      for (const row of report.clientAcceptanceMatrix) {
        row.requireApprovalDebug = "approved_and_completed_once";
      }
      return {
        requiredCount: detectedClients.length,
        pendingCount: expectedPendingIds.size,
        successfulBeforeApproval: 0,
        successfulAfterApproval: successfulAfterApproval.length,
        exactlyOnce: true,
        expectedOutOfScopeWorkspaceDenials: expectedBoundaryDenials.length
      };
    });

    await recordStep("artifact-fetch", async () : Promise<any> => {
      let result: any;
      try {
        result = await runConnectorFetch({
          connectorScript,
          target: journeyResult.target,
          artifactUrl: journeyResult.artifactUrl,
          outputPath: fetchOutputPath,
          env: targetEnvs.get(journeyResult.target)
        });
      } catch (error: any) {
        const diagnosis: any = await diagnoseArtifactGet({
          artifactUrl: journeyResult.artifactUrl,
          target: journeyResult.target,
          env: targetEnvs.get(journeyResult.target)
        });
        error.message = `${error.message} (signed GET diagnostic: status=${diagnosis.status} code=${diagnosis.code || "none"})`;
        throw error;
      }
      if (!result.sha256Matches) {
        const error: Error & Record<string, any> = new Error("Connector-reported sha256 does not match the downloaded bytes.");
        error.code = "release_journey_fetch_digest_mismatch";
        throw error;
      }
      if (result.byteLength !== journeyResult.convert.size) {
        const error: Error & Record<string, any> = new Error("Downloaded byte length does not match the resource_link size.");
        error.code = "release_journey_fetch_size_mismatch";
        throw error;
      }
      const revoked: any = await consoleClient.api(
        `/api/operation-permission/v1/api-keys/${encodeURIComponent(provisionedApiKey.record.keyId)}/revoke`,
        {
          method: "POST",
          body: {
            expectedLifecycleRevision: provisionedApiKey.record.lifecycleRevision,
            reasonCode: "administrator_revoked"
          },
          safetyConfirm: true
        }
      );
      if (!revoked.ok || revoked.payload?.record?.status !== "revoked") {
        throw Object.assign(new Error("API Key revocation did not complete."), {
          code: "release_journey_api_key_revoke_failed"
        });
      }
      const revokedUpload: any = await probeApiKeyUploadRequest({
        baseUrl,
        target: journeyResult.target,
        env: targetEnvs.get(journeyResult.target)
      });
      if (![401, 403, 410, 429].includes(revokedUpload.status)) {
        throw Object.assign(new Error("Revoked API Key still admitted a new upload request."), {
          code: "release_journey_api_key_revoked_upload_admitted"
        });
      }
      const revokedMcp: any = await runMcpDeniedCall({
        connectorScript,
        target: journeyResult.target,
        baseUrl,
        toolName: `upstream.${publishReceipt.serviceId}.${IMMEDIATE_OPERATION_KEY}`,
        artifactReference: uploadsByTarget.get(journeyResult.target).reference,
        env: targetEnvs.get(journeyResult.target)
      });
      const { bytes, ...rest } = result;
      return {
        ...rest,
        followedResourceLinkUrl: true,
        credentialKind: "scoped_api_key",
        siblingOrganizationDenial: apiKeyBoundaryReceipt,
        revokedUpload: revokedUpload.status,
        revokedMcp: revokedMcp.denied === true
      };
    });

    await recordStep("pdf-verify", async () : Promise<any> => {
      const pdfBytes: any = await fs.readFile(fetchOutputPath);
      const verification: any = verifyConvertedPdf(pdfBytes, RELEASE_JOURNEY_FIXTURE_TEXT, { requireFullHanCoverage: true });
      if (!verification.ok) {
        const error: Error & Record<string, any> = new Error(`PDF verification failed: ${JSON.stringify({
          magicOk: verification.magicOk,
          sizeOk: verification.sizeOk,
          notoCjkEmbedded: verification.notoCjkEmbedded,
          hanCodepointsMapped: verification.hanCodepointsMapped,
          hanCodepointsInSource: verification.hanCodepointsInSource,
          missing: verification.missingHanCodepoints
        })}`);
        error.code = "release_journey_pdf_invalid";
        throw error;
      }
      return verification;
    });
  } catch (error: any) {
    if (!report.failure) {
      report.failure = { step: currentStep, code: String(error?.code || "release_journey_failed"), message: redact(error?.message || String(error)).slice(-800) };
    }
  } finally {
    await visualRecorder?.close();
    await cleanup();
  }

  report.visualEvidence = [...(visualRecorder?.evidence || [])];
  report.visualDiagnostics = {
    browserFindings: [...(visualRecorder?.browserFindings || [])]
  };
  if (!report.failure) {
    try {
      await validateReleaseJourneyVisualEvidence({
        repoRoot,
        evidence: report.visualEvidence,
        browserFindings: visualRecorder?.browserFindings || []
      });
    } catch (error: any) {
      report.failure = {
        step: "visual-evidence",
        code: String(error?.code || "release_journey_visual_evidence_failed"),
        message: "Required live checkpoint screenshots are incomplete or invalid."
      };
    }
  }

  const finalized: any = finalizeReleaseJourneyReport(report, { assertNoLeak });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, finalized.serialized);
  if (finalized.report.releaseReady) {
    const [coreReportText, upstreamServiceBasicConfigText, visualEvidenceFiles] = await Promise.all([
      fs.readFile(coreReportPath, "utf8"),
      fs.readFile(basicConfigReportPath, "utf8"),
      readVisualEvidenceFiles(repoRoot, finalized.report.visualEvidence)
    ]);
    const coreReport: any = JSON.parse(coreReportText);
    await fs.writeFile(
      htmlReportPath,
      renderUpstreamServicePublishingHtml(
        coreReport,
        finalized.report,
        upstreamServiceBasicConfigText,
        visualEvidenceFiles,
        candidateContext.projection
      ),
      "utf8"
    );
  } else {
    await fs.writeFile(
      htmlReportPath,
      renderUpstreamServicePublishingHtml(
        null,
        finalized.report,
        "",
        new Map<any, any>(),
        null
      ),
      "utf8"
    );
  }
  if (options.json) {
    process.stdout.write(finalized.serialized);
  } else {
    const summary: any = finalized.report.steps.map((step?: any) : any => `${step.id}:${step.status}`).join(" ");
    process.stdout.write(`${JSON.stringify({ ok: finalized.report.releaseReady, report: RELEASE_JOURNEY_REPORT_PATH, steps: summary })}\n`);
  }
  if (!finalized.report.releaseReady) {
    process.exitCode = 1;
  }
}

main().catch((error?: any) : any => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "release_journey_failed", message: String(error?.message || error).slice(-800) })}\n`);
  process.exitCode = 1;
});
