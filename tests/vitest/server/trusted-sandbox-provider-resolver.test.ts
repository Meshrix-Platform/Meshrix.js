import { describe, expect, it, vi } from "vitest";

import {
  CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
  controlledRef,
  sandboxDigest
} from "../../../packages/foundation/src/execution-sandbox/contracts.ts";
import {
  createSandboxProviderConformanceReceipt,
  createTrustedSandboxProviderResolver,
  REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS
} from "../../../packages/server-runtime/src/execution-sandbox/trusted-provider-resolver.ts";
import {
  createOciBackendConformanceTarget,
  createTrustedOciProviderAdapters
} from "../../../packages/server-runtime/src/execution-sandbox/trusted-oci-provider-adapters.ts";
import { createOciProviderConformanceReceipt } from "../../../tools/server-scripts/verify-execution-sandbox-oci-conformance.ts";

const POLICY_REVISION: any = "policy-revision-current";
const EXECUTABLE_IDENTITY_DIGEST: any = "b".repeat(64);
const CHECK_DIGEST: any = "c".repeat(64);

function configuration(overrides: Record<string, any> = {}) : any {
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
}: Record<string, any>) : any {
  const backend: Record<string, any> = {
    async run() : Promise<any> {},
    async cleanup() : Promise<any> { return { destroyed: true }; },
    async close() : Promise<any> {}
  };
  const descriptor: Record<string, any> = {
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
    probe: probe || vi.fn(async () : Promise<any> => descriptor),
    createBackend: vi.fn(async () : Promise<any> => backend),
    backend
  };
}

describe("trusted sandbox provider resolver", () : any => {
  it("keeps missing configuration unavailable without probing or inventing defaults", async () : Promise<any> => {
    const candidate: any = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver: any = createTrustedSandboxProviderResolver({ adapters: [candidate] });

    expect(await resolver.resolve()).toBeNull();
    expect(candidate.probe).not.toHaveBeenCalled();
    expect(resolver.publicProjection()).toEqual({ sandboxAvailable: false });
    expect(resolver.administrativeProjection()).toMatchObject({ state: "unconfigured" });
  });

  it("keeps explicit disabled configuration distinct from missing configuration", async () : Promise<any> => {
    const candidate: any = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: { enabled: false },
      adapters: [candidate]
    });

    expect(await resolver.resolve()).toBeNull();
    expect(candidate.probe).not.toHaveBeenCalled();
    expect(resolver.administrativeProjection()).toMatchObject({ state: "disabled" });
  });

  it("selects the highest-ranked conforming provider and skips a non-conforming leader", async () : Promise<any> => {
    const rootless: any = adapter({
      id: "podman-rootless",
      providerClass: "rootless-podman",
      receipt: false
    });
    const docker: any = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [docker, rootless],
      now: () : any => new Date("2028-01-01T00:00:00.000Z")
    });

    const selected: any = await resolver.resolve();
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

  it("honors explicit provider identity without falling back to another provider", async () : Promise<any> => {
    const requested: any = adapter({
      id: "podman-system",
      providerClass: "podman",
      healthy: false
    });
    const fallback: any = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration({ providerMode: "explicit", providerId: requested.id }),
      adapters: [fallback, requested],
      now: () : any => new Date("2028-01-01T00:00:00.000Z")
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "sandbox_backend_unhealthy" });
    expect(fallback.probe).not.toHaveBeenCalled();
    expect(resolver.administrativeProjection()).toMatchObject({ state: "degraded" });
  });

  it("deduplicates concurrent refresh and invalidates cached availability", async () : Promise<any> => {
    let releaseProbe: any;
    const probeGate: any = new Promise((resolve?: any) : any => { releaseProbe = resolve; });
    const candidate: any = adapter({
      id: "docker-system",
      providerClass: "docker",
      probe: vi.fn(async () : Promise<any> => {
        await probeGate;
        return adapter({ id: "docker-system", providerClass: "docker" }).probe();
      })
    });
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [candidate],
      now: () : any => new Date("2028-01-01T00:00:00.000Z")
    });

    const first: any = resolver.refresh({ force: true });
    const second: any = resolver.refresh({ force: true });
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

  it("expires public availability and rejects stale resolution generations", async () : Promise<any> => {
    let clock: any = new Date("2028-01-01T00:00:00.000Z");
    const candidate: any = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [candidate],
      now: () : any => clock,
      ttlMs: 1_000
    });

    const first: any = await resolver.resolve();
    expect(resolver.validate(first)).toBe(true);
    clock = new Date("2028-01-01T00:00:01.001Z");
    expect(resolver.publicProjection()).toEqual({ sandboxAvailable: false });
    expect(resolver.validate(first)).toBe(false);
    expect(resolver.administrativeProjection()).toMatchObject({
      state: "unavailable",
      reasonCode: "sandbox_provider_selection_stale"
    });

    const second: any = await resolver.resolve();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(resolver.validate(second)).toBe(true);
    expect(resolver.validate(first)).toBe(false);
  });

  it("fails closed for expired receipts and quarantine", async () : Promise<any> => {
    const candidate: any = adapter({ id: "docker-system", providerClass: "docker" });
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [candidate],
      now: () : any => new Date("2031-01-01T00:00:00.000Z")
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "sandbox_policy_unsupported" });
    expect(resolver.administrativeProjection()).toMatchObject({ state: "degraded" });
    resolver.quarantine();
    expect(await resolver.resolve()).toBeNull();
    expect(resolver.administrativeProjection()).toMatchObject({ state: "quarantined" });
  });

  it("rejects tampered and cross-provider conformance receipts", async () : Promise<any> => {
    const tampered: any = adapter({ id: "docker-system", providerClass: "docker" });
    tampered.probe = vi.fn(async () : Promise<any> => ({
      ...(await adapter({ id: "docker-system", providerClass: "docker" }).probe()),
      conformanceReceipt: {
        ...(await adapter({ id: "docker-system", providerClass: "docker" }).probe()).conformanceReceipt,
        runtimeProfile: "another-profile"
      }
    }));
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [tampered],
      now: () : any => new Date("2028-01-01T00:00:00.000Z")
    });

    await expect(resolver.resolve()).rejects.toMatchObject({ code: "sandbox_policy_unsupported" });
    expect(tampered.createBackend).not.toHaveBeenCalled();

    const crossProvider: any = adapter({ id: "docker-system", providerClass: "docker" });
    const originalDescriptor: any = await crossProvider.probe();
    crossProvider.probe = vi.fn(async () : Promise<any> => ({
      ...originalDescriptor,
      conformanceReceipt: createSandboxProviderConformanceReceipt({
        ...originalDescriptor.conformanceReceipt,
        providerId: "another-provider"
      })
    }));
    const crossProviderResolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration(),
      adapters: [crossProvider],
      now: () : any => new Date("2028-01-01T00:00:00.000Z")
    });
    await expect(crossProviderResolver.resolve()).rejects.toMatchObject({
      code: "sandbox_policy_unsupported"
    });
    expect(crossProvider.createBackend).not.toHaveBeenCalled();
  });

  it("discovers OCI providers only through fixed core adapters and redacts their location", async () : Promise<any> => {
    const executableIdentityDigest: any = "d".repeat(64);
    const serviceIdentityRef: any = controlledRef(sandboxDigest({
      providerId: "oci.docker",
      engine: "docker",
      runtimeClass: "runc",
      executableIdentityDigest
    }), "sandbox-provider-service");
    const receipt: any = createOciProviderConformanceReceipt({
      target: {
        id: "oci.docker",
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
    const backend: Record<string, any> = {
      async descriptor() : Promise<any> {
        return {
          id: "ignored-by-adapter",
          healthy: true,
          production: true,
          enforcedRestrictions: [...REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS]
        };
      },
      async run() : Promise<any> {},
      async cleanup() : Promise<any> { return { destroyed: true }; },
      async close() : Promise<any> {}
    };
    const adapters: any = createTrustedOciProviderAdapters({
      platform: "linux",
      conformanceReceipts: { "oci.docker": receipt },
      pathExists: (candidatePath?: any) : any => candidatePath === "docker",
      rootlessProbe: async () : Promise<any> => false,
      runtimeClassProbe: async () : Promise<any> => "runc",
      executableIdentityProbe: async () : Promise<any> => executableIdentityDigest,
      backendFactory: vi.fn(() : any => backend)
    });
    const resolver: any = createTrustedSandboxProviderResolver({
      configuration: configuration({ allowedProviderClasses: ["docker"] }),
      adapters,
      now: () : any => new Date("2027-01-01T01:00:00.000Z")
    });

    expect((await resolver.resolve())?.backend).toBe(backend);
    const publicState: any = resolver.publicProjection();
    const administrativeState: any = resolver.administrativeProjection();
    expect(publicState).toEqual({ sandboxAvailable: true });
    expect(administrativeState).toMatchObject({
      state: "ready",
      providerClass: "docker",
      isolationClass: "hardened-oci"
    });
    expect(administrativeState).not.toHaveProperty("binary");
    expect(administrativeState).not.toHaveProperty("executablePath");
  });

  it("discovers local Podman only through its non-root host identity", async () : Promise<any> => {
    const backend: Record<string, any> = {
      async descriptor() : Promise<any> {
        return { healthy: true, production: true, enforcedRestrictions: [] };
      },
      async run() : Promise<any> {},
      async cleanup() : Promise<any> { return { destroyed: true }; }
    };
    const adapters: any = createTrustedOciProviderAdapters({
      platform: "linux",
      pathExists: (candidatePath?: any) : any => candidatePath === "podman",
      rootlessProbe: async () : Promise<any> => true,
      runtimeClassProbe: async () : Promise<any> => "crun",
      executableIdentityProbe: async () : Promise<any> => EXECUTABLE_IDENTITY_DIGEST,
      backendFactory: () : any => backend
    });
    const rootless: any = adapters.find(({ id }: Record<string, any>) : any => id === "oci.rootless-podman");
    const rootful: any = adapters.find(({ id }: Record<string, any>) : any => id === "oci.podman");

    expect((await rootless.probe()).healthy).toBe(true);
    expect(rootful).toBeUndefined();
  });

  it("rejects a conformance target whose observed OCI runtime class differs", async () : Promise<any> => {
    const backendFactory: any = vi.fn(() : any => ({
      async descriptor() : Promise<any> {
        return { healthy: true, production: true, enforcedRestrictions: [] };
      }
    }));
    const target: any = await createOciBackendConformanceTarget({
      platform: "darwin",
      pathExists: (candidatePath?: any) : any => candidatePath === "podman",
      rootlessProbe: async () : Promise<any> => true,
      runtimeClassProbe: async () : Promise<any> => "runc",
      executableIdentityProbe: async () : Promise<any> => EXECUTABLE_IDENTITY_DIGEST,
      backendFactory
    });

    expect(target).toBeNull();
    expect(backendFactory).not.toHaveBeenCalled();
  });

  it("constructs the preferred Podman conformance target without Docker", async () : Promise<any> => {
    const backend: any = {
      async descriptor() : Promise<any> {
        return { healthy: true, production: true, enforcedRestrictions: [] };
      }
    };
    const backendFactory: any = vi.fn(() : any => backend);
    const target: any = await createOciBackendConformanceTarget({
      platform: "darwin",
      pathExists: (candidatePath?: any) : any => candidatePath === "podman",
      rootlessProbe: async () : Promise<any> => true,
      runtimeClassProbe: async () : Promise<any> => "crun",
      executableIdentityProbe: async () : Promise<any> => EXECUTABLE_IDENTITY_DIGEST,
      backendFactory
    });

    expect(target).toMatchObject({
      id: "oci.rootless-podman",
      providerClass: "rootless-podman",
      engine: "podman",
      backend
    });
    expect(backendFactory).toHaveBeenCalledWith(expect.objectContaining({
      id: "oci.rootless-podman",
      engine: "podman",
      runtimeClass: "crun",
      rootless: true,
    }));
  });
});
