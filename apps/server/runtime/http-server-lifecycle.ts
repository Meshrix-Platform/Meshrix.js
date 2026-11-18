import { parsePositiveInt } from "./http-server-middleware.ts";

export function createHttpServerLifecycle({ server, runtimeLogger, transportLimits = {} }: Record<string, any>) : any {
  let inFlightCount: any = 0;
  let inFlightCost: any = 0;
  let acceptingRequests: any = false;
  let admissionSealed: any = false;
  let admissionClosedReason: any = new Error("HTTP server startup is not complete.");
  const drainCallbacks: any[] = [];
  const openSockets: any = new Set<any>();
  const activeSockets: any = new Map<any, any>();
  const requestAbortControllers: any = new Set<any>();

  const maxActiveRequests: any = parsePositiveInt(transportLimits.maxActiveRequests, 1_024);
  const maxActiveCost: any = parsePositiveInt(transportLimits.maxActiveCost, 2_048);
  const reservedLightCost: any = Math.min(
    maxActiveCost - 1,
    parsePositiveInt(transportLimits.reservedLightCost, 64)
  );

  function incrementInflight(cost?: any) : any {
    inFlightCount++;
    inFlightCost += cost;
  }

  function decrementInflight(cost?: any) : any {
    inFlightCount--;
    inFlightCost = Math.max(0, inFlightCost - cost);
    if (inFlightCount <= 0) {
      drainCallbacks.splice(0).forEach((cb?: any) : any => cb());
    }
  }

  function waitForDrain(timeoutMs: any = 30_000) : any {
    if (inFlightCount <= 0) return Promise.resolve(true);
    return new Promise((resolve?: any) : any => {
      const t: any = setTimeout(() : any => {
        const i: any = drainCallbacks.indexOf(onDrained);
        if (i >= 0) drainCallbacks.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      const onDrained: any = () : any => {
        clearTimeout(t);
        resolve(true);
      };
      drainCallbacks.push(onDrained);
    });
  }

  function beginRequest({ cost = 1, workloadClass = "light" }: Record<string, any> = {}) : any {
    const controller: any = new AbortController();
    if (!acceptingRequests) {
      controller.abort(admissionClosedReason || new Error("HTTP server is not accepting requests."));
      return controller;
    }
    const normalizedCost: any = parsePositiveInt(cost, 1);
    const normalizedClass: any = String(workloadClass || "light");
    const costCeiling: any = normalizedClass === "light"
      ? maxActiveCost
      : Math.max(1, maxActiveCost - reservedLightCost);
    if (inFlightCount >= maxActiveRequests || normalizedCost > costCeiling - inFlightCost) {
      controller.abort(Object.assign(
        new Error("HTTP request admission capacity is exhausted."),
        { code: "http_request_capacity_exceeded", statusCode: 429 }
      ));
      return controller;
    }
    Object.defineProperty(controller, "__meshrixAdmissionCost", {
      configurable: false,
      enumerable: false,
      value: normalizedCost
    });
    requestAbortControllers.add(controller);
    incrementInflight(normalizedCost);
    return controller;
  }

  function endRequest(controller?: any) : any {
    if (!requestAbortControllers.delete(controller)) return;
    decrementInflight(controller?.__meshrixAdmissionCost || 1);
  }

  function abortInflight(reason: any = new Error("HTTP server is shutting down.")) : any {
    for (const controller of requestAbortControllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  function openAdmission() : any {
    if (admissionSealed) {
      throw new Error("HTTP request admission has been permanently sealed.");
    }
    acceptingRequests = true;
    admissionClosedReason = null;
  }

  function sealAdmission(reason: any = new Error("HTTP server is shutting down.")) : any {
    acceptingRequests = false;
    admissionSealed = true;
    admissionClosedReason = reason;
  }

  function markSocketActive(socket?: any) : any {
    activeSockets.set(socket, (activeSockets.get(socket) || 0) + 1);
  }

  function markSocketIdle(socket?: any) : any {
    const remaining: any = Math.max(0, (activeSockets.get(socket) || 1) - 1);
    if (remaining === 0) activeSockets.delete(socket);
    else activeSockets.set(socket, remaining);
  }

  server.maxConnections = Number(transportLimits.maxConnections || 2_000);
  server.requestTimeout = Number(transportLimits.requestTimeoutMs || 300_000);
  server.headersTimeout = Number(transportLimits.headersTimeoutMs || 60_000);
  server.keepAliveTimeout = Number(transportLimits.keepAliveTimeoutMs || 5_000);
  server.maxRequestsPerSocket = Number(transportLimits.maxRequestsPerSocket || 1_000);
  server.maxHeadersCount = Number(transportLimits.maxHeadersCount || 100);
  server.on("connection", (socket?: any) : any => {
    openSockets.add(socket);
    runtimeLogger.debug("http.connection.opened", {
      openSocketCount: openSockets.size
    });
    socket.on("close", () : any => {
      openSockets.delete(socket);
      activeSockets.delete(socket);
      runtimeLogger.debug("http.connection.closed", {
        openSocketCount: openSockets.size
      });
    });
  });

  return {
    abortInflight,
    beginRequest,
    endRequest,
    getInFlightCount: () : any => inFlightCount,
    getAdmissionUsage: () : any => Object.freeze({
      inFlightCount,
      inFlightCost,
      maxActiveRequests,
      maxActiveCost,
      reservedLightCost
    }),
    isAdmissionOpen: () : any => acceptingRequests,
    isSocketActive: (socket?: any) : any => activeSockets.has(socket),
    markSocketActive,
    markSocketIdle,
    openAdmission,
    openSockets,
    sealAdmission,
    waitForDrain
  };
}

export async function publishStartupLifecycle({
  controllers,
  registeredCoreProvider,
  runtimeLogger,
  protocolEventBus,
  discoveryState,
  listenUrl,
  isFeatureActive,
  exposedMaintenanceAgent,
  deletionCoordinator,
  featureRuntime
}: Record<string, any>) : Promise<any> {
  await protocolEventBus.publish(
    "server.lifecycle",
    {
      status: "started",
      serverId: discoveryState.serverId,
      listenUrl,
      activeServiceUrl: discoveryState.activeServiceUrl,
      mode: discoveryState.mode
    },
    { type: "server.started" }
  );
  const startupSnapshotPort: any = registeredCoreProvider.createStartupSnapshotPort({
    controllers
  });
  const interfaceSnapshot: any = await startupSnapshotPort.readSystemInterfaces();
  await protocolEventBus.publish(
    "system.interfaces",
    interfaceSnapshot,
    { type: "system.interfaces.snapshot" }
  );
  const discoveryConfigSnapshot: any = await startupSnapshotPort.readDiscoveryConfig();
  await protocolEventBus.publish(
    "discovery.config",
    discoveryConfigSnapshot,
    { type: "discovery.config.snapshot" }
  );
  if (isFeatureActive("core-platform")) {
    const agentSyncConfigSnapshot: any = (await startupSnapshotPort.readAgentSyncConfig())?.config || {};
    await protocolEventBus.publish(
      "agent_sync.config",
      agentSyncConfigSnapshot,
      { type: "agent_sync.config.snapshot" }
    );
  }
  if (exposedMaintenanceAgent) {
    await exposedMaintenanceAgent.start();
  }
  const consoleStateSnapshot: any = await startupSnapshotPort.readConsoleState();
  await protocolEventBus.publish(
    "system.console_state",
    {
      state: consoleStateSnapshot
    },
    { type: "system.console_state.snapshot" }
  );
  const storageSummarySnapshot: any = await startupSnapshotPort.readStorageSummary();
  await protocolEventBus.publish(
    "storage.summary",
    storageSummarySnapshot,
    { type: "storage.summary.snapshot" }
  );
  await deletionCoordinator.resumePendingDeletions();
  runtimeLogger.info("server.started", {
    listenUrl,
    serverId: discoveryState.serverId,
    activeServiceUrl: discoveryState.activeServiceUrl,
    mode: discoveryState.mode,
    edition: featureRuntime.edition,
    activeFeatures: featureRuntime.activeFeatureIds
  });
}

export async function closeHttpServerRuntime({
  server,
  lifecycle,
  runtimeOptions,
  runtimeLogger,
  applicationAssembly
}: Record<string, any>) : Promise<any> {
  lifecycle.sealAdmission(new Error("HTTP server is shutting down."));
  runtimeLogger.info("server.close.started", {
    openSocketCount: lifecycle.openSockets.size,
    inFlightCount: lifecycle.getInFlightCount()
  });

  server.close(() : any => {});

  for (const socket of lifecycle.openSockets) {
    if (!lifecycle.isSocketActive(socket)) {
      socket.destroy();
    }
  }

  const drainTimeoutMs: any = parsePositiveInt(
    runtimeOptions.httpCloseDrainTimeoutMs,
    parsePositiveInt(process.env.MESHRIX_HTTP_CLOSE_DRAIN_TIMEOUT_MS, 30_000)
  );
  const drained: any = await lifecycle.waitForDrain(drainTimeoutMs);

  for (const socket of lifecycle.openSockets) {
    socket.destroy();
  }

  if (!drained && lifecycle.getInFlightCount() > 0) {
    lifecycle.abortInflight(new Error("HTTP request cancelled during server shutdown."));
    const cancelTimeoutMs: any = parsePositiveInt(
      runtimeOptions.httpCloseCancelTimeoutMs,
      drainTimeoutMs
    );
    const cancelledTasksSettled: any = await lifecycle.waitForDrain(cancelTimeoutMs);
    if (!cancelledTasksSettled || lifecycle.getInFlightCount() > 0) {
      const shutdownError: Error & Record<string, any> = new Error(
        "HTTP server shutdown could not settle active requests before closing runtime dependencies."
      );
      shutdownError.code = "http_shutdown_inflight";
      runtimeLogger.error("server.close.inflight_timeout", {
        inFlightCount: lifecycle.getInFlightCount()
      });
      throw shutdownError;
    }
  }

  try {
    await applicationAssembly.close();
  } catch (error: any) {
    runtimeLogger.error("server.close.application_shutdown_failed", {
      code: error?.code || "http_shutdown_resources"
    });
    await runtimeLogger.close().catch(() : any => {});
    throw error;
  }
  runtimeLogger.info("server.close.completed", {});
  await runtimeLogger.close().catch(() : any => {});
}
