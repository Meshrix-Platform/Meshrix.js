/**
 * Host-supplied channel port for the peer client.
 *
 * All 13 peer wire kinds travel as request/response pairs on the SAME
 * authenticated admitted session channel the device already owns (the relay
 * session transport, like frames/recovery do). The transport owns raw
 * message serialization and demux: `send` emits one wire request object,
 * `onMessage` delivers every decoded inbound wire object — responses and
 * unsolicited pushes alike. The client correlates a response to its single
 * in-flight request by expected kind and treats everything else as a push
 * (`peer-messages` wakeup pages, `peer-retention-policy` advertisements).
 *
 * A transport that cannot surface inbound objects (poll-only wiring) may
 * omit `onMessage`; the host then calls `PeerClient.handleInboundMessage`
 * for every decoded channel message.
 */
export interface PeerClientTransport {
  send(message: Record<string, unknown>): void | Promise<void>;
  onMessage?(handler: (message: Record<string, unknown>) => void): void;
}

/**
 * Pairing-layer lookup the host owns: maps a wire device id to the stable
 * crypto peer id. The client consults it before initiating a session and
 * falls back to bindings learned from fetched bundles and decrypted
 * envelopes — it never invents a peer id.
 */
export interface PeerDeviceDirectory {
  resolvePeerId(peerDeviceId: string): string | null | Promise<string | null>;
}

/** Static directory for fixed pairings and tests. */
export function staticPeerDirectory(bindings: Readonly<Record<string, string>>): PeerDeviceDirectory {
  return Object.freeze({
    resolvePeerId(peerDeviceId: string): string | null {
      return bindings[peerDeviceId] ?? null;
    }
  });
}
