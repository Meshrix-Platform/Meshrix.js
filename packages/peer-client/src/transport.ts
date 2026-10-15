import { base64urlEncode } from "@meshrix/peer-crypto";
import type { PeerIdentity } from "@meshrix/peer-crypto";

/** Host-supplied channel port for online Peer forwarding. `onMessage` may
 * receive `peer-presence` as a wakeup for local pending retries; the client
 * must still rely on fresh session admission for authority. */
export interface PeerClientTransport {
  send(message: Record<string, unknown>): void | Promise<void>;
  onMessage?(handler: (message: Record<string, unknown>) => void): void;
}

/**
 * Pairing-layer lookup the host owns. The returned Signal public identity
 * must have been persisted in the authenticated pairing completion record;
 * relay-provided metadata is never a trust source.
 */
export interface PeerPairedSignalIdentity {
  readonly peerId: string;
  readonly signalDeviceId: number;
  readonly registrationId: number;
  /** Canonical unpadded base64url of `PeerIdentity.publicKey.serialize()`. */
  readonly identityKey: string;
}

/** Safe public projection for the signed pairing transcript; contains no private key bytes. */
export function peerIdentityPublicDescriptor(identity: PeerIdentity): PeerPairedSignalIdentity {
  return Object.freeze({
    peerId: identity.peerId,
    signalDeviceId: identity.deviceId,
    registrationId: identity.registrationId,
    identityKey: base64urlEncode(identity.publicKey.serialize())
  });
}

export interface PeerDeviceDirectory {
  resolvePeerIdentity(peerDeviceId: string): PeerPairedSignalIdentity | null | Promise<PeerPairedSignalIdentity | null>;
}

/** Static directory for fixed pairings and tests. */
export function staticPeerDirectory(bindings: Readonly<Record<string, PeerPairedSignalIdentity>>): PeerDeviceDirectory {
  return Object.freeze({
    resolvePeerIdentity(peerDeviceId: string): PeerPairedSignalIdentity | null {
      return bindings[peerDeviceId] ?? null;
    }
  });
}
