import { once } from "node:events";
import type { Duplex } from "node:stream";
import type { AuthenticatedContext, Gateway, GatewayOutcome, Invocation, PermitAuthorityPort } from "@meshrix/contracts/gateway";
import {
  parsePrivateRelayRecoveryMessage,
  parseRecoveryRequest,
  parseRecoveryProof,
  parseOperationQuery
} from "@meshrix/contracts/private-relay";
import { createInnerTlsEndpoint, createRelayFrameDuplex, type InnerTlsChannel, type RelayFrameDuplex } from "./inner-channel.ts";
import { createEndpointIdentityStore, type EndpointAuthorityPort, type EndpointIdentityStore, type EndpointDeviceRecord } from "./identity-store.ts";
import { createOperationRecoveryService, type GatewayOperationRecoveryService } from "./operation-recovery.ts";
import { createRecoveryAuthorityService, type RecoveryAuthorityService, type RecoverySigner } from "./recovery-flow.ts";
import { PrivateRelaySession, type PrivateRelayCloseReason, type RelayTransportPort, type RelayAdmissionInput } from "./session-driver.ts";

/**
 * Private gateway endpoint composition.
 *
 * Joins the relay session driver, the pinned inner-TLS channel, the endpoint
 * identity store, the operation-recovery projection and the recovery-authority
 * service onto the existing governed gateway kernel. Standard MCP JSON-RPC is
 * forwarded over the inner channel; semantics, grants and plaintext never
 * leave the endpoint.
 */
export interface PrivateEndpointOptions {
  readonly gateway: Gateway;
  readonly identity?: EndpointIdentityStore;
  readonly authority: EndpointAuthorityPort;
  readonly recoverySigner: RecoverySigner;
  /** Permit authority lookup — resolves canonical execution state for operations already dispatched. */
  readonly permits?: Pick<PermitAuthorityPort, "lookup">;
  readonly transport: RelayTransportPort;
  readonly admission: RelayAdmissionInput;
  readonly innerTls: {
    readonly key: Parameters<typeof createInnerTlsEndpoint>[0]["key"];
    readonly cert: Parameters<typeof createInnerTlsEndpoint>[0]["cert"];
    readonly handshakeTimeoutMs?: number;
  };
  readonly nonceFactory?: () => string;
  readonly now?: () => number;
}

export interface PrivateEndpoint {
  readonly session: PrivateRelaySession;
  readonly recovery: RecoveryAuthorityService;
  readonly operationRecovery: GatewayOperationRecoveryService;
  open(): boolean;
  reconnect(): boolean;
  close(reason?: PrivateRelayCloseReason): boolean;
  /** Feed a raw decoded relay transport message. */
  handleRelayMessage(message: unknown): void;
  /** Dispatch one decoded inner-channel JSON-RPC request to the kernel. */
  dispatchInnerMessage(context: AuthenticatedContext, message: unknown): Promise<GatewayOutcome | null>;
  readonly device: EndpointDeviceRecord | undefined;
}

const JSON_RPC_METHODS: Readonly<Record<string, "invoke" | "readResource" | "getPrompt" | "completePrompt" | "catalog">> = Object.freeze({
  "tools/call": "invoke",
  "resources/read": "readResource",
  "prompts/get": "getPrompt",
  "prompts/complete": "completePrompt",
  "tools/list": "catalog",
  "resources/list": "catalog",
  "prompts/list": "catalog"
});

export function createPrivateGatewayEndpoint(options: PrivateEndpointOptions): PrivateEndpoint {
  const identity = options.identity ?? createEndpointIdentityStore();
  const operationRecovery = createOperationRecoveryService({ now: options.now, permits: options.permits });
  const recovery = createRecoveryAuthorityService({
    identity,
    signer: options.recoverySigner,
    clock: options.now ? { now: options.now } : undefined
  });

  let channel: InnerTlsChannel | undefined;
  let pump: RelayFrameDuplex | undefined;
  let device: EndpointDeviceRecord | undefined;

  function ensureInnerChannel(): void {
    if (!device) return;
    // Liveness guard: a replayed or duplicate admission must not orphan the
    // live channel and pin a second handshake on top of it.
    if (channel && !channel.socket.destroyed) return;
    channel?.close();
    void establishInnerChannel(device)
      .then((tls) => {
        void tls.established.then(() => {
          // Channel live — any frames queued while it was down can drain now.
          session.flushInbound();
        }).catch(() => {
          if (channel === tls) channel = undefined;
          tls.close();
          session.close("protocol_error");
        });
      })
      .catch(() => {
        channel?.close();
        session.close("protocol_error");
      });
  }

  const session = new PrivateRelaySession({
    transport: options.transport,
    admission: options.admission,
    purpose: "forward",
    nonceFactory: options.nonceFactory,
    handlers: {
      onAdmitted() {
        // Fires for both session-admitted and session-restored — a restored
        // session must rebuild the inner channel to honor its cursors.
        ensureInnerChannel();
      },
      onFrame(payload) {
        // The driver withholds the frame ack until this returns true, so a
        // full inner-channel buffer produces bounded queueing, not data loss.
        return pump ? pump.feed(payload) : false;
      },
      onRouteStatus(_routeId, state) {
        void state;
      },
      onClosed() {
        channel?.close();
        channel = undefined;
        pump = undefined;
      }
    }
  });

  async function establishInnerChannel(currentDevice: EndpointDeviceRecord): Promise<InnerTlsChannel> {
    pump = createRelayFrameDuplex({
      sendFrame: (payload) => session.sendPayload(payload).accepted,
      // The TLS socket drained some buffered bytes — retry queued inbound frames.
      onDrained: () => session.flushInbound(),
      maxBufferedBytes: undefined
    });
    const tls = createInnerTlsEndpoint({
      socket: pump as unknown as Duplex,
      key: options.innerTls.key,
      cert: options.innerTls.cert,
      pinnedPeerSpki: [currentDevice.pairedIdentityKey, currentDevice.pairedIdentityFingerprint],
      handshakeTimeoutMs: options.innerTls.handshakeTimeoutMs
    });
    channel = tls;
    return tls;
  }

  return {
    session,
    recovery,
    operationRecovery,
    get device() { return device; },

    open(): boolean {
      return session.open();
    },

    reconnect(): boolean {
      return session.reconnect();
    },

    close(reason: PrivateRelayCloseReason = "normal"): boolean {
      channel?.close();
      channel = undefined;
      pump = undefined;
      return session.close(reason);
    },

    handleRelayMessage(message: unknown): void {
      // Cheap kind peek: identity admission must bind `device` before the
      // driver's synchronous onAdmitted callback fires inside handleMessage.
      const peeked = typeof message === "object" && message !== null && !Array.isArray(message)
        ? (message as { kind?: unknown }).kind
        : undefined;
      if (peeked === "session-admitted") {
        const admitted = identity.admit({
          tenantId: options.admission.tenantId,
          deviceId: options.admission.deviceId,
          routeId: options.admission.routeId,
          role: options.admission.role,
          mode: options.admission.mode,
          admissionGeneration: options.admission.admissionGeneration,
          revocationRevision: options.admission.revocationRevision
        });
        if (admitted.admitted && admitted.device) device = admitted.device;
      }
      // The driver returns the parsed wire kind so routing needs no second
      // parse; only non-session messages fall through to the recovery parser.
      const kind = session.handleMessage(message)
        ?? (() => {
          const parsed = parsePrivateRelayRecoveryMessage(message);
          return parsed ? String(parsed.kind) : null;
        })();
      if (!kind || kind === "session-admitted") return;
      if (kind === "recovery-request" && recovery.admitsKind("recovery-request")) {
        if (parseRecoveryRequest(message)) {
          const challenge = recovery.beginRecovery(message);
          if (challenge) options.transport.send(challenge as Readonly<Record<string, unknown>>);
        }
        return;
      }
      if (kind === "recovery-proof") {
        if (parseRecoveryProof(message)) {
          const result = recovery.completeRecovery(message);
          if (result) options.transport.send(result as Readonly<Record<string, unknown>>);
        }
        return;
      }
      if (kind === "operation-query") {
        if (!parseOperationQuery(message) || !device) return;
        const context = options.authority.contextFor({ device });
        if (!context) return;
        void Promise.resolve(context).then(async (ctx) => {
          const status = await operationRecovery.answerQuery(message, ctx as AuthenticatedContext);
          if (status) options.transport.send(status as unknown as Readonly<Record<string, unknown>>);
        }).catch(() => {
          // Recovery answers are best-effort; a port failure leaves the caller to retry the query.
        });
        return;
      }
    },

    async dispatchInnerMessage(context: AuthenticatedContext, message: unknown): Promise<GatewayOutcome | null> {
      if (typeof message !== "object" || !message || Array.isArray(message)) return null;
      const rpc = message as { method?: string; params?: unknown; id?: unknown };
      const method = rpc.method;
      if (typeof method !== "string") return null;
      const mapping = JSON_RPC_METHODS[method];
      if (!mapping) {
        // Unknown application JSON-RPC — surfaced to caller as a policy failure by the kernel path
        return null;
      }
      const params = rpc.params && typeof rpc.params === "object" ? rpc.params as Record<string, unknown> : {};
      const operationId = typeof params.operationKey === "string" ? params.operationKey : typeof rpc.id === "string" || typeof rpc.id === "number" ? String(rpc.id) : `op.${Date.now().toString(36)}`;
      operationRecovery.markReceived(operationId, {
        principalRef: context.principal,
        generation: Number(context.authGeneration ?? 0) || 0
      });
      try {
        let outcome: GatewayOutcome;
        switch (mapping) {
          case "invoke": {
            const invocation: Invocation = {
              routeRef: String(params.routeRef ?? params.name ?? ""),
              method,
              params: params.arguments ?? params,
              operationKey: operationId,
              signal: params.signal as AbortSignal | undefined
            };
            outcome = await options.gateway.invoke(context, invocation);
            break;
          }
          case "readResource":
            outcome = await (options.gateway.readResource?.(context, String(params.uri ?? ""), params.signal as AbortSignal | undefined)
              ?? Promise.resolve(null)) as GatewayOutcome;
            break;
          case "getPrompt":
            outcome = await (options.gateway.getPrompt?.(context, String(params.name ?? ""), params.arguments as Record<string, unknown> | undefined, params.signal as AbortSignal | undefined)
              ?? Promise.resolve(null)) as GatewayOutcome;
            break;
          case "completePrompt":
            outcome = await (options.gateway.completePrompt?.(context, params.argument as never, params.signal as AbortSignal | undefined)
              ?? Promise.resolve(null)) as GatewayOutcome;
            break;
          case "catalog": {
            const page = options.gateway.catalog(context, {
              ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
              ...(typeof params.limit === "number" && Number.isFinite(params.limit) ? { limit: params.limit } : {}),
              ...(typeof params.search === "string" ? { search: params.search } : {})
            });
            outcome = { kind: "complete", value: page } as unknown as GatewayOutcome;
            break;
          }
          default:
            return null;
        }
        if (outcome && typeof outcome === "object" && outcome.kind === "failure") {
          switch (outcome.effectOutcome) {
            case "not_started":
              // Pre-dispatch refusal — the one outcome a caller may retry.
              operationRecovery.markRefused(operationId);
              break;
            case "cancelled":
              operationRecovery.markCancelIntent(operationId);
              break;
            case "unknown":
              operationRecovery.markUncertain(operationId);
              break;
            default:
              operationRecovery.markSettled(operationId, "failed", false);
              break;
          }
        } else {
          operationRecovery.markSettled(operationId, "complete", true);
        }
        return outcome;
      } catch (error) {
        const effect = error && typeof error === "object" ? (error as { effectOutcome?: string }).effectOutcome : undefined;
        if (effect === "not_started") {
          operationRecovery.markRefused(operationId);
        } else {
          // A thrown error cannot prove the effect never started — stay honest.
          operationRecovery.markUncertain(operationId);
        }
        throw error;
      }
    }
  };
}
