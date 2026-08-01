import { createHash } from "node:crypto";

import { createGitHubReleasePluginPackageSource } from "@meshrix/contracts/plugins/plugin-package-source";
import { setBoundedMapEntry } from "../storage/state-coordinator.ts";
import {
  evaluateOutboundEgressUrl,
  evaluateOutboundRedirectLocation
} from "../security/outbound-egress-policy.ts";

const DEFAULT_MAX_BYTES: any = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: any = 30_000;
const DEFAULT_MAX_REDIRECTS: any = 3;
const DEFAULT_MAX_RETRIES: any = 2;
const DEFAULT_MAX_METADATA_CACHE_ENTRIES: any = 128;
const DEFAULT_API_BASE: any = "https://api.github.com";
const DEFAULT_ALLOWED_HOSTS: readonly any[] = Object.freeze([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

function sanitize(message?: any) : any {
  return String(message || "PLUGIN_PACKAGE_SOURCE_DENIED")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .replace(/Bearer\s+\S+/gu, "Bearer [redacted]")
    .replace(/ghp_[A-Za-z0-9_]+/gu, "[redacted-token]")
    .replace(/github_pat_[A-Za-z0-9_]+/gu, "[redacted-token]")
    .slice(0, 240);
}

function digest(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceKey(source?: any) : any {
  return [
    source.kind,
    source.repository,
    source.release,
    source.asset,
    source.expectedDigest || "",
    source.credentialRef || ""
  ].join("\0");
}

function assertAllowedUrl(url: any, {
  allowedHosts,
  policyPreset,
  policies,
  label
}: Record<string, any>) : any {
  let parsed: any;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: invalid acquisition URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: unsupported acquisition protocol");
  }
  const host: any = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition host is not allowed");
  }
  const decision: any = evaluateOutboundEgressUrl({
    url: parsed.toString(),
    policyPreset,
    policies,
    label
  });
  if (!decision.ok) {
    throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: egress denied (${decision.reason})`);
  }
  return parsed;
}

async function readBody(response: any, { maxBytes, signal }: Record<string, any>) : Promise<any> {
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer: any = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: response exceeds byte budget");
    }
    return buffer;
  }
  const reader: any = response.body.getReader();
  const chunks: any[] = [];
  let total: any = 0;
  while (true) {
    if (signal?.aborted) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    }
    const { done, value } = await reader.read();
    if (done) break;
    const chunk: any = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* bounded */ }
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: response exceeds byte budget");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithBudget(fetchImpl: any, url: any, init: any, { timeoutMs, signal }: Record<string, any>) : Promise<any> {
  const controller: any = new AbortController();
  const onAbort: any = () : any => controller.abort();
  if (signal) {
    if (signal.aborted) throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer: any = setTimeout(() : any => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: "manual" });
  } catch (error: any) {
    if (controller.signal.aborted || signal?.aborted) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    }
    throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: ${sanitize(error?.message || error)}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function isRedirectStatus(status?: any) : any {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function followRedirects(fetchImpl?: any, startUrl?: any, init?: any, policy?: any) : Promise<any> {
  let current: any = String(startUrl);
  for (let hop: any = 0; hop <= policy.maxRedirects; hop += 1) {
    assertAllowedUrl(current, policy);
    const response: any = await fetchWithBudget(fetchImpl, current, init, policy);
    // 304 Not Modified is not a redirect hop; callers handle cache revalidation.
    if (isRedirectStatus(response.status)) {
      const location: any = response.headers?.get?.("location") || response.headers?.get?.("Location") || "";
      const redirect: any = evaluateOutboundRedirectLocation({
        sourceUrl: current,
        status: response.status,
        location,
        policyPreset: policy.policyPreset,
        policies: policy.policies,
        label: "plugin-package.github-release.redirect"
      });
      if (!redirect.ok || !redirect.targetUrl) {
        throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: redirect rejected (${redirect.reason || "unknown"})`);
      }
      assertAllowedUrl(redirect.targetUrl, {
        ...policy,
        label: "plugin-package.github-release.redirect-target"
      });
      current = redirect.targetUrl;
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: redirect budget exceeded");
}

/**
 * Acquire one prebuilt single-plugin archive from an explicit GitHub Release source.
 * Stops at the shared acquired-byte boundary; does not stage or enable plugins.
 */
export function createGitHubReleasePluginPackageAcquisition({
  fetchImpl = globalThis.fetch.bind(globalThis),
  resolveCredentialRef = null,
  apiBaseUrl = DEFAULT_API_BASE,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  policyPreset = "",
  policies = {},
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxRetries = DEFAULT_MAX_RETRIES,
  maxMetadataCacheEntries = DEFAULT_MAX_METADATA_CACHE_ENTRIES
}: Record<string, any> = {}) : any {
  if (typeof fetchImpl !== "function") {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: fetch implementation is required");
  }
  const hostSet: any = new Set<any>(
    (Array.isArray(allowedHosts) ? allowedHosts : DEFAULT_ALLOWED_HOSTS)
      .map((value?: any) : any => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const inflight: any = new Map<any, any>();
  const metadataCache: any = new Map<any, any>();
  const metadataCacheLimit: any = Math.max(
    1,
    Math.min(4096, Number(maxMetadataCacheEntries) || DEFAULT_MAX_METADATA_CACHE_ENTRIES)
  );

  function policyBundle(overrides: Record<string, any> = {}) : any {
    return {
      fetchImpl,
      allowedHosts: hostSet,
      policyPreset,
      policies,
      maxBytes: Number.isSafeInteger(overrides.maxBytes) ? overrides.maxBytes : maxBytes,
      timeoutMs: Number.isSafeInteger(overrides.timeoutMs) ? overrides.timeoutMs : timeoutMs,
      maxRedirects: Number.isSafeInteger(overrides.maxRedirects) ? overrides.maxRedirects : maxRedirects,
      maxRetries: Number.isSafeInteger(overrides.maxRetries) ? overrides.maxRetries : maxRetries,
      label: "plugin-package.github-release"
    };
  }

  async function resolveAuthorization(source?: any) : Promise<any> {
    if (!source.credentialRef) return null;
    if (typeof resolveCredentialRef !== "function") {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: credential reference resolver is not configured");
    }
    const token: any = await resolveCredentialRef(source.credentialRef);
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: credential reference resolved empty");
    }
    return token.trim();
  }

  async function loadReleaseMetadata(source?: any, authorization?: any, policy?: any, signal?: any) : Promise<any> {
    const key: any = sourceKey(source);
    const cached: any = metadataCache.get(key);
    const apiRoot: any = String(apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/u, "");
    const metadataUrl: any = `${apiRoot}/repos/${source.repository}/releases/tags/${encodeURIComponent(source.release)}`;
    const headers: Record<string, any> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "meshrix-plugin-package-acquisition",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    let attempt: any = 0;
    let lastError: any = null;
    while (attempt <= policy.maxRetries) {
      attempt += 1;
      try {
        const { response } = await followRedirects(fetchImpl, metadataUrl, { method: "GET", headers }, {
          ...policy,
          signal
        });
        if (response.status === 304 && cached?.release) {
          return cached.release;
        }
        if (response.status === 404) {
          throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release or asset is missing");
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: release metadata status ${response.status}`);
        }
        const body: any = await readBody(response, policy);
        let release: any;
        try {
          release = JSON.parse(body.toString("utf8"));
        } catch {
          throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release metadata is not JSON");
        }
        const etag: any = response.headers.get("etag");
        if (etag) {
          setBoundedMapEntry(
            metadataCache,
            key,
            { etag, release, recordedAt: Date.now() },
            metadataCacheLimit
          );
        }
        return release;
      } catch (error: any) {
        lastError = error;
        if (String(error?.message || "").includes("cancelled")) throw error;
        if (attempt > policy.maxRetries) break;
      }
    }
    throw lastError || new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release metadata retries exhausted");
  }

  async function downloadAsset(assetUrl?: any, authorization?: any, policy?: any, signal?: any) : Promise<any> {
    const headers: Record<string, any> = {
      Accept: "application/octet-stream",
      "User-Agent": "meshrix-plugin-package-acquisition"
    };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    let attempt: any = 0;
    let lastError: any = null;
    while (attempt <= policy.maxRetries) {
      attempt += 1;
      try {
        const { response } = await followRedirects(fetchImpl, assetUrl, { method: "GET", headers }, {
          ...policy,
          signal
        });
        if (response.status === 404) {
          throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release or asset is missing");
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: asset status ${response.status}`);
        }
        const bytes: any = await readBody(response, { ...policy, signal });
        if (bytes.length === 0) {
          throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: asset response is empty");
        }
        return bytes;
      } catch (error: any) {
        lastError = error;
        if (String(error?.message || "").includes("cancelled")) throw error;
        if (attempt > policy.maxRetries) break;
      }
    }
    throw lastError || new Error("PLUGIN_PACKAGE_SOURCE_DENIED: asset download retries exhausted");
  }

  async function acquireOnce(sourceInput?: any, policyInput: Record<string, any> = {}, signal?: any) : Promise<any> {
    const source: any = createGitHubReleasePluginPackageSource(sourceInput);
    const policy: any = policyBundle(policyInput);
    const authorization: any = await resolveAuthorization(source);
    const release: any = await loadReleaseMetadata(source, authorization, { ...policy, signal }, signal);
    const assets: any = Array.isArray(release?.assets) ? release.assets : [];
    const asset: any = assets.find((entry?: any) : any => String(entry?.name || "") === source.asset);
    if (!asset) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release or asset is missing");
    }
    const assetUrl: any = String(asset.url || asset.browser_download_url || "").trim();
    if (!assetUrl) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: asset URL is missing");
    }
    // Prefer API asset URL (requires Accept: application/octet-stream).
    const downloadUrl: any = String(asset.url || assetUrl).trim();
    const bytes: any = await downloadAsset(downloadUrl, authorization, { ...policy, signal }, signal);
    const archiveDigest: any = digest(bytes);
    if (source.expectedDigest && source.expectedDigest !== archiveDigest) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: acquired digest mismatch");
    }
    return Object.freeze({
      sourceKind: "github_release",
      archiveDigest,
      bytes,
      byteLength: bytes.length,
      metadata: Object.freeze({
        repository: source.repository,
        release: source.release,
        asset: source.asset,
        releaseId: release.id ?? null,
        assetId: asset.id ?? null
      })
    });
  }

  return Object.freeze({
    id: "GitHubReleasePluginPackageAcquisition",

    async acquire(sourceInput?: any, policyInput: Record<string, any> = {}, signal?: any) : Promise<any> {
      const source: any = createGitHubReleasePluginPackageSource(sourceInput);
      const key: any = sourceKey(source);
      if (inflight.has(key)) {
        return inflight.get(key);
      }
      const work: any = acquireOnce(source, policyInput, signal).finally(() : any => {
        if (inflight.get(key) === work) inflight.delete(key);
      });
      inflight.set(key, work);
      try {
        return await work;
      } catch (error: any) {
        const wrapped: Error & Record<string, any> = new Error(sanitize(error?.message || error));
        wrapped.code = String(wrapped.message).startsWith("PLUGIN_PACKAGE_")
          ? wrapped.message.split(":")[0]
          : "PLUGIN_PACKAGE_SOURCE_DENIED";
        throw wrapped;
      }
    }
  });
}

export async function acquireGitHubReleasePluginPackage(source?: any, policy: Record<string, any> = {}, signal?: any) : Promise<any> {
  const acquisition: any = createGitHubReleasePluginPackageAcquisition(policy);
  return acquisition.acquire(source, policy, signal);
}
