import { createHash } from "node:crypto";

import { createGitHubReleasePluginPackageSource } from "@meshrix/contracts/plugins/plugin-package-source";
import { setBoundedMapEntry } from "../storage/state-coordinator.ts";
import {
  evaluateOutboundEgressUrl,
  evaluateOutboundRedirectLocation,
  fetchWithPinnedDns
} from "../security/outbound-egress-policy.ts";

const DEFAULT_MAX_BYTES: any = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: any = 0;
const DEFAULT_MAX_REDIRECTS: any = 3;
const DEFAULT_MAX_RETRIES: any = 2;
const DEFAULT_MAX_METADATA_CACHE_ENTRIES: any = 128;
const DEFAULT_API_BASE: any = "https://api.github.com";
const INTERNAL_FAILURES: any = new WeakMap<any, any>();
const DEFAULT_ALLOWED_HOSTS: readonly any[] = Object.freeze([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

function sourceFailure(code?: any, message?: any, retryable?: any) : any {
  const failure: any = new Error(String(message));
  INTERNAL_FAILURES.set(failure, Object.freeze({
    code: String(code || "PLUGIN_PACKAGE_SOURCE_DENIED"),
    message: failure.message,
    retryable: retryable === true
  }));
  return failure;
}

function publicFailure(error?: any) : any {
  const trusted: any = error && (typeof error === "object" || typeof error === "function")
    ? INTERNAL_FAILURES.get(error)
    : null;
  if (trusted) return Object.assign(new Error(trusted.message), { code: trusted.code });
  return Object.assign(new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition failed"), {
    code: "PLUGIN_PACKAGE_SOURCE_DENIED"
  });
}

function failureDetails(error?: any) : any {
  return error && (typeof error === "object" || typeof error === "function")
    ? INTERNAL_FAILURES.get(error)
    : null;
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
    throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: invalid acquisition URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: unsupported acquisition protocol");
  }
  const host: any = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: acquisition host is not allowed");
  }
  const decision: any = evaluateOutboundEgressUrl({
    url: parsed.toString(),
    policyPreset,
    policies,
    label
  });
  if (!decision.ok) {
    throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", `PLUGIN_PACKAGE_SOURCE_DENIED: egress denied (${decision.reason})`);
  }
  return parsed;
}

function cancelledError() : any {
  return sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
}

function retryableError(message?: any) : any {
  return sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", message, true);
}

function isRetryableStatus(status?: any) : any {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function responseStatus(response?: any) : any {
  const status: any = response?.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: invalid response status");
  }
  return status;
}

async function disposeResponseBody(response?: any) : Promise<any> {
  const body: any = response?.body;
  if (!body || response?.bodyUsed === true) return;
  try {
    if (typeof body.cancel === "function") await body.cancel();
    else if (typeof body.destroy === "function") body.destroy();
  } catch {
    // Closing a failed or already-closed response is best effort.
  }
}

async function readBody(response: any, { maxBytes, signal }: Record<string, any>) : Promise<any> {
  if (signal?.aborted) throw cancelledError();
  if (!response.body || typeof response.body.getReader !== "function") {
    let raw: any;
    try {
      raw = await response.arrayBuffer();
    } catch (error: any) {
      if (signal?.aborted) throw cancelledError();
      throw retryableError("PLUGIN_PACKAGE_SOURCE_DENIED: response body read failed");
    }
    if (signal?.aborted) throw cancelledError();
    const buffer: any = Buffer.from(raw);
    if (buffer.length > maxBytes) {
      throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: response exceeds byte budget");
    }
    return buffer;
  }
  const reader: any = response.body.getReader();
  const chunks: any[] = [];
  let total: any = 0;
  const cancelOnAbort: any = () : any => {
    void Promise.resolve(reader.cancel()).catch(() : any => {});
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw cancelledError();
      let result: any;
      try {
        result = await reader.read();
      } catch (error: any) {
        if (signal?.aborted) throw cancelledError();
        throw retryableError("PLUGIN_PACKAGE_SOURCE_DENIED: response body read failed");
      }
      if (signal?.aborted) throw cancelledError();
      if (result.done) break;
      const chunk: any = Buffer.from(result.value);
      total += chunk.length;
      if (total > maxBytes) {
        throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: response exceeds byte budget");
      }
      chunks.push(chunk);
    }
  } catch (error: any) {
    try { await reader.cancel(); } catch { /* response cleanup follows */ }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithBudget(fetchImpl: any, url: any, init: any, policy: Record<string, any>, consumeResponse: any) : Promise<any> {
  const controller: any = new AbortController();
  const onAbort: any = () : any => controller.abort();
  let timedOut: any = false;
  let request: any = null;
  if (policy.signal) {
    if (policy.signal.aborted) throw cancelledError();
    policy.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer: any = Number.isSafeInteger(policy.timeoutMs) && policy.timeoutMs > 0
    ? setTimeout(() : any => {
      timedOut = true;
      controller.abort();
    }, policy.timeoutMs)
    : null;
  try {
    try {
      request = await fetchWithPinnedDns({
        url,
        label: policy.label,
        policyPreset: policy.policyPreset,
        policies: policy.policies,
        lookup: policy.lookup,
        fetchImpl,
        maxRedirects: 0,
        responseTimeouts: { headersTimeout: 0, bodyTimeout: 0 },
        init: { ...init, signal: controller.signal, redirect: "manual" }
      });
    } catch (error: any) {
      if (policy.signal?.aborted) throw cancelledError();
      if (timedOut) throw retryableError(`PLUGIN_PACKAGE_SOURCE_DENIED: acquisition timed out after ${policy.timeoutMs}ms`);
      let decision: any = null;
      try { decision = error?.decision; } catch { /* External error objects are untrusted. */ }
      if (decision?.ok === false && decision?.reason === "dns_lookup_failed") {
        throw retryableError("PLUGIN_PACKAGE_SOURCE_DENIED: outbound address lookup failed");
      }
      if (decision?.ok === true) {
        throw retryableError("PLUGIN_PACKAGE_SOURCE_DENIED: outbound request failed");
      }
      if (decision?.ok === false) {
        throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", `PLUGIN_PACKAGE_SOURCE_DENIED: outbound request denied (${String(decision.reason || "unknown")})`);
      }
      throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: outbound request failed");
    }
    return await consumeResponse(request.response, controller.signal);
  } catch (error: any) {
    if (policy.signal?.aborted) throw cancelledError();
    if (timedOut) throw retryableError(`PLUGIN_PACKAGE_SOURCE_DENIED: acquisition timed out after ${policy.timeoutMs}ms`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (policy.signal) policy.signal.removeEventListener("abort", onAbort);
    if (request) {
      await disposeResponseBody(request.response);
      await request.close().catch(() : any => {});
    }
  }
}

function isRedirectStatus(status?: any) : any {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function stripCrossOriginCredentials(init?: any, sourceUrl?: any, targetUrl?: any) : any {
  if (new URL(sourceUrl).origin === new URL(targetUrl).origin) return init;
  const headers: any = new Headers(init?.headers);
  for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
  return { ...init, headers: Object.fromEntries(headers.entries()) };
}

async function followRedirects(fetchImpl?: any, startUrl?: any, init?: any, policy?: any, consumeResponse?: any) : Promise<any> {
  let current: any = String(startUrl);
  let currentInit: any = { ...init };
  for (let hop: any = 0; hop <= policy.maxRedirects; hop += 1) {
    assertAllowedUrl(current, policy);
    const result: any = await fetchWithBudget(fetchImpl, current, currentInit, policy, async (response?: any, signal?: any) : Promise<any> => {
      const status: any = responseStatus(response);
      // 304 Not Modified is not a redirect hop; callers handle cache revalidation.
      if (!isRedirectStatus(status)) {
        return { value: await consumeResponse(response, signal) };
      }
      const location: any = response.headers?.get?.("location") || response.headers?.get?.("Location") || "";
      const redirect: any = evaluateOutboundRedirectLocation({
        sourceUrl: current,
        status,
        location,
        policyPreset: policy.policyPreset,
        policies: policy.policies,
        label: "plugin-package.github-release.redirect"
      });
      if (!redirect.ok || !redirect.targetUrl) {
        throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", `PLUGIN_PACKAGE_SOURCE_DENIED: redirect rejected (${redirect.reason || "unknown"})`);
      }
      assertAllowedUrl(redirect.targetUrl, {
        ...policy,
        label: "plugin-package.github-release.redirect-target"
      });
      currentInit = stripCrossOriginCredentials(currentInit, current, redirect.targetUrl);
      return { redirectUrl: redirect.targetUrl };
    });
    if (!result.redirectUrl) return result.value;
    current = result.redirectUrl;
  }
  throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: redirect budget exceeded");
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
  lookup = undefined,
  policyPreset = "",
  policies = {},
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxRetries = DEFAULT_MAX_RETRIES,
  maxMetadataCacheEntries = DEFAULT_MAX_METADATA_CACHE_ENTRIES
}: Record<string, any> = {}) : any {
  if (typeof fetchImpl !== "function") {
    throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: fetch implementation is required");
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
      lookup,
      policyPreset,
      policies,
      maxBytes: Number.isSafeInteger(overrides.maxBytes) ? overrides.maxBytes : maxBytes,
      timeoutMs: Number.isSafeInteger(overrides.timeoutMs) ? overrides.timeoutMs : timeoutMs,
      maxRedirects: Number.isSafeInteger(overrides.maxRedirects) ? overrides.maxRedirects : maxRedirects,
      maxRetries: Number.isSafeInteger(overrides.maxRetries) ? overrides.maxRetries : maxRetries,
      label: "plugin-package.github-release"
    };
  }

  function flightKey(source: any, policy: any) : any {
    const limits: any[] = [policy.maxBytes, policy.timeoutMs, policy.maxRedirects, policy.maxRetries];
    return JSON.stringify([
      sourceKey(source),
      ...limits.map((value?: any) : any => `${typeof value}:${String(value)}`)
    ]);
  }

  function waitForFlight(flight: any, signal?: any) : Promise<any> {
    if (signal?.aborted) return Promise.reject(cancelledError());
    return new Promise<any>((resolve?: any, reject?: any) : any => {
      const waiter: any = {};
      let settled: any = false;
      const detach: any = (cancelled?: any) : any => {
        if (settled) return false;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        flight.waiters.delete(waiter);
        if (
          cancelled &&
          flight.waiters.size === 0 &&
          inflight.get(flight.key) === flight
        ) {
          inflight.delete(flight.key);
          flight.controller.abort();
        }
        return true;
      };
      const onAbort: any = () : any => {
        if (detach(true)) reject(cancelledError());
      };
      flight.waiters.add(waiter);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (value?: any) : any => { if (detach(false)) resolve(value); },
        (error?: any) : any => { if (detach(false)) reject(error); }
      );
    });
  }

  async function resolveAuthorization(source?: any) : Promise<any> {
    if (!source.credentialRef) return null;
    if (typeof resolveCredentialRef !== "function") {
      throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: credential reference resolver is not configured");
    }
    const token: any = await resolveCredentialRef(source.credentialRef);
    if (typeof token !== "string" || token.trim().length === 0) {
      throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: credential reference resolved empty");
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
        const release: any = await followRedirects(fetchImpl, metadataUrl, { method: "GET", headers }, {
          ...policy,
          signal
        }, async (response?: any, responseSignal?: any) : Promise<any> => {
          const status: any = responseStatus(response);
          if (status === 304 && cached?.release) return cached.release;
          if (status === 404) {
            throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: release or asset is missing");
          }
          if (status < 200 || status >= 300) {
            throw sourceFailure(
              "PLUGIN_PACKAGE_SOURCE_DENIED",
              `PLUGIN_PACKAGE_SOURCE_DENIED: release metadata status ${status}`,
              isRetryableStatus(status)
            );
          }
          const body: any = await readBody(response, { ...policy, signal: responseSignal });
          let parsedRelease: any;
          try {
            parsedRelease = JSON.parse(body.toString("utf8"));
          } catch {
            throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: release metadata is not JSON");
          }
          const etag: any = response.headers.get("etag");
          if (etag) {
            setBoundedMapEntry(
              metadataCache,
              key,
              { etag, release: parsedRelease, recordedAt: Date.now() },
              metadataCacheLimit
            );
          }
          return parsedRelease;
        });
        return release;
      } catch (error: any) {
        lastError = error;
        if (failureDetails(error)?.retryable !== true || attempt > policy.maxRetries) break;
      }
    }
    throw lastError || sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: release metadata retries exhausted");
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
        const bytes: any = await followRedirects(fetchImpl, assetUrl, { method: "GET", headers }, {
          ...policy,
          signal
        }, async (response?: any, responseSignal?: any) : Promise<any> => {
          const status: any = responseStatus(response);
          if (status === 404) {
            throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: release or asset is missing");
          }
          if (status < 200 || status >= 300) {
            throw sourceFailure(
              "PLUGIN_PACKAGE_SOURCE_DENIED",
              `PLUGIN_PACKAGE_SOURCE_DENIED: asset status ${status}`,
              isRetryableStatus(status)
            );
          }
          const responseBytes: any = await readBody(response, { ...policy, signal: responseSignal });
          if (responseBytes.length === 0) {
            throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: asset response is empty");
          }
          return responseBytes;
        });
        return bytes;
      } catch (error: any) {
        lastError = error;
        if (failureDetails(error)?.retryable !== true || attempt > policy.maxRetries) break;
      }
    }
    throw lastError || sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: asset download retries exhausted");
  }

  async function acquireOnce(source: any, policy: any, signal?: any) : Promise<any> {
    const authorization: any = await resolveAuthorization(source);
    const release: any = await loadReleaseMetadata(source, authorization, { ...policy, signal }, signal);
    const assets: any = Array.isArray(release?.assets) ? release.assets : [];
    const asset: any = assets.find((entry?: any) : any => String(entry?.name || "") === source.asset);
    if (!asset) {
      throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: release or asset is missing");
    }
    const assetUrl: any = String(asset.url || asset.browser_download_url || "").trim();
    if (!assetUrl) {
      throw sourceFailure("PLUGIN_PACKAGE_SOURCE_DENIED", "PLUGIN_PACKAGE_SOURCE_DENIED: asset URL is missing");
    }
    // Prefer API asset URL (requires Accept: application/octet-stream).
    const downloadUrl: any = String(asset.url || assetUrl).trim();
    const bytes: any = await downloadAsset(downloadUrl, authorization, { ...policy, signal }, signal);
    const archiveDigest: any = digest(bytes);
    // Remote packages must be verified against the operator-fixed digest. The
    // source contract requires expectedDigest; this second check is a hard
    // guard so a missing digest can never accept unverified bytes.
    if (source.expectedDigest !== archiveDigest) {
      throw sourceFailure("PLUGIN_PACKAGE_FORMAT_REJECTED", "PLUGIN_PACKAGE_FORMAT_REJECTED: acquired digest mismatch");
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
      try {
        if (signal?.aborted) throw cancelledError();
        const source: any = createGitHubReleasePluginPackageSource(sourceInput);
        const policy: any = policyBundle(policyInput);
        const key: any = flightKey(source, policy);
        let flight: any = inflight.get(key);
        if (!flight || flight.controller.signal.aborted) {
          const controller: any = new AbortController();
          flight = {
            key,
            controller,
            waiters: new Set<any>(),
            promise: null
          };
          inflight.set(key, flight);
          flight.promise = Promise.resolve().then(() => acquireOnce(source, policy, controller.signal));
          const release: any = () : any => {
            if (inflight.get(key) === flight) inflight.delete(key);
          };
          void flight.promise.then(release, release);
        }
        return await waitForFlight(flight, signal);
      } catch (error: any) {
        throw publicFailure(error);
      }
    }
  });
}

export async function acquireGitHubReleasePluginPackage(source?: any, policy: Record<string, any> = {}, signal?: any) : Promise<any> {
  const acquisition: any = createGitHubReleasePluginPackageAcquisition(policy);
  return acquisition.acquire(source, policy, signal);
}
