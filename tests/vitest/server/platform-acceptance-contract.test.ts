import { describe, expect, it } from "vitest";

import {
  parsePlatformAcceptanceArgs,
  requirePlatformAcceptanceProfile,
} from "../../../tools/server-scripts/lib/platform-acceptance-contract.ts";

describe("platform acceptance profile contract", () : any => {
  it("requires one registered profile for plan and execution modes", () : any => {
    expect(parsePlatformAcceptanceArgs(["--profile", "enterprise-single-node"])).toEqual({
      planOnly: false,
      selectedProfile: "enterprise-single-node",
    });
    expect(parsePlatformAcceptanceArgs(["--profile", "enterprise-single-node", "--plan"])).toEqual({
      planOnly: true,
      selectedProfile: "enterprise-single-node",
    });
    expect(() : any => parsePlatformAcceptanceArgs([])).toThrow("requires --profile");
    expect(() : any => parsePlatformAcceptanceArgs(["--profile", "any"])).toThrow(
      "Unknown platform acceptance profile",
    );
    expect(() : any => parsePlatformAcceptanceArgs(["--profile", "enterprise-single-node", "--profile", "enterprise-single-node"]))
      .toThrow("provided more than once");
  });

  it("rejects missing and unknown profile bindings", () : any => {
    expect(requirePlatformAcceptanceProfile("enterprise-single-node")).toBe("enterprise-single-node");
    expect(() : any => requirePlatformAcceptanceProfile("")).toThrow("requires --profile");
    expect(() : any => requirePlatformAcceptanceProfile("any")).toThrow(
      "Unknown platform acceptance profile",
    );
  });
});
