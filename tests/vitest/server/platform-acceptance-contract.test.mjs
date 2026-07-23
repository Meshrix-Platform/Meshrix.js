import { describe, expect, it } from "vitest";

import {
  parsePlatformAcceptanceArgs,
  requirePlatformAcceptanceProfile,
} from "../../../tools/server-scripts/lib/platform-acceptance-contract.mjs";

describe("platform acceptance profile contract", () => {
  it("requires one registered profile for plan and execution modes", () => {
    expect(parsePlatformAcceptanceArgs(["--profile", "core"])).toEqual({
      planOnly: false,
      selectedProfile: "core",
    });
    expect(parsePlatformAcceptanceArgs(["--profile", "core", "--plan"])).toEqual({
      planOnly: true,
      selectedProfile: "core",
    });
    expect(() => parsePlatformAcceptanceArgs([])).toThrow("requires --profile");
    expect(() => parsePlatformAcceptanceArgs(["--profile", "any"])).toThrow(
      "Unknown platform acceptance profile",
    );
    expect(() => parsePlatformAcceptanceArgs(["--profile", "core", "--profile", "core"]))
      .toThrow("provided more than once");
  });

  it("rejects missing and unknown profile bindings", () => {
    expect(requirePlatformAcceptanceProfile("core")).toBe("core");
    expect(() => requirePlatformAcceptanceProfile("")).toThrow("requires --profile");
    expect(() => requirePlatformAcceptanceProfile("any")).toThrow(
      "Unknown platform acceptance profile",
    );
  });
});
