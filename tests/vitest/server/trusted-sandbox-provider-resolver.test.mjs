import { describe, expect, it, vi } from "vitest";

import {
  CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
  controlledRef,
  sandboxDigest
} from "../../../packages/foundation/src/execution-sandbox/contracts.mjs";
import {
  createSandboxProviderConformanceReceipt,
  createTrustedSandboxProviderResolver,
  REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS
} from "../../../packages/server-runtime/src/execution-sandbox/trusted-provider-resolver.mjs";
import { createTrustedOciProviderAdapters } from "../../../packages/server-runtime/src/execution-sandbox/trusted-oci-provider-adapters.mjs";
import { createOciProviderConformanceReceipt } from "../../../tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs";

const POLICY_REVISION = "policy-revision-current";
const EXECUTABLE_IDENTITY_DIGEST = "b".repeat(64);
const CHECK_DIGEST = "c".repeat(64);

function configuration(overrides = {}) {
  return {
    enabled: true,
    providerMode: "automatic",
    providerId: "",
    profileId: "isolated-workload",
    policyRevision: POLICY_REVISION,
    receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
    allowedProviderClasses: [
      "rootless-podman",
      "podman",
      "rootless-docker",
      "docker",
      "registered-container"
    ],
    ...overrides
  };
}

function adapter({
  id,
  providerClass,
  healthy = true,
  production = true,
  receipt = true,
  restrictions = REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS,
  probe = null
}) {
  const backend = {
    async run() {},
    async cleanup() { return { destroyed: true }; },
    async close() {}
  };
  const descriptor = {
    id,
    providerClass,
    isolationClass: "container",
    serviceIdentityRef: `service:${id}`,
    executableIdentityDigest: EXECUTABLE_IDENTITY_DIGEST,
    healthy,
    production,
    enforcedRestrictions: [...restrictions],
    ...(receipt ? {
      conformanceReceipt: createSandboxProviderConformanceReceipt({
        schemaVersion: SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
        providerId: id,
        providerClass,
        status: "passed",
        policyRevision: POLICY_REVISION,
        receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
        runtimeProfile: "isolated-workload",
        isolationClass: "container",
        serviceIdentityRef: `service:${id}`,
        executableIdentityDigest: EXECUTABLE_IDENTITY_DIGEST,
        checkDigest: CHECK_DIGEST,
        generatedAt: "2027-01-01T00:00:00.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z"
      })
    } : {})
  };
  return {
    id,
    providerClass,
    probe: probe || vi.fn(async () => descriptor),
    createBackend: vi.fn(async () => backend),
    backend
  };
}

describe("trusted sandbox provider resolver", () => {
  it("keeps missing configuration unavailable without probing or inventing defaults", async () => {
    const candidate = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver = createTrustedSandboxProviderResolver({ adapters: [candidate] });

    expect(await resolver.resolve()).toBeNull();
    expect(candidate.probe).not.toHaveBeenCalled();
    expect(resolver.publicProjection()).toEqual({ sandboxAvailable: false });
    expect(resolver.administrativeProjection()).toMatchObject({ state: "unconfigured" });
  });

  it("keeps explicit disabled configuration distinct from missing configuration", async () => {
    const candidate = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver = createTrustedSandboxProviderResolver({
      configuration: { enabled: false },
      adapters: [candidate]
    });

    expect(await resolver.resolve()).toBeNull();
    expect(candidate.probe).not.toHaveBeenCalled();
    expect(resolver.administrativeProjection()).toMatchObject({ state: "disabled" });
  });

  it("selects the highest-ranked conforming provider and skips a non-conforming leader", async () => {
    const rootless = adapter({
      id: "podman-rootless",
      providerClass: "rootless-podman",
      receipt: false
    });
    const docker = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [docker, rootless],
      now: () => new Date("2028-01-01T00:00:00.000Z")
    });

    const selected = await resolver.resolve();
    expect(selected?.backend).toBe(docker.backend);
    expect(rootless.createBackend).not.toHaveBeenCalled();
    expect(docker.createBackend).toHaveBeenCalledTimes(1);
    expect(resolver.publicProjection()).toEqual({ sandboxAvailable: true });
    expect(resolver.administrativeProjection()).toMatchObject({
      state: "ready",
      providerClass: "docker",
      isolationClass: "container",
      policyRevision: POLICY_REVISION
    });
  });

  it("honors explicit provider identity without falling back to another provider", async () => {
    const requested = adapter({
      id: "podman-system",
      providerClass: "podman",
      healthy: false
    });
    const fallback = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver = createTrustedSandboxProviderResolver({
      configuration: configuration({ providerMode: "explicit", providerId: requested.id }),
      adapters: [fallback, requested],
      now: () => new Date("2028-01-01T00:00:00.000Z")
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "sandbox_backend_unhealthy" });
    expect(fallback.probe).not.toHaveBeenCalled();
    expect(resolver.administrativeProjection()).toMatchObject({ state: "degraded" });
  });

  it("deduplicates concurrent refresh and invalidates cached availability", async () => {
    let releaseProbe;
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    const candidate = adapter({
      id: "docker-system",
      providerClass: "docker",
      probe: vi.fn(async () => {
        await probeGate;
        return adapter({ id: "docker-system", providerClass: "docker" }).probe();
      })
    });
    const resolver = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [candidate],
      now: () => new Date("2028-01-01T00:00:00.000Z")
    });

    const first = resolver.refresh({ force: true });
    const second = resolver.refresh({ force: true });
    releaseProbe();
    await Promise.all([first, second]);
    expect(candidate.probe).toHaveBeenCalledTimes(1);
    expect(resolver.publicProjection()).toEqual({ sandboxAvailable: true });
    expect((await resolver.resolve())?.backend).toBe(candidate.backend);
    expect(candidate.probe).toHaveBeenCalledTimes(1);

    resolver.invalidate();
    expect(resolver.publicProjection()).toEqual({ sandboxAvailable: false });
    expect(resolver.administrativeProjection()).toMatchObject({ state: "unavailable" });
  });

  it("expires public availability and rejects stale resolution generations", async () => {
    let clock = new Date("2028-01-01T00:00:00.000Z");
    const candidate = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [candidate],
      now: () => clock,
      ttlMs: 1_000
    });

    const first = await resolver.resolve();
    expect(resolver.validate(first)).toBe(true);
    clock = new Date("2028-01-01T00:00:01.001Z");
    expect(resolver.publicProjection()).toEqual({ sandboxAvailable: false });
    expect(resolver.validate(first)).toBe(false);
    expect(resolver.administrativeProjection()).toMatchObject({
      state: "unavailable",
      reasonCode: "sandbox_provider_selection_stale"
    });

    const second = await resolver.resolve();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(resolver.validate(second)).toBe(true);
    expect(resolver.validate(first)).toBe(false);
  });

  it("fails closed for expired receipts and quarantine", async () => {
    const candidate = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [candidate],
      now: () => new Date("2031-01-01T00:00:00.000Z")
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "sandbox_policy_unsupported" });
    expect(resolver.administrativeProjection()).toMatchObject({ state: "degraded" });
    resolver.quarantine();
    expect(await resolver.resolve()).toBeNull();
    expect(resolver.administrativeProjection()).toMatchObject({ state: "quarantined" });
  });

  it("rejects tampered and cross-provider conformance receipts", async () => {
    const tampered = adapter({ id: "docker-system", providerClass: "docker" });
    tampered.probe = vi.fn(async () => ({
      ...(await adapter({ id: "docker-system", providerClass: "docker" }).probe()),
      conformanceReceipt: {
        ...(await adapter({ id: "docker-system", providerClass: "docker" }).probe()).conformanceReceipt,
        runtimeProfile: "another-profile"
      }
    }));
    const resolver = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [tampered],
      now: () => new Date("2028-01-01T00:00:00.000Z")
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "sandbox_policy_unsupported" });
    expect(tampered.createBackend).not.toHaveBeenCalled();

    const crossProvider = adapter({ id: "docker-system", providerClass: "docker" });
    const originalDescriptor = await crossProvider.probe();
    crossProvider.probe = vi.fn(async () => ({
      ...originalDescriptor,
      conformanceReceipt: createSandboxProviderConformanceReceipt({
        ...originalDescriptor.conformanceReceipt,
        providerId: "another-provider"
      })
    }));
    const crossProviderResolver = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [crossProvider],
      now: () => new Date("2028-01-01T00:00:00.000Z")
    });
    await expect(crossProviderResolver.resolve()).rejects.toMatchObject({
      code: "sandbox_policy_unsupported"
    });
    expect(crossProvider.createBackend).not.toHaveBeenCalled();
  });

  it("discovers OCI providers only through fixed core adapters and redacts their location", async () => {
    const executableIdentityDigest = "d".repeat(64);
    const serviceIdentityRef = controlledRef(sandboxDigest({
      providerId: "oci.docker.primary",
      engine: "docker",
      runtimeClass: "runc",
      executableIdentityDigest
    }), "sandbox-provider-service");
    const receipt = createOciProviderConformanceReceipt({
      target: {
        id: "oci.docker.primary",
        providerClass: "docker",
        isolationClass: "hardened-oci",
        serviceIdentityRef,
        executableIdentityDigest
      },
      checks: { isolated: true },
      generatedAt: new Date("2027-01-01T00:00:00.000Z"),
      policyRevision: POLICY_REVISION,
      runtimeProfile: "isolated-workload",
      receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
    });
    const backend = {
      async descriptor() {
        return {
          id: "ignored-by-adapter",
          healthy: true,
          production: true,
          enforcedRestrictions: [...REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS]
        };
      },
      async run() {},
      async cleanup() { return { destroyed: true }; },
      async close() {}
    };
    const adapters = createTrustedOciProviderAdapters({
      platform: "linux",
      conformanceReceipts: { "oci.docker.primary": receipt },
      pathExists: (candidatePath) => candidatePath === "/usr/bin/docker",
      rootlessProbe: async () => false,
      executableIdentityProbe: async () => executableIdentityDigest,
      backendFactory: vi.fn(() => backend)
    });
    const resolver = createTrustedSandboxProviderResolver({
      configuration: configuration({ allowedProviderClasses: ["docker"] }),
      adapters,
      now: () => new Date("2027-01-01T01:00:00.000Z")
    });

    expect((await resolver.resolve())?.backend).toBe(backend);
    const publicState = resolver.publicProjection();
    const administrativeState = resolver.administrativeProjection();
    expect(publicState).toEqual({ sandboxAvailable: true });
    expect(administrativeState).toMatchObject({
      state: "ready",
      providerClass: "docker",
      isolationClass: "hardened-oci"
    });
    expect(JSON.stringify({ publicState, administrativeState })).not.toContain("/usr/bin/docker");
  });

  it("does not classify one OCI service as both rootless and rootful", async () => {
    const backend = {
      async descriptor() {
        return { healthy: true, production: true, enforcedRestrictions: [] };
      },
      async run() {},
      async cleanup() { return { destroyed: true }; }
    };
    const adapters = createTrustedOciProviderAdapters({
      platform: "linux",
      pathExists: (candidatePath) => candidatePath === "/usr/bin/podman",
      rootlessProbe: async () => true,
      executableIdentityProbe: async () => EXECUTABLE_IDENTITY_DIGEST,
      backendFactory: () => backend
    });
    const rootless = adapters.find(({ id }) => id === "oci.rootless-podman.primary");
    const rootful = adapters.find(({ id }) => id === "oci.podman.primary");

    expect((await rootless.probe()).healthy).toBe(true);
    expect((await rootful.probe()).healthy).toBe(false);
  });
});
