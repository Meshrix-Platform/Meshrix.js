import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PATTERN_CLASSIFIED_SCRIPT_NAMES,
  SCRIPT_REGISTRY,
  UNCLASSIFIED_ALLOWLIST,
  getDeclaredEntry,
  getEntry,
  isClassified
} from "../../../tools/scripts/package-script-registry.ts";

const packageScripts: any = Object.keys(
  JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts || {}
);

describe("package script registry declarations", () : any => {
  it("does not classify an undeclared name merely because it has a known prefix", () : any => {
    expect(isClassified("verify:undeclared-fixture")).toBe(false);
    expect(isClassified("server:verify:undeclared-fixture")).toBe(false);
  });

  it("has one current declaration for every package script", () : any => {
    const declarations: any[] = [
      ...Object.keys(SCRIPT_REGISTRY),
      ...PATTERN_CLASSIFIED_SCRIPT_NAMES,
      ...UNCLASSIFIED_ALLOWLIST
    ];
    const counts: any = new Map<any, any>();
    for (const scriptName of declarations) {
      counts.set(scriptName, (counts.get(scriptName) || 0) + 1);
    }

    expect(packageScripts.filter((scriptName?: any) : any => !isClassified(scriptName))).toEqual([]);
    expect([...new Set<any>(declarations)].filter((scriptName?: any) : any => !packageScripts.includes(scriptName))).toEqual([]);
    expect([...counts].filter(([, count]: any[]) : any => count !== 1)).toEqual([]);
  });

  it("keeps the raw registry alias separate from the projected package command", () : any => {
    const scriptName: any = "verify:acceptance:plan";
    const packageCommand: any = "node tools/server-scripts/verify-platform-acceptance.ts --plan";

    expect(getDeclaredEntry(scriptName)?.command).toBe(`npm run ${scriptName}`);
    expect(getEntry(scriptName, { [scriptName]: packageCommand })?.command).toBe(packageCommand);
    expect(getDeclaredEntry(scriptName)?.command).toBe(`npm run ${scriptName}`);
  });

  it("classifies canonical acceptance by its destructive generation ownership", () : any => {
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
