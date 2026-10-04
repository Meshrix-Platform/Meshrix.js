import { describe, expect, it } from "vitest";

import {
  parsePlatformAcceptanceArgs,
  resolveAcceptanceCommandInvocation,
  requirePlatformAcceptanceProfile,
} from "../../../tools/server-scripts/lib/platform-acceptance-contract.ts";

describe("platform acceptance profile contract", () : any => {
  it("uses the shared npm CLI resolver for every npm command without a shell", () : any => {
    expect(resolveAcceptanceCommandInvocation("npm", ["run", "verify:acceptance"], {
      npmInvocation: { command: "/runtime/node", prefixArgs: ["/runtime/npm-cli.js"] },
    })).toEqual({
      executable: "/runtime/node",
      args: ["/runtime/npm-cli.js", "run", "verify:acceptance"],
    });
    expect(resolveAcceptanceCommandInvocation("node", ["tests/run.ts"], {
      nodeExecutable: "/runtime/node",
    })).toEqual({ executable: "/runtime/node", args: ["tests/run.ts"] });
  });

  it("requires one registered profile for plan and execution modes", () : any => {
    expect(parsePlatformAcceptanceArgs(["--profile", "single-node"])).toEqual({
      planOnly: false,
      selectedProfile: "single-node",
    });
    expect(parsePlatformAcceptanceArgs(["--profile", "single-node", "--plan"])).toEqual({
      planOnly: true,
      selectedProfile: "single-node",
    });
    expect(() : any => parsePlatformAcceptanceArgs([])).toThrow("requires --profile");
    expect(() : any => parsePlatformAcceptanceArgs(["--profile", "any"])).toThrow(
      "Unknown platform acceptance profile",
    );
    expect(() : any => parsePlatformAcceptanceArgs(["--profile", "single-node", "--profile", "single-node"]))
      .toThrow("provided more than once");
  });

  it("rejects missing and unknown profile bindings", () : any => {
    expect(requirePlatformAcceptanceProfile("single-node")).toBe("single-node");
    expect(() : any => requirePlatformAcceptanceProfile("")).toThrow("requires --profile");
    expect(() : any => requirePlatformAcceptanceProfile("any")).toThrow(
      "Unknown platform acceptance profile",
    );
  });
});
