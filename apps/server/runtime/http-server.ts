import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createRuntimeLogger,
  setRuntimeLogger,
  summarizeError
} from "#meshrix/runtime-logger";
import { ServerConfig } from "#meshrix/server-config";
import {
  LOCAL_SECRET_MASTER_KEY_FILE_ENV,
  assertLocalSecretKeyReady
} from "#meshrix/foundation/security/secrets/local-secret-key-provider";
import {
  OPERATION_PROOF_SIGNER_SECRET_FILE_ENV
} from "#meshrix/foundation/proof/proof-substrate/index";
import {
  assertIndependentBackupRootReady
} from "#meshrix/foundation/storage/backup-contract";
import {
  createProductionIngressContract
} from "#meshrix/foundation/security/production-ingress-contract";
import { createHttpApplicationAssembly } from "#meshrix/server-runtime/composition/http-application-assembly";
import { createConsoleDomainServices } from "#meshrix/server-runtime/composition/console-domain/services";
import {
  defaultAdvertisedHost,
  formatUrlHost
} from "#meshrix/http-utils";
import { isUpstreamPayloadTransitRoute } from "#meshrix/protocols/http/controllers/upstream-payload-transit-controller";
import {
  assertSafeListenHost,
  createFixedWindowRateLimiter,
  resolveHttpRateLimits,
  resolveHttpTransportLimits
} from "./http-server-middleware.ts";
import { createHttpServerRequestHandler } from "./http-server-routes.ts";
import {
  closeHttpServerRuntime,
  createHttpServerLifecycle,
  publishStartupLifecycle
} from "./http-server-lifecycle.ts";
import { proxyApiRequest } from "./http-server-proxy.ts";

export {
  resolveProxyUpstreamUrl
} from "./http-server-proxy.ts";

const sourceCheckoutRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function isPathInside(parentPath?: any, candidatePath?: any) : any {
  const relative: any = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveServerUserDataPath(inputUserDataPath?: any) : any {
  const resolved: any = path.resolve(String(inputUserDataPath || ServerConfig.getDataDir()));
  const runningFromSourceCheckout: any = fs.existsSync(path.join(sourceCheckoutRoot, ".git"));
  if (runningFromSourceCheckout && isPathInside(sourceCheckoutRoot, resolved)) {
    throw new Error(
      "Refusing a project-local Meshrix.js server data directory. Use the platform data directory or an external MESHRIX_SERVER_DATA_DIR."
    );
  }
  return resolved;
}

function assertProductionSecretCustodySeparated({
  encryptionKeyFile = "",
  proofSignerFile = ""
}: Record<string, any> = {}) : any {
  const encryptionPath: any = String(encryptionKeyFile || "").trim();
  const signerPath: any = String(proofSignerFile || "").trim();
  if (!encryptionPath || !signerPath) return;
  let encryptionBytes: any;
  let signerBytes: any;
  try {
    const encryptionStat: any = fs.lstatSync(encryptionPath);
    const signerStat: any = fs.lstatSync(signerPath);
    if (
      !encryptionStat.isFile() ||
      !signerStat.isFile() ||
      encryptionStat.size > 256 ||
      signerStat.size > 256
    ) {
      return;
    }
    const sameFile: any = fs.realpathSync(encryptionPath) === fs.realpathSync(signerPath);
    encryptionBytes = fs.readFileSync(encryptionPath);
    signerBytes = fs.readFileSync(signerPath);
    const encryptionValue: any = encryptionBytes.length === 65 && encryptionBytes[64] === 0x0a
      ? encryptionBytes.subarray(0, 64)
      : encryptionBytes;
    const signerValue: any = signerBytes.length === 65 && signerBytes[64] === 0x0a
      ? signerBytes.subarray(0, 64)
      : signerBytes;
    const sameValue: any = encryptionValue.length === signerValue.length &&
      timingSafeEqual(encryptionValue, signerValue);
    if (sameFile || sameValue) {
      throw Object.assign(
        new Error("Meshrix.js production encryption and proof-signing secrets must be distinct."),
        { code: "production_secret_custody_separation_required" }
      );
    }
  } catch (error: any) {
    if (error?.code === "production_secret_custody_separation_required") throw error;
    // The owning key providers emit the stable missing/invalid custody error.
  } finally {
    encryptionBytes?.fill(0);
    signerBytes?.fill(0);
  }
}

async function closeFailedStartupServer(server?: any, lifecycle?: any) : Promise<any> {
  lifecycle.sealAdmission(new Error("HTTP server startup failed."));
  server.close(() : any => {});
  lifecycle.abortInflight(new Error("HTTP request cancelled after server startup failed."));
  for (const socket of lifecycle.openSockets) socket.destroy();
  const settled: any = await lifecycle.waitForDrain(5_000);
  if (!settled || lifecycle.getInFlightCount() > 0) {
    throw new Error("Active HTTP requests did not settle after server startup failed.");
  }
}

async function runFailedStartupCleanups(cleanups?: any) : Promise<any> {
  let complete: any = true;
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup.close();
    } catch {
      complete = false;
      if (cleanup.blocksDependencyShutdown) return false;
    }
  }
  return complete;
}

export async function startHttpServer({
  userDataPath,
  distPath,
  jobManager: incomingJobManager,
  runtimeOptions = {},
  discoveryOptions = {},
  operationLockManager: injectedOperationLockManager = null,
  operationConcurrencyScope: requestedOperationConcurrencyScope = "",
  registerPluginRuntimeMeasurementSource = null,
  pluginHostPorts = {},
  host = "127.0.0.1",
  port = 0,
  advertisedHost = ""
}: Record<string, any>) : Promise<any> {
  assertSafeListenHost(host, runtimeOptions);
  const resolvedUserDataPath: any = resolveServerUserDataPath(userDataPath);
  const serverWorkspaceRoot: any = String(runtimeOptions.workspaceRoot || process.cwd()).trim() || process.cwd();
  const runtimeLogger: any = createRuntimeLogger({
    userDataPath: resolvedUserDataPath,
    runtimeOptions,
    component: "server"
  });
  setRuntimeLogger(runtimeLogger);
  const startupCleanups: any[] = [];
  try {
    runtimeLogger.info("server.start.requested", {
      host,
      port,
      advertisedHost,
      distributionConfigured: Boolean(String(distPath || "").trim()),
      dataRootConfigured: true,
      profile: runtimeOptions?.profile || "",
      fileLoggingEnabled: Boolean(runtimeLogger.logDir),
      retentionDays: runtimeLogger.retentionDays
    });
    const localSecretKeyFile: any = String(
      process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV] || ""
    ).trim();
    if (localSecretKeyFile) {
      await assertLocalSecretKeyReady({ dataDir: resolvedUserDataPath });
    }
    assertProductionSecretCustodySeparated({
      encryptionKeyFile: localSecretKeyFile,
      proofSignerFile: process.env[OPERATION_PROOF_SIGNER_SECRET_FILE_ENV]
    });
    const ingressContract: any = createProductionIngressContract({
      advertisedBaseUrl: discoveryOptions.advertisedBaseUrl
    });
    await assertIndependentBackupRootReady({ userDataPath: resolvedUserDataPath });
    const serverLabel: any = String(discoveryOptions.serverLabel || "").trim();
    const applicationAssembly: any = await createHttpApplicationAssembly({
      userDataPath: resolvedUserDataPath,
      distPath,
      incomingJobManager,
      runtimeOptions,
      operationLockManager: injectedOperationLockManager,
      operationConcurrencyScope: requestedOperationConcurrencyScope,
      registerPluginRuntimeMeasurementSource,
      pluginHostPorts,
      serverWorkspaceRoot,
      serverLabel,
      runtimeLogger,
      createConsoleDomainServices,
      proxyApiRequest,
      registerStartupCleanup: (cleanup?: any) : any => startupCleanups.push(cleanup)
    });

    const rateLimits: any = resolveHttpRateLimits(runtimeOptions);
    const ipRateLimiter: any = createFixedWindowRateLimiter({
      limit: rateLimits.ip.limit,
      windowMs: rateLimits.windowMs,
      label: "ip"
    });
    const subjectRateLimiter: any = createFixedWindowRateLimiter({
      limit: rateLimits.subject.limit,
      windowMs: rateLimits.windowMs,
      label: "subject"
    });
    const tenantRateLimiter: any = createFixedWindowRateLimiter({
      limit: rateLimits.tenant.limit,
      windowMs: rateLimits.windowMs,
      label: "tenant"
    });
    const loginRateLimiter: any = createFixedWindowRateLimiter({
      limit: rateLimits.login.limit,
      windowMs: rateLimits.windowMs,
      label: "login"
    });

    const server: any = http.createServer();
    const transportLimits: any = resolveHttpTransportLimits(runtimeOptions);
    const lifecycle: any = createHttpServerLifecycle({ server, runtimeLogger, transportLimits });
    startupCleanups.push({
      close: () : any => closeFailedStartupServer(server, lifecycle),
      blocksDependencyShutdown: true
    });
    const requestHandler: any = applicationAssembly.createRequestHandler({
      handlerFactory: createHttpServerRequestHandler,
      ingressContract,
      lifecycle,
      loginRateLimiter,
      rateLimits,
      subjectRateLimiter,
      tenantRateLimiter,
      ipRateLimiter
    });
    server.on("request", requestHandler);
    server.on("checkContinue", (request?: any, response?: any) : any => {
      let governedPayloadTransit: any = false;
      try {
        governedPayloadTransit = isUpstreamPayloadTransitRoute(
          request.method || "POST",
          new URL(request.url || "/", "http://127.0.0.1").pathname
        );
      } catch {
        governedPayloadTransit = false;
      }
      if (!governedPayloadTransit) response.writeContinue();
      requestHandler(request, response);
    });

    await new Promise((resolve?: any, reject?: any) : any => {
      server.once("error", reject);
      server.listen(port, host, () : any => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address: any = server.address();
    if (!address || typeof address === "string") {
      throw new Error("无法确定本地服务监听地址。");
    }
    runtimeLogger.info("server.listen.ready", {
      host,
      boundAddress: address.address,
      port: address.port
    });

    const listenHost: any = typeof address.address === "string" ? address.address : host;
    const resolvedAdvertisedHost: any = advertisedHost || defaultAdvertisedHost(host);
    // A configured advertised base URL wins over the socket bind address: with
    // container port mapping the bind port is not externally reachable, so
    // externally-facing URLs (artifact resource links, discovery metadata) must
    // keep the advertised host and port.
    const advertisedBaseUrl: any = String(discoveryOptions.advertisedBaseUrl || "").trim().replace(/\/+$/, "");
    const listenUrl: any = advertisedBaseUrl || `http://${formatUrlHost(resolvedAdvertisedHost)}:${address.port}`;
    const discoveryState: any = await applicationAssembly.activateListeningEndpoint({
      resolvedListenUrl: listenUrl,
      discoveryOptions
    });
    await publishStartupLifecycle(applicationAssembly.startupLifecycleContext());
    lifecycle.openAdmission();
    // Optional adapters are admitted only after the Core listener, discovery,
    // startup snapshots, and request admission are ready. Their asynchronous
    // connect path is supervised and cannot delay this startup boundary.
    applicationAssembly.startOptionalIntegrations();
    let closePromise: any = null;

    return {
      server,
      host: listenHost,
      port: address.port,
      url: listenUrl,
      discovery: discoveryState,
      initialOwner: applicationAssembly.initialOwner.created
        ? {
            created: true,
            username: applicationAssembly.initialOwner.username,
            credentialsPath: applicationAssembly.initialCredentialsPath
          }
        : { created: false },
      close: () : any => {
        if (!closePromise) {
          closePromise = closeHttpServerRuntime({
            server,
            lifecycle,
            runtimeOptions,
            runtimeLogger,
            applicationAssembly
          }).catch((error?: any) : any => {
            if (["http_shutdown_inflight", "http_shutdown_dependencies"].includes(error?.code)) {
              closePromise = null;
            }
            throw error;
          });
        }
        return closePromise;
      }
    };
  } catch (startupError: any) {
    runtimeLogger.error("server.start.failed", {
      error: summarizeError(startupError)
    });
    const cleanupComplete: any = await runFailedStartupCleanups(startupCleanups);
    if (!cleanupComplete) {
      runtimeLogger.error("server.start.cleanup_incomplete", {});
    }
    await runtimeLogger.close().catch(() : any => {});
    throw startupError;
  }
}

export async function startLocalHttpServer(options?: any) : Promise<any> {
  return startHttpServer({
    host: "127.0.0.1",
    port: 0,
    ...options
  });
}
