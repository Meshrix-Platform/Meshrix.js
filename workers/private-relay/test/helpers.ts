/**
 * Synthetic test helpers: enrollment, socket plumbing, ephemeral WebCrypto
 * keys and recovery-wire builders. Every key/credential/nonce is generated
 * in-code — no real secrets or machine data anywhere.
 */

import { env, SELF } from "cloudflare:test";

import {
  PRIVATE_RELAY_PEER_SCHEMA_VERSION,
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
} from "../../../packages/contracts/src/private-relay/index.ts";
import { base64UrlToBytes, bytesToBase64Url, mailboxObjectName, sha256Hex, utf8Bytes, vaultObjectName } from "../src/ids.ts";
import { snapshotCiphertextDigest, vaultFetchTranscript, vaultWriteTranscript } from "../src/vault-crypto.ts";

export const ADMIN_TOKEN = "local-only-synthetic-admin-token";
export const RELAY_ORIGIN = "https://relay.test";
/**
 * Synthetic local-only invite signing key (PKCS8, base64url) whose public
 * half is the `RELAY_INVITE_PUBLIC_KEY` var in the committed local
 * profile. Used only by the test suite to mint tickets — a real issuer's
 * private key never enters this repository.
 */
export const INVITE_PRIVATE_KEY_PKCS8 = "MC4CAQAwBQYDK2VwBCIEIN4gE0_2Doc0lS9J575qYulQEh4Dtl4U7gd2JONu_pMF";

export const TENANT_A = "tenant.pr.1";
export const TENANT_B = "tenant.pr.2";
export const ROUTE_1 = "route.pr.1";
export const ROUTE_2 = "route.pr.2";
export const VAULT_1 = "vault.pr.1";

let nonceCounter = 0;
export function freshNonce(prefix = "n.test"): string {
  nonceCounter += 1;
  return `${prefix}.${Date.now().toString(36)}.${nonceCounter}uniquevalue`;
}

export async function adminPost(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${RELAY_ORIGIN}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function adminGet(path: string): Promise<Response> {
  return SELF.fetch(`${RELAY_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

export interface Enrolled {
  deviceId: string;
  routeId: string;
  role: string;
  mode: string;
  credential: string;
  admissionGeneration: number;
  revocationRevision: number;
}

export async function enroll(
  tenantId: string,
  deviceId: string,
  routeId: string,
  role: "entry" | "endpoint",
  mode: "personal" | "enterprise" = "personal",
): Promise<Enrolled> {
  const response = await adminPost(`/admin/tenants/${tenantId}/enroll`, { deviceId, routeId, role, mode });
  const body = await response.json() as Enrolled & { error?: string };
  if (!response.ok) throw new Error(`enroll failed ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------------------------------
// WebSocket plumbing
// ---------------------------------------------------------------------------

export interface ReceivedMessage {
  raw: string;
  parsed: Record<string, unknown> | null;
}

export class WsClient {
  readonly ws: WebSocket;
  private queue: ReceivedMessage[] = [];
  private waiters: { pred: (m: ReceivedMessage) => boolean; resolve: (m: ReceivedMessage) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  closed: Promise<{ code: number; reason: string }>;
  private closedResolve!: (value: { code: number; reason: string }) => void;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => { this.closedResolve = resolve; });
    ws.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      const message: ReceivedMessage = { raw, parsed: safeParse(raw) };
      const index = this.waiters.findIndex((waiter) => waiter.pred(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      this.closedResolve({ code: event.code, reason: event.reason });
    });
  }

  static async connect(tenantId: string, routeId: string, credential: string): Promise<WsClient> {
    const response = await SELF.fetch(`${RELAY_ORIGIN}/session/${tenantId}/${routeId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${credential}` },
    });
    if (!response.webSocket) {
      const text = await response.text();
      throw new Error(`upgrade refused ${response.status}: ${text}`);
    }
    const ws = response.webSocket;
    ws.accept();
    return new WsClient(ws);
  }

  /** Try to upgrade; returns the HTTP status when the upgrade is refused. */
  static async tryConnect(tenantId: string, routeId: string, credential: string): Promise<{ status: number; ws: WsClient | null }> {
    const response = await SELF.fetch(`${RELAY_ORIGIN}/session/${tenantId}/${routeId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${credential}` },
    });
    if (!response.webSocket) return { status: response.status, ws: null };
    const ws = response.webSocket;
    ws.accept();
    return { status: 101, ws: new WsClient(ws) };
  }

  send(message: unknown): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  async waitFor(pred: (m: ReceivedMessage) => boolean, timeoutMs = 5_000): Promise<ReceivedMessage> {
    const queued = this.queue.findIndex(pred);
    if (queued >= 0) {
      const [message] = this.queue.splice(queued, 1);
      return message;
    }
    return new Promise<ReceivedMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.pred === pred);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for websocket message"));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  async waitForKind(kind: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const message = await this.waitFor((m) => m.parsed?.kind === kind, timeoutMs);
    return message.parsed!;
  }

  close(): void {
    try { this.ws.close(1000, "test-done"); } catch { /* closed */ }
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function sessionOpenMessage(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "v0.0.1:private-relay:wire-1",
    wireProtocol: "meshrix-private-relay/0",
    kind: "session-open",
    purpose: "forward",
    clientNonce: freshNonce("cn.test"),
    ...overrides,
  };
}

export function frameMessage(sessionId: string, routeId: string, seq: number, payloadB64: string, final = false): Record<string, unknown> {
  return {
    schemaVersion: "v0.0.1:private-relay:wire-1",
    wireProtocol: "meshrix-private-relay/0",
    kind: "frame",
    sessionId,
    routeId,
    seq,
    messageId: `msg.test.${seq}`,
    payload: payloadB64,
    final,
  };
}

export function frameAckMessage(routeId: string, upToSeq: number): Record<string, unknown> {
  return {
    schemaVersion: "v0.0.1:private-relay:wire-1",
    wireProtocol: "meshrix-private-relay/0",
    kind: "frame-ack",
    routeId,
    upToSeq,
  };
}

export function sessionReconnectMessage(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "v0.0.1:private-relay:wire-1",
    wireProtocol: "meshrix-private-relay/0",
    kind: "session-reconnect",
    clientNonce: freshNonce("cn.test"),
    ...overrides,
  };
}

export function recoveryRequestMessage(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "recovery-request",
    purpose: "recover_device",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Vault helpers (ephemeral keys)
// ---------------------------------------------------------------------------

export interface VaultKeys {
  keyId: string;
  algorithm: "Ed25519";
  publicKey: string;
  privateKey: CryptoKey;
}

export async function generateVaultKeys(keyId: string): Promise<VaultKeys> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer;
  return { keyId, algorithm: "Ed25519", publicKey: bytesToBase64Url(raw), privateKey: pair.privateKey };
}

export async function provisionVault(
  vaultId: string,
  writers: VaultKeys[],
  recoveryVerifier: { keyId: string; algorithm: string; publicKey: string },
  generation = 1,
): Promise<Response> {
  const response = await adminPost(`/admin/vaults/${vaultId}/provision`, {
    writers: writers.map((w) => ({ keyId: w.keyId, algorithm: w.algorithm, publicKey: w.publicKey })),
    recoveryVerifier,
    generation,
  });
  // Drain the body: an unconsumed response stream keeps the vault object
  // referenced and blocks evictDurableObject in restart checks.
  await response.arrayBuffer();
  return response;
}

export function makeSnapshot(
  vaultId: string,
  generation: number,
  revision: number,
  ciphertext: string,
  verifier: { keyId: string; algorithm: string; publicKey: string },
): Record<string, unknown> {
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "encrypted-recovery-snapshot",
    vaultId,
    formatVersion: 1,
    generation,
    revision,
    snapshot: {
      algorithm: "XChaCha20-Poly1305",
      nonce: `sn.test.${revision}snapshotnonce`,
      ciphertext,
      byteLength: Math.floor(ciphertext.length * 3 / 4),
    },
    publicVerifier: verifier,
  };
}

export async function signTranscript(privateKey: CryptoKey, transcript: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, transcript as BufferSource);
  return bytesToBase64Url(signature);
}

export async function vaultFetchMessage(
  vaultId: string,
  key: VaultKeys,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const nonce = freshNonce("fn.test");
  const issuedAt = new Date().toISOString();
  const proof = { keyId: key.keyId, nonce, issuedAt, ...(overrides.fetchProof as object ?? {}) };
  const signature = await signTranscript(key.privateKey, vaultFetchTranscript(vaultId, proof as { keyId: string; nonce: string; issuedAt: string }));
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "vault-fetch",
    vaultId,
    purpose: "vault_fetch",
    ...overrides,
    fetchProof: { ...proof, signature },
  };
}

export async function vaultWriteMessage(
  vaultId: string,
  writer: VaultKeys,
  expectedRevision: number,
  snapshot: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const ciphertext = (snapshot.snapshot as { ciphertext: string }).ciphertext;
  const snapshotDigest = await snapshotCiphertextDigest(ciphertext);
  const nonce = freshNonce("wn.test");
  const auth = { writerKeyId: writer.keyId, nonce, snapshotDigest, ...(overrides.writeAuth as object ?? {}) };
  const signature = await signTranscript(
    writer.privateKey,
    vaultWriteTranscript(vaultId, auth as { writerKeyId: string; nonce: string; snapshotDigest: string }, expectedRevision),
  );
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "vault-write",
    vaultId,
    purpose: "vault_write",
    expectedRevision,
    snapshot,
    ...overrides,
    writeAuth: { ...auth, signature },
  };
}

let vaultPostSourceCounter = 0;
export async function vaultPost(vaultId: string, message: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  // Unique source per call: the public edge counts every well-formed
  // attempt toward a per-source bound, so a suite of same-source posts
  // would otherwise throttle itself.
  vaultPostSourceCounter += 1;
  const response = await SELF.fetch(`${RELAY_ORIGIN}/vault/${vaultId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${vaultPostSourceCounter % 250}` },
    body: JSON.stringify(message),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/**
 * Durable-Object-level post, bypassing the public edge: refusal semantics
 * (proof_invalid/not_found/purpose_denied) are the object's contract —
 * the edge deliberately normalizes them into one refusal, so tests that
 * exercise the semantics call the object directly.
 */
export async function vaultPostDirect(vaultId: string, message: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(vaultId)));
  const response = await stub.fetch("http://vault.internal/vault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export function randomCiphertext(byteLength = 48): string {
  const bytes = new Uint8Array(byteLength);
  // getRandomValues rejects buffers over 64 KiB; fill in bounded chunks.
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
  }
  return bytesToBase64Url(bytes);
}

// ---------------------------------------------------------------------------
// Peer mailbox wire builders (schema v0.0.1:private-relay:peer-1)
// ---------------------------------------------------------------------------

const PEER_PROTOCOL = "meshrix-private-relay/0";

function peerEnvelope(kind: string, extras: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: PRIVATE_RELAY_PEER_SCHEMA_VERSION,
    wireProtocol: PEER_PROTOCOL,
    kind,
    ...extras,
  };
}

let peerCounter = 0;
export function freshPeerId(prefix = "msg.peer"): string {
  peerCounter += 1;
  return `${prefix}.${Date.now().toString(36)}.${peerCounter}id`;
}

export function peerEnvelopeObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "signal-pqxdh",
    headers: {
      messageType: "session",
      senderBundleId: "bnd.test.sender.1",
      recipientBundleId: "bnd.test.recipient.1",
      prekeyId: null,
      signedPrekeyId: null,
      baseKeyId: null,
    },
    ciphertext: `Q0lQSEVSVGVYVHN5bnRoZXRpYw${peerCounter}${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

export function peerBundleObject(deviceId: string, revision: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "signal-pqxdh",
    bundleId: `bnd.test.${deviceId.slice(-8)}.${revision}`,
    revision,
    material: `QlVORExFbWF0ZXJpYWw${revision}${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

export function peerSendMessage(
  tenantId: string, routeId: string, deviceId: string, peerDeviceId: string,
  messageId: string, envelope: Record<string, unknown>,
): Record<string, unknown> {
  return peerEnvelope("peer-send", { tenantId, routeId, deviceId, peerDeviceId, messageId, envelope });
}

export function peerFetchMessage(
  tenantId: string, routeId: string, deviceId: string, afterSeq: number, limit = 64,
): Record<string, unknown> {
  return peerEnvelope("peer-fetch", { tenantId, routeId, deviceId, afterSeq, limit });
}

export function peerAckMessage(
  tenantId: string, routeId: string, deviceId: string,
  received: { messageId: string; position: number }[],
  reports: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return peerEnvelope("peer-ack", { tenantId, routeId, deviceId, received, reports });
}

export function peerReceiptQueryMessage(
  tenantId: string, routeId: string, deviceId: string, messageIds: string[],
): Record<string, unknown> {
  return peerEnvelope("peer-receipt", { tenantId, routeId, deviceId, messageIds });
}

export function peerBundlePublishMessage(
  tenantId: string, routeId: string, deviceId: string, bundle: Record<string, unknown>,
): Record<string, unknown> {
  return peerEnvelope("peer-bundle-publish", { tenantId, routeId, deviceId, bundle });
}

export function peerBundleFetchMessage(
  tenantId: string, routeId: string, deviceId: string, peerDeviceId: string,
): Record<string, unknown> {
  return peerEnvelope("peer-bundle-fetch", { tenantId, routeId, deviceId, peerDeviceId });
}

export function peerAgentReport(
  kind: string, messageId: string, position: number, detail: string | null = null,
): Record<string, unknown> {
  return { kind, source: "agent", messageId, position, detail };
}

/** Durable Object stub for one recipient partition. */
export function mailboxStub(tenantId: string, routeId: string, deviceId: string) {
  return env.RELAY_MAILBOX.get(env.RELAY_MAILBOX.idFromName(mailboxObjectName(tenantId, routeId, deviceId)));
}

/** Direct internal request to a partition (exercises the session reach-in). */
export async function mailboxPeerCall(
  tenantId: string, routeId: string, ownerDeviceId: string,
  admission: Record<string, unknown>, message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stub = mailboxStub(tenantId, routeId, ownerDeviceId);
  const response = await stub.fetch("http://mailbox.internal/internal/peer", {
    method: "POST",
    body: JSON.stringify({ admission, message }),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export { bytesToBase64Url, base64UrlToBytes, sha256Hex, utf8Bytes };
export { env };
