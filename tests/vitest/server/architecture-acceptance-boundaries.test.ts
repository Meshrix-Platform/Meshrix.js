import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runArchitectureGraph } from "../../../tools/verifiers/architecture-graph.ts";
import { computeArchitectureFactsDigest } from "../../../tools/generators/generate-architecture-diagram-digests.ts";

const root: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("architecture and acceptance machine boundaries", () : any => {
  it("resolves production import forms with zero active exceptions", async () : Promise<any> => {
    const report: any = await runArchitectureGraph({ verbose: false, writeReport: false });
    expect(report.violations).toEqual([]);
    expect(report.unresolvedImports).toEqual([]);
    expect(report.graph.summary.exceptionCount).toBe(0);
    expect(report.graph.summary.relativeEdgeCount).toBeGreaterThan(0);
    expect(report.graph.summary.packageImportEdgeCount).toBeGreaterThan(0);
    expect(report.graph.summary.workspacePackageEdgeCount).toBeGreaterThan(0);
  });

  it("locks architecture diagrams to the architecture-facts digest", () : any => {
    const digest: any = computeArchitectureFactsDigest();
    for (const relativePath of [
      "docs/architecture/MESHRIX-SYSTEM-ARCHITECTURE.html",
      "docs/architecture/MESHRIX-SERVICE-CAPABILITY-ARCHITECTURE.html"
    ]) {
      const html: any = fs.readFileSync(path.join(root, relativePath), "utf8");
      expect(html).toContain(`<!-- architecture-facts-digest: ${digest} -->`);
      expect(html).toMatch(/Projection-only diagram/);
      expect(html).toMatch(/Authority:\s*packages\/contracts\/src\/modules\/manifest\.ts/);
    }
  });
});
