import { describe, expect, it } from "vitest";

import {
  parsePlatformAcceptanceArgs,
  requirePlatformAcceptanceProfile,
} from "../../../tools/server-scripts/lib/platform-acceptance-contract.mjs";

describe("platform acceptance profile contract", () => {
  it("requires one registered profile for plan and execution modes", () => {
    expect(parsePlatformAcceptanceArgs(["--profile", "enterprise-single-node"])).toEqual({
      planOnly: false,
      selectedProfile: "enterprise-single-node",
    });
    expect(parsePlatformAcceptanceArgs(["--profile", "enterprise-single-node", "--plan"])).toEqual({
      planOnly: true,
      selectedProfile: "enterprise-single-node",
    });
    expect(() => parsePlatformAcceptanceArgs([])).toThrow("requires --profile");
    expect(() => parsePlatformAcceptanceArgs(["--profile", "any"])).toThrow(
      "Unknown platform acceptance profile",
    );
    expect(() => parsePlatformAcceptanceArgs(["--profile", "enterprise-single-node", "--profile", "enterprise-single-node"]))
      .toThrow("provided more than once");
  });

  it("rejects missing and unknown profile bindings", () => {
    expect(requirePlatformAcceptanceProfile("enterprise-single-node")).toBe("enterprise-single-node");
    expect(() => requirePlatformAcceptanceProfile("")).toThrow("requires --profile");
    expect(() => requirePlatformAcceptanceProfile("any")).toThrow(
      "Unknown platform acceptance profile",
    );
  });
});
