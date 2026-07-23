import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";

import { createGitHubReleasePluginPackageSource } from "#lico/contracts/plugins/plugin-package-source";
import { createPluginPackageAcquisition } from "#lico/foundation/module-system/plugin-package-acquisition";
import { createGitHubReleasePluginPackageAcquisition } from "#lico/foundation/module-system/github-release-plugin-package-source";
import { createPluginPackageLifecycle } from "#lico/foundation/module-system/plugin-package-lifecycle";
import { createPluginPackageCustody } from "#lico/foundation/module-system/plugin-package-custody";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function mockResponse(status, body, headerMap = {}) {
  const headers = new Map(
    Object.entries(headerMap).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  const bytes = body === null || body === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(String(body), "utf8");
  return {
    status,
    headers: {
      get(name) {
        return headers.get(String(name).toLowerCase()) || null;
      }
    },
    body: null,
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    }
  };
}

function createFixtureFetch({
  assetBytes,
  assetName = "sample-plugin.tar.gz",
  releaseTag = "v1.0.0",
  etag = "\"etag-1\"",
  redirectAsset = false,
  missingAsset = false,
  oversize = false
} = {}) {
  let metadataHits = 0;
  let assetHits = 0;
  const releaseBody = {
    id: 11,
    tag_name: releaseTag,
    assets: missingAsset
      ? []
      : [
        {
          id: 22,
          name: assetName,
          url: "https://api.github.com/repos/acme/plugins/releases/assets/22",
          browser_download_url: "https://github.com/acme/plugins/releases/download/v1.0.0/sample-plugin.tar.gz"
        }
      ]
  };

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(String(url));
    if (parsed.hostname === "api.github.com" && parsed.pathname.endsWith(`/releases/tags/${releaseTag}`)) {
      metadataHits += 1;
      if (init.headers?.["If-None-Match"] === etag) {
        return mockResponse(304, null, { etag });
      }
      return mockResponse(200, JSON.stringify(releaseBody), {
        "content-type": "application/json",
        etag
      });
    }
    if (parsed.pathname.endsWith("/releases/assets/22")) {
      assetHits += 1;
      if (redirectAsset) {
        return mockResponse(302, null, {
          location: "https://objects.githubusercontent.com/asset.bin"
        });
      }
      let body = assetBytes;
      if (oversize) body = Buffer.concat([assetBytes, Buffer.alloc(32)]);
      return mockResponse(200, body, { "content-type": "application/octet-stream" });
    }
    if (parsed.hostname === "objects.githubusercontent.com") {
      assetHits += 1;
      return mockResponse(200, assetBytes);
    }
    return mockResponse(404, "missing");
  }

  return {
    fetchImpl,
    stats: () => ({ metadataHits, assetHits })
  };
}

describe("github release plugin package acquisition", () => {
  it("requires explicit repository/release/asset and keeps absent credential absent", () => {
    assert.throws(() => createGitHubReleasePluginPackageSource({}), /repository/);
    const source = createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz"
    });
    assert.equal(source.credentialRef, null);
    assert.equal(source.expectedDigest, null);
  });

  it("acquires public and credential-reference assets through the shared port", async () => {
    const assetBytes = Buffer.from("fixture-plugin-bytes");
    const fixture = createFixtureFetch({ assetBytes });
    const acquisition = createPluginPackageAcquisition({
      github: {
        fetchImpl: fixture.fetchImpl,
        allowedHosts: [
          "api.github.com",
          "github.com",
          "objects.githubusercontent.com",
          "release-assets.githubusercontent.com"
        ],
        resolveCredentialRef: async (ref) => {
          assert.equal(ref, "secrets/github-token");
          return "ghp_testtokenvalue000";
        }
      }
    });

    const publicSource = createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    });
    const first = await acquisition.acquire(publicSource);
    assert.equal(first.sourceKind, "github_release");
    assert.equal(first.archiveDigest, sha256(assetBytes));
    assert.equal(Buffer.compare(first.bytes, assetBytes), 0);

    const authed = await acquisition.acquire({
      ...publicSource,
      credentialRef: "secrets/github-token"
    });
    assert.equal(authed.archiveDigest, sha256(assetBytes));
  });

  it("follows bounded redirects, coalesces identical fetches, and revalidates metadata", async () => {
    const assetBytes = Buffer.from("redirect-bytes");
    const calls = [];
    const fixture = createFixtureFetch({ assetBytes, redirectAsset: true });
    const fetchImpl = async (url, init) => {
      const response = await fixture.fetchImpl(url, init);
      calls.push({ url: String(url), status: response.status, location: response.headers.get("location") });
      return response;
    };
    const github = createGitHubReleasePluginPackageAcquisition({
      fetchImpl,
      allowedHosts: ["api.github.com", "objects.githubusercontent.com"],
      maxRetries: 0
    });
    const source = createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz"
    });
    const a = await github.acquire(source);
    assert.equal(a.byteLength, assetBytes.length, JSON.stringify(calls));
    const b = await github.acquire(source);
    assert.equal(a.archiveDigest, b.archiveDigest);
    assert.ok(calls.some((entry) => entry.status === 302 && entry.location));
    assert.ok(fixture.stats().metadataHits >= 1);
  });

  it("rejects missing assets, hostile sizes, cancellation, and redacts diagnostics", async () => {
    const assetBytes = Buffer.from("x".repeat(64));
    const missing = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: createFixtureFetch({ assetBytes, missingAsset: true }).fetchImpl
    });
    await assert.rejects(
      () => missing.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz"
      }),
      /release or asset is missing/
    );

    const oversize = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: createFixtureFetch({ assetBytes, oversize: true }).fetchImpl,
      maxBytes: assetBytes.length
    });
    await assert.rejects(
      () => oversize.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz"
      }),
      /byte budget/
    );

    const controller = new AbortController();
    controller.abort();
    const cancelled = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: createFixtureFetch({ assetBytes }).fetchImpl
    });
    await assert.rejects(
      () => cancelled.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz"
      }, {}, controller.signal),
      /cancelled/
    );

    try {
      await createGitHubReleasePluginPackageAcquisition({
        fetchImpl: async () => {
          throw new Error("Bearer <credential> <user-home>/plugin-source failed");
        }
      }).acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz"
      });
      assert.fail("expected rejection");
    } catch (error) {
      assert.match(String(error.message), /PLUGIN_PACKAGE_/);
      assert.equal(String(error.message).includes("<credential>"), false);
    }
  });

  it("stops at acquired bytes and does not stage or enable plugins", async () => {
    const assetBytes = Buffer.from("acquired-only");
    const fixture = createFixtureFetch({ assetBytes });
    const acquisition = createPluginPackageAcquisition({
      github: { fetchImpl: fixture.fetchImpl }
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-gh-acq-"));
    try {
      const lifecycle = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
        acquisitionPort: acquisition.port
      });
      const receipt = await lifecycle.acquire({
        pluginId: "sample-plugin",
        source: {
          kind: "github_release",
          repository: "acme/plugins",
          release: "v1.0.0",
          asset: "sample-plugin.tar.gz",
          expectedDigest: sha256(assetBytes)
        }
      });
      assert.equal(receipt.state, "acquired");
      assert.equal(lifecycle.getState("sample-plugin"), "acquired");
      assert.equal(lifecycle.getHealth("sample-plugin").ready, false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
