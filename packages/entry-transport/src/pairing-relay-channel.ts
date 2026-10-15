import { randomUUID } from "node:crypto";
import {
  canonicalAccountActionTarget,
  isAccountStepUpPermitId,
  isPairingPeerIdentity,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type PairingCompletionReceipt,
  type PairingCompletionRequest,
  type PairingEndpointPort,
  type PairingInvite,
  type PairingPeerIdentity
} from "@meshrix/contracts/account";
import { peerIdForRouteDevice } from "@meshrix/contracts/private-relay";
import type { RelayAdmissionInput, RelayTransportPort } from "@meshrix/gateway/private-endpoint";
import { entryError } from "./errors.ts";
import { EntryRelaySession, type EntrySessionOptions, type EntryTransportLifecycle } from "./entry-session.ts";
import { createWssRelayTransport, type WssRelayTransport } from "./wss-transport.ts";

export interface PairingRelayBootstrap {
  readonly bootstrapId: string;
  readonly relayAdmission: string;
  readonly account: AccountAuthorityBinding;
  readonly tenantId: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPinRef: string;
  readonly entryDeviceId: string;
  readonly role: "entry";
  readonly mode: "personal" | "enterprise";
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  readonly expiresAt: string;
}

export interface EntryPairingRelayChannelOptions {
  readonly relaySessionUrl: string | URL;
  readonly bootstrap: PairingRelayBootstrap;
  readonly invite: PairingInvite;
  readonly innerTls: EntrySessionOptions["innerTls"];
  readonly connectTimeoutMs?: number | null;
  readonly transport?: RelayTransportPort & Partial<EntryTransportLifecycle> & {
    readonly handlers?: WssRelayTransport["handlers"];
    onMessage?: (message: Readonly<Record<string, unknown>>) => void;
    onSocketClose?: (code: number, reason: string, wasClean: boolean) => void;
    onSocketDrop?: () => void;
  };
  readonly transportFactory?: (input: {
    readonly url: string;
    readonly headers: Record<string, string>;
  }) => EntryPairingRelayChannelOptions["transport"];
  readonly allowInsecureLoopback?: boolean;
}

export interface EntryPairingCompletionRelayChannelOptions {
  readonly relaySessionUrl: string | URL;
  readonly bootstrap: PairingRelayBootstrap;
  readonly completion: PairingCompletionRequest;
  readonly innerTls: EntrySessionOptions["innerTls"];
  readonly connectTimeoutMs?: number | null;
  readonly transport?: EntryPairingRelayChannelOptions["transport"];
  readonly transportFactory?: EntryPairingRelayChannelOptions["transportFactory"];
  readonly allowInsecureLoopback?: boolean;
}

/**
 * Restricted Entry pairing channel over the private relay's pair_device
 * purpose and the invite-pinned inner TLS channel. It deliberately exposes
 * only the two pairing RPCs; callers cannot attach MCP, recovery or ordinary
 * endpoint operation traffic to this provisional session.
 */
export class EntryPairingRelayChannel implements PairingEndpointPort {
  readonly #options: EntryPairingRelayChannelOptions;
  readonly #session: EntryRelaySession;
  readonly #transport: EntryPairingRelayChannelOptions["transport"];
  #challenge: {
    readonly challengeId: string;
    readonly deviceId: string;
    readonly devicePublicKey: string;
    readonly account: AccountAuthorityBinding;
    readonly target: AccountActionTarget;
  } | null = null;

  constructor(options: EntryPairingRelayChannelOptions) {
    assertBootstrapMatchesInvite(options.bootstrap, options.invite);
    this.#options = options;
    const url = options.relaySessionUrl instanceof URL ? options.relaySessionUrl.toString() : options.relaySessionUrl;
    this.#transport = options.transport ?? options.transportFactory?.({
      url,
      headers: { authorization: `Bearer ${options.bootstrap.relayAdmission}` }
    }) ?? createWssRelayTransport({
      url,
      headers: { authorization: `Bearer ${options.bootstrap.relayAdmission}` },
      allowInsecureLoopback: options.allowInsecureLoopback === true
    });
    const admission: RelayAdmissionInput = {
      tenantId: options.bootstrap.tenantId,
      routeId: options.bootstrap.routeId,
      deviceId: options.bootstrap.entryDeviceId,
      role: "entry",
      mode: options.invite.mode,
      admissionGeneration: options.bootstrap.admissionGeneration,
      revocationRevision: options.bootstrap.revocationRevision
    } as RelayAdmissionInput;
    this.#session = new EntryRelaySession({
      transport: this.#transport,
      admission,
      purpose: "pair_device",
      innerTls: options.innerTls,
      connectTimeoutMs: options.connectTimeoutMs
    });
    attachPairingTransport(this.#transport, this.#session);
  }

  async connect(): Promise<void> {
    await this.#session.connect();
  }

  close(): void {
    this.#challenge = null;
    this.#session.close("normal");
  }

  async beginPairing(input: {
    readonly invite: PairingInvite;
    readonly deviceId: string;
    readonly devicePublicKey: string;
  }): Promise<{
    readonly outcome: "challenge";
    readonly challengeId: string;
    readonly nonce: string;
    readonly expiresAt: string;
    readonly account: AccountAuthorityBinding;
    readonly target: AccountActionTarget;
  } | { readonly outcome: "refused"; readonly refusal: string }> {
    assertSameInvite(input.invite, this.#options.invite);
    if (this.#challenge) {
      throw entryError("pairing_state_invalid", "The restricted channel already has an outstanding endpoint challenge.");
    }
    const value = await this.#request("meshrix/pairing/begin", {
      bootstrapId: this.#options.bootstrap.bootstrapId,
      inviteId: input.invite.inviteId,
      pairingToken: input.invite.pairingToken,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey
    });
    if (isRecord(value) && value.outcome === "refused" && typeof value.refusal === "string") {
      return { outcome: "refused", refusal: safeText(value.refusal) };
    }
    if (!isRecord(value)
      || value.outcome !== "challenge"
      || typeof value.challengeId !== "string"
      || typeof value.nonce !== "string"
      || typeof value.expiresAt !== "string"
      || !isBinding(value.account)
      || !isActionTarget(value.target)
      || value.account.accountId !== this.#options.bootstrap.account.accountId
      || value.account.authEpoch !== this.#options.bootstrap.account.authEpoch
      || value.target.tenantId !== input.invite.tenantId
      || value.target.routeId !== input.invite.endpointRouteId
      || value.target.deviceId !== input.deviceId
      || value.target.devicePublicKey !== input.devicePublicKey
      || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw entryError("pairing_target_mismatch", "The endpoint returned a challenge outside this account bootstrap and device key.");
    }
    this.#challenge = {
      challengeId: value.challengeId,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey,
      account: value.account,
      target: value.target
    };
    return value as unknown as Awaited<ReturnType<PairingEndpointPort["beginPairing"]>>;
  }

  async completePairing(input: {
    readonly invite: PairingInvite;
    readonly challengeId: string;
    readonly deviceId: string;
    readonly devicePublicKey: string;
    readonly entryPeerIdentity: PairingPeerIdentity | null;
    readonly signature: string;
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: "pair_device";
    readonly target: AccountActionTarget;
    readonly operationId: string;
  }): Promise<{
    readonly outcome: "enrolled";
    readonly capabilityGrantRef: string;
    readonly admissionGeneration: number;
    readonly revocationRevision: number;
    readonly endpointPeerIdentity: PairingPeerIdentity | null;
  } | { readonly outcome: "refused"; readonly refusal: string }> {
    assertSameInvite(input.invite, this.#options.invite);
    const challenge = this.#challenge;
    if (!challenge
      || input.challengeId !== challenge.challengeId
      || input.deviceId !== challenge.deviceId
      || input.devicePublicKey !== challenge.devicePublicKey
      || (input.entryPeerIdentity !== null && !isPairingPeerIdentity(input.entryPeerIdentity,
        routePeerId(input.invite.tenantId, input.invite.endpointRouteId, input.deviceId)))
      || input.account.accountId !== challenge.account.accountId
      || input.account.authEpoch !== challenge.account.authEpoch
      || input.purpose !== "pair_device"
      || canonicalAccountActionTarget(input.target) !== canonicalAccountActionTarget(challenge.target)
      || input.target.devicePublicKey !== challenge.devicePublicKey
      || !isAccountStepUpPermitId(input.permitId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(input.operationId)) {
      throw entryError("pairing_authorization_invalid", "The completion permit does not match the active endpoint challenge.");
    }
    const value = await this.#request("meshrix/pairing/complete", {
      bootstrapId: this.#options.bootstrap.bootstrapId,
      inviteId: input.invite.inviteId,
      pairingToken: input.invite.pairingToken,
      challengeId: input.challengeId,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey,
      entryPeerIdentity: input.entryPeerIdentity,
      account: input.account,
      permitId: input.permitId,
      purpose: input.purpose,
      target: input.target,
      operationId: input.operationId,
      signature: input.signature
    });
    if (isRecord(value) && value.outcome === "refused" && typeof value.refusal === "string") {
      this.#challenge = null;
      return { outcome: "refused", refusal: safeText(value.refusal) };
    }
    if (!isRecord(value)
      || value.outcome !== "enrolled"
      || value.capabilityGrantRef !== input.target.grantRef
      || !Number.isSafeInteger(value.admissionGeneration)
      || !Number.isSafeInteger(value.revocationRevision)
      || (input.entryPeerIdentity === null) !== (value.endpointPeerIdentity === null)
      || (value.endpointPeerIdentity !== null && !isPairingPeerIdentity(value.endpointPeerIdentity,
        routePeerId(input.invite.tenantId, input.invite.endpointRouteId, input.invite.endpointDeviceId)))) {
      throw entryError("pairing_completion_invalid", "The endpoint did not confirm durable enrollment for the authorized grant.");
    }
    this.#challenge = null;
    return value as unknown as Awaited<ReturnType<PairingEndpointPort["completePairing"]>>;
  }

  async #request(method: "meshrix/pairing/begin" | "meshrix/pairing/complete", params: Record<string, unknown>): Promise<unknown> {
    if (!this.#session.acceptsNewWork) {
      throw entryError("endpoint_unreachable", "The restricted pairing endpoint is not ready.", { effectOutcome: "not_started" });
    }
    return this.#session.request({
      jsonrpc: "2.0",
      id: `pair.rpc.${randomUUID()}`,
      method,
      params
    });
  }
}

/**
 * A deliberately narrow forward-session caller used only to replay an
 * already checkpointed pairing completion. The original challenge, permit,
 * operation id, invite and device proof are captured at construction; no
 * caller can begin pairing or attach general endpoint operations to this
 * session.
 */
export class EntryPairingCompletionRelayChannel {
  readonly #session: EntryRelaySession;
  readonly #completion: PairingCompletionRequest;
  readonly #bootstrapId: string;
  #attempted = false;

  constructor(options: EntryPairingCompletionRelayChannelOptions) {
    assertCompletionMatchesBootstrap(options.bootstrap, options.completion);
    if (!options.innerTls.pinnedPeerSpki.includes(options.completion.invite.endpointPinRef)) {
      throw entryError("pairing_pin_mismatch", "The completion replay TLS pin does not match its original endpoint invite.");
    }
    const url = options.relaySessionUrl instanceof URL ? options.relaySessionUrl.toString() : options.relaySessionUrl;
    const headers = { authorization: `Bearer ${options.bootstrap.relayAdmission}` };
    const transport = options.transport ?? options.transportFactory?.({ url, headers }) ?? createWssRelayTransport({
      url,
      headers,
      allowInsecureLoopback: options.allowInsecureLoopback === true
    });
    const admission: RelayAdmissionInput = {
      tenantId: options.bootstrap.tenantId,
      routeId: options.bootstrap.routeId,
      deviceId: options.bootstrap.entryDeviceId,
      role: "entry",
      mode: options.bootstrap.mode,
      admissionGeneration: options.bootstrap.admissionGeneration,
      revocationRevision: options.bootstrap.revocationRevision
    } as RelayAdmissionInput;
    this.#session = new EntryRelaySession({
      transport,
      admission,
      purpose: "forward",
      innerTls: options.innerTls,
      connectTimeoutMs: options.connectTimeoutMs
    });
    this.#completion = options.completion;
    this.#bootstrapId = options.bootstrap.bootstrapId;
    attachPairingTransport(transport, this.#session);
  }

  async connect(): Promise<void> {
    await this.#session.connect();
  }

  /** Send the saved complete operation once on this fresh forward session. */
  async replayCompletion(): Promise<PairingCompletionReceipt | { readonly outcome: "refused"; readonly refusal: string }> {
    if (this.#attempted) {
      throw entryError("pairing_completion_replay_used", "This completion-only channel has already submitted its saved operation.");
    }
    this.#attempted = true;
    if (!this.#session.acceptsNewWork) {
      throw entryError("endpoint_unreachable", "The promoted forward endpoint is not ready for completion replay.", { effectOutcome: "not_started" });
    }
    const input = this.#completion;
    const value = await this.#session.request({
      jsonrpc: "2.0",
      id: `pair.replay.${randomUUID()}`,
      method: "meshrix/pairing/complete",
      params: {
        bootstrapId: this.#bootstrapId,
        inviteId: input.invite.inviteId,
        pairingToken: input.invite.pairingToken,
        challengeId: input.challengeId,
        deviceId: input.deviceId,
        devicePublicKey: input.devicePublicKey,
        entryPeerIdentity: input.entryPeerIdentity,
        account: input.account,
        permitId: input.permitId,
        purpose: input.purpose,
        target: input.target,
        operationId: input.operationId,
        signature: input.signature
      }
    });
    if (isRecord(value) && value.outcome === "refused" && typeof value.refusal === "string") {
      return { outcome: "refused", refusal: safeText(value.refusal) };
    }
    if (!isRecord(value)
      || value.outcome !== "enrolled"
      || value.capabilityGrantRef !== input.target.grantRef
      || !Number.isSafeInteger(value.admissionGeneration) || Number(value.admissionGeneration) < 1
      || !Number.isSafeInteger(value.revocationRevision) || Number(value.revocationRevision) < 0
      || (input.entryPeerIdentity === null) !== (value.endpointPeerIdentity === null)
      || (value.endpointPeerIdentity !== null && !isPairingPeerIdentity(value.endpointPeerIdentity,
        routePeerId(input.invite.tenantId, input.invite.endpointRouteId, input.invite.endpointDeviceId)))) {
      throw entryError("pairing_completion_invalid", "The endpoint did not confirm the saved pairing operation.");
    }
    return {
      outcome: "enrolled",
      capabilityGrantRef: value.capabilityGrantRef,
      admissionGeneration: Number(value.admissionGeneration),
      revocationRevision: Number(value.revocationRevision),
      endpointPeerIdentity: value.endpointPeerIdentity as PairingPeerIdentity | null
    };
  }

  close(): void {
    this.#session.close("normal");
  }
}

function attachPairingTransport(transport: NonNullable<EntryPairingRelayChannelOptions["transport"]>, session: EntryRelaySession): void {
  const onMessage = (message: Readonly<Record<string, unknown>>) => session.handleMessage(message);
  const onClose = () => session.handleTransportClose();
  if (transport.handlers) {
    transport.handlers.onMessage = onMessage;
    transport.handlers.onSocketClose = () => onClose();
  } else {
    transport.onMessage = onMessage;
    transport.onSocketClose = () => onClose();
    transport.onSocketDrop = () => onClose();
  }
}

function assertBootstrapMatchesInvite(bootstrap: PairingRelayBootstrap, invite: PairingInvite): void {
  if (bootstrap.role !== "entry"
    || bootstrap.tenantId !== invite.tenantId
    || bootstrap.routeId !== invite.endpointRouteId
    || bootstrap.endpointDeviceId !== invite.endpointDeviceId
    || bootstrap.endpointPinRef !== invite.endpointPinRef
    || bootstrap.mode !== invite.mode
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(bootstrap.bootstrapId)
    || !Number.isSafeInteger(bootstrap.account.authEpoch)
    || !bootstrap.account.accountId
    || bootstrap.relayAdmission.length < 32
    || !Number.isSafeInteger(bootstrap.admissionGeneration)
    || bootstrap.admissionGeneration < 1
    || !Number.isSafeInteger(bootstrap.revocationRevision)
    || bootstrap.revocationRevision < 0
    || !Number.isFinite(Date.parse(bootstrap.expiresAt))) {
    throw entryError("account_bootstrap_invalid", "The pairing bootstrap does not match the endpoint invite.");
  }
  if (Date.parse(bootstrap.expiresAt) <= Date.now()) {
    throw entryError("account_bootstrap_expired", "The restricted pairing bootstrap has expired.");
  }
}

function assertCompletionMatchesBootstrap(bootstrap: PairingRelayBootstrap, input: PairingCompletionRequest): void {
  const invite = input.invite;
  if (bootstrap.role !== "entry"
    || bootstrap.tenantId !== invite.tenantId
    || bootstrap.routeId !== invite.endpointRouteId
    || bootstrap.endpointDeviceId !== invite.endpointDeviceId
    || bootstrap.endpointPinRef !== invite.endpointPinRef
    || bootstrap.mode !== invite.mode
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(bootstrap.bootstrapId)
    || !bootstrap.relayAdmission || bootstrap.relayAdmission.length < 32
    || !isBinding(bootstrap.account)
    || bootstrap.account.accountId !== input.account.accountId
    || bootstrap.account.authEpoch !== input.account.authEpoch
    || bootstrap.entryDeviceId !== input.deviceId
    || input.purpose !== "pair_device"
    || input.target.tenantId !== invite.tenantId
    || input.target.routeId !== invite.endpointRouteId
    || input.target.deviceId !== input.deviceId
    || input.target.devicePublicKey !== input.devicePublicKey
    || (input.entryPeerIdentity !== null && !isPairingPeerIdentity(input.entryPeerIdentity,
      routePeerId(bootstrap.tenantId, bootstrap.routeId, input.deviceId)))
    || input.devicePublicKey.length < 32
    || input.challengeId.length < 8
    || !isAccountStepUpPermitId(input.permitId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(input.operationId)
    || !/^[A-Za-z0-9_-]{80,100}$/u.test(input.signature)
    || !isActionTarget(input.target)
    || !Number.isSafeInteger(bootstrap.admissionGeneration) || bootstrap.admissionGeneration < 1
    || !Number.isSafeInteger(bootstrap.revocationRevision) || bootstrap.revocationRevision < 0
    || !Number.isFinite(Date.parse(bootstrap.expiresAt))) {
    throw entryError("pairing_completion_invalid", "The saved completion does not match its original account, endpoint and device admission.");
  }
}

function routePeerId(tenantId: string, routeId: string, deviceId: string): string {
  return peerIdForRouteDevice({ tenantId, routeId, deviceId }) ?? "";
}

function assertSameInvite(input: PairingInvite, expected: PairingInvite): void {
  if (input.inviteId !== expected.inviteId
    || input.tenantId !== expected.tenantId
    || input.endpointRouteId !== expected.endpointRouteId
    || input.endpointDeviceId !== expected.endpointDeviceId
    || input.endpointPinRef !== expected.endpointPinRef
    || input.pairingToken !== expected.pairingToken) {
    throw entryError("pairing_invite_mismatch", "The pairing request is not bound to the active endpoint invite.");
  }
}

function isBinding(value: unknown): value is AccountAuthorityBinding {
  return isRecord(value)
    && typeof value.accountId === "string"
    && Number.isSafeInteger(value.authEpoch)
    && Number(value.authEpoch) > 0;
}

function isActionTarget(value: unknown): value is AccountActionTarget {
  return isRecord(value)
    && typeof value.tenantId === "string"
    && typeof value.routeId === "string"
    && typeof value.deviceId === "string"
    && typeof value.devicePublicKey === "string"
    && typeof value.grantRef === "string"
    && Array.isArray(value.scopes)
    && value.scopes.every((scope) => typeof scope === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256);
}
