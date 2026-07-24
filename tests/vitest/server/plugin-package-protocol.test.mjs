import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
} = {}) {
  const runtime = Buffer.from(
    "export async function activatePlugin(){ return { id: 'sample-plugin', close: async () => {} }; }\n",
    "utf8"
  );
  const contentFiles = [
    { path: "runtime.mjs", content: runtime },
    ...extraFiles.map((file) => ({
      path: file.path,
      content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ""), "utf8")
    }))
  ];
  const payloadMap = new Map(contentFiles.map((entry) => [entry.path, entry.content]));
  const payloadDigest = computePluginPackagePayloadDigest(payloadMap);

  let manifestObject = {
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    pluginId,
    version: "1.0.0",
    label: pluginId,
    entrypoint: "runtime.mjs",
    files: contentFiles.map((entry) => ({
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

  const manifestBytes = Buffer.from(`${JSON.stringify(manifestObject, null, 2)}\n`, "utf8");
  if (omitManifestFile) {
    return {
      archive: createPluginPackageTarGz(contentFiles),
      manifest: manifestObject
    };
  }

  const archive = createPluginPackageTarGz([
    { path: PLUGIN_BUNDLE_MANIFEST_FILENAME, content: manifestBytes },
    ...contentFiles
  ]);
  return {
    archive,
    manifest: normalizePluginBundleManifest(JSON.parse(manifestBytes.toString("utf8")))
  };
}

describe("plugin package protocol", () => {
  it("rejects closed-manifest mutations and hostile archives", () => {
    assert.throws(
      () => normalizePluginBundleManifest({ schemaVersion: "nope" }),
      /PLUGIN_PACKAGE_FORMAT_REJECTED/
    );
    assert.throws(
      () => normalizePluginBundleManifest({
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

    const good = buildBundle();
    const verified = validatePluginPackageArchive({
      bytes: good.archive,
      expectedPluginId: "sample-plugin",
      trustedPublicKeyIds: null
    });
    assert.equal(verified.pluginId, "sample-plugin");
    assert.equal(verified.packageDigest, sha256Digest(good.archive));
    assert.equal(verified.manifest.payloadDigest, good.manifest.payloadDigest);
    assert.equal(
      verified.manifest.payloadDigest,
      computePluginPackagePayloadDigest(extractPluginPackageTarGz(good.archive))
    );

    assert.throws(
      () => validatePluginPackageArchive({
        bytes: createPluginPackageTarGz([
          { path: "../escape.mjs", content: Buffer.from("x") }
        ])
      }),
      /PLUGIN_PACKAGE_FORMAT_REJECTED/
    );
    assert.throws(
      () => validatePluginPackageArchive({
        bytes: createPluginPackageTarGz([
          { path: "runtime.mjs", content: Buffer.from("export default 1\n") }
        ])
      }),
      /manifest file is missing/
    );
    assert.throws(
      () => validatePluginPackageArchive({
        bytes: buildBundle({
          mutateManifest: (manifest) => ({
            ...manifest,
            payloadDigest: "sha256:" + "f".repeat(64)
          })
        }).archive
      }),
      /payloadDigest/
    );
  });

  it("covers PluginPackageState transitions and fenced lifecycle", async () => {
    for (const state of PLUGIN_PACKAGE_STATES) {
      assert.equal(typeof state, "string");
    }
    assert.throws(() => assertPluginPackageTransition("declared", "active"), /cannot move/);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle = buildBundle();
      const lifecycle = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
        acquisitionPort: createPluginPackageAcquisitionPort(),
        contributionTransactionFactory: async ({ pluginId, generation, packageDigest }) =>
          beginPluginContributionTransaction({
            pluginId,
            generation,
            packageDigest,
            prepareSnapshot: async () => Object.freeze({ operations: {}, routes: {} }),
            publishSnapshot: async () => undefined,
            discardSnapshot: async () => undefined
          })
      });

      const source = createBytesPluginPackageSource({ bytes: bundle.archive });
      const acquired = await lifecycle.acquire({
        pluginId: "sample-plugin",
        source,
        acquisitionIdempotencyKey: "acq-1"
      });
      assert.equal(acquired.state, "acquired");
      const acquiredAgain = await lifecycle.acquire({
        pluginId: "sample-plugin",
        source,
        acquisitionIdempotencyKey: "acq-1"
      });
      assert.equal(acquiredAgain.state, "acquired");

      const verified = await lifecycle.verify({ pluginId: "sample-plugin" });
      assert.equal(verified.state, "verified", verified.reasonCode || "");
      const staged = await lifecycle.stage({ pluginId: "sample-plugin", configuration: {} });
      assert.equal(staged.state, "staged");
      const active = await lifecycle.activate({
        pluginId: "sample-plugin",
        activationIdempotencyKey: "act-1"
      });
      assert.equal(active.state, "active");
      assert.equal(lifecycle.getHealth("sample-plugin").ready, true);

      const rolled = await lifecycle.rollback({ pluginId: "sample-plugin" });
      assert.equal(rolled.state, "rolled-back");
      const removed = await lifecycle.uninstall({ pluginId: "sample-plugin" });
      assert.equal(removed.state, "removed");
      assert.equal(JSON.stringify(removed).includes(root), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discards contribution generation on activation failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle = buildBundle();
      let discarded = false;
      const lifecycle = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
        contributionTransactionFactory: async ({ pluginId, generation, packageDigest }) =>
          beginPluginContributionTransaction({
            pluginId,
            generation,
            packageDigest,
            prepareSnapshot: async () => Object.freeze({ ok: true }),
            publishSnapshot: async () => {
              throw new Error("publish boom");
            },
            discardSnapshot: async () => {
              discarded = true;
            }
          })
      });
      await lifecycle.acquire({
        pluginId: "sample-plugin",
        source: createBytesPluginPackageSource({ bytes: bundle.archive })
      });
      const verified = await lifecycle.verify({ pluginId: "sample-plugin" });
      assert.equal(verified.state, "verified", verified.reasonCode || "");
      await lifecycle.stage({ pluginId: "sample-plugin", configuration: {} });
      const failed = await lifecycle.activate({ pluginId: "sample-plugin" });
      assert.equal(failed.state, "failed");
      assert.equal(discarded, true);
      assert.match(failed.reasonCode || "", /^PLUGIN_PACKAGE_/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers staged digest-bound work across restart and keeps empty configuration empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle = buildBundle();
      const custody = createPluginPackageCustody({ rootDir: path.join(root, "custody") });
      const first = createPluginPackageLifecycle({ custody });
      await first.acquire({
        pluginId: "sample-plugin",
        source: createBytesPluginPackageSource({ bytes: bundle.archive })
      });
      const verified = await first.verify({ pluginId: "sample-plugin" });
      assert.equal(verified.state, "verified", verified.reasonCode || "");
      await first.stage({ pluginId: "sample-plugin", configuration: {} });

      const restarted = createPluginPackageLifecycle({ custody });
      const recovered = await restarted.recover({ pluginId: "sample-plugin" });
      assert.equal(recovered.state, "staged");
      assert.ok(recovered.packageDigest);
      assert.equal(Object.keys(restarted.getHealth("sample-plugin")).includes("defaultModel"), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writers per plugin identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-package-"));
    try {
      const bundle = buildBundle();
      const lifecycle = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") })
      });
      const source = createBytesPluginPackageSource({ bytes: bundle.archive });
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
