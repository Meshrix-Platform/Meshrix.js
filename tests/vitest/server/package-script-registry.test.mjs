import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PATTERN_CLASSIFIED_SCRIPT_NAMES,
  SCRIPT_REGISTRY,
  UNCLASSIFIED_ALLOWLIST,
  getDeclaredEntry,
  getEntry,
  isClassified
} from "../../../tools/scripts/package-script-registry.mjs";

const packageScripts = Object.keys(
  JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts || {}
);

describe("package script registry declarations", () => {
  it("does not classify an undeclared name merely because it has a known prefix", () => {
    expect(isClassified("verify:undeclared-fixture")).toBe(false);
    expect(isClassified("server:verify:undeclared-fixture")).toBe(false);
  });

  it("has one current declaration for every package script", () => {
    const declarations = [
      ...Object.keys(SCRIPT_REGISTRY),
      ...PATTERN_CLASSIFIED_SCRIPT_NAMES,
      ...UNCLASSIFIED_ALLOWLIST
    ];
    const counts = new Map();
    for (const scriptName of declarations) {
      counts.set(scriptName, (counts.get(scriptName) || 0) + 1);
    }

    expect(packageScripts.filter((scriptName) => !isClassified(scriptName))).toEqual([]);
    expect([...new Set(declarations)].filter((scriptName) => !packageScripts.includes(scriptName))).toEqual([]);
    expect([...counts].filter(([, count]) => count !== 1)).toEqual([]);
  });

  it("keeps the raw registry alias separate from the projected package command", () => {
    const scriptName = "verify:acceptance:plan";
    const packageCommand = "node tools/server-scripts/verify-platform-acceptance.mjs --plan";

    expect(getDeclaredEntry(scriptName)?.command).toBe(`npm run ${scriptName}`);
    expect(getEntry(scriptName, { [scriptName]: packageCommand })?.command).toBe(packageCommand);
    expect(getDeclaredEntry(scriptName)?.command).toBe(`npm run ${scriptName}`);
  });

  it("classifies canonical acceptance by its destructive generation ownership", () => {
    expect(getDeclaredEntry("verify:acceptance")).toMatchObject({
      tier: "release",
      sideEffects: "destructive",
      requiresFreshContainer: true,
      ciProfile: "release",
      expectedDurationClass: "extended",
      outputs: [
        "build/acceptance-evidence/**",
        "build/acceptance-proof-ledger/**",
        "build/reports/**"
      ]
    });
  });
});
