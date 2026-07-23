#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_BUNDLE_MANIFEST_FILENAME,
  PLUGIN_BUNDLE_MANIFEST_SCHEMA
} from "../../packages/contracts/src/plugins/plugin-bundle-manifest.mjs";
import { createBytesPluginPackageSource } from "../../packages/contracts/src/plugins/plugin-package-source.mjs";
import { createPluginPackageCustody } from "../../packages/foundation/src/module-system/plugin-package-custody.mjs";
import { createPluginPackageLifecycle } from "../../packages/foundation/src/module-system/plugin-package-lifecycle.mjs";
import {
  computePluginPackagePayloadDigest,
  validatePluginPackageArchive
} from "../../packages/foundation/src/module-system/plugin-package-validator.mjs";
import {
  createPluginPackageTarGz,
  sha256Digest
} from "../../packages/foundation/src/module-system/plugin-package-tar.mjs";
import { beginPluginContributionTransaction } from "../../packages/server-runtime/src/composition/plugin-contribution-transaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const REPORT_PATH = path.join(ROOT, "build/reports/plugin-bundle-protocol.json");
const VERIFIER = "tools/server-scripts/verify-plugin-bundle-protocol.mjs";

function sanitize(value) {
  return String(value || "")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 512);
}

function buildFixtureArchive() {
  const runtime = Buffer.from(
    "export async function activatePlugin(){ return { id: 'fixture-plugin', close: async () => {} }; }\n",
    "utf8"
  );
  const contentFiles = [{ path: "runtime.mjs", content: runtime }];
  const payloadDigest = computePluginPackagePayloadDigest(new Map([["runtime.mjs", runtime]]));
  const manifestObject = {
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    pluginId: "fixture-plugin",
    version: "1.0.0",
    label: "fixture-plugin",
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
    trust: { algorithm: "configured-digest" }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifestObject, null, 2)}\n`, "utf8");
  return createPluginPackageTarGz([
    { path: PLUGIN_BUNDLE_MANIFEST_FILENAME, content: manifestBytes },
    ...contentFiles
  ]);
}

async function main() {
  const checks = [];
  const archive = buildFixtureArchive();
  const verified = validatePluginPackageArchive({
    bytes: archive,
    expectedPluginId: "fixture-plugin"
  });
  assert.equal(verified.packageDigest, sha256Digest(archive));
  checks.push("schema-and-payload-digest");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-plugin-bundle-verify-"));
  try {
    let discarded = false;
    const lifecycle = createPluginPackageLifecycle({
      custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
      contributionTransactionFactory: async ({ pluginId, generation, packageDigest }) =>
        beginPluginContributionTransaction({
          pluginId,
          generation,
          packageDigest,
          prepareSnapshot: async () => Object.freeze({ operations: {} }),
          publishSnapshot: async () => undefined,
          discardSnapshot: async () => {
            discarded = true;
          }
        })
    });
    await lifecycle.acquire({
      pluginId: "fixture-plugin",
      source: createBytesPluginPackageSource({ bytes: archive }),
      acquisitionIdempotencyKey: "verify-acq"
    });
    const verifiedReceipt = await lifecycle.verify({ pluginId: "fixture-plugin" });
    assert.equal(verifiedReceipt.state, "verified", verifiedReceipt.reasonCode || "");
    await lifecycle.stage({ pluginId: "fixture-plugin", configuration: {} });
    const active = await lifecycle.activate({
      pluginId: "fixture-plugin",
      activationIdempotencyKey: "verify-act"
    });
    assert.equal(active.state, "active");
    assert.equal(discarded, false);
    checks.push("lifecycle-activate");

    const failing = createPluginPackageLifecycle({
      custody: createPluginPackageCustody({ rootDir: path.join(root, "custody-fail") }),
      contributionTransactionFactory: async ({ pluginId, generation, packageDigest }) =>
        beginPluginContributionTransaction({
          pluginId,
          generation,
          packageDigest,
          prepareSnapshot: async () => Object.freeze({ operations: {} }),
          publishSnapshot: async () => {
            throw new Error("forced publication failure");
          },
          discardSnapshot: async () => {
            discarded = true;
          }
        })
    });
    await failing.acquire({
      pluginId: "fixture-plugin",
      source: createBytesPluginPackageSource({ bytes: archive })
    });
    await failing.verify({ pluginId: "fixture-plugin" });
    await failing.stage({ pluginId: "fixture-plugin", configuration: {} });
    const failed = await failing.activate({ pluginId: "fixture-plugin" });
    assert.equal(failed.state, "failed");
    assert.equal(discarded, true);
    checks.push("atomic-rollback");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const report = {
    schemaVersion: "v0.0.1:plugin:bundle-protocol-verification-1",
    verifier: VERIFIER,
    status: "passed",
    checks,
    recordedAt: new Date().toISOString()
  };
  const serialized = JSON.stringify(report);
  if (/(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/)/u.test(serialized)) {
    throw new Error("plugin_bundle_protocol_local_path_leak");
  }
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "passed", report: "build/reports/plugin-bundle-protocol.json" })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${sanitize(error?.stack || error)}\n`);
  process.exitCode = 1;
});
