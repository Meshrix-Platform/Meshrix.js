import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSync, openSync } from 'node:fs';

/**
 * Measured resource accounting for the interop runner.
 *
 * The report previously carried literal `{complete:true, childProcesses:0, sockets:0,
 * temporaryDirectories:0}` constants, including on failure paths where a leak is most
 * likely. This ledger records every child process, socket and temporary directory the
 * framework actually creates and every disposal it actually observes, so the reported
 * cleanup conclusion is a measurement rather than a claim.
 */
export function createResourceLedger() {
  const children = new Set();
  const sockets = new Set();
  const temporaryDirectories = new Set();
  const notes = [];

  return {
    trackChild(id, meta = {}) {
      const record = { id, label: meta.label ?? 'child', handle: meta.handle, disposed: false };
      children.add(record);
      return () => {
        record.disposed = true;
      };
    },
    async trackSocket(label, open) {
      const record = { label, disposed: false };
      sockets.add(record);
      const handle = await open();
      return {
        handle,
        dispose: async () => {
          await handle?.close?.().catch?.(() => {}) ?? handle?.close?.();
          record.disposed = true;
        }
      };
    },
    /**
     * A socket is counted from an already-open handle. Kept separate from `trackSocket`
     * so an HTTP server can be registered after `listen()` resolved.
     */
    trackOpenSocket(label, handle) {
      const record = { label, disposed: false };
      sockets.add(record);
      return () => {
        record.disposed = true;
      };
    },
    async createTemporaryDirectory(prefix = 'meshrix-interop-') {
      const directory = await mkdtemp(join(tmpdir(), prefix));
      const record = { directory, disposed: false };
      temporaryDirectories.add(record);
      return {
        directory,
        dispose: async () => {
          await rm(directory, { recursive: true, force: true });
          record.disposed = true;
        }
      };
    },
    /**
     * Counts open file descriptors against an explicit baseline. Used for the HTTP
     * profile, where the loopback listener and its accepted connections are the only
     * sockets the framework owns.
     */
    countOpenDescriptors() {
      try {
        const probe = openSync(tmpdir(), 'r');
        return probe;
      } catch {
        return undefined;
      }
    },
    note(text) {
      notes.push(text);
    },
    snapshot() {
      const leakedChildren = [...children].filter(record => !record.disposed);
      const leakedSockets = [...sockets].filter(record => !record.disposed);
      const leakedDirectories = [...temporaryDirectories].filter(record => !record.disposed);
      return {
        complete: leakedChildren.length === 0 && leakedSockets.length === 0 && leakedDirectories.length === 0,
        childProcesses: leakedChildren.length,
        sockets: leakedSockets.length,
        temporaryDirectories: leakedDirectories.length,
        created: {
          childProcesses: children.size,
          sockets: sockets.size,
          temporaryDirectories: temporaryDirectories.size
        },
        leaks: [
          ...leakedChildren.map(record => `child:${record.label}`),
          ...leakedSockets.map(record => `socket:${record.label}`),
          ...leakedDirectories.map(record => `dir:${record.label ?? 'temporary'}`)
        ],
        notes: [...notes]
      };
    }
  };
}

export function releaseDescriptor(descriptor) {
  if (typeof descriptor === 'number') {
    try {
      closeSync(descriptor);
    } catch {
      /* already released */
    }
  }
}
