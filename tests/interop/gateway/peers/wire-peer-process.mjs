import { startWirePeer } from './wire-peer.mjs';

const peer = await startWirePeer({ protocolVersion: process.env.MESHRIX_INTEROP_PEER_PROTOCOL_VERSION ?? '2026-07-28' });
process.send?.({ type: 'ready', endpoint: peer.endpoint });
process.on('message', async message => {
  if (message?.type === 'snapshot') process.send?.({ type: 'snapshot', id: message.id, snapshot: peer.snapshot() });
  if (message?.type === 'close') {
    await peer.close();
    process.disconnect?.();
  }
});
