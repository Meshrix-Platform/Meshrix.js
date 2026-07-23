import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  GOVERNED_VERSION_PATTERN,
  collectGovernedVersionOccurrences,
  isValidatedGovernedDynamicVersionTemplateAt
} from "../../../packages/foundation/src/version-control/version-scan.mjs";

describe("governed version scanning", () => {
  it("captures malformed shapes and exempts only explicitly validated dynamic templates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-version-scan-"));
    try {
      const scanRoot = path.join(root, "fixtures");
      await fs.mkdir(scanRoot, { recursive: true });
      const valid = ["v0.0.1", "sample-domain", "sample-contract-1"].join(":");
      const malformedSuffix = `${valid}x`;
      const malformedAxis = `${valid}:BAD`;
      const malformedSingleColon = ["v0.0.1", "single-axis-1"].join(":");
      const dynamicPrefix = ["v0.0.1", "sample-domain", "dynamic-contract-"].join(":");
      const invalidDynamicPrefix = ["v0.0.1", "sample-domain", "invalid-dynamic-contract-"].join(":");
      await fs.writeFile(
        path.join(scanRoot, "versions.mjs"),
        [
          `export const valid = "${valid}";`,
          `export const malformedSuffix = "${malformedSuffix}";`,
          `export const malformedAxis = "${malformedAxis}";`,
          `export const malformedSingleColon = "${malformedSingleColon}";`,
          `export const dynamic = \`${dynamicPrefix}\${revision}-1\`;`,
          `export const invalidDynamic = \`${invalidDynamicPrefix}\${revision.toLowerCase()}-1\`;`
        ].join("\n"),
        "utf8"
      );

      const occurrences = collectGovernedVersionOccurrences({
        repoRoot: root,
        scanRoots: ["fixtures"]
      });

      expect(occurrences.has(valid)).toBe(true);
      expect(occurrences.has(malformedSuffix)).toBe(true);
      expect(occurrences.has(malformedAxis)).toBe(true);
      expect(occurrences.has(malformedSingleColon)).toBe(true);
      expect(occurrences.has(dynamicPrefix)).toBe(true);
      expect(occurrences.has(invalidDynamicPrefix)).toBe(true);
      expect(GOVERNED_VERSION_PATTERN.test(valid)).toBe(true);
      expect(GOVERNED_VERSION_PATTERN.test(malformedSuffix)).toBe(false);
      expect(GOVERNED_VERSION_PATTERN.test(malformedAxis)).toBe(false);
      expect(GOVERNED_VERSION_PATTERN.test(malformedSingleColon)).toBe(false);
      expect(GOVERNED_VERSION_PATTERN.test(["v0.0.1", "strategy", "service-v2-1"].join(":"))).toBe(false);
      expect(GOVERNED_VERSION_PATTERN.test(["v0.0.1", "strategy", "legacy-service-1"].join(":"))).toBe(false);
      expect(GOVERNED_VERSION_PATTERN.test(["v0.0.1", "strategy", "compat-service-1"].join(":"))).toBe(false);

      const generatorPath = "tools/generators/generate-capability-acceptance-definitions.mjs";
      const generatorSource = await fs.readFile(
        new URL("../../../tools/generators/generate-capability-acceptance-definitions.mjs", import.meta.url),
        "utf8"
      );
      const generatorDynamicPrefix = ["v0.0.1", "state-machine", "capability-acceptance-"].join(":");
      const generatorCandidateIndex = generatorSource.indexOf(generatorDynamicPrefix);
      expect(isValidatedGovernedDynamicVersionTemplateAt(generatorSource, generatorCandidateIndex, {
        relativePath: generatorPath
      })).toBe(true);
      expect(isValidatedGovernedDynamicVersionTemplateAt(
        `\`${dynamicPrefix}\${revision.toLowerCase()}-1\``,
        1,
        { relativePath: generatorPath }
      )).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let the registry document act as its own functional source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-version-registry-source-"));
    try {
      const registryDir = path.join(root, "packages/foundation/src/version-control");
      await fs.mkdir(registryDir, { recursive: true });
      const registryOnlyVersion = ["v0.0.1", "sample-domain", "registry-only-1"].join(":");
      await fs.writeFile(
        path.join(registryDir, "version-registry.json"),
        `${JSON.stringify({ activeVersion: registryOnlyVersion })}\n`,
        "utf8"
      );

      const occurrences = collectGovernedVersionOccurrences({
        repoRoot: root,
        scanRoots: ["packages"],
        excludedRelativePaths: ["packages/foundation/src/version-control/version-registry.json"]
      });

      expect(occurrences.has(registryOnlyVersion)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
