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
} from "../../packages/contracts/src/plugins/plugin-bundle-manifest.ts";
import { createBytesPluginPackageSource } from "../../packages/contracts/src/plugins/plugin-package-source.ts";
import { createPluginPackageCustody } from "../../packages/foundation/src/module-system/plugin-package-custody.ts";
import { createPluginPackageLifecycle } from "../../packages/foundation/src/module-system/plugin-package-lifecycle.ts";
import {
  computePluginPackagePayloadDigest,
  validatePluginPackageArchive
} from "../../packages/foundation/src/module-system/plugin-package-validator.ts";
import {
  createPluginPackageTarGz,
  sha256Digest
} from "../../packages/foundation/src/module-system/plugin-package-tar.ts";
import { beginPluginContributionTransaction } from "../../packages/server-runtime/src/composition/plugin-contribution-transaction.ts";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));
const ROOT: any = path.resolve(__dirname, "../..");
const REPORT_PATH: any = path.join(ROOT, "build/reports/plugin-bundle-protocol.json");
const VERIFIER: any = "tools/server-scripts/verify-plugin-bundle-protocol.ts";

function sanitize(value?: any) : any {
  return String(value || "")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 512);
}

function buildFixtureArchive() : any {
  const runtime: any = Buffer.from(
    "export async function activatePlugin(){ return { id: 'fixture-plugin', close: async () => {} }; }\n",
    "utf8"
  );
  const contentFiles: any[] = [{ path: "runtime.ts", content: runtime }];
  const payloadDigest: any = computePluginPackagePayloadDigest(new Map<any, any>([["runtime.ts", runtime]]));
  const manifestObject: Record<string, any> = {
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    pluginId: "fixture-plugin",
    version: "1.0.0",
    label: "fixture-plugin",
    entrypoint: "runtime.ts",
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
    trust: { algorithm: "configured-digest" }
  };
  const manifestBytes: any = Buffer.from(`${JSON.stringify(manifestObject, null, 2)}\n`, "utf8");
  return createPluginPackageTarGz([
    { path: PLUGIN_BUNDLE_MANIFEST_FILENAME, content: manifestBytes },
    ...contentFiles
  ]);
}

async function main() : Promise<any> {
  const checks: any[] = [];
  const archive: any = buildFixtureArchive();
  const verified: any = validatePluginPackageArchive({
    bytes: archive,
    expectedPluginId: "fixture-plugin"
  });
  assert.equal(verified.packageDigest, sha256Digest(archive));
  checks.push("schema-and-payload-digest");

  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-bundle-verify-"));
  try {
    let discarded: any = false;
    const lifecycle: any = createPluginPackageLifecycle({
      custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
      contributionTransactionFactory: async ({ pluginId, generation, packageDigest }: Record<string, any>) : Promise<any> =>
        beginPluginContributionTransaction({
          pluginId,
          generation,
          packageDigest,
          prepareSnapshot: async () : Promise<any> => Object.freeze({ operations: {} }),
          publishSnapshot: async () : Promise<any> => undefined,
          discardSnapshot: async () : Promise<any> => {
            discarded = true;
          }
        })
    });
    await lifecycle.acquire({
      pluginId: "fixture-plugin",
      source: createBytesPluginPackageSource({ bytes: archive }),
      acquisitionIdempotencyKey: "verify-acq"
    });
    const verifiedReceipt: any = await lifecycle.verify({ pluginId: "fixture-plugin" });
    assert.equal(verifiedReceipt.state, "verified", verifiedReceipt.reasonCode || "");
    await lifecycle.stage({ pluginId: "fixture-plugin", configuration: {} });
    const active: any = await lifecycle.activate({
      pluginId: "fixture-plugin",
      activationIdempotencyKey: "verify-act"
    });
    assert.equal(active.state, "active");
    assert.equal(discarded, false);
    checks.push("lifecycle-activate");

    const failing: any = createPluginPackageLifecycle({
      custody: createPluginPackageCustody({ rootDir: path.join(root, "custody-fail") }),
      contributionTransactionFactory: async ({ pluginId, generation, packageDigest }: Record<string, any>) : Promise<any> =>
        beginPluginContributionTransaction({
          pluginId,
          generation,
          packageDigest,
          prepareSnapshot: async () : Promise<any> => Object.freeze({ operations: {} }),
          publishSnapshot: async () : Promise<any> => {
            throw new Error("forced publication failure");
          },
          discardSnapshot: async () : Promise<any> => {
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
    const failed: any = await failing.activate({ pluginId: "fixture-plugin" });
    assert.equal(failed.state, "failed");
    assert.equal(discarded, true);
    checks.push("atomic-rollback");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:plugin:bundle-protocol-verification-1",
    verifier: VERIFIER,
    status: "passed",
    checks,
    recordedAt: new Date().toISOString()
  };
  const serialized: any = JSON.stringify(report);
  if (/(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/)/u.test(serialized)) {
    throw new Error("plugin_bundle_protocol_local_path_leak");
  }
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "passed", report: "build/reports/plugin-bundle-protocol.json" })}\n`);
}

main().catch((error?: any) : any => {
  process.stderr.write(`${sanitize(error?.stack || error)}\n`);
  process.exitCode = 1;
});
