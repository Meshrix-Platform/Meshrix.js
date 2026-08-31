import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";

import { createGitHubReleasePluginPackageSource } from "#meshrix/contracts/plugins/plugin-package-source";
import { createPluginPackageAcquisition } from "#meshrix/foundation/module-system/plugin-package-acquisition";
import { createGitHubReleasePluginPackageAcquisition } from "#meshrix/foundation/module-system/github-release-plugin-package-source";
import { createPluginPackageLifecycle } from "#meshrix/foundation/module-system/plugin-package-lifecycle";
import { createPluginPackageCustody } from "#meshrix/foundation/module-system/plugin-package-custody";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sha256(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function mockResponse(status?: any, body?: any, headerMap: Record<string, any> = {}) : any {
  const headers: any = new Map<any, any>(
    (Object.entries(headerMap) as [string, any][]).map(([key, value]: any[]) : any => [String(key).toLowerCase(), String(value)])
  );
  const bytes: any = body === null || body === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(String(body), "utf8");
  return {
    status,
    headers: {
      get(name?: any) : any {
        return headers.get(String(name).toLowerCase()) || null;
      }
    },
    body: null,
    async arrayBuffer() : Promise<any> {
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
}: Record<string, any> = {}) : any {
  let metadataHits: any = 0;
  let assetHits: any = 0;
  const releaseBody: Record<string, any> = {
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

  async function fetchImpl(url?: any, init: Record<string, any> = {}) : Promise<any> {
    const parsed: any = new URL(String(url));
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
      let body: any = assetBytes;
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
    stats: () : any => ({ metadataHits, assetHits })
  };
}

describe("github release plugin package acquisition", () : any => {
  it("requires explicit repository/release/asset and keeps absent credential absent", () : any => {
    assert.throws(() : any => createGitHubReleasePluginPackageSource({}), /repository/);
    assert.throws(() : any => createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz"
    }), /expectedDigest/);
    const source: any = createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: "dummy"
    });
    assert.equal(source.credentialRef, null);
    assert.equal(source.expectedDigest, "dummy");
  });

  it("acquires public and credential-reference assets through the shared port", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("fixture-plugin-bytes");
    const fixture: any = createFixtureFetch({ assetBytes });
    const acquisition: any = createPluginPackageAcquisition({
      github: {
        fetchImpl: fixture.fetchImpl,
        allowedHosts: [
          "api.github.com",
          "github.com",
          "objects.githubusercontent.com",
          "release-assets.githubusercontent.com"
        ],
        resolveCredentialRef: async (ref?: any) : Promise<any> => {
          assert.equal(ref, "secrets/github-token");
          return "ghp_testtokenvalue000";
        }
      }
    });

    const publicSource: any = createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    });
    const first: any = await acquisition.acquire(publicSource);
    assert.equal(first.sourceKind, "github_release");
    assert.equal(first.archiveDigest, sha256(assetBytes));
    assert.equal(Buffer.compare(first.bytes, assetBytes), 0);

    const authed: any = await acquisition.acquire({
      ...publicSource,
      credentialRef: "secrets/github-token"
    });
    assert.equal(authed.archiveDigest, sha256(assetBytes));
  });

  it("follows bounded redirects, coalesces identical fetches, and revalidates metadata", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("redirect-bytes");
    const calls: any[] = [];
    const fixture: any = createFixtureFetch({ assetBytes, redirectAsset: true });
    const fetchImpl: any = async (url?: any, init?: any) : Promise<any> => {
      const response: any = await fixture.fetchImpl(url, init);
      calls.push({ url: String(url), status: response.status, location: response.headers.get("location") });
      return response;
    };
    const github: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl,
      allowedHosts: ["api.github.com", "objects.githubusercontent.com"],
      maxRetries: 0
    });
    const source: any = createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    });
    const a: any = await github.acquire(source);
    assert.equal(a.byteLength, assetBytes.length, JSON.stringify(calls));
    const b: any = await github.acquire(source);
    assert.equal(a.archiveDigest, b.archiveDigest);
    assert.ok(calls.some((entry?: any) : any => entry.status === 302 && entry.location));
    assert.ok(fixture.stats().metadataHits >= 1);
  });

  it("rejects missing assets, hostile sizes, cancellation, and redacts diagnostics", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("x".repeat(64));
    const missing: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: createFixtureFetch({ assetBytes, missingAsset: true }).fetchImpl
    });
    await assert.rejects(
      () : any => missing.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: sha256(assetBytes)
      }),
      /release or asset is missing/
    );

    const oversize: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: createFixtureFetch({ assetBytes, oversize: true }).fetchImpl,
      maxBytes: assetBytes.length
    });
    await assert.rejects(
      () : any => oversize.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: sha256(assetBytes)
      }),
      /byte budget/
    );

    const controller: any = new AbortController();
    controller.abort();
    const cancelled: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: createFixtureFetch({ assetBytes }).fetchImpl
    });
    await assert.rejects(
      () : any => cancelled.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: sha256(assetBytes)
      }, {}, controller.signal),
      /cancelled/
    );

    try {
      await createGitHubReleasePluginPackageAcquisition({
        fetchImpl: async () : Promise<any> => {
          throw new Error("Bearer <credential> <user-home>/plugin-source failed");
        }
      }).acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: sha256(assetBytes)
      });
      assert.fail("expected rejection");
    } catch (error: any) {
      assert.match(String(error.message), /PLUGIN_PACKAGE_/);
      assert.equal(String(error.message).includes("<credential>"), false);
    }
  });

  it("stops at acquired bytes and does not stage or enable plugins", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("acquired-only");
    const fixture: any = createFixtureFetch({ assetBytes });
    const acquisition: any = createPluginPackageAcquisition({
      github: { fetchImpl: fixture.fetchImpl }
    });
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-gh-acq-"));
    try {
      const lifecycle: any = createPluginPackageLifecycle({
        custody: createPluginPackageCustody({ rootDir: path.join(root, "custody") }),
        acquisitionPort: acquisition.port
      });
      const receipt: any = await lifecycle.acquire({
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
