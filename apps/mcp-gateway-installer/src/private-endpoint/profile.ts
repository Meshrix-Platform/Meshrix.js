import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify, X509Certificate } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { isPairingPeerIdentity, type AccountActionTarget, type AccountAuthorityBinding, type AccountDeviceCurrentBindingResponse } from "@meshrix/contracts/account";
import type { AuthenticatedContext, CatalogDescriptor, CurrentAuthorityPort, Gateway, GatewayOutcome, PermitAuthorityPort, RouteSnapshot } from "@meshrix/contracts/gateway";
import { PRIVATE_RELAY_SESSION_STATES, PRIVATE_RELAY_REJECT_REASONS, peerIdForRouteDevice } from "@meshrix/contracts/private-relay";
import { createInnerDispatchLoop, isPeerSchemaMessage, type InnerDispatchLoop } from "@meshrix/entry-transport";
import {
  createEndpointIdentityStore,
  accountDeviceAuthorizationMatches,
  EndpointAccountPairingApplication,
  createPrivateGatewayEndpoint,
  AccountEndpointAuthorityClient,
  createFileEndpointIdentityDurablePort,
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
import { EndpointPeerRuntime, stablePeerCode } from "./peer.ts";
import { RelayWebSocketTransport, type RelaySocketFactory } from "./transport.ts";

export { claimManagedEndpoint } from "./claim.ts";
export type { ClaimManagedEndpointOptions, ClaimManagedEndpointProgress, ClaimManagedEndpointResult } from "./claim.ts";

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
  readonly buildRuntime?: (config: RuntimeConfig, serverVersion: string, signal: AbortSignal, composition?: { readonly currentAuthority?: CurrentAuthorityPort }) => Promise<GatewayRuntimeParts>;
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

function innerDeniedOutcome(detail: string): GatewayOutcome {
  return {
    kind: "failure",
    code: "account_authority_denied",
    message: detail,
    status: 403,
    effectOutcome: "not_started"
  } as GatewayOutcome;
}

interface InnerPeerBinding {
  readonly peerSessionId: string;
  readonly peerSpki: string;
  readonly pairingOnly: boolean;
  readonly device?: EndpointDeviceRecord;
}

function isPairingMethod(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" && method.startsWith("meshrix/pairing/");
}

function isAccountAuthorityNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "not_found";
}

function isAccountAuthorityDenied(error: unknown): boolean {
  return isRecord(error) && error.code === "forbidden";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  authority: Pick<EndpointAuthorityPort, "contextFor">,
  peer: InnerPeerBinding,
  accountAuthority?: AccountEndpointAuthorityClient
): InnerDispatchLoop {
  return createInnerDispatchLoop({
    socket: channel.socket,
    async dispatch(message) {
      if (peer.pairingOnly) {
        if (!isPairingMethod(message)) return innerDeniedOutcome("The provisional channel only permits account pairing methods.");
        return owner.dispatchAccountMessage({
          peerSessionId: peer.peerSessionId,
          pairingOnly: true,
          message
        });
      }
      if (isPairingMethod(message)) {
        return owner.dispatchAccountMessage({
          peerSessionId: peer.peerSessionId,
          pairingOnly: false,
          ...(peer.device ? { device: peer.device } : {}),
          message
        });
      }
      const device = peer.device;
      if (!device) return innerUnavailableOutcome("Endpoint device is not admitted.");
      if (accountAuthority && (!device.accountBinding || device.role !== "entry")) {
        return innerDeniedOutcome("This account-managed endpoint only admits devices with a current account grant.");
      }
      let context = await authority.contextFor({ device });
      if (!context) return innerUnavailableOutcome("Endpoint authority denied the device.");
      if (device.accountBinding) {
        if (!accountAuthority) return innerDeniedOutcome("Managed account authority is unavailable.");
        let current: AccountDeviceCurrentBindingResponse | null;
        try { current = await accountAuthority.currentDeviceAuthorization(device.deviceId); }
        catch (error) {
          if (isAccountAuthorityNotFound(error) || isAccountAuthorityDenied(error)) {
            return innerDeniedOutcome("The account authority no longer authorizes this device.");
          }
          return innerUnavailableOutcome("The account authority could not be reached; the request was not started.");
        }
        if (!accountDeviceAuthorizationMatches({ response: current, binding: device.accountBinding, device })) {
          return innerDeniedOutcome("The device grant is no longer current.");
        }
        context = Object.freeze({
          ...context,
          grant: Object.freeze({ ...context.grant, routes: Object.freeze([...new Set(current!.authorizedScopes)]) }),
          metadata: Object.freeze({
            ...(context.metadata ?? {}),
            accountId: device.accountBinding.accountId,
            authEpoch: device.accountBinding.authEpoch,
            deviceId: device.deviceId
          })
        });
      }
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
  /** Peer messaging block — `enabled:false` when the optional peer config is absent. */
  readonly peer: { readonly enabled: boolean; readonly peerId: string | null; readonly live: boolean };
}

/** Already-tracked counters the exposition needs beyond the `/status` surface. */
export interface EndpointMetricsExtras {
  /** Outbound messages queued behind a still-connecting socket generation. */
  readonly transportQueuedMessages?: number;
  /** Transport socket generation (connect attempts since profile start). */
  readonly transportGeneration?: number;
}

interface EndpointMetricSpec {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge";
  readonly samples: readonly { readonly labels?: Readonly<Record<string, string>>; readonly value: number }[];
}

function metricLabelValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"").replace(/\n/gu, "\\n");
}

function metricStateSamples<T extends string>(states: readonly T[], current: string): { labels: { state: string }; value: number }[] {
  return states.map((state) => ({ labels: { state }, value: state === current ? 1 : 0 }));
}

const TRANSPORT_STATES = Object.freeze(["idle", "connecting", "open", "closed"]);

/**
 * Prometheus text exposition (v0.0.4) of the endpoint's existing counters.
 *
 * This is a narrow read of the same point-in-time surface `GET /status`
 * emits, plus the transport's already-tracked queue/generation counters.
 * Metrics do not scan peer history or add per-operation instrumentation;
 * added, and the output carries only counters and bounded enum labels —
 * never payloads, plaintext, key or digest material, tokens, session ids,
 * device ids or peer ids.
 */
export function renderEndpointMetrics(surface: PrivateEndpointSurface, extras: EndpointMetricsExtras = {}): string {
  const specs: EndpointMetricSpec[] = [
    {
      name: "meshrix_endpoint_session_state",
      help: "Private-relay session driver state; the active state carries value 1.",
      type: "gauge",
      samples: metricStateSamples(PRIVATE_RELAY_SESSION_STATES, surface.session)
    },
    {
      name: "meshrix_endpoint_transport_state",
      help: "Relay transport socket state; the active state carries value 1.",
      type: "gauge",
      samples: metricStateSamples(TRANSPORT_STATES, surface.transport)
    },
    {
      name: "meshrix_endpoint_accepts_new_work",
      help: "Whether a new call would dispatch right now (1 = reachable, 0 = endpoint_unreachable).",
      type: "gauge",
      samples: [{ value: surface.acceptsNewWork ? 1 : 0 }]
    },
    {
      name: "meshrix_endpoint_reconnect_generation",
      help: "Reconnect generation acknowledged by the relay for the current session.",
      type: "gauge",
      samples: [{ value: surface.reconnectGeneration }]
    },
    {
      name: "meshrix_endpoint_operations_tracked",
      help: "Operations currently tracked by the endpoint recovery ledger.",
      type: "gauge",
      samples: [{ value: surface.operationsTracked }]
    },
    {
      name: "meshrix_endpoint_restarts_total",
      help: "Endpoint session-driver rebuilds since this profile run started.",
      type: "counter",
      samples: [{ value: surface.endpointRestarts }]
    },
    {
      name: "meshrix_endpoint_dropped_outbound_messages_total",
      help: "Outbound relay messages dropped because no live socket generation could carry them.",
      type: "counter",
      samples: [{ value: surface.droppedOutboundMessages }]
    },
    {
      name: "meshrix_endpoint_local_revocation_revision",
      help: "Endpoint owner's current local revocation revision.",
      type: "gauge",
      samples: [{ value: surface.localRevocationRevision }]
    }
  ];
  if (surface.admittedRevocationRevision !== null) {
    specs.push({
      name: "meshrix_endpoint_admitted_revocation_revision",
      help: "Revocation revision the relay acknowledged with the last admission.",
      type: "gauge",
      samples: [{ value: surface.admittedRevocationRevision }]
    });
  }
  if (extras.transportQueuedMessages !== undefined) {
    specs.push({
      name: "meshrix_endpoint_transport_queued_messages",
      help: "Outbound messages queued behind a still-connecting socket generation.",
      type: "gauge",
      samples: [{ value: extras.transportQueuedMessages }]
    });
  }
  if (extras.transportGeneration !== undefined) {
    specs.push({
      name: "meshrix_endpoint_transport_generation",
      help: "Transport socket generation (connect attempts since profile start).",
      type: "gauge",
      samples: [{ value: extras.transportGeneration }]
    });
  }
  if (surface.device !== null) {
    specs.push({
      name: "meshrix_endpoint_device_trust_generation",
      help: "Trust generation of the admitted endpoint device.",
      type: "gauge",
      samples: [{ value: surface.device.trustGeneration }]
    });
  }
  if (surface.peer.enabled) {
    specs.push({
      name: "meshrix_endpoint_peer_live",
      help: "Whether the peer channel currently rides a live admitted session (1 = live).",
      type: "gauge",
      samples: [{ value: surface.peer.live ? 1 : 0 }]
    });
  }
  const lines: string[] = [];
  for (const spec of specs) {
    lines.push(`# HELP ${spec.name} ${spec.help}`);
    lines.push(`# TYPE ${spec.name} ${spec.type}`);
    for (const sample of spec.samples) {
      const labels = sample.labels === undefined
        ? ""
        : `{${Object.entries(sample.labels).map(([key, value]) => `${key}="${metricLabelValue(value)}"`).join(",")}}`;
      lines.push(`${spec.name}${labels} ${sample.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Validate a private-endpoint configuration without connecting anywhere. */
export async function checkPrivateEndpoint(options: { readonly config?: string } = {}): Promise<Readonly<Record<string, unknown>>> {
  if (!options.config) throw endpointConfigError("private_endpoint_config_required", "Private endpoint check requires --config.");
  const config = await loadPrivateEndpointConfig(options.config);
  // The referenced gateway configuration is parsed with the same loader as
  // `serve` — it stays offline (no upstream contact, no listeners).
  const gateway = await loadConfig(config.gatewayConfigPath).catch((error: unknown) => {
    throw endpointConfigError(
      "private_endpoint_gateway_invalid",
      "Gateway configuration is not usable."
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
    recoveryAuthorities: config.recovery.authorities.length,
    ...(config.adminListen ? { admin: Object.freeze({
      listen: config.adminListen,
      credential: config.adminTokenFile ? { file: config.adminTokenFile } : { environment: config.adminTokenEnv }
    }) } : {}),
    peer: config.peer
      ? Object.freeze({ enabled: true, peerId: config.peer.peerId ?? null, storageDir: config.peer.storageDir })
      : Object.freeze({ enabled: false })
  });
}

const MAX_ADMIN_ORIGIN_BYTES = 2048;

/** Same origin shape as `createEntryMcpLoopbackHttp`: one http(s) origin, no userinfo or path. */
function normalizeAdminOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ADMIN_ORIGIN_BYTES || Buffer.byteLength(value, "utf8") > MAX_ADMIN_ORIGIN_BYTES || !/^https?:\/\/[^/?#]+$/iu.test(value)) return undefined;
  try {
    const origin = new URL(value);
    if (value.includes("@") || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return undefined;
    return origin.origin;
  } catch {
    return undefined;
  }
}

/** Duplicate or unparseable Origin is invalid. A missing Origin is absent (non-browser clients). */
function adminRequestOrigin(request: IncomingMessage): string | "absent" | "invalid" {
  let found = false;
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== "origin") continue;
    if (found) return "invalid";
    found = true;
    value = request.rawHeaders[index + 1];
  }
  if (!found) return "absent";
  return normalizeAdminOrigin(value) ?? "invalid";
}

function isAllowedLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
  } catch {
    return false;
  }
}

function adminRequestHost(request: IncomingMessage): string | "absent" | "invalid" {
  let found = false;
  let value = "";
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== "host") continue;
    if (found) return "invalid";
    found = true;
    value = request.rawHeaders[index + 1] ?? "";
  }
  if (!found) return "absent";
  if (!value) return "invalid";
  return value;
}

function adminHostAllowed(value: string, boundHost: string, boundPort: number): boolean {
  if (value.length > 255 || value.includes("@") || /[\s/\\?#]/u.test(value)) return false;
  const host = value.toLowerCase();
  if (host === `localhost:${boundPort}` || (boundPort === 80 && host === "localhost")) return true;
  if (boundHost === "::1") {
    return host === `[::1]:${boundPort}` || (boundPort === 80 && host === "[::1]");
  }
  return host === `${boundHost.toLowerCase()}:${boundPort}` || (boundPort === 80 && host === boundHost.toLowerCase());
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
      "private_endpoint_gateway_invalid",
      "Gateway configuration is not usable."
    );
  });
  const schedule = deps.schedule ?? ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
  const cancelSchedule = deps.cancelSchedule ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const writeLine = deps.writeLine ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const signal = deps.signal;

  const startup = new AbortController();
  const abortStartup = () => startup.abort();
  signal?.addEventListener("abort", abortStartup, { once: true });

  // Durable endpoint trust is loaded before gateway composition so a managed
  // profile can inject the same current-authority check used by the remote
  // device path into the kernel's pre-effect boundary.
  const identity = deps.identityStore ?? createEndpointIdentityStore(
    createFileEndpointIdentityDurablePort(join(dirname(configPath), ".meshrix-private-endpoint-state.json"))
  );
  const storedEndpoint = identity.device(config.admission.deviceId);
  if (!storedEndpoint) {
    identity.enroll({
      deviceId: config.admission.deviceId,
      routeId: config.admission.routeId,
      tenantId: config.admission.tenantId,
      trustBinding: config.trustBinding
    });
  } else if (storedEndpoint.routeId !== config.admission.routeId
    || storedEndpoint.tenantId !== config.admission.tenantId
    || storedEndpoint.role !== "endpoint"
    || storedEndpoint.pairedIdentityKey !== String(config.trustBinding.pairedIdentityKey)
    || storedEndpoint.pairedIdentityFingerprint !== String(config.trustBinding.pairedIdentityFingerprint)) {
    throw endpointConfigError("private_endpoint_identity_conflict", "Persisted endpoint trust does not match this configuration.");
  }
  if (storedEndpoint?.accountBinding && !config.account) {
    throw endpointConfigError("private_endpoint_account_downgrade", "An account-managed endpoint cannot start without its account authority configuration.");
  }
  if (config.account && config.recovery.authorities.length > 0) {
    throw endpointConfigError("private_endpoint_account_recovery_conflict", "Managed-account endpoints cannot configure independent endpoint recovery authorities.");
  }

  const accountAuthority = config.account
    ? new AccountEndpointAuthorityClient({
        origin: config.account.origin,
        tenantId: config.admission.tenantId,
        routeId: config.admission.routeId,
        deviceId: config.admission.deviceId,
        signingKey: createPrivateKey(config.account.signingKey)
      })
    : undefined;
  if (accountAuthority && config.account) {
    let managedRoute;
    try { managedRoute = await accountAuthority.managedRoute(); }
    catch (error) {
      throw endpointConfigError("account_authority_unavailable", "Managed account authority could not be reached.");
    }
    const endpointSigningKey = createPrivateKey(config.account.signingKey);
    const endpointPublicKey = createPublicKey(endpointSigningKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    const endpointPinRef = createHash("sha256")
      .update(new X509Certificate(config.innerTls.cert).publicKey.export({ format: "der", type: "spki" }))
      .digest("base64url");
    if (!managedRoute || managedRoute.tenantId !== config.admission.tenantId
      || managedRoute.routeId !== config.admission.routeId
      || managedRoute.endpointDeviceId !== config.admission.deviceId
      || managedRoute.endpointPublicKey !== endpointPublicKey
      || managedRoute.endpointPinRef !== endpointPinRef
      || managedRoute.endpointPinRef !== config.account.endpointPinRef
      || managedRoute.vaultId !== config.account.vaultId) {
      if (storedEndpoint?.accountBinding && managedRoute?.accountId === storedEndpoint.accountBinding.accountId
        && managedRoute.authEpoch > storedEndpoint.accountBinding.authEpoch) {
        identity.revokeAccountEpoch(managedRoute.accountId, managedRoute.authEpoch);
      }
      throw endpointConfigError("account_endpoint_not_current", "This endpoint is not currently authorized by its account owner.");
    }
    const boundEndpoint = identity.bindAccountEndpoint({
      deviceId: config.admission.deviceId,
      account: { accountId: managedRoute.accountId, authEpoch: managedRoute.authEpoch }
    });
    if (boundEndpoint.revoked) {
      throw endpointConfigError("account_endpoint_reenrollment_required", "Account recovery revoked this endpoint; it must be explicitly re-enrolled before serving.");
    }
  }

  const recoverySigner = createPrivateEndpointRecoverySigner(config.recovery.signingKey);
  for (const authority of config.account ? [] : config.recovery.authorities) {
    identity.enrollRecoveryAuthority(authority);
  }

  const currentAuthority: CurrentAuthorityPort | undefined = accountAuthority ? Object.freeze({
    async read({ context, route }: { readonly context: AuthenticatedContext; readonly route: RouteSnapshot }): Promise<AuthenticatedContext> {
      const metadata = context.metadata;
      const deviceId = metadata && typeof metadata.deviceId === "string" ? metadata.deviceId : undefined;
      const accountId = metadata && typeof metadata.accountId === "string" ? metadata.accountId : undefined;
      const authEpoch = metadata && Number.isSafeInteger(metadata.authEpoch) ? Number(metadata.authEpoch) : undefined;
      // Local operator/self-hosted gateway contexts retain their independent
      // configured authority. Account-bound Entry contexts always carry these
      // facts from the endpoint's enrolled identity record.
      if (!deviceId || !accountId || authEpoch === undefined) return context;
      const device = identity.device(deviceId);
      if (!device?.accountBinding || device.accountBinding.accountId !== accountId || device.accountBinding.authEpoch !== authEpoch) {
        throw endpointConfigError("account_device_stale", "The device account epoch is no longer current.");
      }
      const live = await accountAuthority.currentDeviceAuthorization(deviceId);
      if (!accountDeviceAuthorizationMatches({ response: live, binding: device.accountBinding, device, scope: route.logicalRoute })) {
        if (live?.account.accountId === device.accountBinding.accountId && live.account.authEpoch > device.accountBinding.authEpoch) {
          identity.revokeAccountEpoch(live.account.accountId, live.account.authEpoch);
        }
        throw endpointConfigError("account_device_revoked", "The account no longer authorizes this device for the requested route.");
      }
      return Object.freeze({
        ...context,
        grant: Object.freeze({ ...context.grant, routes: Object.freeze([...new Set(live!.authorizedScopes)]) })
      });
    }
  }) : undefined;

  const builder = deps.buildRuntime ?? (async (loaded: RuntimeConfig, serverVersion: string, startupSignal: AbortSignal, composition?: { readonly currentAuthority?: CurrentAuthorityPort }) => {
    const runtime = await createRuntime(loaded, serverVersion, startupSignal, composition);
    return {
      gateway: runtime.gateway,
      descriptors: runtime.descriptors,
      permits: runtime.permits,
      ...(loaded.remoteAuth ? { allowedServiceIds: loaded.remoteAuth.allowedServiceIds } : {})
    };
  });
  const runtime = await builder(gatewayConfig, await packageVersion(), startup.signal, currentAuthority ? { currentAuthority } : undefined);
  signal?.removeEventListener("abort", abortStartup);
  if (signal?.aborted) {
    await runtime.gateway.close({ drainDeadline: 1_000 }).catch(() => {});
    return Object.freeze({ profile: "private-endpoint" as const, outcome: "stopped" as const });
  }

  const allowedRoutes = Object.freeze(runtime.descriptors
    .filter((descriptor) => !runtime.allowedServiceIds || runtime.allowedServiceIds.includes(descriptor.route.upstreamIdentity))
    .map((descriptor) => descriptor.route.logicalRoute));
  const authority = {
    contextFor({ device }: { device: EndpointDeviceRecord }): AuthenticatedContext {
      const routes = device.accountBinding
        ? allowedRoutes.filter((route) => device.accountScopes?.includes(route))
        : allowedRoutes;
      return Object.freeze({
        tenant: device.tenantId,
        principal: device.principalRef,
        authGeneration: String(device.trustGeneration),
        grant: Object.freeze({ revision: String(device.admissionGeneration), routes }),
        ...(device.accountBinding ? { metadata: Object.freeze({
          accountId: device.accountBinding.accountId,
          authEpoch: device.accountBinding.authEpoch,
          deviceId: device.deviceId
        }) } : {})
      });
    }
  };

  const transport = new RelayWebSocketTransport({
    url: config.sessionUrl,
    headers: { authorization: `Bearer ${config.relayCredential}` },
    ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {})
  });

  let admission = Object.freeze({
    ...config.admission,
    revocationRevision: Math.max(config.admission.revocationRevision, identity.revocationRevision(config.admission.tenantId))
  });
  const accountPairing = config.account && accountAuthority
    ? new EndpointAccountPairingApplication({
        identity,
        authority: accountAuthority,
        proof: accountAuthority,
        invite: Object.freeze({
          tenantId: config.admission.tenantId,
          routeId: config.admission.routeId,
          endpointDeviceId: config.admission.deviceId,
          endpointPinRef: config.account.endpointPinRef,
          endpointSpkiPin: config.account.endpointSpkiPin,
          endpointPrincipalRef: String(config.trustBinding.endpointPrincipalRef),
          relayService: config.relayBaseUrl.toString(),
          vaultId: config.account.vaultId,
          mode: config.admission.mode as "personal" | "enterprise",
          recoveryAuthority: null
        }),
        availableScopes: allowedRoutes
      })
    : undefined;
  let endpoint = buildEndpoint(admission);

  // --- optional peer messaging ----------------------------------------------
  // The peer runtime shares the SAME admitted forward session: outbound peer
  // requests ride `transport.send` behind an admission gate reading the live
  // endpoint binding, and inbound peer-schema messages are demuxed in
  // `onRelayMessage` before the session driver ever sees them. Absent config
  // means the stack is never started and peer kinds are ignored by contract.
  const peer = config.peer === undefined
    ? null
    : await EndpointPeerRuntime.create({
        peer: config.peer,
        route: {
          tenantId: config.admission.tenantId,
          routeId: config.admission.routeId,
          deviceId: config.admission.deviceId
        },
        send: (message) => transport.send(message),
        resolvePeerIdentity: async (peerDeviceId) => {
          const paired = identity.device(peerDeviceId);
          const ownBinding = identity.device(config.admission.deviceId)?.accountBinding;
          const expectedPeerId = paired
            ? peerIdForRouteDevice({ tenantId: paired.tenantId, routeId: paired.routeId, deviceId: paired.deviceId })
            : null;
          if (!paired || paired.role !== "entry" || paired.revoked
            || paired.tenantId !== config.admission.tenantId || paired.routeId !== config.admission.routeId
            || !expectedPeerId || !isPairingPeerIdentity(paired.entryPeerIdentity, expectedPeerId)) {
            return null;
          }
          if (ownBinding) {
            if (!accountAuthority || !paired.accountBinding
              || paired.accountBinding.accountId !== ownBinding.accountId
              || paired.accountBinding.authEpoch !== ownBinding.authEpoch) return null;
          } else if (paired.accountBinding) {
            return null;
          }
          return Object.freeze({ ...paired.entryPeerIdentity });
        },
        sessionLive: () => {
          const state = endpoint.session.state;
          return state === "admitted" || state === "streaming";
        }
      });

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
      ...(accountPairing ? { accountPairing } : {}),
      transport,
      admission: currentAdmission,
      innerTls: {
        key: config.innerTls.key,
        cert: config.innerTls.cert,
        ...(config.innerTls.handshakeTimeoutMs ? { handshakeTimeoutMs: config.innerTls.handshakeTimeoutMs } : {})
      },
      onInnerChannel(channel, peerBinding) {
        // Both admission and session-restore rebuilds land here; the loop is
        // bound to the endpoint generation that owns the channel so a stale
        // generation's late teardown can never steal a live dispatch.
        const loop = attachInnerDispatch(created, channel, authority, peerBinding, accountAuthority);
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
      droppedOutboundMessages: transport.droppedSends,
      peer: Object.freeze({
        enabled: peer !== null,
        peerId: peer?.peerId ?? null,
        live: peer !== null && (endpoint.session.state === "admitted" || endpoint.session.state === "streaming")
      })
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
    // Peer message kinds never reach the session driver — they are
    // request/response traffic on the same admitted channel and land on the
    // peer client's own parser/correlator.
    if (isPeerSchemaMessage(message)) {
      peer?.handleInbound(message);
      return;
    }
    const kind = typeof message === "object" && message !== null && !Array.isArray(message)
      ? (message as { kind?: unknown }).kind
      : undefined;
    // Feed the driver first; supervisor reactions are gated on the state the
    // driver actually reached — a malformed admit/reject must never be
    // honored as if the session had really transitioned.
    endpoint.handleRelayMessage(message);
    const sessionState = endpoint.session.state;
    if (kind === "session-admitted" && (sessionState === "admitted" || sessionState === "streaming")) {
      peer?.onSessionLive();
      reconnectAttempts = 0;
      lastAdmitted = {
        admittedGeneration: Number((message as { admittedGeneration?: unknown }).admittedGeneration ?? 0),
        revocationRevision: Number((message as { revocationRevision?: unknown }).revocationRevision ?? 0)
      };
    } else if (kind === "session-restored" && sessionState === "admitted") {
      reconnectAttempts = 0;
      peer?.onSessionLive();
    } else if (kind === "session-rejected" && sessionState === "rejected") {
      peer?.onSessionDown();
      const offeredReason = (message as { reason?: unknown }).reason;
      const reason = typeof offeredReason === "string" && (PRIVATE_RELAY_REJECT_REASONS as readonly string[]).includes(offeredReason)
        ? offeredReason : "unknown";
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
      peer?.onSessionDown();
      const closeReason = String((message as { reason?: unknown }).reason ?? "");
      if (closeReason === "revoked") {
        terminal = { outcome: "revoked", code: "private_endpoint_revoked", detail: "The relay closed the session as revoked." };
      } else if (closeReason === "protocol_error") {
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
    peer?.onSessionDown();
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
    if (peer) await peer.close().catch(() => {});
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
  // `admin.listen` always requires a bearer. The header is hashed before
  // comparison (same pattern as the entry product's loopback server) so the
  // token itself is never stored and mismatched lengths cannot short-circuit
  // the equality check. There is no path that serves the listener without it.
  const adminToken = config.adminToken;
  if ((config.adminListen || config.adminTokenEnv !== undefined) && !adminToken) {
    throw endpointConfigError("private_endpoint_credential_missing", "Admin bearer credential is unavailable.");
  }
  const adminAuthHash = adminToken === undefined ? undefined : createHash("sha256").update(`Bearer ${adminToken}`).digest();
  const adminSocket = {
    host: config.adminListen?.host ?? "127.0.0.1",
    port: config.adminListen?.port ?? 0
  };
  const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body ?? null);
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(payload) });
    response.end(payload);
  };
  const sendText = (response: ServerResponse, status: number, body: string): void => {
    response.writeHead(status, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  };
  const readJsonBody = (request: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> => new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        rejectPromise(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolvePromise(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectPromise(Object.assign(new Error("request body is not valid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", rejectPromise);
  });

  /**
   * Loopback admin routes — the endpoint operator surface.
   * Peer ops exist only when `peer.enabled` activated the runtime; disabled
   * peers answer 404 `peer_disabled` rather than a generic not-found.
   */
  async function handleAdminRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = adminRequestOrigin(request);
    if (origin === "invalid" || (origin !== "absent" && !isAllowedLoopbackOrigin(origin))) {
      sendJson(response, 403, { error: "admin_origin_rejected", message: "Admin request origin is not an allowed loopback origin." });
      return;
    }
    const host = adminRequestHost(request);
    if (host === "absent" || host === "invalid" || !adminHostAllowed(host, adminSocket.host, adminSocket.port)) {
      sendJson(response, 403, { error: "admin_host_rejected", message: "Admin host is not the bound loopback listener." });
      return;
    }
    // A local browser may carry the bearer across loopback ports. Preflight
    // discloses no state; every actual request still requires the bearer.
    if (origin !== "absent") {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        response.setHeader("access-control-allow-headers", "Authorization, Content-Type");
        response.writeHead(204);
        response.end();
        return;
      }
    }
    if (adminAuthHash === undefined) {
      sendJson(response, 401, { error: "admin_unauthorized", message: "Missing or invalid bearer token." });
      return;
    }
    const header = request.headers.authorization;
    const provided = typeof header === "string" ? createHash("sha256").update(header).digest() : null;
    if (provided === null || !timingSafeEqual(provided, adminAuthHash)) {
      sendJson(response, 401, { error: "admin_unauthorized", message: "Missing or invalid bearer token." });
      return;
    }
    if (request.method === "POST") {
      const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
      if (contentType.split(";", 1)[0]?.trim() !== "application/json") {
        sendJson(response, 415, { error: "admin_content_type_rejected", message: "Admin POST requires application/json." });
        return;
      }
    }
    const route = (request.url ?? "").split("?")[0];
    if (route === "/status" && request.method === "GET") {
      sendJson(response, 200, surface());
      return;
    }
    if (route === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { status: stopping ? "stopping" : "ok" });
      return;
    }
    if (route === "/metrics" && request.method === "GET") {
      const extras: EndpointMetricsExtras = {
        transportQueuedMessages: transport.queuedMessages,
        transportGeneration: transport.generation
      };
      sendText(response, 200, renderEndpointMetrics(surface(), extras));
      return;
    }
    if (route === "/pairing/invites" && request.method === "POST") {
      if (!accountPairing || adminAuthHash === undefined) {
        sendJson(response, 404, { error: "pairing_invitation_unavailable" });
        return;
      }
      const issued = await accountPairing.issueInvite();
      // The pairing bearer is returned exactly once in the operator's local
      // response. It is never persisted in plaintext, logged, or echoed later.
      sendJson(response, 201, { invite: issued.invite });
      return;
    }
    if (route.startsWith("/peer/")) {
      if (peer === null) {
        sendJson(response, 404, { error: "peer_disabled", message: "Peer messaging is not enabled in this endpoint configuration." });
        return;
      }
      try {
        if (route === "/peer/status" && request.method === "GET") {
          sendJson(response, 200, await peer.status());
          return;
        }
        if (route === "/peer/inbox" && request.method === "GET") {
          const query = new URL(request.url ?? "", "http://loopback.invalid");
          const limit = query.searchParams.get("limit");
          const afterSequence = query.searchParams.get("afterSequence");
          sendJson(response, 200, await peer.inbox(
            limit === null ? 64 : Number(limit),
            afterSequence === null ? 0 : Number(afterSequence)
          ));
          return;
        }
        if (route === "/peer/pair-safety" && request.method === "GET") {
          const query = new URL(request.url ?? "", "http://loopback.invalid");
          const peerDeviceId = query.searchParams.get("peerDeviceId") ?? "";
          if (!peerDeviceId) {
            sendJson(response, 400, { error: "peer_device_required", message: "pair-safety requires ?peerDeviceId=" });
            return;
          }
          sendJson(response, 200, await peer.pairSafety(peerDeviceId));
          return;
        }
        if (request.method === "POST") {
          let body: unknown;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            sendJson(response, (error as { statusCode?: number }).statusCode ?? 400, { error: "peer_request_invalid", message: "Peer request body is invalid." });
            return;
          }
          const args = (body ?? {}) as Record<string, unknown>;
          if (route === "/peer/send") {
            const entry = await peer.sendMessage({
              peerDeviceId: String(args.peerDeviceId ?? ""),
              text: typeof args.text === "string" ? args.text : undefined,
              plaintextBase64url: typeof args.plaintextBase64url === "string" ? args.plaintextBase64url : undefined,
              messageId: typeof args.messageId === "string" ? args.messageId : undefined
            });
            sendJson(response, 200, entry);
            return;
          }
        }
        sendJson(response, 404, { error: "peer_route_unknown" });
      } catch (error) {
        const offered = (error as { code?: unknown })?.code;
        sendJson(response, 400, { error: stablePeerCode(offered) ?? "peer_failed", message: "Peer operation could not be completed." });
      }
      return;
    }
    sendJson(response, 404, { error: "route_unknown" });
  }

  if (config.adminListen) {
    adminServer = createServer((request, response) => {
      void handleAdminRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          const code = "internal_error";
          response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: code }));
          return;
        }
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      adminServer!.once("error", reject);
      adminServer!.listen(config.adminListen!.port, config.adminListen!.host, () => {
        const address = adminServer!.address();
        if (address && typeof address !== "string") adminSocket.port = address.port;
        resolve();
      });
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
