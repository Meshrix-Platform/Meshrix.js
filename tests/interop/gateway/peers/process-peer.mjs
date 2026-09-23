import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function startProcessPeer(ledger, protocolVersion = '2026-07-28') {
  const child = fork(fileURLToPath(new URL('./wire-peer-process.mjs', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, MESHRIX_INTEROP_PEER_PROTOCOL_VERSION: protocolVersion }
  });
  const release = ledger?.trackChild(child.pid, { label: 'wire-peer', handle: child });
  let sequence = 0;
  const pending = new Map();
  let endpoint;
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message?.type === 'ready') { endpoint = message.endpoint; resolve(); }
      if (message?.type === 'snapshot') { pending.get(message.id)?.(message.snapshot); pending.delete(message.id); }
    });
    child.once('error', reject);
    child.once('exit', () => { release?.(); reject(new Error('peer_process_exited')); });
  });
  let timer;
  try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('peer_startup_timeout')), 5000); })]); }
  catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
  return {
    endpoint,
    protocolVersion,
    async snapshot() {
      const id = ++sequence;
      const response = new Promise(resolve => pending.set(id, resolve));
      child.send({ type: 'snapshot', id });
      let timer;
      try { return await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('peer_snapshot_timeout')), 5000); })]); }
      finally { clearTimeout(timer); pending.delete(id); }
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.send({ type: 'close' });
      let timer;
      const graceful = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
      clearTimeout(timer);
      if (!graceful) { child.kill(); await exited; throw new Error('peer_process_not_cleanly_reaped'); }
    }
  };
}
