import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AuthenticatedContext, CatalogDescriptor, Gateway, GatewayOutcome, PermitAuthorityPort } from "@meshrix/contracts/gateway";
import { createInnerDispatchLoop, type InnerDispatchLoop } from "@meshrix/entry-transport";
import {
  createEndpointIdentityStore,
  createPrivateGatewayEndpoint,
  type EndpointAuthorityPort,
  type EndpointDeviceRecord,
  type EndpointIdentityStore,
  type InnerTlsChannel,
  type PrivateEndpoint,
  type RecoverySigner,
  type RelayAdmissionInput
} from "@meshrix/gateway/private-endpoint";
import { createRuntime, loadConfig, version as packageVersion, type RuntimeConfig } from "../cli.ts";
import { endpointConfigError, loadPrivateEndpointConfig } from "./config.ts";
import { RelayWebSocketTransport, type RelaySocketFactory } from "./transport.ts";

/**
 * Private-endpoint profile runtime.
 *
 * Composes `createPrivateGatewayEndpoint` over a real WebSocket transport
 * (undici) so a self-hosted Meshrix gateway serves as the user-controlled
 * receiving endpoint of the private-relay profile. The profile owns:
 *
 *  - configuration loading/validation (`check` mode never connects);
 *  - the WSS transport lifecycle with bounded queues and reconnect backoff;
 *  - the honest endpoint state surface (reachable / endpoint_unreachable for
 *    new work, revocation propagation pending, recovery authority state);
 *  - trusted control routing: relay-carried recovery and operation-status
 *    messages terminate at the endpoint, and inner-channel JSON-RPC is
 *    dispatched to the governed kernel through `dispatchInnerMessage`;
 *  - SIGTERM/SIGINT drain: session-close, transport terminate, gateway drain.
 *
 * New work is never queued for later execution while unreachable: the surface
 * reports `endpoint_unreachable` and dispatch checks `session.acceptsNewWork`.
 * Nothing here interrupts healthy in-flight work on a timer — the only fixed
 * deadline is the operator-configured inner-TLS handshake bound.
 */

/** Runtime pieces the profile needs from the governed gateway composition. */
export interface GatewayRuntimeParts {
  readonly gateway: Gateway;
  readonly descriptors: readonly CatalogDescriptor[];
  readonly permits?: Pick<PermitAuthorityPort, "lookup">;
  /** Service ids the remote profile restricted publication to, when present. */
  readonly allowedServiceIds?: readonly string[];
}

export interface PrivateEndpointServeDeps {
  /** Defaults to the installer runtime (`createRuntime` over gateway.configPath). */
  readonly buildRuntime?: (config: RuntimeConfig, serverVersion: string, signal: AbortSignal) => Promise<GatewayRuntimeParts>;
  /** Defaults to the undici WebSocket client. */
  readonly socketFactory?: RelaySocketFactory;
  /** Endpoint identity/admission store; injectable for tests. */
  readonly identityStore?: EndpointIdentityStore;
  /** Readiness/state lines; defaults to process.stdout. */
  readonly writeLine?: (line: string) => void;
  /** Stop signal (SIGTERM/SIGINT wired by the CLI entry). */
  readonly signal?: AbortSignal;
  /** Timer injection for deterministic tests. */
  readonly schedule?: (fn: () => void, delayMs: number) => unknown;
  readonly cancelSchedule?: (handle: unknown) => void;
  /** Time source for surface bookkeeping. */
  readonly now?: () => number;
}

export interface PrivateEndpointServeResult {
  readonly profile: "private-endpoint";
  readonly outcome: "stopped" | "rejected" | "revoked" | "terminated";
  readonly code?: string;
  readonly detail?: string;
}

/**
 * Recovery signer backed by the configured endpoint recovery signing key.
 * Ed25519 signs with a null algorithm; RSA/EC keys use SHA-256. `sign` exists
 * for endpoint-side recovery acts (rotation); `verify` checks fresh-device
 * possession proofs under the public key presented in the proof.
 */
export function createPrivateEndpointRecoverySigner(signingKeyMaterial?: string): RecoverySigner {
  const key = signingKeyMaterial ? createPrivateKey(signingKeyMaterial) : undefined;
  return Object.freeze({
    sign(transcript: unknown): string {
      if (!key) {
        throw endpointConfigError("private_endpoint_recovery_signer_missing", "No recovery signing key is configured.");
      }
      const algorithm = key.asymmetricKeyType === "ed25519" ? null : "sha256";
      return cryptoSign(algorithm, Buffer.from(String(transcript), "utf8"), key).toString("base64url");
    },
    verify(input: { publicKey: string; signature: string; transcript: unknown }): boolean {
      try {
        const publicKey = input.publicKey.startsWith("-----BEGIN")
          ? createPublicKey(input.publicKey)
          : createPublicKey({ key: Buffer.from(input.publicKey, "base64url"), format: "der", type: "spki" });
        const algorithm = publicKey.asymmetricKeyType === "ed25519" ? null : "sha256";
        return cryptoVerify(algorithm, Buffer.from(String(input.transcript), "utf8"), publicKey, Buffer.from(input.signature, "base64url"));
      } catch {
        return false;
      }
    }
  });
}

/**
 * Honest outcome for an inner request that arrived while the endpoint had no
 * admitted device context — a pre-dispatch refusal the entry may retry.
 */
function innerUnavailableOutcome(detail: string): GatewayOutcome {
  return {
    kind: "failure",
    code: "endpoint_unreachable",
    message: detail,
    status: 503,
    effectOutcome: "not_started"
  } as GatewayOutcome;
}

/**
 * Bind the shared inner-wire dispatch loop (`@meshrix/entry-transport`) to one
 * established pinned-TLS channel. The loop owns newline framing, the
 * `{id, outcome}` response envelope, bounded response backpressure and channel
 * teardown; this binding only supplies the semantic dispatch — every request
 * runs `dispatchInnerMessage` under the admitted device's authenticated
 * context, and a thrown dispatch surfaces as the loop's honest
 * `endpoint_dispatch_failed` (`effectOutcome: "unknown"`) outcome.
 */
function attachInnerDispatch(
  owner: PrivateEndpoint,
  channel: InnerTlsChannel,
  authority: Pick<EndpointAuthorityPort, "contextFor">
): InnerDispatchLoop {
  return createInnerDispatchLoop({
    socket: channel.socket,
    async dispatch(message) {
      const device = owner.device;
      if (!device) return innerUnavailableOutcome("Endpoint device is not admitted.");
      const context = await authority.contextFor({ device });
      if (!context) return innerUnavailableOutcome("Endpoint authority denied the device.");
      return owner.dispatchInnerMessage(context, message);
    }
  });
}

/** Honest point-in-time surface for operators and the admin listener. */
export interface PrivateEndpointSurface {
  readonly profile: "private-endpoint";
  readonly session: string;
  readonly transport: string;
  readonly routeState: string;
  /** What a new call receives right now: "reachable" or "endpoint_unreachable". */
  readonly reachability: "reachable" | "endpoint_unreachable";
  readonly acceptsNewWork: boolean;
  readonly sessionId: string | null;
  readonly reconnectGeneration: number;
  /** Relay-acknowledged revocation revision from the last admission. */
  readonly admittedRevocationRevision: number | null;
  /** Endpoint owner's current local revocation revision. */
  readonly localRevocationRevision: number;
  readonly revocationPropagation: "applied" | "pending" | "unknown";
  readonly device: { readonly deviceId: string; readonly revoked: boolean; readonly trustGeneration: number } | null;
  readonly recoveryAuthorities: readonly { readonly recoveryKeyId: string; readonly state: string; readonly generation: number }[];
  readonly operationsTracked: number;
  readonly endpointRestarts: number;
  readonly droppedOutboundMessages: number;
}

/** Validate a private-endpoint configuration without connecting anywhere. */
export async function checkPrivateEndpoint(options: { readonly config?: string } = {}): Promise<Readonly<Record<string, unknown>>> {
  if (!options.config) throw endpointConfigError("private_endpoint_config_required", "Private endpoint check requires --config.");
  const config = await loadPrivateEndpointConfig(options.config);
  // The referenced gateway configuration is parsed with the same loader as
  // `serve` — it stays offline (no upstream contact, no listeners).
  const gateway = await loadConfig(config.gatewayConfigPath).catch((error: unknown) => {
    throw endpointConfigError(
      typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "private_endpoint_gateway_invalid",
      `Gateway configuration is not usable: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  return Object.freeze({
    profile: "private-endpoint",
    health: "ok",
    endpoint: Object.freeze({
      tenantId: config.admission.tenantId,
      deviceId: config.admission.deviceId,
      routeId: config.admission.routeId,
      mode: config.admission.mode,
      admissionGeneration: config.admission.admissionGeneration,
      revocationRevision: config.admission.revocationRevision
    }),
    relay: Object.freeze({ host: config.relayBaseUrl.host, secure: config.relayBaseUrl.protocol === "wss:" }),
    services: gateway.services.length,
    recoveryAuthorities: config.recovery.authorities.length
  });
}

/**
 * Serve the private-endpoint profile until the stop signal fires or a
 * terminal relay outcome (non-retryable rejection, revocation, protocol
 * failure) ends the run.
 */
export async function servePrivateEndpointProfile(
  configPath: string,
  deps: PrivateEndpointServeDeps = {}
): Promise<PrivateEndpointServeResult> {
  const config = await loadPrivateEndpointConfig(configPath);
  const gatewayConfig = await loadConfig(config.gatewayConfigPath).catch((error: unknown) => {
    throw endpointConfigError(
      typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "private_endpoint_gateway_invalid",
      `Gateway configuration is not usable: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  const schedule = deps.schedule ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
  const cancelSchedule = deps.cancelSchedule ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const writeLine = deps.writeLine ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const signal = deps.signal;

  const startup = new AbortController();
  const abortStartup = () => startup.abort();
  signal?.addEventListener("abort", abortStartup, { once: true });

  const builder = deps.buildRuntime ?? (async (loaded: RuntimeConfig, serverVersion: string, startupSignal: AbortSignal) => {
    const runtime = await createRuntime(loaded, serverVersion, startupSignal);
    return {
      gateway: runtime.gateway,
      descriptors: runtime.descriptors,
      permits: runtime.permits,
      ...(loaded.remoteAuth ? { allowedServiceIds: loaded.remoteAuth.allowedServiceIds } : {})
    };
  });
  const runtime = await builder(gatewayConfig, await packageVersion(), startup.signal);
  signal?.removeEventListener("abort", abortStartup);
  if (signal?.aborted) {
    await runtime.gateway.close({ drainDeadline: 1_000 }).catch(() => {});
    return Object.freeze({ profile: "private-endpoint" as const, outcome: "stopped" as const });
  }

  // The identity store is shared across endpoint rebuilds: enrollment and
  // revocations are endpoint authority state, never re-derived from the wire.
  const identity = deps.identityStore ?? createEndpointIdentityStore();
  identity.enroll({
    deviceId: config.admission.deviceId,
    routeId: config.admission.routeId,
    tenantId: config.admission.tenantId,
    trustBinding: config.trustBinding
  });
  for (const authority of config.recovery.authorities) {
    identity.enrollRecoveryAuthority(authority);
  }
  const recoverySigner = createPrivateEndpointRecoverySigner(config.recovery.signingKey);

  const allowedRoutes = Object.freeze(runtime.descriptors
    .filter((descriptor) => !runtime.allowedServiceIds || runtime.allowedServiceIds.includes(descriptor.route.upstreamIdentity))
    .map((descriptor) => descriptor.route.logicalRoute));
  const authority = {
    contextFor({ device }: { device: EndpointDeviceRecord }): AuthenticatedContext {
      return Object.freeze({
        tenant: device.tenantId,
        principal: device.principalRef,
        authGeneration: String(device.trustGeneration),
        grant: Object.freeze({ revision: String(device.admissionGeneration), routes: allowedRoutes })
      });
    }
  };

  const credential = process.env[config.credentialEnv]!;
  const transport = new RelayWebSocketTransport({
    url: config.sessionUrl,
    headers: { authorization: `Bearer ${credential}` },
    ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {})
  });

  let admission = config.admission;
  let endpoint = buildEndpoint(admission);
  let endpointRestarts = 0;
  let lastAdmitted: { admittedGeneration: number; revocationRevision: number } | null = null;
  let terminal: { outcome: PrivateEndpointServeResult["outcome"]; code: string; detail: string } | undefined;
  let reconnectAttempts = 0;
  let reconnectTimer: unknown;
  let needsRebuild = false;
  let stopping = false;
  let lastSurfaceJson = "";
  // Live inner dispatch loops, one per established pinned-TLS channel. A loop
  // dies with its channel's socket; the set only exists so finish() can bound
  // teardown without waiting on a peer.
  const innerLoops = new Set<InnerDispatchLoop>();

  function buildEndpoint(currentAdmission: RelayAdmissionInput): PrivateEndpoint {
    let created!: PrivateEndpoint;
    created = createPrivateGatewayEndpoint({
      gateway: runtime.gateway,
      identity,
      authority,
      recoverySigner,
      ...(runtime.permits ? { permits: runtime.permits } : {}),
      transport,
      admission: currentAdmission,
      innerTls: {
        key: config.innerTls.key,
        cert: config.innerTls.cert,
        ...(config.innerTls.handshakeTimeoutMs ? { handshakeTimeoutMs: config.innerTls.handshakeTimeoutMs } : {})
      },
      onInnerChannel(channel) {
        // Both admission and session-restore rebuilds land here; the loop is
        // bound to the endpoint generation that owns the channel so a stale
        // generation's late teardown can never steal a live dispatch.
        const loop = attachInnerDispatch(created, channel, authority);
        innerLoops.add(loop);
        channel.socket.once("close", () => innerLoops.delete(loop));
      }
    });
    return created;
  }

  function surface(): PrivateEndpointSurface {
    const device = endpoint.device;
    const reachable = endpoint.session.acceptsNewWork && transport.state === "open";
    const admittedRevision = lastAdmitted?.revocationRevision ?? null;
    const localRevision = identity.revocationRevision(config.admission.tenantId);
    return Object.freeze({
      profile: "private-endpoint",
      session: endpoint.session.state,
      transport: transport.state,
      routeState: endpoint.session.routeState,
      reachability: reachable ? "reachable" : "endpoint_unreachable",
      acceptsNewWork: reachable,
      sessionId: endpoint.session.sessionId,
      reconnectGeneration: endpoint.session.reconnectGeneration,
      admittedRevocationRevision: admittedRevision,
      localRevocationRevision: localRevision,
      revocationPropagation: admittedRevision === null ? "unknown" : localRevision > admittedRevision ? "pending" : "applied",
      device: device ? Object.freeze({ deviceId: device.deviceId, revoked: device.revoked, trustGeneration: device.trustGeneration }) : null,
      recoveryAuthorities: Object.freeze(identity.recoveryAuthorities().map((record) => Object.freeze({ recoveryKeyId: record.recoveryKeyId, state: record.state, generation: record.generation }))),
      operationsTracked: endpoint.operationRecovery.ledger.size(),
      endpointRestarts,
      droppedOutboundMessages: transport.droppedSends
    });
  }

  function emitSurface(): void {
    const json = JSON.stringify(surface());
    if (json !== lastSurfaceJson) {
      lastSurfaceJson = json;
      writeLine(json);
    }
  }

  function openIntent(): void {
    const state = endpoint.session.state;
    if (state === "initiated") {
      endpoint.open();
    } else if (state === "closed" && endpoint.session.sessionId !== null) {
      // A session that admitted before can reconnect with its cursors; one
      // that never carried an admission has nothing to restore — rebuild so
      // the relay sees a fresh session-open instead of a doomed reconnect.
      endpoint.reconnect();
    } else if (state === "closed") {
      needsRebuild = false;
      endpointRestarts += 1;
      transport.resetQueue();
      endpoint = buildEndpoint(admission);
      endpoint.open();
    }
  }

  function scheduleReconnect(): void {
    if (stopping || terminal || reconnectTimer !== undefined) return;
    const delay = Math.min(config.reconnect.maxDelayMs, config.reconnect.initialDelayMs * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      if (terminal) { void finish(terminal); return; }
      if (stopping) return;
      beginConnect();
    }, delay);
  }

  function beginConnect(): void {
    if (needsRebuild) {
      needsRebuild = false;
      endpointRestarts += 1;
      transport.resetQueue();
      endpoint = buildEndpoint(admission);
    }
    if (transport.connect()) {
      // Issue the session intent immediately: while the socket is still
      // connecting, sends queue inside this generation and flush on open —
      // a pre-open failure simply retries the same intent on the next socket.
      openIntent();
    } else if (transport.state === "closed") {
      scheduleReconnect();
    }
  }

  function onRelayMessage(message: unknown): void {
    const kind = typeof message === "object" && message !== null && !Array.isArray(message)
      ? (message as { kind?: unknown }).kind
      : undefined;
    // Feed the driver first; supervisor reactions are gated on the state the
    // driver actually reached — a malformed admit/reject must never be
    // honored as if the session had really transitioned.
    endpoint.handleRelayMessage(message);
    const sessionState = endpoint.session.state;
    if (kind === "session-admitted" && (sessionState === "admitted" || sessionState === "streaming")) {
      reconnectAttempts = 0;
      lastAdmitted = {
        admittedGeneration: Number((message as { admittedGeneration?: unknown }).admittedGeneration ?? 0),
        revocationRevision: Number((message as { revocationRevision?: unknown }).revocationRevision ?? 0)
      };
    } else if (kind === "session-restored" && sessionState === "admitted") {
      reconnectAttempts = 0;
    } else if (kind === "session-rejected" && sessionState === "rejected") {
      const reason = String((message as { reason?: unknown }).reason ?? "unknown");
      const retryable = (message as { retryable?: unknown }).retryable === true;
      const expected = Number((message as { expectedRevocationRevision?: unknown }).expectedRevocationRevision);
      if (retryable) {
        // Re-present with the relay-expected revocation revision on a fresh
        // session driver — the rejected one is terminal by contract.
        if (Number.isSafeInteger(expected)) {
          admission = Object.freeze({ ...admission, revocationRevision: expected });
        }
        needsRebuild = true;
        // The relay closes the socket after a rejection; make sure of it so
        // the retry does not wait on a peer that never follows through.
        transport.close();
      } else {
        terminal = { outcome: "rejected", code: "private_endpoint_admission_rejected", detail: reason };
      }
    } else if (kind === "session-close" && sessionState === "closed") {
      const closeReason = String((message as { reason?: unknown }).reason ?? "");
      if (closeReason === "revoked") {
        terminal = { outcome: "revoked", code: "private_endpoint_revoked", detail: "The relay closed the session as revoked." };
      } else if (closeReason === "protocol_error" || closeReason === "capacity_exceeded") {
        terminal = { outcome: "terminated", code: "private_endpoint_session_failed", detail: `The relay closed the session: ${closeReason}.` };
      }
    }
    if (terminal) {
      // Let the driver settle the close handshake, then end the run.
      transport.close();
      if (transport.state === "closed") void finish(terminal);
    }
    emitSurface();
  }

  function onSocketDown(detail: { hadOpened: boolean }): void {
    const state = endpoint.session.state;
    if (state === "admitted" || state === "streaming" || state === "open_sent") {
      // Preserve cursors for an honest reconnect; the session-close this emits
      // is dropped by the dead transport — the relay already saw the socket die.
      endpoint.session.close("reconnect");
    } else if (state === "reconnecting" || state === "closing") {
      // The driver cannot leave `reconnecting` without a relay answer that died
      // with the socket, and a `closing` session only reaches `closed` through
      // the close handshake. Both rebuild rather than wedge or invent state.
      needsRebuild = true;
    }
    emitSurface();
    if (stopping || terminal) {
      void finish(terminal);
      return;
    }
    scheduleReconnect();
  }

  let finishResolve: (result: PrivateEndpointServeResult) => void = () => {};
  const finished = new Promise<PrivateEndpointServeResult>((resolve) => {
    finishResolve = resolve;
  });
  let done = false;
  let adminServer: Server | undefined;
  async function finish(outcome: typeof terminal): Promise<void> {
    if (done) return;
    done = true;
    if (reconnectTimer !== undefined) cancelSchedule(reconnectTimer);
    for (const loop of innerLoops) loop.close();
    innerLoops.clear();
    try {
      endpoint.close("normal");
    } catch { /* closing is best-effort */ }
    transport.terminate();
    if (adminServer) await new Promise<void>((resolve) => adminServer!.close(() => resolve()));
    await runtime.gateway.close({ drainDeadline: 5_000 }).catch(() => {});
    finishResolve(Object.freeze({
      profile: "private-endpoint" as const,
      outcome: outcome?.outcome ?? "stopped" as const,
      ...(outcome ? { code: outcome.code, detail: outcome.detail } : {})
    }));
  }

  // --- optional loopback admin/state surface ------------------------------
  if (config.adminListen) {
    adminServer = createServer((request, response) => {
      if (request.url === "/status" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(`${JSON.stringify(surface())}\n`);
        return;
      }
      if (request.url === "/healthz" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ status: stopping ? "stopping" : "ok" }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      adminServer!.once("error", reject);
      adminServer!.listen(config.adminListen!.port, config.adminListen!.host, resolve);
    });
  }

  transport.setHandlers({ onMessage: onRelayMessage, onDown: onSocketDown, onOpen: emitSurface });
  beginConnect();
  emitSurface();

  const onStop = () => { stopping = true; void finish(undefined); };
  signal?.addEventListener("abort", onStop, { once: true });
  try {
    return await finished;
  } finally {
    signal?.removeEventListener("abort", onStop);
  }
}

/** CLI entry: wire process signals and run until stop or a terminal outcome. */
export async function servePrivateEndpoint(configPath?: string): Promise<void> {
  if (!configPath) throw endpointConfigError("private_endpoint_config_required", "Private endpoint serve requires --config.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const result = await servePrivateEndpointProfile(configPath, { signal: controller.signal });
    if (result.outcome !== "stopped") {
      throw endpointConfigError(result.code ?? "private_endpoint_failed", result.detail ?? `Private endpoint ended: ${result.outcome}.`);
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
