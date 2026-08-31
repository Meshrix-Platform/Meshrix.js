import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, it } from "vitest";

import {
  PLUGIN_BUNDLE_MANIFEST_FILENAME,
  PLUGIN_BUNDLE_MANIFEST_SCHEMA,
  normalizePluginBundleManifest
} from "#meshrix/contracts/plugins/plugin-bundle-manifest";
import { createBytesPluginPackageSource } from "#meshrix/contracts/plugins/plugin-package-source";
import { assertPluginPackageTransition, PLUGIN_PACKAGE_STATES } from "#meshrix/contracts/plugins/plugin-package-state";
import { createPluginPackageCustody } from "#meshrix/foundation/module-system/plugin-package-custody";
import { createPluginPackageLifecycle } from "#meshrix/foundation/module-system/plugin-package-lifecycle";
import { createPluginPackageAcquisitionPort } from "#meshrix/foundation/module-system/plugin-package-acquisition-port";
import {
  computePluginPackagePayloadDigest,
  validatePluginPackageArchive
} from "#meshrix/foundation/module-system/plugin-package-validator";
import { createPluginPackageTarGz, extractPluginPackageTarGz, sha256Digest } from "#meshrix/foundation/module-system/plugin-package-tar";
import { beginPluginContributionTransaction } from "#meshrix/server-runtime/composition/plugin-contribution-transaction";

function buildBundle({
  pluginId = "sample-plugin",
  trust = { algorithm: "configured-digest" },
  extraFiles = [],
  omitManifestFile = false,
  mutateManifest = null
}: Record<string, any> = {}) : any {
  const runtime: any = Buffer.from(
    "export async function activatePlugin(){ return { id: 'sample-plugin', close: async () => {} }; }\n",
    "utf8"
  );
  const contentFiles: any[] = [
    { path: "runtime.mjs", content: runtime },
    ...extraFiles.map((file?: any) : any => ({
      path: file.path,
      content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ""), "utf8")
    }))
  ];
  const payloadMap: any = new Map<any, any>(contentFiles.map((entry?: any) : any => [entry.path, entry.content]));
  const payloadDigest: any = computePluginPackagePayloadDigest(payloadMap);

  let manifestObject: Record<string, any> = {
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    pluginId,
    version: "1.0.0",
    label: pluginId,
    entrypoint: "runtime.mjs",
    files: contentFiles.map((entry?: any) : any => ({
      path: entry.path,
      sha256: sha256Digest(entry.content),
      size: entry.content.length
    })),
    coreCompatibility: {},
    dependencies: [],
    configurationSchema: {},
    permissions: [],
    lifecycleHooks: ["activate", "close"],
    payloadDigest,
    trust
  };
  if (typeof mutateManifest === "function") {
    manifestObject = mutateManifest(manifestObject) || manifestObject;
  }

  const manifestBytes: any = Buffer.from(`${JSON.stringify(manifestObject, null, 2)}\n`, "utf8");
  if (omitManifestFile) {
    return {
      archive: createPluginPackageTarGz(contentFiles),
      manifest: manifestObject
    };
  }

  const archive: any = createPluginPackageTarGz([
    { path: PLUGIN_BUNDLE_MANIFEST_FILENAME, content: manifestBytes },
    ...contentFiles
  ]);
  return {
    archive,
    manifest: normalizePluginBundleManifest(JSON.parse(manifestBytes.toString("utf8")))
  };
}

describe("plugin package protocol", () : any => {
  it("rejects closed-manifest mutations and hostile archives", async () : Promise<any> => {
    assert.throws(
      () : any => normalizePluginBundleManifest({ schemaVersion: "nope" }),
      /PLUGIN_PACKAGE_FORMAT_REJECTED/
    );
    assert.throws(
      () : any => normalizePluginBundleManifest({
        schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
        pluginId: "Bad_ID",
        version: "1",
        entrypoint: "runtime.mjs",
        files: [{ path: "runtime.mjs", sha256: "sha256:" + "a".repeat(64), size: 1 }],
        payloadDigest: "sha256:" + "b".repeat(64),
        trust: { algorithm: "configured-digest" }
      }),
      /pluginId/
    );

    // No package-manifest signature verification exists; an ed25519 trust
    // claim must be rejected as unsupported instead of admitted unverified.
    assert.throws(
      () : any => normalizePluginBundleManifest({
        schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
        pluginId: "sample-plugin",
        version: "1",
        entrypoint: "runtime.mjs",
        files: [{ path: "runtime.mjs", sha256: "sha256:" + "a".repeat(64), size: 1 }],
        payloadDigest: "sha256:" + "b".repeat(64),
        trust: { algorithm: "ed25519", publicKeyId: "ed25519:any", signature: "AAAA" }
      }),
      /PLUGIN_PACKAGE_TRUST_REJECTED/
    );

    const good: any = buildBundle();
    const verified: any = await validatePluginPackageArchive({
      bytes: good.archive,
      expectedPluginId: "sample-plugin"
    });
    assert.equal(verified.pluginId, "sample-plugin");
    assert.equal(verified.packageDigest, sha256Digest(good.archive));
    assert.equal(verified.manifest.payloadDigest, good.manifest.payloadDigest);
    assert.equal(
      verified.manifest.payloadDigest,
      computePluginPackagePayloadDigest(await extractPluginPackageTarGz(good.archive))
    );

    assert.throws(
      () : any => validatePluginPackageArchive({
        bytes: createPluginPackageTarGz([
          { path: "../escape.ts", content: Buffer.from("x") }
        ])
      }),
      /PLUGIN_PACKAGE_FORMAT_REJECTED/
    );
    await assert.rejects(
      () : any => validatePluginPackageArchive({
        bytes: createPluginPackageTarGz([
          { path: "runtime.mjs", content: Buffer.from("export default 1\n") }
        ])
      }),
      /manifest file is missing/
    );
    await assert.rejects(
      () : any => validatePluginPackageArchive({
        bytes: buildBundle({
          mutateManifest: (manifest?: any) : any => ({
            ...manifest,
            payloadDigest: "sha256:" + "f".repeat(64)
          })
        }).archive
      }),
      /payloadDigest/
    );
  });

  it("covers PluginPackageState transitions and fenced lifecycle", async () : Promise<any> => {
    for (const state of PLUGIN_PACKAGE_STATES) {
      assert.equal(typeof state, "string");
    }
    assert.throws(() : any => assertPluginPackageTransition("declared", "active"), /cannot move/);

    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle: any = buildBundle();
      const lifecycle: any = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
        acquisitionPort: createPluginPackageAcquisitionPort(),
        contributionTransactionFactory: async ({ pluginId, generation, packageDigest }: Record<string, any>) : Promise<any> =>
          beginPluginContributionTransaction({
            pluginId,
            generation,
            packageDigest,
            prepareContribution: async () : Promise<any> => Object.freeze({
              commit: async () : Promise<any> => undefined,
              rollback: async () : Promise<any> => undefined
            })
          })
      });

      const source: any = createBytesPluginPackageSource({ bytes: bundle.archive });
      const acquired: any = await lifecycle.acquire({
        pluginId: "sample-plugin",
        source,
        acquisitionIdempotencyKey: "acq-1"
      });
      assert.equal(acquired.state, "acquired");
      const acquiredAgain: any = await lifecycle.acquire({
        pluginId: "sample-plugin",
        source,
        acquisitionIdempotencyKey: "acq-1"
      });
      assert.equal(acquiredAgain.state, "acquired");

      const verified: any = await lifecycle.verify({ pluginId: "sample-plugin" });
      assert.equal(verified.state, "verified", verified.reasonCode || "");
      const staged: any = await lifecycle.stage({ pluginId: "sample-plugin", configuration: {} });
      assert.equal(staged.state, "staged");
      const active: any = await lifecycle.activate({
        pluginId: "sample-plugin",
        activationIdempotencyKey: "act-1"
      });
      assert.equal(active.state, "active");
      assert.equal(lifecycle.getHealth("sample-plugin").ready, true);

      const rolled: any = await lifecycle.rollback({ pluginId: "sample-plugin" });
      assert.equal(rolled.state, "rolled-back");
      const removed: any = await lifecycle.uninstall({ pluginId: "sample-plugin" });
      assert.equal(removed.state, "removed");
      assert.equal(JSON.stringify(removed).includes(root), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects hostile archives during bounded incremental admission", async () : Promise<any> => {
    const expanded: any = createPluginPackageTarGz([{ path: "payload.bin", content: Buffer.alloc(8 * 1024, 1) }]);
    await assert.rejects(
      () : any => extractPluginPackageTarGz(expanded, { maxBytes: 1024, maxExpansionRatio: 64 }),
      /expansion byte budget/
    );
    await assert.rejects(
      () : any => extractPluginPackageTarGz(expanded.subarray(0, expanded.length - 4), { maxExpansionRatio: 1024 }),
      /gzip-compressed tar|truncated/
    );
    const duplicate: any = createPluginPackageTarGz([
      { path: "same.txt", content: "first" },
      { path: "same.txt", content: "second" }
    ]);
    await assert.rejects(() : any => extractPluginPackageTarGz(duplicate), /duplicate archive entry/);
    const tooMany: any = createPluginPackageTarGz([
      { path: "first.txt", content: "first" },
      { path: "second.txt", content: "second" }
    ]);
    await assert.rejects(() : any => extractPluginPackageTarGz(tooMany, { maxEntries: 1 }), /entry count exceeded/);

    const invalidTypeTar: any = gunzipSync(createPluginPackageTarGz([{ path: "entry.txt", content: "value" }]));
    invalidTypeTar[156] = "2".charCodeAt(0);
    invalidTypeTar.fill(32, 148, 156);
    let sum: any = 0;
    for (const byte of invalidTypeTar.subarray(0, 512)) sum += byte;
    invalidTypeTar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    await assert.rejects(
      () : any => extractPluginPackageTarGz(gzipSync(invalidTypeTar)),
      /entry type is not a regular file/
    );

    const controller: any = new AbortController();
    controller.abort();
    await assert.rejects(
      () : any => extractPluginPackageTarGz(tooMany, { signal: controller.signal }),
      /admission cancelled/
    );
  });

  it("discards contribution generation on activation failure", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle: any = buildBundle();
      let discarded: any = false;
      const visibleContributions: any = new Set<any>();
      const lifecycle: any = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
        contributionTransactionFactory: async ({ pluginId, generation, packageDigest }: Record<string, any>) : Promise<any> =>
          beginPluginContributionTransaction({
            pluginId,
            generation,
            packageDigest,
            prepareContribution: async () : Promise<any> => Object.freeze({
              commit: async () : Promise<any> => {
                visibleContributions.add("sample-plugin.run");
                throw new Error("publish boom");
              },
              rollback: async () : Promise<any> => {
                visibleContributions.clear();
                discarded = true;
              }
            })
          })
      });
      await lifecycle.acquire({
        pluginId: "sample-plugin",
        source: createBytesPluginPackageSource({ bytes: bundle.archive })
      });
      const verified: any = await lifecycle.verify({ pluginId: "sample-plugin" });
      assert.equal(verified.state, "verified", verified.reasonCode || "");
      await lifecycle.stage({ pluginId: "sample-plugin", configuration: {} });
      const failed: any = await lifecycle.activate({ pluginId: "sample-plugin" });
      assert.equal(failed.state, "failed");
      assert.equal(discarded, true);
      assert.equal(visibleContributions.size, 0);
      assert.match(failed.reasonCode || "", /^PLUGIN_PACKAGE_/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("requires a contribution transaction before activation", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle: any = buildBundle();
      const custody: any = createPluginPackageCustody({ rootDir: path.join(root, "custody") });
      const lifecycle: any = createPluginPackageLifecycle({ custody });
      await lifecycle.acquire({
        pluginId: "sample-plugin",
        source: createBytesPluginPackageSource({ bytes: bundle.archive })
      });
      await lifecycle.verify({ pluginId: "sample-plugin" });
      await lifecycle.stage({ pluginId: "sample-plugin", configuration: {} });

      const failed: any = await lifecycle.activate({ pluginId: "sample-plugin" });

      assert.equal(failed.state, "failed");
      assert.equal(failed.reasonCode, "PLUGIN_PACKAGE_TRANSACTION_REQUIRED");
      assert.equal(lifecycle.getHealth("sample-plugin").ready, false);
      assert.equal((await custody.getActiveGeneration("sample-plugin")).state, "staged");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back published contributions when durable activation fails", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle: any = buildBundle();
      const durableCustody: any = createPluginPackageCustody({ rootDir: path.join(root, "custody") });
      let rejectActiveGeneration: any = true;
      const custody: any = Object.freeze({
        ...durableCustody,
        async setActiveGeneration(pluginId?: any, generation?: any) : Promise<any> {
          if (generation?.state === "active" && rejectActiveGeneration) {
            rejectActiveGeneration = false;
            throw new Error("forced active generation failure");
          }
          return durableCustody.setActiveGeneration(pluginId, generation);
        }
      });
      const visibleContributions: any = new Set<any>();
      const lifecycle: any = createPluginPackageLifecycle({
        custody,
        contributionTransactionFactory: async ({ pluginId, generation, packageDigest }: Record<string, any>) : Promise<any> =>
          beginPluginContributionTransaction({
            pluginId,
            generation,
            packageDigest,
            prepareContribution: async () : Promise<any> => Object.freeze({
              commit: async () : Promise<any> => {
                visibleContributions.add("sample-plugin.run");
              },
              rollback: async () : Promise<any> => {
                visibleContributions.clear();
              }
            })
          })
      });
      await lifecycle.acquire({
        pluginId: "sample-plugin",
        source: createBytesPluginPackageSource({ bytes: bundle.archive })
      });
      await lifecycle.verify({ pluginId: "sample-plugin" });
      await lifecycle.stage({ pluginId: "sample-plugin", configuration: {} });

      const failed: any = await lifecycle.activate({ pluginId: "sample-plugin" });

      assert.equal(failed.state, "failed");
      assert.equal(failed.reasonCode, "PLUGIN_PACKAGE_ACTIVATION_FAILED");
      assert.equal(visibleContributions.size, 0);
      assert.equal(lifecycle.getHealth("sample-plugin").ready, false);
      assert.equal((await durableCustody.getActiveGeneration("sample-plugin")).state, "staged");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports rollback failure instead of swallowing it", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle: any = buildBundle();
      const visibleContributions: any = new Set<any>();
      const lifecycle: any = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
        contributionTransactionFactory: async ({ pluginId, generation, packageDigest }: Record<string, any>) : Promise<any> =>
          beginPluginContributionTransaction({
            pluginId,
            generation,
            packageDigest,
            prepareContribution: async () : Promise<any> => Object.freeze({
              commit: async () : Promise<any> => {
                visibleContributions.add("sample-plugin.run");
                throw new Error("publish boom");
              },
              rollback: async () : Promise<any> => {
                visibleContributions.clear();
                throw new Error("cleanup evidence unavailable");
              }
            })
          })
      });
      await lifecycle.acquire({
        pluginId: "sample-plugin",
        source: createBytesPluginPackageSource({ bytes: bundle.archive })
      });
      await lifecycle.verify({ pluginId: "sample-plugin" });
      await lifecycle.stage({ pluginId: "sample-plugin", configuration: {} });

      const failed: any = await lifecycle.activate({ pluginId: "sample-plugin" });

      assert.equal(failed.state, "failed");
      assert.equal(failed.reasonCode, "PLUGIN_PACKAGE_ROLLBACK_FAILED");
      assert.equal(visibleContributions.size, 0);
      assert.equal(lifecycle.getHealth("sample-plugin").ready, false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers staged digest-bound work across restart and keeps empty configuration empty", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle: any = buildBundle();
      const custody: any = createPluginPackageCustody({ rootDir: path.join(root, "custody") });
      const first: any = createPluginPackageLifecycle({ custody });
      await first.acquire({
        pluginId: "sample-plugin",
        source: createBytesPluginPackageSource({ bytes: bundle.archive })
      });
      const verified: any = await first.verify({ pluginId: "sample-plugin" });
      assert.equal(verified.state, "verified", verified.reasonCode || "");
      await first.stage({ pluginId: "sample-plugin", configuration: {} });

      const restarted: any = createPluginPackageLifecycle({ custody });
      const recovered: any = await restarted.recover({ pluginId: "sample-plugin" });
      assert.equal(recovered.state, "staged");
      assert.ok(recovered.packageDigest);
      assert.equal(Object.keys(restarted.getHealth("sample-plugin")).includes("defaultModel"), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writers per plugin identity", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle: any = buildBundle();
      const lifecycle: any = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") })
      });
      const source: any = createBytesPluginPackageSource({ bytes: bundle.archive });
      const [first, second] = await Promise.all([
        lifecycle.acquire({ pluginId: "sample-plugin", source, acquisitionIdempotencyKey: "a" }),
        lifecycle.acquire({ pluginId: "sample-plugin", source, acquisitionIdempotencyKey: "b" })
      ]);
      assert.ok(["acquired", "failed"].includes(first.state));
      assert.ok(["acquired", "failed"].includes(second.state));
      assert.notEqual(lifecycle.getState("sample-plugin"), "acquiring");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
