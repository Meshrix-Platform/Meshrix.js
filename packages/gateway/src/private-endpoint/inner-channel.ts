import { createHash, X509Certificate, type KeyObject } from "node:crypto";
import { Duplex } from "node:stream";
import { TLSSocket, connect as tlsConnect, type PeerCertificate, type TLSSocketOptions } from "node:tls";
import { PRIVATE_RELAY_LIMITS, parsePrivateRelayMessage } from "@meshrix/contracts/private-relay";

/**
 * Inner pinned-TLS channel for the private endpoint.
 *
 * The relay only ever forwards opaque frame payloads; those payloads are TLS
 * records of an inner channel terminated here. The channel is authenticated by
 * peer *public-key pinning* (SPKI fingerprint), not by CA trust and never by a
 * relay-selected identifier. This module owns the frame↔TLS pump and the pin
 * verification; enrollment semantics live in the identity store.
 */
export function spkiSha256Base64Url(key: KeyObject | Buffer | string): string {
  const der = typeof key === "object" && key !== null && "export" in key
    ? (key as KeyObject).export({ format: "der", type: "spki" })
    : Buffer.isBuffer(key) ? key : Buffer.from(String(key), "utf8");
  return createHash("sha256").update(der).digest("base64url");
}

function peerSpkiPin(peer: PeerCertificate | undefined): string | null {
  const pubkey = peer?.pubkey;
  let der: Buffer | undefined;
  if (pubkey) {
    der = typeof pubkey === "object" && "export" in pubkey
      ? (pubkey as unknown as KeyObject).export({ format: "der", type: "spki" })
      : Buffer.from(pubkey as Buffer);
  } else if (peer?.raw) {
    // Node omits PeerCertificate.pubkey for some key types (e.g. Ed25519) —
    // derive the SPKI from the raw DER certificate instead of failing closed
    // on every such peer.
    try {
      der = new X509Certificate(peer.raw).publicKey.export({ format: "der", type: "spki" });
    } catch {
      return null;
    }
  }
  if (!der) return null;
  return createHash("sha256").update(der).digest("base64url");
}

export interface InnerTlsChannel {
  readonly socket: TLSSocket;
  /** Resolves with the verified peer pin once the handshake completes. */
  readonly established: Promise<{ readonly peerSpki: string }>;
  close(): void;
}

function attachPinCheck(
  tlsSocket: TLSSocket,
  pinned: ReadonlySet<string>,
  established: { resolve(result: { peerSpki: string }): void; reject(error: Error): void },
  timer?: NodeJS.Timeout
): void {
  tlsSocket.once("secure", () => {
    try {
      const pin = peerSpkiPin(tlsSocket.getPeerCertificate(true));
      if (!pin || !pinned.has(pin)) {
        established.reject(Object.assign(new Error("Peer identity is not pinned for this endpoint."), { code: "inner_tls_peer_unpinned" }));
        tlsSocket.destroy();
        return;
      }
      established.resolve({ peerSpki: pin });
    } catch (error) {
      established.reject(error as Error);
      tlsSocket.destroy();
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

function handshakePromise() {
  let resolve!: (result: { peerSpki: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ peerSpki: string }>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, settle: { resolve, reject } };
}

/**
 * Wrap a Duplex carrying opaque bytes (typically a relay frame pump) in a
 * server-side TLS 1.3 socket that requires and pins the client SPKI.
 */
export function createInnerTlsEndpoint(options: {
  readonly socket: Duplex;
  readonly key: TLSSocketOptions["key"];
  readonly cert: TLSSocketOptions["cert"];
  /** Pinned SPKI fingerprints accepted for this session's peer. */
  readonly pinnedPeerSpki: readonly string[];
  readonly handshakeTimeoutMs?: number;
}): InnerTlsChannel {
  const pinned = new Set(options.pinnedPeerSpki);
  const { promise, settle } = handshakePromise();
  const timer = options.handshakeTimeoutMs && options.handshakeTimeoutMs > 0
    ? setTimeout(() => {
        settle.reject(Object.assign(new Error("Inner TLS handshake timed out."), { code: "inner_tls_handshake_timeout" }));
        tlsSocket.destroy();
      }, options.handshakeTimeoutMs)
    : undefined;
  const tlsSocket = new TLSSocket(options.socket, {
    isServer: true,
    key: options.key,
    cert: options.cert,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: false,
    enableTrace: false
  });
  attachPinCheck(tlsSocket, pinned, settle, timer);
  tlsSocket.once("error", (error) => {
    if (timer) clearTimeout(timer);
    settle.reject(error);
  });
  return Object.freeze({ socket: tlsSocket, established: promise, close() {
    if (timer) clearTimeout(timer);
    tlsSocket.destroy();
  } });
}

/**
 * Client-side counterpart used by the entry product and by tests: mutual TLS
 * over the caller-supplied duplex, pinning the endpoint SPKI.
 */
export function createInnerTlsClient(options: {
  readonly socket: Duplex;
  readonly key: TLSSocketOptions["key"];
  readonly cert: TLSSocketOptions["cert"];
  readonly ca?: TLSSocketOptions["ca"];
  readonly pinnedPeerSpki: readonly string[];
  readonly handshakeTimeoutMs?: number;
}): InnerTlsChannel {
  const pinned = new Set(options.pinnedPeerSpki);
  const { promise, settle } = handshakePromise();
  const timer = options.handshakeTimeoutMs && options.handshakeTimeoutMs > 0
    ? setTimeout(() => {
        settle.reject(Object.assign(new Error("Inner TLS handshake timed out."), { code: "inner_tls_handshake_timeout" }));
        tlsSocket.destroy();
      }, options.handshakeTimeoutMs)
    : undefined;
  const tlsSocket = tlsConnect({
    socket: options.socket,
    key: options.key,
    cert: options.cert,
    ca: options.ca,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: false,
    servername: "meshrix-private-endpoint"
  }) as TLSSocket;
  attachPinCheck(tlsSocket, pinned, settle, timer);
  tlsSocket.once("error", (error) => {
    if (timer) clearTimeout(timer);
    settle.reject(error);
  });
  return Object.freeze({ socket: tlsSocket, established: promise, close() {
    if (timer) clearTimeout(timer);
    tlsSocket.destroy();
  } });
}

/**
 * Bidirectional pump between a relay session frame stream and a Duplex.
 * Inbound relay payloads are pushed into the inner channel; bytes written by
 * the TLS socket are emitted as outbound relay frames through `sendFrame`.
 */
export interface RelayFrameDuplex extends Duplex {
  /** Push an inbound base64url payload; false when the bounded buffer is full. */
  feed(payloadBase64Url: string): boolean;
}

export function createRelayFrameDuplex(options: {
  sendFrame: (payloadBase64Url: string) => boolean;
  onOverflow?: () => void;
  /** Invoked when a consumer reads buffered bytes — queue-drained frames may be retryable. */
  onDrained?: () => void;
  maxBufferedBytes?: number;
}): RelayFrameDuplex {
  const maxBuffered = options.maxBufferedBytes ?? PRIVATE_RELAY_LIMITS.maxOutstandingBytes;
  const duplex = new Duplex({
    read() {
      options.onDrained?.();
    },
    write(chunk: Buffer, _encoding, callback) {
      const accepted = options.sendFrame(chunk.toString("base64url"));
      if (!accepted) {
        options.onOverflow?.();
        callback(Object.assign(new Error("Relay frame backpressure: bounded buffer exhausted."), { code: "relay_backpressure" }));
        return;
      }
      callback();
    }
  }) as RelayFrameDuplex;
  duplex.feed = (payloadBase64Url: string) => {
    if (duplex.destroyed || duplex.readableEnded) return false;
    const bytes = Buffer.from(payloadBase64Url, "base64url");
    if (duplex.readableLength + bytes.length > maxBuffered) return false;
    // push()'s return is only a backpressure hint — the bytes are queued
    // either way. Acceptance is decided by our own bounded buffer above, so
    // a large-but-in-budget frame is never re-fed as a duplicate TLS record.
    duplex.push(bytes);
    return true;
  };
  return duplex;
}

/**
 * Feed one decoded relay message into a frame duplex. Returns true when the
 * message was an accepted opaque frame.
 */
export function feedRelayMessage(duplex: RelayFrameDuplex, message: unknown): boolean {
  const parsed = parsePrivateRelayMessage(message);
  if (!parsed || parsed.kind !== "frame") return false;
  return duplex.feed(String(parsed.payload));
}
