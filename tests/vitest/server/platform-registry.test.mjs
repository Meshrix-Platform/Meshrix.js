import { describe, expect, it, vi } from "vitest";
import {
  callPlatformInterface,
  createPlatformRegistry,
  registerPlatformService,
  requirePlatformInterface
} from "#lico/platform-registry";

describe("platform interactive registry", () => {
  it("registers common-platform interfaces, lists public metadata, and calls function values", async () => {
    const handler = vi.fn((left, right) => ({ sum: left + right }));
    const registry = createPlatformRegistry({ scope: "unit-scope" });

    const record = registry.register({
      platform: "core",
      id: "core.math.add",
      label: "Add",
      kind: "function",
      ownerFeatureId: "math-feature",
      metadata: { stable: true },
      value: handler
    });

    expect(registry.scope).toBe("unit-scope");
    expect(record).toMatchObject({
      id: "core.math.add",
      platform: "core",
      layer: "common",
      label: "Add",
      kind: "function",
      ownerFeatureId: "math-feature",
      public: true,
      metadata: { stable: true }
    });
    expect(registry.get(" core.math.add ")).toBe(record);
    expect(registry.get("missing")).toBeNull();
    await expect(registry.callInterface("core.math.add", 2, 3)).resolves.toEqual({ sum: 5 });
    expect(handler).toHaveBeenCalledWith(2, 3);

    expect(registry.list({ platform: "core" })).toEqual([
      {
        id: "core.math.add",
        platform: "core",
        layer: "common",
        label: "Add",
        kind: "function",
        ownerFeatureId: "math-feature",
        public: true,
        metadata: { stable: true }
      }
    ]);
    expect(registry.list({ layer: "other" })).toEqual([]);
  });

  it("supports handle-object values, defaults, and helper facades", async () => {
    const registry = createPlatformRegistry();
    const value = {
      handle: vi.fn(async (input) => ({ echoed: input }))
    };

    const record = registerPlatformService(registry, {
      platform: "security",
      id: "security.echo",
      public: false,
      value
    });

    expect(record).toMatchObject({
      label: "security.echo",
      kind: "service",
      ownerFeatureId: "security-platform",
      public: false
    });
    expect(requirePlatformInterface(registry, "security.echo")).toBe(record);
    await expect(callPlatformInterface(registry, "security.echo", "payload")).resolves.toEqual({ echoed: "payload" });
    expect(value.handle).toHaveBeenCalledWith("payload");
  });

  it("rejects invalid platforms, inconsistent layers, duplicate ids, missing records, and non-callable values", async () => {
    const registry = createPlatformRegistry({ scope: "" });
    expect(registry.scope).toBe("server");

    expect(() => registry.register({ platform: "", id: "missing.platform" }))
      .toThrow("Platform registry platform is required.");
    expect(() => registry.register({ platform: "feature", id: "feature.bad" }))
      .toThrow("only accepts bottom platform interfaces");
    expect(() => registry.register({ platform: "core", id: "" }))
      .toThrow("Platform registry id is required.");
    expect(() => registry.register({ platform: "core", id: "core.bad-layer", layer: "specialized" }))
      .toThrow("inconsistent layer specialized");

    registry.register({ platform: "storage", id: "storage.repo", value: { name: "not-callable" } });
    expect(() => registry.register({ platform: "storage", id: "storage.repo" }))
      .toThrow("Duplicate platform registration");
    expect(() => registry.require("missing.interface")).toThrow("Missing platform registration");
    await expect(registry.callInterface("storage.repo")).rejects.toThrow("Platform interface is not callable");

    expect(() => registerPlatformService(null, {})).toThrow("A PlatformRegistry instance is required.");
    expect(() => requirePlatformInterface({}, "x")).toThrow("A PlatformInteractiveRegistry instance is required.");
    expect(() => callPlatformInterface({}, "x")).toThrow("A PlatformInteractiveRegistry instance is required.");
  });
});
