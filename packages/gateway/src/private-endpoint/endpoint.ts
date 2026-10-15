import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import type { AuthenticatedContext, Gateway, GatewayOutcome, Invocation, PermitAuthorityPort } from "@meshrix/contracts/gateway";
import { canonicalAccountActionTarget, isAccountStepUpPermitId, type AccountActionTarget, type AccountAuthorityBinding } from "@meshrix/contracts/account";
import {
  parsePairingBootstrap,
  parsePrivateRelayRecoveryMessage,
  parseRecoveryRequest,
  parseRecoveryProof,
  parseOperationQuery
} from "@meshrix/contracts/private-relay";
import { createInnerTlsEndpoint, createRelayFrameDuplex, type InnerTlsChannel, type RelayFrameDuplex } from "./inner-channel.ts";
import { createEndpointIdentityStore, type EndpointAuthorityPort, type EndpointIdentityStore, type EndpointDeviceRecord } from "./identity-store.ts";
import { createOperationRecoveryService, type GatewayOperationRecoveryService } from "./operation-recovery.ts";
import { createRecoveryAuthorityService, type RecoveryAuthorityService, type RecoverySigner } from "./recovery-flow.ts";
import { EndpointAccountPairingApplication, type ActivePairingBootstrap } from "./account-pairing.ts";
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
  /** Present only for account-managed endpoint profiles. */
  readonly accountPairing?: EndpointAccountPairingApplication;
  readonly innerTls: {
    readonly key: Parameters<typeof createInnerTlsEndpoint>[0]["key"];
    readonly cert: Parameters<typeof createInnerTlsEndpoint>[0]["cert"];
    readonly handshakeTimeoutMs?: number;
  };
  readonly nonceFactory?: () => string;
  readonly now?: () => number;
  /**
   * Invoked each time the pinned inner-TLS channel finishes establishment —
   * on both the session-admitted and session-restored rebuild paths. The
   * operator profile uses this to attach the inner dispatch loop; the hook
   * never fires before the mutual trust binding is proven, and a channel
   * torn down by a later session event closes its own socket listeners.
   */
  readonly onInnerChannel?: (channel: InnerTlsChannel, peer: {
    readonly peerSessionId: string;
    readonly peerSpki: string;
    readonly pairingOnly: boolean;
    readonly device?: EndpointDeviceRecord;
  }) => void;
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
  dispatchAccountMessage(input: { readonly peerSessionId: string; readonly pairingOnly: boolean; readonly device?: EndpointDeviceRecord; readonly message: unknown }): Promise<unknown>;
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

/**
 * DER prefix of an Ed25519 SubjectPublicKeyInfo: `SEQUENCE { SEQUENCE {
 * OID id-Ed25519 (RFC 8410) }, BIT STRING 00 <32-byte key> }`. The inner-channel trust
 * anchor is `sha256(spki-der)`; an enrolled record may carry the raw 32-byte
 * Ed25519 key (pairing/recovery bindings) or the `fp.` fingerprint form, so
 * both normalize onto the same digest here. Derivation only rewrites stored
 * material — it can never introduce a key the operator did not enroll.
 */
const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function pinCandidatesFromStoredIdentity(value: string): string[] {
  const candidates = new Set<string>();
  if (!value) return [];
  candidates.add(value);
  if (value.startsWith("fp.")) candidates.add(value.slice(3));
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.byteLength === 32) {
      candidates.add(createHash("sha256").update(Buffer.concat([ED25519_SPKI_DER_PREFIX, raw])).digest("base64url"));
    }
  } catch {
    // Not base64url — the stored form is opaque; only exact-length keys derive.
  }
  return [...candidates];
}

/**
 * The acceptable peer pins for the inner channel: every enrolled, non-revoked
 * entry-role binding plus the admitted device's own paired identity. Each
 * stored field yields its raw form, its `fp.`-stripped form, and — when it is
 * a raw Ed25519 key — the derived SPKI pin, so paired and recovered devices
 * both bind by public-key digest.
 */
export function pinnedPeerSpkiCandidates(identity: EndpointIdentityStore, currentDevice: EndpointDeviceRecord): string[] {
  const pins = new Set<string>();
  const collect = (record: EndpointDeviceRecord) => {
    if (record.revoked) return;
    for (const pin of pinCandidatesFromStoredIdentity(record.pairedIdentityKey)) pins.add(pin);
    for (const pin of pinCandidatesFromStoredIdentity(record.pairedIdentityFingerprint)) pins.add(pin);
  };
  collect(currentDevice);
  for (const record of identity.devices()) {
    if (record.role === "entry") collect(record);
  }
  return [...pins];
}

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
  /** Sender session the live inner channel is bound to; a peer reconnect replaces it. */
  let boundPeerSessionId: string | undefined;
  /** Opaque relay locator while the endpoint authenticates account pairing state. */
  let pendingPairingLocator: { readonly bootstrapId: string; readonly entrySessionId: string } | undefined;
  let activePairing: ActivePairingBootstrap | undefined;
  let device: EndpointDeviceRecord | undefined;

  function clearPairingLocator(): void {
    pendingPairingLocator = undefined;
    activePairing = undefined;
  }

  function ensureInnerChannel(): void {
    if (!device) return;
    // Liveness guard: a replayed or duplicate admission must not orphan the
    // live channel and pin a second handshake on top of it.
    if (channel && !channel.socket.destroyed) return;
    channel?.close();
    const peerSessionId = boundPeerSessionId;
    if (!peerSessionId) return;
    const pairing = activePairing?.entrySessionId === peerSessionId ? activePairing : undefined;
    void establishInnerChannel(device, pairing)
      .then((tls) => {
        void tls.established.then(({ peerSpki }) => {
          if (boundPeerSessionId !== peerSessionId || channel !== tls) {
            tls.close();
            return;
          }
          const peer = pairing
            ? (activePairing === pairing && peerSpki === pairing.peerSpki
                ? { peerSessionId, peerSpki, pairingOnly: true as const }
                : undefined)
            : (() => {
                const admitted = identity.deviceByFingerprint(peerSpki);
                return admitted && admitted.role === "entry" && !admitted.revoked
                  ? { peerSessionId, peerSpki, pairingOnly: false as const, device: admitted }
                  : undefined;
              })();
          if (!peer) {
            if (channel === tls) channel = undefined;
            tls.close();
            return;
          }
          // Channel live — hand it to the profile's dispatch loop before any
          // buffered inbound frames drain into its socket.
          options.onInnerChannel?.(tls, peer);
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
      onFrame(payload, _messageId, peerSessionId) {
        // The relay forwards the sender's sessionId verbatim. A replaced peer
        // session starts a fresh TLS handshake — the channel bound to the
        // previous session is dead weight even before its socket reports
        // destroyed, and feeding it the new ClientHello poisons nothing but
        // answers nothing either.
        if (boundPeerSessionId !== undefined && peerSessionId !== boundPeerSessionId) {
          channel?.close();
          channel = undefined;
          pump = undefined;
          if (activePairing?.entrySessionId !== peerSessionId) clearPairingLocator();
        }
        // The relay sends pairing-bootstrap before any pair-device frame. Keep
        // the driver's bounded inbound queue unacknowledged until the endpoint
        // has authenticated that locator with the account authority.
        if (pendingPairingLocator?.entrySessionId === peerSessionId && !activePairing) return false;
        if (pendingPairingLocator && pendingPairingLocator.entrySessionId !== peerSessionId) return false;
        if (activePairing && activePairing.entrySessionId !== peerSessionId) return false;
        boundPeerSessionId = peerSessionId;
        if (!channel || channel.socket.destroyed) ensureInnerChannel();
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
        boundPeerSessionId = undefined;
        clearPairingLocator();
      }
    }
  });

  async function establishInnerChannel(currentDevice: EndpointDeviceRecord, pairing?: ActivePairingBootstrap): Promise<InnerTlsChannel> {
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
      pinnedPeerSpki: pairing ? [pairing.peerSpki] : pinnedPeerSpkiCandidates(identity, currentDevice),
      handshakeTimeoutMs: options.innerTls.handshakeTimeoutMs
    });
    channel = tls;
    // Frames withheld while the channel was down belong to this peer session —
    // drain them into the new pump now, or a queued ClientHello can never
    // complete the handshake it is waiting on.
    session.flushInbound();
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
      boundPeerSessionId = undefined;
      clearPairingLocator();
      return session.close(reason);
    },

    handleRelayMessage(message: unknown): void {
      const pairingHint = parsePairingBootstrap(message);
      if (pairingHint) {
        if (!options.accountPairing) {
          session.failSession("protocol_error");
          return;
        }
        const locator = Object.freeze({
          bootstrapId: String(pairingHint.bootstrapId),
          entrySessionId: String(pairingHint.entrySessionId)
        });
        if (activePairing?.bootstrapId === locator.bootstrapId && activePairing.entrySessionId === locator.entrySessionId) return;
        if (pendingPairingLocator?.bootstrapId === locator.bootstrapId && pendingPairingLocator.entrySessionId === locator.entrySessionId) return;
        channel?.close();
        channel = undefined;
        pump = undefined;
        boundPeerSessionId = locator.entrySessionId;
        activePairing = undefined;
        pendingPairingLocator = locator;
        void options.accountPairing.inspectBootstrap(locator).then((inspected) => {
          if (pendingPairingLocator !== locator) return;
          pendingPairingLocator = undefined;
          if (!inspected || inspected.bootstrapId !== locator.bootstrapId || inspected.entrySessionId !== locator.entrySessionId) {
            clearPairingLocator();
            session.failSession("protocol_error");
            return;
          }
          activePairing = inspected;
          ensureInnerChannel();
          session.flushInbound();
        }).catch(() => {
          if (pendingPairingLocator !== locator) return;
          clearPairingLocator();
          session.failSession("protocol_error");
        });
        return;
      }
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
      // Account recovery advances an account-global epoch and must not be
      // bypassed by the endpoint's older independent possession-only recovery
      // authority. Unbound self-hosted endpoints keep that separate mechanism.
      if (options.accountPairing && identity.device(options.admission.deviceId)?.accountBinding
        && (kind === "recovery-request" || kind === "recovery-proof")) return;
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
        const query = parseOperationQuery(message);
        if (!query || !device) return;
        if (options.accountPairing) {
          // An account-bound status query must resolve to the live Entry trust
          // record and pass the same current-account grant check as an inner
          // request. The endpoint's own relay identity is not the querying
          // Entry and cannot stand in for it.
          const candidates = identity.devices().filter((candidate) => candidate.role === "entry" && !candidate.revoked
            && candidate.principalRef === query.principalRef && candidate.trustGeneration === query.generation);
          if (candidates.length !== 1) return;
          const entry = candidates[0]!;
          void options.accountPairing.currentDeviceIsAuthorized(entry).then(async (authorized) => {
            if (!authorized) return;
            const context = await options.authority.contextFor({ device: entry });
            if (!context) return;
            const status = await operationRecovery.answerQuery(message, context);
            if (status) options.transport.send(status as unknown as Readonly<Record<string, unknown>>);
          }).catch(() => {
            // Recovery answers are best-effort; a port failure leaves the caller to retry the query.
          });
          return;
        }
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

    async dispatchAccountMessage(input): Promise<unknown> {
      const pairing = options.accountPairing;
      if (!pairing || !isRecord(input.message)) return null;
      const method = input.message.method;
      if (typeof method !== "string") return null;
      const params = isRecord(input.message.params) ? input.message.params : {};
      if (input.pairingOnly) {
        const active = activePairing;
        if (!active || active.entrySessionId !== input.peerSessionId || params.bootstrapId !== active.bootstrapId) {
          return { outcome: "refused", refusal: "pairing_bootstrap_stale" };
        }
        if (method === "meshrix/pairing/begin") {
          return pairing.beginPairing({
            bootstrapId: active.bootstrapId,
            entrySessionId: active.entrySessionId,
            inviteId: String(params.inviteId ?? ""),
            pairingToken: String(params.pairingToken ?? ""),
            deviceId: active.entryDeviceId,
            devicePublicKey: active.entryDevicePublicKey
          });
        }
        if (method === "meshrix/pairing/complete") {
          return pairing.completePairing({
            bootstrapId: active.bootstrapId,
            entrySessionId: active.entrySessionId,
            inviteId: String(params.inviteId ?? ""),
            pairingToken: String(params.pairingToken ?? ""),
            challengeId: String(params.challengeId ?? ""),
            deviceId: active.entryDeviceId,
            devicePublicKey: active.entryDevicePublicKey,
            entryPeerIdentity: (params.entryPeerIdentity ?? null) as import("@meshrix/contracts/account").PairingPeerIdentity | null,
            signature: String(params.signature ?? ""),
            account: params.account as AccountAuthorityBinding,
            permitId: String(params.permitId ?? ""),
            purpose: params.purpose as "pair_device",
            target: params.target as AccountActionTarget,
            operationId: String(params.operationId ?? "")
          });
        }
        return { outcome: "refused", refusal: "pairing_method_refused" };
      }
      const entry = input.device;
      if (!entry || entry.role !== "entry" || entry.revoked) return null;
      if (method === "meshrix/pairing/begin") return { outcome: "refused", refusal: "pairing_method_refused" };
      if (method === "meshrix/pairing/complete") {
        const bootstrapId = params.bootstrapId;
        const operation = typeof bootstrapId === "string" ? identity.pairingOperation(bootstrapId) : undefined;
        const currentEntry = identity.device(entry.deviceId);
        const sameBinding = (value: unknown, expected: AccountAuthorityBinding): boolean =>
          isRecord(value) && value.accountId === expected.accountId && value.authEpoch === expected.authEpoch;
        let sameTarget = false;
        if (isRecord(params.target)) {
          try {
            sameTarget = canonicalAccountActionTarget(params.target as unknown as AccountActionTarget)
              === canonicalAccountActionTarget(operation?.target as AccountActionTarget);
          } catch {
            sameTarget = false;
          }
        }
        if (!operation || operation.state !== "enrolled" || !currentEntry || currentEntry !== entry || !input.peerSessionId
          || input.peerSessionId === operation.entrySessionId
          || currentEntry.role !== "entry" || currentEntry.revoked
          || typeof operation.operationId !== "string" || !operation.operationId
          || !isAccountStepUpPermitId(operation.permitId)
          || operation.bootstrapId !== bootstrapId
          || operation.target.tenantId !== currentEntry.tenantId
          || operation.target.routeId !== currentEntry.routeId
          || operation.target.deviceId !== currentEntry.deviceId
          || operation.target.devicePublicKey !== currentEntry.pairedIdentityKey
          || !currentEntry.accountBinding
          || currentEntry.accountBinding.accountId !== operation.account.accountId
          || currentEntry.accountBinding.authEpoch !== operation.account.authEpoch
          || params.deviceId !== currentEntry.deviceId
          || params.devicePublicKey !== currentEntry.pairedIdentityKey
          || params.inviteId !== operation.inviteId
          || params.challengeId !== operation.challengeId
          || params.operationId !== operation.operationId
          || JSON.stringify(params.entryPeerIdentity ?? null) !== JSON.stringify(operation.entryPeerIdentity ?? null)
          || JSON.stringify(currentEntry.entryPeerIdentity ?? null) !== JSON.stringify(operation.entryPeerIdentity ?? null)
          || params.permitId !== operation.permitId
          || params.purpose !== "pair_device"
          || !sameBinding(params.account, operation.account)
          || !sameTarget
          || typeof params.pairingToken !== "string" || !params.pairingToken
          || typeof params.signature !== "string" || !params.signature) {
          return { outcome: "refused", refusal: "pairing_operation_not_replayable" };
        }
        // The new forward session proves the same enrolled device via its
        // pinned TLS identity. Reuse the original persisted pairing context so
        // only the exact already-enrolled operation can complete its response.
        return pairing.completePairing({
          bootstrapId: operation.bootstrapId,
          entrySessionId: operation.entrySessionId,
          inviteId: operation.inviteId,
          pairingToken: params.pairingToken,
          challengeId: operation.challengeId,
          deviceId: currentEntry.deviceId,
          devicePublicKey: currentEntry.pairedIdentityKey,
          entryPeerIdentity: operation.entryPeerIdentity ?? null,
          signature: params.signature,
          account: operation.account,
          permitId: operation.permitId,
          purpose: "pair_device",
          target: operation.target,
          operationId: operation.operationId
        });
      }
      if (method === "meshrix/pairing/grant_catalog") return pairing.grantCatalog({ device: entry });
      if (method === "meshrix/pairing/grant_targets") return pairing.grantTarget({
        device: entry,
        scopes: Array.isArray(params.scopes) ? params.scopes.filter((scope): scope is string => typeof scope === "string") : []
      });
      if (method === "meshrix/pairing/grant_access") return pairing.grantAccess({
        device: entry,
        account: params.account as AccountAuthorityBinding,
        operationId: String(params.operationId ?? ""),
        permitId: String(params.permitId ?? ""),
        purpose: params.purpose as "grant_access",
        target: params.target as AccountActionTarget,
        signature: String(params.signature ?? "")
      });
      return null;
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
      const effectContext = await accountEffectContext(options.accountPairing, identity, context);
      if (!effectContext) return accountEffectDenied();
      context = effectContext;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Re-check the enrolled device against current account authority immediately
 * before a protected effect. A context assembled on an earlier path, including
 * one that never passed through the account UI, cannot keep a stale epoch or
 * grant. Self-hosted endpoints have no account pairing application. */
async function accountEffectContext(
  pairing: EndpointAccountPairingApplication | undefined,
  identity: EndpointIdentityStore,
  context: AuthenticatedContext
): Promise<AuthenticatedContext | null> {
  if (!pairing) return context;
  const metadata = context.metadata;
  const deviceId = typeof metadata?.deviceId === "string" ? metadata.deviceId : "";
  const accountId = typeof metadata?.accountId === "string" ? metadata.accountId : "";
  const authEpoch = typeof metadata?.authEpoch === "number" ? metadata.authEpoch : Number.NaN;
  const device = deviceId ? identity.device(deviceId) : undefined;
  const binding = device?.accountBinding;
  if (!device || device.revoked || device.role !== "entry" || !binding
    || binding.accountId !== accountId || binding.authEpoch !== authEpoch
    || !Number.isSafeInteger(authEpoch) || authEpoch < 1) {
    return null;
  }
  const authorized = await pairing.authorizeProtectedEffect(device);
  if (!authorized) return null;
  return Object.freeze({
    ...context,
    grant: Object.freeze({
      ...context.grant,
      routes: Object.freeze([...new Set(authorized.authorizedScopes)])
    })
  });
}

function accountEffectDenied(): GatewayOutcome {
  return Object.freeze({
    kind: "failure",
    origin: "policy",
    code: "account_stale",
    message: "The account grant is no longer current.",
    status: 403,
    effectOutcome: "not_started"
  });
}
