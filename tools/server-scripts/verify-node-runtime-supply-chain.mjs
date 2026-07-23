#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { assertNoLeak } from "./lib/report-evidence-safety.mjs";

const REPORT_PATH = "build/reports/node-runtime-supply-chain.json";
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-node-runtime-supply-chain-"));
process.env.LICO_MCP_NODE_RUNTIME_CACHE_DIR = path.join(tempRoot, "cache");

const report = {
  schemaVersion: "v1:node-runtime-supply-chain-report",
  verifier: "tools/server-scripts/verify-node-runtime-supply-chain.mjs",
  generatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  tests: [],
  summary: {}
};

function record(name, status, evidence = {}) {
  report.tests.push({ name, status, evidence });
}

try {
  const {
    downloadPinnedFile,
    loadNodeRuntimeLock,
    resolveBundledNodeVersion,
    verifyNodeReleaseSignature,
    verifyPinnedNodeRuntimeRelease,
    verifyNodeRuntimeSignedChecksums
  } = await import("./lib/mcp-release-portable.mjs");
  const lock = await loadNodeRuntimeLock();

  await assert.rejects(() => resolveBundledNodeVersion("v0.0.0"), /node_runtime_version_not_locked/u);
  assert.throws(
    () => verifyNodeRuntimeSignedChecksums({ lock, checksumsText: "tampered\n" }),
    /node_runtime_checksums_digest_mismatch/u
  );
  for (const publicKeyUrl of [
    lock.signer.publicKeyUrl.replace("https://", "https://user@"),
    `${lock.signer.publicKeyUrl}?candidate=1`,
    `${lock.signer.publicKeyUrl}#candidate`,
    lock.signer.publicKeyUrl.replace("raw.githubusercontent.com", "raw.githubusercontent.com:444")
  ]) {
    const invalidSignerLock = structuredClone(lock);
    invalidSignerLock.signer.publicKeyUrl = publicKeyUrl;
    assert.throws(
      () => verifyNodeRuntimeSignedChecksums({ lock: invalidSignerLock, checksumsText: "tampered\n" }),
      /node_runtime_lock_untrusted_signer_key/u
    );
  }
  const invalidMetadataSizeLock = structuredClone(lock);
  invalidMetadataSizeLock.signatureSizeBytes = 0;
  assert.throws(
    () => verifyNodeRuntimeSignedChecksums({ lock: invalidMetadataSizeLock, checksumsText: "tampered\n" }),
    /node_runtime_lock_invalid_metadata_size/u
  );
  const invalidTargetSizeLock = structuredClone(lock);
  invalidTargetSizeLock.targets[Object.keys(invalidTargetSizeLock.targets)[0]].sizeBytes = 0;
  assert.throws(
    () => verifyNodeRuntimeSignedChecksums({ lock: invalidTargetSizeLock, checksumsText: "tampered\n" }),
    /node_runtime_lock_target_invalid/u
  );
  record("tampered or unpinned runtime inputs fail closed", "passed", {
    unpinnedVersionRejected: true,
    tamperedChecksumsRejected: true,
    unsafeSignerUrlsRejected: true,
    missingOrInvalidSizesRejected: true
  });

  const evidence = await verifyPinnedNodeRuntimeRelease({ outputDir: path.join(tempRoot, "verify") });
  assert.equal(evidence.signatureVerified, true);
  assert.equal(evidence.signedChecksumsVerified, true);
  assert.equal(evidence.signerFingerprint, lock.signer.fingerprint);
  record("official Node checksum signature and pinned signer verify", "passed", evidence);

  const cacheDir = process.env.LICO_MCP_NODE_RUNTIME_CACHE_DIR;
  const checksumsPath = path.join(cacheDir, `${lock.version}-${lock.checksumsFile}`);
  const signaturePath = path.join(cacheDir, `${lock.version}-${lock.signatureFile}`);
  const keyPath = path.join(cacheDir, `${lock.signer.fingerprint}.asc`);
  const wrongSignerLock = structuredClone(lock);
  wrongSignerLock.signer.fingerprint = lock.signer.fingerprint === "A".repeat(40)
    ? "B".repeat(40)
    : "A".repeat(40);
  await assert.rejects(
    () => verifyNodeReleaseSignature({
      lock: wrongSignerLock,
      checksumsPath,
      signaturePath,
      keyPath
    }),
    /node_runtime_signature_signer_mismatch/u
  );
  const tamperedSignaturePath = path.join(tempRoot, "tampered-signature.sig");
  const tamperedSignature = await fs.readFile(signaturePath);
  tamperedSignature[0] ^= 0xff;
  await fs.writeFile(tamperedSignaturePath, tamperedSignature);
  await assert.rejects(
    () => verifyNodeReleaseSignature({
      lock,
      checksumsPath,
      signaturePath: tamperedSignaturePath,
      keyPath
    }),
    /node_runtime_signature_invalid/u
  );
  record("wrong signer and invalid signature fail closed", "passed", {
    wrongSignerRejected: true,
    invalidSignatureRejected: true
  });

  const fixtureBytes = Buffer.from("bounded-pinned-download", "utf8");
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  const responseFor = (body, { redirected = false, contentLength = null } = {}) => ({
    status: 200,
    redirected,
    headers: new Headers(contentLength === null ? {} : { "content-length": String(contentLength) }),
    body: Readable.from([body])
  });
  await assert.rejects(
    () => downloadPinnedFile(
      "https://nodejs.org/dist/redirect-fixture",
      path.join(tempRoot, "redirect-fixture"),
      fixtureSha256,
      fixtureBytes.length,
      { fetchImpl: async () => responseFor(fixtureBytes, { redirected: true }) }
    ),
    /node_runtime_pinned_download_failed/u
  );
  await assert.rejects(
    () => downloadPinnedFile(
      "https://nodejs.org/dist/oversize-fixture",
      path.join(tempRoot, "oversize-fixture"),
      fixtureSha256,
      fixtureBytes.length,
      { fetchImpl: async () => responseFor(Buffer.concat([fixtureBytes, Buffer.from("x")])) }
    ),
    /node_runtime_download_size_limit_exceeded/u
  );

  let transientRetryFetchCount = 0;
  const transientRetryDestination = path.join(tempRoot, "transient-retry-fixture");
  await downloadPinnedFile(
    "https://nodejs.org/dist/transient-retry-fixture",
    transientRetryDestination,
    fixtureSha256,
    fixtureBytes.length,
    {
      fetchImpl: async () => {
        transientRetryFetchCount += 1;
        if (transientRetryFetchCount === 1) {
          const error = new TypeError("fetch failed");
          error.code = "ECONNRESET";
          throw error;
        }
        return responseFor(fixtureBytes, { contentLength: fixtureBytes.length });
      }
    }
  );
  assert.equal(transientRetryFetchCount, 2);
  record("transient network failures retry within a bounded pinned download policy", "passed", {
    transientFailureRetried: true,
    finalIntegrityVerified: true
  });

  let concurrentFetchCount = 0;
  const concurrentDestination = path.join(tempRoot, "concurrent-fixture");
  const concurrentFetch = async () => {
    concurrentFetchCount += 1;
    return responseFor(fixtureBytes, { contentLength: fixtureBytes.length });
  };
  await Promise.all([
    downloadPinnedFile(
      "https://nodejs.org/dist/concurrent-fixture",
      concurrentDestination,
      fixtureSha256,
      fixtureBytes.length,
      { fetchImpl: concurrentFetch }
    ),
    downloadPinnedFile(
      "https://nodejs.org/dist/concurrent-fixture",
      concurrentDestination,
      fixtureSha256,
      fixtureBytes.length,
      { fetchImpl: concurrentFetch }
    )
  ]);
  assert.equal(concurrentFetchCount, 1);
  assert.equal((await fs.stat(concurrentDestination)).size, fixtureBytes.length);
  record("redirects, oversized streams, and concurrent cache misses fail safely", "passed", {
    redirectRejected: true,
    cumulativeByteLimitEnforced: true,
    concurrentCacheMissDeduplicated: true
  });

  report.summary = {
    testCount: report.tests.length,
    failedCount: 0,
    releaseReady: true,
    reportLeakScan: true
  };
} catch (error) {
  record("node runtime supply-chain verifier", "failed", {
    errorCode: /^node_runtime_[a-z0-9_]+$/u.test(String(error?.message || ""))
      ? String(error.message)
      : "node_runtime_supply_chain_verification_failed"
  });
  report.summary = {
    testCount: report.tests.length,
    failedCount: 1,
    releaseReady: false,
    reportLeakScan: false
  };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    report.summary.reportLeakScan = false;
    assertNoLeak(report, "node runtime supply-chain report");
    report.summary.reportLeakScan = true;
    assertNoLeak(report, "node runtime supply-chain report");
    const serialized = JSON.stringify(report, null, 2);
    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, `${serialized}\n`, "utf8");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
