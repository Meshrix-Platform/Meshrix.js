#!/usr/bin/env node
// verify-release-journey.mjs — Mandatory release journey gate.
//
// Re-runs the v0.1.0-alpha release-defining scenario deterministically on
// every release: an MCP client installs the Meshrix MCP connector (target
// kimi), publishes the containerized file-parser/format-convert upstream
// service, uploads a tracked Chinese UTF-8 fixture through the MCP surface,
// converts it through the governed gateway via a workspace: artifact
// reference, and downloads the resulting PDF by following the returned
// resource_link URL. The MCP steps run over the real connector stdio proxy —
// the identical transport an MCP client uses; no LLM client is required.
//
// Flags:
//   --plan                  Print the step list without executing anything.
//   --keep-stack            Leave the compose stack running (debug).
//   --port N                Pin the host port (must be free).
//   --adapter-source PATH   Directory or .tgz with the kimi client adapter
//                           (default: ../Meshrix-Plugins/plugins/agents/kimi,
//                           or MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE).
//   --image-name NAME       format-convert image (default: meshrix-format-convert:local).
//   --json                  Also print the final report JSON to stdout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONVERTER_IMAGE,
  DEFAULT_FORMAT_CONVERTER_BUILD_DIR,
  RELEASE_JOURNEY_COMPOSE_PROJECT,
  RELEASE_JOURNEY_CONVERTER_CONTAINER,
  RELEASE_JOURNEY_SERVER_CONTAINER,
  RELEASE_JOURNEY_SERVER_IMAGE,
  assertDockerAvailable,
  chooseHostPort,
  composeEnv,
  dockerImageExists,
  runCompose,
  runDocker,
  waitForConverterReady,
  waitForHttpOk
} from "./lib/release-journey-compose.mjs";
import {
  approveAuthorizationRequest,
  createConsoleClient,
  listPendingAuthorizationRequests,
  publishUpstreamService,
  rotateOwnerPassword
} from "./lib/release-journey-console.mjs";
import { resolveKimiClientCommand, seedClientAdapterCache } from "./lib/release-journey-adapter.mjs";
import { diagnoseArtifactGet, runConnectorFetch, runMcpJourney } from "./lib/release-journey-mcp.mjs";
import {
  RELEASE_JOURNEY_FIXTURE_BYTES,
  RELEASE_JOURNEY_FIXTURE_FILENAME,
  RELEASE_JOURNEY_FIXTURE_SHA256,
  RELEASE_JOURNEY_FIXTURE_TEXT
} from "./lib/release-journey-fixture.mjs";
import { verifyConvertedPdf } from "./lib/release-journey-pdf.mjs";
import {
  RELEASE_JOURNEY_REPORT_PATH,
  RELEASE_JOURNEY_STEPS,
  createRedaction,
  createReleaseJourneyReport,
  finalizeReleaseJourneyReport,
  stepReceipt
} from "./lib/release-journey-report.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(repoRoot, RELEASE_JOURNEY_REPORT_PATH);
const connectorScript = path.join(repoRoot, "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.mjs");
const descriptorPath = path.join(repoRoot, "docs/examples/file-parser-format-convert.upstream.json");

const GRANT_TOOLSETS = "meshrix.gateway.write,meshrix.storage.read,meshrix.storage.write,meshrix.agent.workspace,meshrix.jobs.read";
const GRANT_SCOPES = "gateway:write,storage:read,storage:write,workspace:write,workspace:read,jobs:read";
const GRANT_MAX_RISK = "safe_write";

const STEP_TIMEOUTS_MS = Object.freeze({
  preflight: 60_000,
  "stack-build-up": 30 * 60_000,
  "admin-bootstrap": 60_000,
  "upstream-publish": 120_000,
  "adapter-seed": 120_000,
  "connector-install": 10 * 60_000,
  "mcp-journey": 5 * 60_000,
  "artifact-fetch": 120_000,
  "pdf-verify": 60_000,
  cleanup: 120_000
});

function usage() {
  process.stdout.write(`Usage: node tools/server-scripts/verify-release-journey.mjs [options]

  --plan                 Print the gate step list and exit.
  --keep-stack           Leave the compose stack running for debugging.
  --port N               Pin the loopback host port for the server.
  --adapter-source PATH  Kimi client adapter source (dir or .tgz).
  --image-name NAME      format-convert image (default ${DEFAULT_CONVERTER_IMAGE}).
  --json                 Print the final report JSON to stdout.
`);
}

function parseArgs(argv) {
  const options = { plan: false, keepStack: false, port: 0, adapterSource: "", imageName: DEFAULT_CONVERTER_IMAGE, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
      const error = new Error(`Unknown argument: ${arg}`);
      error.code = "release_journey_argument_invalid";
      throw error;
    }
  }
  return options;
}

function withTimeout(stepId, promise) {
  const budget = STEP_TIMEOUTS_MS[stepId] ?? 120_000;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Release journey step ${stepId} exceeded its ${Math.round(budget / 1000)}s budget.`);
      error.code = "release_journey_step_timeout";
      reject(error);
    }, budget);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function runConnectorInstall({
  installArgs,
  env,
  consoleClient,
  redact
}) {
  const child = spawn(process.execPath, installArgs, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const requestId = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(
        new Error(`Connector install did not submit a device authorization request in time: ${redact(stderr).slice(-600)}`),
        { code: "release_journey_authorization_missing" }
      ));
    }, 60_000);
    child.stderr.on("data", () => {
      const match = /authorization\s+(mcp_auth_req_[A-Za-z0-9_]+)\s+is pending/u.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(Object.assign(
        new Error(`Connector install exited (${code}) before the device authorization was approved: ${redact(stderr).slice(-600)}`),
        { code: "release_journey_install_failed" }
      ));
    });
  });

  const verificationCode = /code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/u.exec(stderr)?.[1] || "";
  const pending = await listPendingAuthorizationRequests(consoleClient);
  const request = pending.find((entry) => entry.requestId === requestId);
  if (!request) {
    const error = new Error("Device authorization request is not visible in the console pending list.");
    error.code = "release_journey_authorization_missing";
    throw error;
  }
  if (verificationCode && String(request.verificationCode || "") !== verificationCode) {
    const error = new Error("Console verification code does not match the connector's code.");
    error.code = "release_journey_verification_code_mismatch";
    throw error;
  }
  await approveAuthorizationRequest(consoleClient, requestId);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  let payload = null;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    payload = null;
  }
  if (exitCode !== 0 || payload?.ok !== true || payload?.installed?.kimi?.status !== "installed") {
    const error = new Error(
      `Connector install failed (exit ${exitCode}): ${redact(String(payload?.installed?.kimi?.error || stderr)).slice(-600)}`
    );
    error.code = "release_journey_install_failed";
    throw error;
  }
  return {
    requestId,
    verificationCodeMatched: Boolean(verificationCode),
    tokenSource: String(payload.installed.kimi.tokenSource || ""),
    adapterCacheHit: payload.installed.kimi.adapterCacheHit === true,
    httpVerificationOk: payload.installed.kimi.httpVerification?.systemHealthOk === true,
    visibleToolCount: Number(payload.installed.kimi.httpVerification?.toolCount || 0)
  };
}

async function runConnectorUninstall({ connectorScript: script, env, redact }) {
  const child = spawn(process.execPath, [script, "uninstall", "--target", "kimi", "--json"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exitCode = await new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  let payload = null;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    payload = null;
  }
  const removed = payload?.uninstalled?.kimi?.serverDeviceRemoved === true && payload?.uninstalled?.kimi?.localProcessIdentityRemoved === true;
  return { exitCode, ok: exitCode === 0 && removed, detail: redact(stdout).slice(-300) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.plan) {
    process.stdout.write(`${JSON.stringify({ ok: true, schemaVersion: "v0.0.1:report:release-journey-1", plan: RELEASE_JOURNEY_STEPS }, null, 2)}\n`);
    return;
  }

  const redaction = createRedaction({ repoRoot });
  const report = createReleaseJourneyReport({});
  const { addNeedle, redact, assertNoLeak } = redaction;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-journey-"));
  const gateHome = path.join(workDir, "home");
  const adapterCacheRoot = path.join(workDir, "adapter-cache");
  const fetchOutputPath = path.join(workDir, "output.pdf");
  await fs.mkdir(gateHome, { recursive: true, mode: 0o700 });

  let hostPort = 0;
  let stackStarted = false;
  let connectorInstalled = false;
  let currentStep = "preflight";

  const gateEnv = {
    HOME: gateHome,
    KIMI_CODE_HOME: path.join(gateHome, ".kimi-code"),
    MESHRIX_MCP_PROCESS_IDENTITY_STORE: "file",
    MESHRIX_MCP_ADAPTER_CACHE: adapterCacheRoot,
    MESHRIX_MCP_DISCOVERY_FILE: path.join(workDir, "servers.json")
  };

  async function recordStep(id, fn) {
    currentStep = id;
    const started = Date.now();
    try {
      const receipt = await withTimeout(id, fn());
      report.steps.push(stepReceipt(id, { status: "passed", durationMs: Date.now() - started, receipt }));
      return receipt;
    } catch (error) {
      error.message = redact(error?.message || String(error));
      report.steps.push(stepReceipt(id, { status: "failed", durationMs: Date.now() - started, error }));
      report.failure = { step: id, code: String(error?.code || "release_journey_failed"), message: String(error.message).slice(-800) };
      throw error;
    }
  }

  async function cleanup() {
    const details = report.cleanup.details;
    if (connectorInstalled) {
      const started = Date.now();
      try {
        const result = await withTimeout("cleanup", runConnectorUninstall({ connectorScript, env: gateEnv, redact }));
        details.push({ id: "connector-uninstall", status: result.ok ? "passed" : "failed", durationMs: Date.now() - started });
      } catch (error) {
        details.push({ id: "connector-uninstall", status: "failed", durationMs: Date.now() - started, error: redact(error?.message || String(error)).slice(-300) });
      }
    }
    if (stackStarted && !options.keepStack) {
      const started = Date.now();
      try {
        await withTimeout("cleanup", runCompose(["--profile", "format-convert", "down", "-v"], {
          cwd: repoRoot,
          env: composeEnv({ hostPort, converterImage: options.imageName }),
          redact,
          allowFailure: true
        }));
        details.push({ id: "compose-down", status: "passed", durationMs: Date.now() - started });
      } catch (error) {
        details.push({ id: "compose-down", status: "failed", durationMs: Date.now() - started, error: redact(error?.message || String(error)).slice(-300) });
      }
      const imageStarted = Date.now();
      try {
        await withTimeout("cleanup", runDocker(["image", "rm", "-f", RELEASE_JOURNEY_SERVER_IMAGE], { redact, allowFailure: true }));
        details.push({ id: "server-image-remove", status: "passed", durationMs: Date.now() - imageStarted });
      } catch (error) {
        details.push({ id: "server-image-remove", status: "failed", durationMs: Date.now() - imageStarted, error: redact(error?.message || String(error)).slice(-300) });
      }
    }
    if (options.keepStack) {
      details.push({ id: "compose-down", status: "skipped", note: "--keep-stack requested" });
    }
    const tempStarted = Date.now();
    try {
      await fs.rm(workDir, { recursive: true, force: true });
      details.push({ id: "temp-workdir", status: "passed", durationMs: Date.now() - tempStarted });
    } catch (error) {
      details.push({ id: "temp-workdir", status: "failed", durationMs: Date.now() - tempStarted, error: redact(error?.message || String(error)).slice(-300) });
    }
    report.cleanup.performed = true;
  }

  let publishReceipt = null;
  let journeyResult = null;
  try {
    await recordStep("preflight", async () => {
      const engineVersion = await assertDockerAvailable();
      await fs.access(descriptorPath);
      await fs.access(connectorScript);
      const fixtureDigest = createHash("sha256").update(RELEASE_JOURNEY_FIXTURE_BYTES).digest("hex");
      if (fixtureDigest !== RELEASE_JOURNEY_FIXTURE_SHA256) {
        const error = new Error("The tracked release journey fixture does not match its pinned sha256.");
        error.code = "release_journey_fixture_drift";
        throw error;
      }
      hostPort = await chooseHostPort({ explicitPort: options.port });
      report.environment = {
        dockerServerVersion: engineVersion,
        composeProject: RELEASE_JOURNEY_COMPOSE_PROJECT,
        hostPort,
        advertisedBaseUrl: `http://127.0.0.1:${hostPort}`,
        serverImage: RELEASE_JOURNEY_SERVER_IMAGE,
        converterImage: options.imageName,
        converterContainer: RELEASE_JOURNEY_CONVERTER_CONTAINER,
        serverContainer: RELEASE_JOURNEY_SERVER_CONTAINER,
        identityStoreMode: "file (isolated temporary HOME; no OS credential backend, no user client configuration)"
      };
      return { dockerServerVersion: engineVersion, hostPort };
    });

    await recordStep("stack-build-up", async () => {
      const env = composeEnv({ hostPort, converterImage: options.imageName });
      if (!dockerImageExists(options.imageName)) {
        const buildDir = path.resolve(repoRoot, DEFAULT_FORMAT_CONVERTER_BUILD_DIR);
        await fs.access(buildDir).catch(() => {
          const error = new Error(
            `format-convert image ${options.imageName} is missing and the default build directory ${DEFAULT_FORMAT_CONVERTER_BUILD_DIR} is unavailable. ` +
            "Build the image first (make image in Meshrix-Services/file-parser/format-convert) or pass --image-name."
          );
          error.code = "release_journey_image_missing";
          throw error;
        });
        runDocker(["build", "--pull=false", "--tag", options.imageName, buildDir], { env, redact });
      }
      await runCompose(["--profile", "format-convert", "build", "meshrix-server"], { cwd: repoRoot, env, redact });
      await runCompose(["--profile", "format-convert", "up", "-d"], { cwd: repoRoot, env, redact });
      stackStarted = true;
      const baseUrl = `http://127.0.0.1:${hostPort}`;
      await waitForHttpOk(`${baseUrl}/api/healthz`, { timeoutMs: 180000 });
      await waitForConverterReady({ containerName: RELEASE_JOURNEY_CONVERTER_CONTAINER, env });
      return { serverHealth: "ok", converterReady: true };
    });

    const baseUrl = `http://127.0.0.1:${hostPort}`;
    const consoleClient = createConsoleClient({ baseUrl, addNeedle });

    await recordStep("admin-bootstrap", async () => {
      const password = await rotateOwnerPassword({
        containerName: RELEASE_JOURNEY_SERVER_CONTAINER,
        env: composeEnv({ hostPort, converterImage: options.imageName }),
        redact
      });
      addNeedle(password);
      const session = await consoleClient.login({ username: "owner", password });
      return { consoleUser: session.username, roleId: session.roleId };
    });

    publishReceipt = await recordStep("upstream-publish", async () => {
      const descriptorDocument = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
      return publishUpstreamService({ consoleClient, descriptorDocument });
    });

    await recordStep("adapter-seed", async () => {
      return seedClientAdapterCache({
        repoRoot,
        target: "kimi",
        adapterSource: options.adapterSource,
        cacheRoot: adapterCacheRoot
      });
    });

    await recordStep("connector-install", async () => {
      const clientCommand = resolveKimiClientCommand({});
      const installArgs = [
        connectorScript,
        "install",
        "--target", "kimi",
        "--url", baseUrl,
        "--json",
        "--adapter-cache", adapterCacheRoot,
        "--toolsets", GRANT_TOOLSETS,
        "--scopes", GRANT_SCOPES,
        "--max-risk", GRANT_MAX_RISK,
        "--upstream-capability", `cap:upstream:${publishReceipt.serviceId}:convert`,
        "--allowed-service", publishReceipt.serviceId,
        "--client-command", clientCommand.command,
        "--discovery-file", gateEnv.MESHRIX_MCP_DISCOVERY_FILE
      ];
      const result = await runConnectorInstall({ installArgs, env: gateEnv, consoleClient, redact });
      connectorInstalled = true;
      return { ...result, clientCommandSource: clientCommand.source };
    });

    journeyResult = await recordStep("mcp-journey", async () => {
      const { receipt, artifactUrl, artifactId } = await runMcpJourney({
        connectorScript,
        target: "kimi",
        baseUrl,
        serviceId: publishReceipt.serviceId,
        fixtureBytes: RELEASE_JOURNEY_FIXTURE_BYTES,
        fixtureFileName: RELEASE_JOURNEY_FIXTURE_FILENAME,
        env: gateEnv,
        redact
      });
      return { ...receipt, artifactId, artifactUrl };
    });

    await recordStep("artifact-fetch", async () => {
      let result;
      try {
        result = await runConnectorFetch({
          connectorScript,
          target: "kimi",
          artifactUrl: journeyResult.artifactUrl,
          outputPath: fetchOutputPath,
          env: gateEnv
        });
      } catch (error) {
        const diagnosis = await diagnoseArtifactGet({ artifactUrl: journeyResult.artifactUrl, env: gateEnv });
        error.message = `${error.message} (signed GET diagnostic: status=${diagnosis.status} code=${diagnosis.code || "none"})`;
        throw error;
      }
      if (!result.sha256Matches) {
        const error = new Error("Connector-reported sha256 does not match the downloaded bytes.");
        error.code = "release_journey_fetch_digest_mismatch";
        throw error;
      }
      if (result.byteLength !== journeyResult.convert.size) {
        const error = new Error("Downloaded byte length does not match the resource_link size.");
        error.code = "release_journey_fetch_size_mismatch";
        throw error;
      }
      const { bytes, ...rest } = result;
      return { ...rest, followedResourceLinkUrl: true };
    });

    await recordStep("pdf-verify", async () => {
      const pdfBytes = await fs.readFile(fetchOutputPath);
      const verification = verifyConvertedPdf(pdfBytes, RELEASE_JOURNEY_FIXTURE_TEXT, { requireFullHanCoverage: true });
      if (!verification.ok) {
        const error = new Error(`PDF verification failed: ${JSON.stringify({
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
  } catch (error) {
    if (!report.failure) {
      report.failure = { step: currentStep, code: String(error?.code || "release_journey_failed"), message: redact(error?.message || String(error)).slice(-800) };
    }
  } finally {
    await cleanup();
  }

  const finalized = finalizeReleaseJourneyReport(report, { assertNoLeak });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, finalized.serialized);
  if (options.json) {
    process.stdout.write(finalized.serialized);
  } else {
    const summary = finalized.report.steps.map((step) => `${step.id}:${step.status}`).join(" ");
    process.stdout.write(`${JSON.stringify({ ok: finalized.report.releaseReady, report: RELEASE_JOURNEY_REPORT_PATH, steps: summary })}\n`);
  }
  if (!finalized.report.releaseReady) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "release_journey_failed", message: String(error?.message || error).slice(-800) })}\n`);
  process.exitCode = 1;
});
