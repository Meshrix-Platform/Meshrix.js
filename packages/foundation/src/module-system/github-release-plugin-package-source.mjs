import { createHash } from "node:crypto";

import { createGitHubReleasePluginPackageSource } from "@meshrix/contracts/plugins/plugin-package-source";
import { setBoundedMapEntry } from "../storage/state-coordinator.mjs";
import {
  evaluateOutboundEgressUrl,
  evaluateOutboundRedirectLocation
} from "../security/outbound-egress-policy.mjs";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_METADATA_CACHE_ENTRIES = 128;
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

function sanitize(message) {
  return String(message || "PLUGIN_PACKAGE_SOURCE_DENIED")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .replace(/Bearer\s+\S+/gu, "Bearer [redacted]")
    .replace(/ghp_[A-Za-z0-9_]+/gu, "[redacted-token]")
    .replace(/github_pat_[A-Za-z0-9_]+/gu, "[redacted-token]")
    .slice(0, 240);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceKey(source) {
  return [
    source.kind,
    source.repository,
    source.release,
    source.asset,
    source.expectedDigest || "",
    source.credentialRef || ""
  ].join("\0");
}

function assertAllowedUrl(url, {
  allowedHosts,
  policyPreset,
  policies,
  label
}) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: invalid acquisition URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: unsupported acquisition protocol");
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition host is not allowed");
  }
  const decision = evaluateOutboundEgressUrl({
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

async function readBody(response, { maxBytes, signal }) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: response exceeds byte budget");
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    if (signal?.aborted) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    }
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* bounded */ }
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: response exceeds byte budget");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithBudget(fetchImpl, url, init, { timeoutMs, signal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: "manual" });
  } catch (error) {
    if (controller.signal.aborted || signal?.aborted) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    }
    throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: ${sanitize(error?.message || error)}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function followRedirects(fetchImpl, startUrl, init, policy) {
  let current = String(startUrl);
  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    assertAllowedUrl(current, policy);
    const response = await fetchWithBudget(fetchImpl, current, init, policy);
    // 304 Not Modified is not a redirect hop; callers handle cache revalidation.
    if (isRedirectStatus(response.status)) {
      const location = response.headers?.get?.("location") || response.headers?.get?.("Location") || "";
      const redirect = evaluateOutboundRedirectLocation({
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
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: fetch implementation is required");
  }
  const hostSet = new Set(
    (Array.isArray(allowedHosts) ? allowedHosts : DEFAULT_ALLOWED_HOSTS)
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const inflight = new Map();
  const metadataCache = new Map();
  const metadataCacheLimit = Math.max(
    1,
    Math.min(4096, Number(maxMetadataCacheEntries) || DEFAULT_MAX_METADATA_CACHE_ENTRIES)
  );

  function policyBundle(overrides = {}) {
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

  async function resolveAuthorization(source) {
    if (!source.credentialRef) return null;
    if (typeof resolveCredentialRef !== "function") {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: credential reference resolver is not configured");
    }
    const token = await resolveCredentialRef(source.credentialRef);
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: credential reference resolved empty");
    }
    return token.trim();
  }

  async function loadReleaseMetadata(source, authorization, policy, signal) {
    const key = sourceKey(source);
    const cached = metadataCache.get(key);
    const apiRoot = String(apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/u, "");
    const metadataUrl = `${apiRoot}/repos/${source.repository}/releases/tags/${encodeURIComponent(source.release)}`;
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "meshrix-plugin-package-acquisition",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    let attempt = 0;
    let lastError = null;
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
        const body = await readBody(response, policy);
        let release;
        try {
          release = JSON.parse(body.toString("utf8"));
        } catch {
          throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release metadata is not JSON");
        }
        const etag = response.headers.get("etag");
        if (etag) {
          setBoundedMapEntry(
            metadataCache,
            key,
            { etag, release, recordedAt: Date.now() },
            metadataCacheLimit
          );
        }
        return release;
      } catch (error) {
        lastError = error;
        if (String(error?.message || "").includes("cancelled")) throw error;
        if (attempt > policy.maxRetries) break;
      }
    }
    throw lastError || new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release metadata retries exhausted");
  }

  async function downloadAsset(assetUrl, authorization, policy, signal) {
    const headers = {
      Accept: "application/octet-stream",
      "User-Agent": "meshrix-plugin-package-acquisition"
    };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    let attempt = 0;
    let lastError = null;
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
        const bytes = await readBody(response, { ...policy, signal });
        if (bytes.length === 0) {
          throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: asset response is empty");
        }
        return bytes;
      } catch (error) {
        lastError = error;
        if (String(error?.message || "").includes("cancelled")) throw error;
        if (attempt > policy.maxRetries) break;
      }
    }
    throw lastError || new Error("PLUGIN_PACKAGE_SOURCE_DENIED: asset download retries exhausted");
  }

  async function acquireOnce(sourceInput, policyInput = {}, signal) {
    const source = createGitHubReleasePluginPackageSource(sourceInput);
    const policy = policyBundle(policyInput);
    const authorization = await resolveAuthorization(source);
    const release = await loadReleaseMetadata(source, authorization, { ...policy, signal }, signal);
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((entry) => String(entry?.name || "") === source.asset);
    if (!asset) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: release or asset is missing");
    }
    const assetUrl = String(asset.url || asset.browser_download_url || "").trim();
    if (!assetUrl) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: asset URL is missing");
    }
    // Prefer API asset URL (requires Accept: application/octet-stream).
    const downloadUrl = String(asset.url || assetUrl).trim();
    const bytes = await downloadAsset(downloadUrl, authorization, { ...policy, signal }, signal);
    const archiveDigest = digest(bytes);
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

    async acquire(sourceInput, policyInput = {}, signal) {
      const source = createGitHubReleasePluginPackageSource(sourceInput);
      const key = sourceKey(source);
      if (inflight.has(key)) {
        return inflight.get(key);
      }
      const work = acquireOnce(source, policyInput, signal).finally(() => {
        if (inflight.get(key) === work) inflight.delete(key);
      });
      inflight.set(key, work);
      try {
        return await work;
      } catch (error) {
        const wrapped = new Error(sanitize(error?.message || error));
        wrapped.code = String(wrapped.message).startsWith("PLUGIN_PACKAGE_")
          ? wrapped.message.split(":")[0]
          : "PLUGIN_PACKAGE_SOURCE_DENIED";
        throw wrapped;
      }
    }
  });
}

export async function acquireGitHubReleasePluginPackage(source, policy = {}, signal) {
  const acquisition = createGitHubReleasePluginPackageAcquisition(policy);
  return acquisition.acquire(source, policy, signal);
}
