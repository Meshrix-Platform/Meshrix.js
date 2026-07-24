import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRuntimeLogger,
  setRuntimeLogger,
  summarizeError
} from "#meshrix/runtime-logger";
import { ServerConfig } from "#meshrix/server-config";
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
} from "./http-server-middleware.mjs";
import { createHttpServerRequestHandler } from "./http-server-routes.mjs";
import {
  closeHttpServerRuntime,
  createHttpServerLifecycle,
  publishStartupLifecycle
} from "./http-server-lifecycle.mjs";
import { proxyApiRequest } from "./http-server-proxy.mjs";

export {
  proxyShouldForwardCredentials,
  resolveProxyUpstreamUrl
} from "./http-server-proxy.mjs";

const sourceCheckoutRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveServerUserDataPath(inputUserDataPath) {
  const resolved = path.resolve(String(inputUserDataPath || ServerConfig.getDataDir()));
  const runningFromSourceCheckout = fs.existsSync(path.join(sourceCheckoutRoot, ".git"));
  if (runningFromSourceCheckout && isPathInside(sourceCheckoutRoot, resolved)) {
    throw new Error(
      "Refusing a project-local Meshrix server data directory. Use the platform data directory or an external MESHRIX_SERVER_DATA_DIR."
    );
  }
  return resolved;
}

async function closeFailedStartupServer(server, lifecycle) {
  lifecycle.sealAdmission(new Error("HTTP server startup failed."));
  server.close(() => {});
  lifecycle.abortInflight(new Error("HTTP request cancelled after server startup failed."));
  for (const socket of lifecycle.openSockets) socket.destroy();
  const settled = await lifecycle.waitForDrain(5_000);
  if (!settled || lifecycle.getInFlightCount() > 0) {
    throw new Error("Active HTTP requests did not settle after server startup failed.");
  }
}

async function runFailedStartupCleanups(cleanups) {
  let complete = true;
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
}) {
  assertSafeListenHost(host, runtimeOptions);
  const resolvedUserDataPath = resolveServerUserDataPath(userDataPath);
  const serverWorkspaceRoot = String(runtimeOptions.workspaceRoot || process.cwd()).trim() || process.cwd();
  const runtimeLogger = createRuntimeLogger({
    userDataPath: resolvedUserDataPath,
    runtimeOptions,
    component: "server"
  });
  setRuntimeLogger(runtimeLogger);
  const startupCleanups = [];
  try {
    runtimeLogger.info("server.start.requested", {
      host,
      port,
      advertisedHost,
      distPath,
      userDataPath: resolvedUserDataPath,
      profile: runtimeOptions?.profile || "",
      logDir: runtimeLogger.logDir,
      retentionDays: runtimeLogger.retentionDays
    });
    const serverLabel = String(discoveryOptions.serverLabel || "").trim();
    const applicationAssembly = await createHttpApplicationAssembly({
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
      registerStartupCleanup: (cleanup) => startupCleanups.push(cleanup)
    });

    const rateLimits = resolveHttpRateLimits(runtimeOptions);
    const ipRateLimiter = createFixedWindowRateLimiter({
      limit: rateLimits.ip.limit,
      windowMs: rateLimits.windowMs,
      label: "ip"
    });
    const subjectRateLimiter = createFixedWindowRateLimiter({
      limit: rateLimits.subject.limit,
      windowMs: rateLimits.windowMs,
      label: "subject"
    });
    const tenantRateLimiter = createFixedWindowRateLimiter({
      limit: rateLimits.tenant.limit,
      windowMs: rateLimits.windowMs,
      label: "tenant"
    });
    const loginRateLimiter = createFixedWindowRateLimiter({
      limit: rateLimits.login.limit,
      windowMs: rateLimits.windowMs,
      label: "login"
    });

    const server = http.createServer();
    const transportLimits = resolveHttpTransportLimits(runtimeOptions);
    const lifecycle = createHttpServerLifecycle({ server, runtimeLogger, transportLimits });
    startupCleanups.push({
      close: () => closeFailedStartupServer(server, lifecycle),
      blocksDependencyShutdown: true
    });
    const requestHandler = applicationAssembly.createRequestHandler({
      handlerFactory: createHttpServerRequestHandler,
      lifecycle,
      loginRateLimiter,
      rateLimits,
      subjectRateLimiter,
      tenantRateLimiter,
      ipRateLimiter
    });
    server.on("request", requestHandler);
    server.on("checkContinue", (request, response) => {
      let governedPayloadTransit = false;
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

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("无法确定本地服务监听地址。");
    }
    runtimeLogger.info("server.listen.ready", {
      host,
      boundAddress: address.address,
      port: address.port
    });

    const listenHost = typeof address.address === "string" ? address.address : host;
    const resolvedAdvertisedHost = advertisedHost || defaultAdvertisedHost(host);
    const listenUrl = `http://${formatUrlHost(resolvedAdvertisedHost)}:${address.port}`;
    const discoveryState = await applicationAssembly.activateListeningEndpoint({
      resolvedListenUrl: listenUrl,
      discoveryOptions
    });
    await publishStartupLifecycle(applicationAssembly.startupLifecycleContext());
    lifecycle.openAdmission();
    let closePromise = null;

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
      close: () => {
        if (!closePromise) {
          closePromise = closeHttpServerRuntime({
            server,
            lifecycle,
            runtimeOptions,
            runtimeLogger,
            applicationAssembly
          }).catch((error) => {
            if (["http_shutdown_inflight", "http_shutdown_dependencies"].includes(error?.code)) {
              closePromise = null;
            }
            throw error;
          });
        }
        return closePromise;
      }
    };
  } catch (startupError) {
    runtimeLogger.error("server.start.failed", {
      error: summarizeError(startupError)
    });
    const cleanupComplete = await runFailedStartupCleanups(startupCleanups);
    if (!cleanupComplete) {
      runtimeLogger.error("server.start.cleanup_incomplete", {});
    }
    await runtimeLogger.close().catch(() => {});
    throw startupError;
  }
}

export async function startLocalHttpServer(options) {
  return startHttpServer({
    host: "127.0.0.1",
    port: 0,
    ...options
  });
}
