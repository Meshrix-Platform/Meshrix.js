import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFixedWindowRateLimiter,
  normalizeClientIp,
  resolveHttpRateLimits,
  resolveRequestTenantKey
} from "../../../apps/server/runtime/http-server-middleware.mjs";
import { clientIpFromRequest } from "../../../packages/foundation/src/security/trusted-client-ip.mjs";
import {
  isSecureRequest,
  isTrustedProxy,
  requestTargetOrigin
} from "../../../packages/foundation/src/security/auth/console-auth-support.mjs";

const originalTrustedProxies = process.env.LICO_TRUSTED_PROXIES;

function requestFrom(remoteAddress, forwardedFor = "") {
  return {
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    socket: { remoteAddress }
  };
}

afterEach(() => {
  vi.useRealTimers();
  if (originalTrustedProxies === undefined) {
    delete process.env.LICO_TRUSTED_PROXIES;
  } else {
    process.env.LICO_TRUSTED_PROXIES = originalTrustedProxies;
  }
});

describe("HTTP middleware client IP normalization", () => {
  it("keeps rotating spoofed forwarded addresses from direct loopback in one rate-limit bucket", () => {
    delete process.env.LICO_TRUSTED_PROXIES;
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      label: "direct-loopback",
      maxBuckets: 8
    });
    const firstIp = normalizeClientIp(requestFrom("127.0.0.1", "198.51.100.10"));
    const secondIp = normalizeClientIp(requestFrom("127.0.0.1", "203.0.113.20"));

    expect(firstIp).toBe("127.0.0.1");
    expect(secondIp).toBe("127.0.0.1");
    expect(limiter.shouldAllow(`ip:${firstIp}`).allowed).toBe(true);
    expect(limiter.shouldAllow(`ip:${secondIp}`).allowed).toBe(false);
  });

  it("honors a valid forwarded chain only for an explicitly trusted socket peer", () => {
    process.env.LICO_TRUSTED_PROXIES = "10.0.0.9, 192.0.2.4";

    expect(normalizeClientIp(requestFrom(
      "10.0.0.9",
      "203.0.113.8, 192.0.2.4"
    ))).toBe("203.0.113.8");
    expect(normalizeClientIp(
      requestFrom("10.0.0.9", "203.0.113.8, 192.0.2.5"),
      { trustedProxies: ["10.0.0.9"] }
    )).toBe("192.0.2.5");
    expect(normalizeClientIp(
      requestFrom("127.0.0.1", "198.51.100.11"),
      { trustedProxies: ["127.0.0.1"] }
    )).toBe("198.51.100.11");
    expect(normalizeClientIp(requestFrom(
      "10.0.0.8",
      "203.0.113.8"
    ))).toBe("10.0.0.8");
    expect(normalizeClientIp(requestFrom(
      "10.0.0.9",
      "203.0.113.8, invalid-hop"
    ))).toBe("10.0.0.9");
    expect(normalizeClientIp(requestFrom(
      "10.0.0.9",
      "not-an-ip"
    ))).toBe("10.0.0.9");
  });

  it("uses the same explicit proxy trust boundary for authorization, cookies, and origin resolution", () => {
    delete process.env.LICO_TRUSTED_PROXIES;
    const directLoopback = {
      headers: {
        host: "127.0.0.1:7228",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-host": "console.example.invalid",
        "x-forwarded-proto": "https"
      },
      socket: { encrypted: false, remoteAddress: "127.0.0.1" }
    };

    expect(clientIpFromRequest(directLoopback)).toBe("127.0.0.1");
    expect(isTrustedProxy(directLoopback)).toBe(false);
    expect(isSecureRequest(directLoopback)).toBe(false);
    expect(requestTargetOrigin(directLoopback)).toBe("http://127.0.0.1:7228");

    process.env.LICO_TRUSTED_PROXIES = "127.0.0.1";
    expect(clientIpFromRequest(directLoopback)).toBe("203.0.113.10");
    expect(isTrustedProxy(directLoopback)).toBe(true);
    expect(isSecureRequest(directLoopback)).toBe(true);
    expect(requestTargetOrigin(directLoopback)).toBe("https://console.example.invalid");

    directLoopback.headers["x-forwarded-proto"] = "https, http";
    directLoopback.headers["x-forwarded-host"] = "console.example.invalid, forged.example.invalid";
    expect(isSecureRequest(directLoopback)).toBe(false);
    expect(requestTargetOrigin(directLoopback)).toBe("http://127.0.0.1:7228");
  });
});

describe("fixed-window rate limiter capacity", () => {
  it("does not let quota races or rejected retries extend a fixed window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      label: "quota-race",
      maxBuckets: 3
    });

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve().then(() => limiter.shouldAllow("same-key")))
    );
    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(1);
    for (let retry = 0; retry < 1_000; retry += 1) {
      expect(limiter.shouldAllow("same-key").allowed).toBe(false);
    }
    expect(limiter.getState()).toMatchObject({
      bucketCount: 1,
      dedicatedBucketCount: 1,
      expirationCount: 1,
      overflowActive: false
    });

    vi.advanceTimersByTime(1_001);
    expect(limiter.shouldAllow("same-key").allowed).toBe(true);
  });

  it("aggregates overflow without evicting active buckets and recovers after TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      label: "capacity-recovery",
      maxBuckets: 3
    });

    expect(limiter.shouldAllow("key-a")).toMatchObject({ allowed: true, aggregated: false });
    expect(limiter.shouldAllow("key-b")).toMatchObject({ allowed: true, aggregated: false });
    expect(limiter.shouldAllow("key-c")).toMatchObject({ allowed: true, aggregated: true });
    expect(limiter.shouldAllow("key-d")).toMatchObject({ allowed: false, aggregated: true });
    expect(limiter.shouldAllow("key-a")).toMatchObject({ allowed: false, aggregated: false });
    expect(limiter.getState()).toEqual({
      bucketCount: 3,
      dedicatedBucketCount: 2,
      expirationCount: 2,
      maxBuckets: 3,
      overflowActive: true
    });

    vi.advanceTimersByTime(1_001);

    expect(limiter.shouldAllow("key-after-ttl")).toMatchObject({
      allowed: true,
      aggregated: false
    });
    expect(limiter.getState()).toMatchObject({
      bucketCount: 1,
      dedicatedBucketCount: 1,
      expirationCount: 1,
      maxBuckets: 3,
      overflowActive: false
    });
  });

  it("stays strictly bounded under high-cardinality identifier churn", () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 2,
      windowMs: 60_000,
      label: "bounded-churn",
      maxBuckets: 4
    });

    for (let index = 0; index < 5_000; index += 1) {
      limiter.shouldAllow(`rotating-${index}`);
    }

    expect(limiter.getState()).toEqual({
      bucketCount: 4,
      dedicatedBucketCount: 3,
      expirationCount: 3,
      maxBuckets: 4,
      overflowActive: true
    });
    expect(limiter.shouldAllow("rotating-0")).toMatchObject({
      allowed: true,
      aggregated: false,
      allowedAt: 2
    });
    expect(limiter.shouldAllow("another-new-key")).toMatchObject({
      allowed: false,
      aggregated: true
    });
  });
});

describe("HTTP tenant admission identity", () => {
  it("uses the authenticated tenant without trusting request headers", () => {
    const request = {
      headers: { "x-tenant-id": "untrusted-tenant" },
      socket: { remoteAddress: "127.0.0.1" }
    };
    const consoleAuth = {
      getSessionFromRequest: () => ({ user: { tenantId: "tenant-a", username: "user-a" } })
    };

    expect(resolveRequestTenantKey(request, consoleAuth)).toBe("tenant:tenant-a");
    expect(resolveRequestTenantKey(request, {
      getSessionFromRequest: () => ({ user: { username: "user-a" } })
    })).toBe("tenant-subject:user-a");
    expect(resolveRequestTenantKey(request, null)).toBe("tenant:anonymous");
  });

  it("resolves a separately configurable tenant rate limit", () => {
    expect(resolveHttpRateLimits({
      httpRateLimitPerIpPerMinute: 11,
      httpRateLimitPerSubjectPerMinute: 12,
      httpRateLimitPerTenantPerMinute: 13
    })).toMatchObject({
      ip: { limit: 11 },
      subject: { limit: 12 },
      tenant: { limit: 13 }
    });
  });
});
