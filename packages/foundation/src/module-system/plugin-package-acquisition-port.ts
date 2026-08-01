import { createHash } from "node:crypto";

import { assertPluginPackageSource } from "@meshrix/contracts/plugins/plugin-package-source";

function digest(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Source-neutral acquisition port.
 * Production GitHub/local adapters are registered by later nodes; 001 ships the port + bytes seam.
 */
export function createPluginPackageAcquisitionPort({ adapters = {} }: Record<string, any> = {}) : any {
  const registry: any = new Map<any, any>((Object.entries(adapters) as [string, any][]));

  return Object.freeze({
    id: "PluginPackageAcquisitionPort",

    registerAdapter(kind?: any, adapter?: any) : any {
      if (typeof kind !== "string" || typeof adapter !== "function") {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: adapter registration is invalid");
      }
      registry.set(kind, adapter);
    },

    async acquire(source?: any, policy: Record<string, any> = {}, signal: any = undefined) : Promise<any> {
      if (signal?.aborted) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
      }
      const normalized: any = assertPluginPackageSource(source);
      if (normalized.kind === "bytes") {
        const bytes: any = Buffer.from(normalized.bytes);
        const archiveDigest: any = digest(bytes);
        if (normalized.expectedDigest && normalized.expectedDigest !== archiveDigest) {
          throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: acquired digest mismatch");
        }
        return Object.freeze({
          sourceKind: "bytes",
          archiveDigest,
          bytes,
          byteLength: bytes.length
        });
      }
      const adapter: any = registry.get(normalized.kind);
      if (typeof adapter !== "function") {
        throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: no adapter registered for ${normalized.kind}`);
      }
      const acquired: any = await adapter(normalized, policy, signal);
      if (!acquired || !Buffer.isBuffer(acquired.bytes)) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: adapter did not return bytes");
      }
      const archiveDigest: any = acquired.archiveDigest || digest(acquired.bytes);
      if (normalized.expectedDigest && normalized.expectedDigest !== archiveDigest) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: acquired digest mismatch");
      }
      return Object.freeze({
        sourceKind: normalized.kind,
        archiveDigest,
        bytes: Buffer.from(acquired.bytes),
        byteLength: acquired.bytes.length
      });
    }
  });
}
