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
const canned1 = "secrets/github-token";




function sha256(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function publicDnsLookup(_host?: any) : Promise<any> {
  // Synthetic public-class DNS answer; the injected transport opens no socket.
  return [{ address: [8, 8, 8, 8].join("."), family: 4 }];
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
        lookup: publicDnsLookup,
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
      credentialRef: canned1
    });
    assert.equal(authed.archiveDigest, sha256(assetBytes));
  });

  it("follows bounded redirects, coalesces identical fetches, and revalidates metadata", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("redirect-bytes");
    const calls: any[] = [];
    const dnsHosts: any[] = [];
    const redirectResponses: any[] = [];
    const fixture: any = createFixtureFetch({ assetBytes, redirectAsset: true });
    const fetchImpl: any = async (url?: any, init?: any) : Promise<any> => {
      const parsed: any = new URL(String(url));
      if (parsed.pathname.endsWith("/releases/assets/22")) {
        const response: any = new Response("redirect body", {
          status: 302,
          headers: { location: "https://objects.githubusercontent.com/asset.bin" }
        });
        redirectResponses.push(response);
        calls.push({ url: String(url), status: response.status, authorization: init.headers?.Authorization });
        return response;
      }
      const response: any = await fixture.fetchImpl(url, init);
      calls.push({ url: String(url), status: response.status, location: response.headers.get("location"), authorization: init.headers?.Authorization });
      return response;
    };
    const minted = "token-for-test";
    const github: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl,
      lookup: async (host?: any) : Promise<any> => {
        dnsHosts.push(host);
        return publicDnsLookup(host);
      },
      resolveCredentialRef: async () : Promise<any> => minted,
      allowedHosts: ["api.github.com", "objects.githubusercontent.com"],
      maxRetries: 0
    });
    const source: any = createGitHubReleasePluginPackageSource({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes),
      credentialRef: canned1
    });
    const a: any = await github.acquire(source);
    assert.equal(a.byteLength, assetBytes.length, JSON.stringify(calls));
    const b: any = await github.acquire(source);
    assert.equal(a.archiveDigest, b.archiveDigest);
    assert.ok(calls.some((entry?: any) : any => entry.status === 302));
    assert.equal(calls.find((entry?: any) : any => new URL(entry.url).hostname === "objects.githubusercontent.com")?.authorization, undefined);
    assert.equal(calls.find((entry?: any) : any => new URL(entry.url).pathname.endsWith("/releases/assets/22"))?.authorization, "Bearer token-for-test");
    assert.ok(redirectResponses.every((response?: any) : any => response.bodyUsed));
    assert.ok(dnsHosts.includes("api.github.com") && dnsHosts.includes("objects.githubusercontent.com"));
    assert.ok(fixture.stats().metadataHits >= 1);
  });

  it("keeps shared work alive while any identical-policy waiter remains", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("shared-flight-bytes");
    const releaseBody: Record<string, any> = {
      id: 11,
      assets: [{ id: 22, name: "sample-plugin.tar.gz", url: "https://api.github.com/repos/acme/plugins/releases/assets/22" }]
    };
    let metadataHits: any = 0;
    let assetHits: any = 0;
    let requestSignal: any;
    let resolveAsset: any;
    let resolveAssetStarted: any;
    const assetStarted: any = new Promise<any>((resolve) : any => { resolveAssetStarted = resolve; });
    const acquisition: any = createGitHubReleasePluginPackageAcquisition({
      lookup: publicDnsLookup,
      maxRetries: 0,
      fetchImpl: async (url?: any, init?: any) : Promise<any> => {
        const parsed: any = new URL(String(url));
        if (parsed.pathname.includes("/releases/tags/")) {
          metadataHits += 1;
          return mockResponse(200, JSON.stringify(releaseBody));
        }
        assetHits += 1;
        requestSignal = init.signal;
        resolveAssetStarted();
        return new Promise<any>((resolve) : any => { resolveAsset = () : any => resolve(mockResponse(200, assetBytes)); });
      }
    });
    const source: any = {
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    };
    const cancelledWaiter: any = new AbortController();
    const first: any = acquisition.acquire(source, {}, cancelledWaiter.signal);
    await assetStarted;
    const remaining: any = acquisition.acquire(source);
    cancelledWaiter.abort();
    await assert.rejects(() : any => first, /cancelled/);
    assert.equal(requestSignal.aborted, false);
    resolveAsset();
    const result: any = await remaining;
    assert.equal(result.archiveDigest, sha256(assetBytes));
    assert.deepEqual({ metadataHits, assetHits }, { metadataHits: 1, assetHits: 1 });
  });

  it("does not coalesce acquisitions with different byte, timeout, redirect, or retry policies", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("policy-flight-bytes");
    const releaseBody: Record<string, any> = {
      id: 11,
      assets: [{ id: 22, name: "sample-plugin.tar.gz", url: "https://api.github.com/repos/acme/plugins/releases/assets/22" }]
    };

    async function checkPolicyDifference(field?: any, alternate?: any) : Promise<any> {
      let metadataHits: any = 0;
      let assetHits: any = 0;
      const metadataReleases: any[] = [];
      const metadataWaiters: any[] = [];
      const acquisition: any = createGitHubReleasePluginPackageAcquisition({
        lookup: publicDnsLookup,
        fetchImpl: async (url?: any) : Promise<any> => {
          const parsed: any = new URL(String(url));
          if (parsed.pathname.includes("/releases/tags/")) {
            metadataHits += 1;
            for (const waiter of metadataWaiters.splice(0)) {
              if (metadataHits >= waiter.target) waiter.resolve();
              else metadataWaiters.push(waiter);
            }
            return new Promise<any>((resolve) : any => {
              metadataReleases.push(() : any => resolve(mockResponse(200, JSON.stringify(releaseBody))));
            });
          }
          assetHits += 1;
          return mockResponse(200, assetBytes);
        }
      });
      const waitForMetadataHits: any = (target?: any) : any => metadataHits >= target
        ? Promise.resolve()
        : new Promise<any>((resolve) : any => metadataWaiters.push({ target, resolve }));
      const source: any = {
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: sha256(assetBytes)
      };
      const basePolicy: any = { maxBytes: 512, timeoutMs: 10_000, maxRedirects: 3, maxRetries: 0 };
      const first: any = acquisition.acquire(source, basePolicy);
      await waitForMetadataHits(1);
      const second: any = acquisition.acquire(source, { ...basePolicy, [field]: alternate });
      await waitForMetadataHits(2);
      for (const release of metadataReleases.splice(0)) release();
      const results: any[] = await Promise.all([first, second]);
      assert.equal(results[0].archiveDigest, sha256(assetBytes));
      assert.equal(results[1].archiveDigest, sha256(assetBytes));
      assert.equal(metadataHits, 2, `${field} policy should produce independent metadata requests`);
      assert.equal(assetHits, 2, `${field} policy should produce independent asset requests`);
    }

    for (const [field, alternate] of [
      ["maxBytes", 1024],
      ["timeoutMs", 20_000],
      ["maxRedirects", 2],
      ["maxRetries", 1]
    ]) {
      await checkPolicyDifference(field, alternate);
    }
  });

  it("rejects missing assets, hostile sizes, cancellation, and redacts diagnostics", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("x".repeat(1024));
    const missingFixture: any = createFixtureFetch({ assetBytes, missingAsset: true });
    const missing: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: missingFixture.fetchImpl,
      lookup: publicDnsLookup
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
    assert.equal(missingFixture.stats().metadataHits, 1);

    const oversizeFixture: any = createFixtureFetch({ assetBytes, oversize: true });
    const oversize: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: oversizeFixture.fetchImpl,
      lookup: publicDnsLookup,
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
    assert.equal(oversizeFixture.stats().assetHits, 1);

    const controller: any = new AbortController();
    controller.abort();
    const cancelled: any = createGitHubReleasePluginPackageAcquisition({
      fetchImpl: createFixtureFetch({ assetBytes }).fetchImpl,
      lookup: publicDnsLookup
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
        lookup: publicDnsLookup,
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

  it("sanitizes shared credential and network failures for every waiter", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("privacy-fixture");
    const resolverError: any = "resolver-canary-opaque /private/resolver/path";
    let resolverHits: any = 0;
    let finishResolver: any;
    let resolveResolverStarted: any;
    const resolverStarted: any = new Promise<any>((resolve) : any => { resolveResolverStarted = resolve; });
    const credentialSource: any = {
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes),
      credentialRef: canned1
    };
    const credentialed: any = createGitHubReleasePluginPackageAcquisition({
      maxRetries: 0,
      resolveCredentialRef: async () : Promise<any> => {
        resolverHits += 1;
        resolveResolverStarted();
        return new Promise<any>((_resolve, reject) : any => { finishResolver = () : any => reject(new Error(resolverError)); });
      },
      fetchImpl: async () : Promise<any> => mockResponse(200, "{}")
    });
    const first: any = credentialed.acquire(credentialSource);
    await resolverStarted;
    const second: any = credentialed.acquire(credentialSource);
    finishResolver();
    const sharedFailures: any[] = await Promise.allSettled([first, second]);
    assert.equal(resolverHits, 1);
    for (const result of sharedFailures) {
      assert.equal(result.status, "rejected");
      const error: any = (result as PromiseRejectedResult).reason;
      assert.equal(error.message, "PLUGIN_PACKAGE_SOURCE_DENIED: acquisition failed");
      assert.equal(error.message.includes("resolver-canary-opaque"), false);
      assert.equal(error.message.includes("/private/resolver/path"), false);
    }

    const networkCanary: any = "network-canary-token /private/network/path";
    const network: any = createGitHubReleasePluginPackageAcquisition({
      lookup: publicDnsLookup,
      maxRetries: 0,
      fetchImpl: async () : Promise<any> => { throw new Error(networkCanary); }
    });
    let networkError: any;
    try {
      await network.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: sha256(assetBytes)
      });
    } catch (error: any) {
      networkError = error;
    }
    assert.ok(networkError);
    assert.match(networkError.message, /outbound request failed/);
    assert.equal(networkError.message.includes("network-canary-token"), false);
    assert.equal(networkError.message.includes("/private/network/path"), false);
  });

  it("stops at acquired bytes and does not stage or enable plugins", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("acquired-only");
    const fixture: any = createFixtureFetch({ assetBytes });
    const acquisition: any = createPluginPackageAcquisition({
      github: { fetchImpl: fixture.fetchImpl, lookup: publicDnsLookup }
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

  it("retries transient upstream status and disposes deterministic failures", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("retry-safe-bytes");
    const fixture: any = createFixtureFetch({ assetBytes });
    const temporaryFailure: any = new Response("temporarily unavailable", { status: 503 });
    let metadataAttempts: any = 0;
    const retrying: any = createGitHubReleasePluginPackageAcquisition({
      lookup: publicDnsLookup,
      maxRetries: 1,
      fetchImpl: async (url?: any, init?: any) : Promise<any> => {
        if (new URL(String(url)).pathname.includes("/releases/tags/")) {
          metadataAttempts += 1;
          if (metadataAttempts === 1) return temporaryFailure;
        }
        return fixture.fetchImpl(url, init);
      }
    });
    const acquired: any = await retrying.acquire({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    });
    assert.equal(acquired.archiveDigest, sha256(assetBytes));
    assert.equal(metadataAttempts, 2);
    assert.equal(temporaryFailure.bodyUsed, true);

    let dnsAttempts: any = 0;
    const retryingDns: any = createGitHubReleasePluginPackageAcquisition({
      maxRetries: 1,
      lookup: async (host?: any) : Promise<any> => {
        dnsAttempts += 1;
        if (dnsAttempts === 1) throw new Error("EAI_AGAIN");
        return publicDnsLookup(host);
      },
      fetchImpl: fixture.fetchImpl
    });
    const afterDnsRetry: any = await retryingDns.acquire({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    });
    assert.equal(afterDnsRetry.archiveDigest, sha256(assetBytes));
    assert.equal(dnsAttempts, 3);

    for (const { response, expectedMessage } of [
      { response: new Response("unauthorized", { status: 401 }), expectedMessage: /status 401/ },
      { response: new Response("not json", { status: 200 }), expectedMessage: /not JSON/ }
    ]) {
      let attempts: any = 0;
      const deterministic: any = createGitHubReleasePluginPackageAcquisition({
        lookup: publicDnsLookup,
        fetchImpl: async () : Promise<any> => {
          attempts += 1;
          return response;
        }
      });
      await assert.rejects(() : any => deterministic.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: sha256(assetBytes)
      }), expectedMessage);
      assert.equal(attempts, 1);
      assert.equal(response.bodyUsed, true);
    }
  });

  it("rejects a private DNS answer before contacting the release host", async () : Promise<any> => {
    let fetchCalls: any = 0;
    let lookedUpHost: any = "";
    const acquisition: any = createGitHubReleasePluginPackageAcquisition({
      lookup: async (host?: any) : Promise<any> => {
        lookedUpHost = host;
        return [{ address: "10.0.0.8", family: 4 }];
      },
      fetchImpl: async () : Promise<any> => {
        fetchCalls += 1;
        return mockResponse(200, "{}");
      }
    });
    await assert.rejects(() : any => acquisition.acquire({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: "sha256:unused"
    }), /restricted_dns_address_private/);
    assert.equal(lookedUpHost, "api.github.com");
    assert.equal(fetchCalls, 0);
  });

  it("uses only the configured operator timeout", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("timeout-test");
    const fixture: any = createFixtureFetch({ assetBytes });
    let assetAttempts: any = 0;
    let requestAborted: any = false;
    const acquisition: any = createGitHubReleasePluginPackageAcquisition({
      lookup: publicDnsLookup,
      timeoutMs: 50,
      maxRetries: 0,
      fetchImpl: async (url?: any, init?: any) : Promise<any> => {
        if (!new URL(String(url)).pathname.endsWith("/releases/assets/22")) {
          return fixture.fetchImpl(url, init);
        }
        assetAttempts += 1;
        return new Promise<any>((_resolve, reject) : any => {
          init.signal.addEventListener("abort", () : any => {
            requestAborted = true;
            reject(new Error("synthetic request aborted"));
          }, { once: true });
        });
      }
    });
    await assert.rejects(() : any => acquisition.acquire({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    }), /timed out after 50ms/);
    assert.equal(assetAttempts, 1);
    assert.equal(requestAborted, true);
  });

  it("cancels an in-flight package body when the parent signal aborts", async () : Promise<any> => {
    const assetBytes: any = Buffer.from("unused");
    let readStarted: any;
    const bodyReadStarted: any = new Promise<any>((resolve) : any => { readStarted = resolve; });
    let finishRead: any;
    let bodyCancelled: any = false;
    const streamResponse: any = {
      status: 200,
      headers: { get: () : any => null },
      body: {
        getReader() : any {
          return {
            read() : Promise<any> {
              readStarted();
              return new Promise<any>((resolve) : any => { finishRead = resolve; });
            },
            async cancel() : Promise<any> {
              bodyCancelled = true;
              finishRead?.({ done: true });
            },
            releaseLock() : any {}
          };
        }
      }
    };
    const fixture: any = createFixtureFetch({ assetBytes });
    const acquisition: any = createGitHubReleasePluginPackageAcquisition({
      lookup: publicDnsLookup,
      fetchImpl: async (url?: any, init?: any) : Promise<any> =>
        new URL(String(url)).pathname.endsWith("/releases/assets/22")
          ? streamResponse
          : fixture.fetchImpl(url, init)
    });
    const controller: any = new AbortController();
    const pending: any = acquisition.acquire({
      repository: "acme/plugins",
      release: "v1.0.0",
      asset: "sample-plugin.tar.gz",
      expectedDigest: sha256(assetBytes)
    }, {}, controller.signal);
    await bodyReadStarted;
    controller.abort();
    await assert.rejects(() : any => pending, /cancelled/);
    assert.equal(bodyCancelled, true);
  });
});
