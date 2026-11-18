import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  explicitAnyFindings,
  isExcludedFile,
  NEW_TYPESCRIPT_SCOPE,
  scanNoExplicitAny,
  TYPING_SUBSTRATE_OWNED_PATHS
} from "../../../tools/server-scripts/verify-no-explicit-any.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("delivery typing substrate", () => {
  it("denies typescript/no-explicit-any in the oxlint configuration", async () => {
    const config = JSON.parse(
      await fs.readFile(path.join(repoRoot, ".oxlintrc.json"), "utf8")
    ) as { rules?: Record<string, unknown> };
    const rule = config.rules?.["typescript/no-explicit-any"];
    expect(rule === "error" || (Array.isArray(rule) && rule[0] === "error")).toBe(true);
  });

  it("detects explicit any while accepting unknown and concrete types", () => {
    expect(explicitAnyFindings("export const value: any = 1;", "a.ts")).toHaveLength(1);
    expect(explicitAnyFindings("const value = thing as any;", "a.ts")).toHaveLength(1);
    expect(explicitAnyFindings("const values: any[] = [];", "a.ts")).toHaveLength(1);
    expect(explicitAnyFindings("const record: Record<string, any> = {};", "a.ts")).toHaveLength(1);
    expect(explicitAnyFindings("export const value: string = 'a';", "a.ts")).toHaveLength(0);
    expect(explicitAnyFindings("export function f(value: unknown): unknown { return value; }", "a.ts"))
      .toHaveLength(0);
    expect(explicitAnyFindings("// any word in a comment is not a type position", "a.ts"))
      .toHaveLength(0);
  });

  it("keeps GATE-CONTRACT, generated operations, and declaration files outside the write set", () => {
    expect(isExcludedFile("packages/contracts/src/service-collaboration-contract.d.ts")).toBe(true);
    expect(isExcludedFile("packages/contracts/src/generated/operations.generated.ts")).toBe(true);
    expect(isExcludedFile("packages/foundation/src/security/authorization/generated-capabilities.ts"))
      .toBe(true);
    expect(isExcludedFile("packages/contracts/src/service-collaboration-contract.ts")).toBe(false);
  });

  it("scans the contracts plus security batch with zero explicit any", async () => {
    expect(TYPING_SUBSTRATE_OWNED_PATHS.length).toBeGreaterThan(0);
    expect(NEW_TYPESCRIPT_SCOPE.length).toBeGreaterThan(0);
    const { findings, scannedFiles } = await scanNoExplicitAny({ root: repoRoot });
    expect(findings).toEqual([]);
    expect(scannedFiles.length).toBeGreaterThan(0);
    expect(scannedFiles.some((file) => file === "packages/contracts/src/mcp-catalog-delivery.ts"))
      .toBe(true);
    expect(scannedFiles.some((file) => file.startsWith("packages/foundation/src/security/auth/")))
      .toBe(true);
    expect(scannedFiles.some((file) => file.endsWith(".d.ts"))).toBe(false);
  });
});
